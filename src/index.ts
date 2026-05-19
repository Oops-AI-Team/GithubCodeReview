import { Env, ProgressEntry, ReviewTask } from './types';
import { verifyWebhookSignature, verifyADPSignature } from './verify';
import {
  getInstallationToken,
  postIssueComment,
  postReview,
  updateIssueComment,
} from './github';
import { triggerADPReview } from './adp';
import { buildReviewPrompt } from './prompt';

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === '/' && request.method === 'GET') {
      return Response.json({ status: 'ok', app: 'oops-github-app' });
    }

    // GitHub Webhook endpoint
    if (url.pathname === '/api/webhook' && request.method === 'POST') {
      return handleWebhook(request, env, ctx);
    }

    // ADP progress endpoint — agent reports incremental progress here.
    // Each call appends a line to the sticky placeholder comment on the PR.
    if (url.pathname === '/api/adp/progress' && request.method === 'POST') {
      return handleADPProgress(request, env, ctx);
    }

    // ADP callback endpoint — agent calls this once when the review is done.
    if (url.pathname === '/api/adp/callback' && request.method === 'POST') {
      return handleADPCallback(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// ─── Helpers ────────────────────────────────────────────────

/** Validate external-supplied correlationId before using it as a KV key. */
function isValidCorrelationId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-zA-Z0-9_-]{32,64}$/.test(id);
}

// ─── GitHub Webhook Handler ─────────────────────────────────

async function handleWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();
  const signature = request.headers.get('X-Hub-Signature-256') ?? '';

  const isValid = await verifyWebhookSignature(body, signature, env.GITHUB_WEBHOOK_SECRET);
  if (!isValid) {
    return new Response('Invalid signature', { status: 401 });
  }

  const event = request.headers.get('X-GitHub-Event') ?? '';
  const payload = JSON.parse(body);

  try {
    switch (event) {
      case 'pull_request': {
        const action = payload.action;
        if (action === 'opened' || action === 'synchronize') {
          const installationId = payload.installation?.id;
          const owner = payload.repository?.owner?.login;
          const repo = payload.repository?.name;
          const prNumber = payload.pull_request?.number;
          const prTitle = payload.pull_request?.title ?? '';
          const prDescription = payload.pull_request?.body ?? '';
          const prAuthor = payload.pull_request?.user?.login ?? 'unknown';

          if (!installationId || !owner || !repo || !prNumber) {
            return new Response('Missing required fields', { status: 400 });
          }

          ctx.waitUntil(
            triggerReview(env, installationId, owner, repo, prNumber, prTitle, prDescription, prAuthor)
          );

          return new Response('Review triggered', { status: 202 });
        }
        break;
      }

      case 'issue_comment': {
        const action = payload.action;
        console.log(`issue_comment: action=${action}, isPR=${!!payload.issue?.pull_request}, body=${payload.comment?.body}`);
        if (action === 'created' && payload.issue?.pull_request) {
          const commentBody = payload.comment?.body ?? '';
          const botName = env.GITHUB_APP_NAME?.trim() ? `@${env.GITHUB_APP_NAME.trim()}` : '@oops-github-app';
          console.log(`botName="${botName}", commentBody="${commentBody}"`);

          if (!commentBody.toLowerCase().includes(botName.toLowerCase())) {
            return new Response(`Not a bot mention: botName="${botName}", commentBody="${commentBody}"`, { status: 200 });
          }

          const installationId = payload.installation?.id;
          const owner = payload.repository?.owner?.login;
          const repo = payload.repository?.name;
          const prNumber = payload.issue?.number;
          const prTitle = payload.issue?.title ?? '';
          const prDescription = payload.issue?.body ?? '';
          const prAuthor = payload.comment?.user?.login ?? payload.issue?.user?.login ?? 'unknown';

          if (!installationId || !owner || !repo || !prNumber) {
            return new Response('Missing required fields', { status: 400 });
          }

          ctx.waitUntil(
            triggerReview(env, installationId, owner, repo, prNumber, prTitle, prDescription, prAuthor)
          );

          return new Response('Review triggered', { status: 202 });
        }
        break;
      }

      case 'ping': {
        return new Response('pong', { status: 200 });
      }
    }
  } catch (err) {
    console.error('Webhook handling error:', err);
    return new Response(`Internal error: ${(err as Error).message}`, { status: 500 });
  }

  return new Response('Event ignored', { status: 200 });
}

// ─── ADP Progress Handler ───────────────────────────────────
//
// ADP agent POSTs incremental progress updates while it's working.
// Each update is appended to the task's progressLog and the placeholder
// comment is rewritten in place (PATCH).
//
// Body:
//   {
//     "correlationId": "<conversationId>",
//     "stage": "cloning" | "analyzing" | ...    (optional)
//     "message": "已完成 8/12 文件的扫描"        (required)
//   }

async function handleADPProgress(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // Verify ADP HMAC signature
  const body = await request.text();
  const signature = request.headers.get('X-ADP-Signature-256') ?? '';
  const isValid = await verifyADPSignature(body, signature, env.ADP_APP_KEY);
  if (!isValid) {
    return new Response('Invalid ADP signature', { status: 401 });
  }

  let data: { correlationId?: string; stage?: string; message?: string };
  try {
    data = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { correlationId, stage, message } = data;
  if (!isValidCorrelationId(correlationId) || !message) {
    return Response.json(
      { error: 'Missing or invalid correlationId / message' },
      { status: 400 },
    );
  }

  const taskKey = `task:${correlationId}`;
  const taskData = (await env.TASKS_KV.get(taskKey, 'json')) as ReviewTask | null;
  if (!taskData) {
    return Response.json({ error: 'Task not found', correlationId }, { status: 404 });
  }

  // If the task is already completed/failed, ignore late progress updates so
  // we don't trash the final review output.
  if (taskData.status !== 'pending') {
    return Response.json(
      { status: 'ignored', reason: `task is ${taskData.status}` },
      { status: 200 },
    );
  }

  const entry: ProgressEntry = {
    at: Date.now(),
    stage: stage?.trim() || undefined,
    message: message.slice(0, 2000), // hard cap per entry
  };
  taskData.progressLog = [...(taskData.progressLog ?? []), entry].slice(-50); // cap log size
  await env.TASKS_KV.put(taskKey, JSON.stringify(taskData));

  // Rewrite the placeholder comment in background; respond fast to ADP.
  ctx.waitUntil(
    (async () => {
      if (!taskData.placeholderCommentId) return;
      try {
        const token = await getInstallationToken(env, taskData.installationId);
        await updateIssueComment(
          token,
          taskData.owner,
          taskData.repo,
          taskData.placeholderCommentId,
          renderProgressComment(taskData),
        );
      } catch (err) {
        console.error(
          `Failed to update progress comment for ${correlationId}:`,
          err,
        );
      }
    })(),
  );

  return Response.json({ status: 'accepted' }, { status: 202 });
}

// ─── ADP Callback Handler ───────────────────────────────────

async function handleADPCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const body = await request.text();

  // Verify ADP HMAC signature
  const signature = request.headers.get('X-ADP-Signature-256') ?? '';
  const isValid = await verifyADPSignature(body, signature, env.ADP_APP_KEY);
  if (!isValid) {
    return new Response('Invalid ADP signature', { status: 401 });
  }

  let data: { correlationId?: string; review?: string };
  try {
    data = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { correlationId, review } = data;
  if (!isValidCorrelationId(correlationId) || !review) {
    return Response.json({ error: 'Missing or invalid correlationId / review' }, { status: 400 });
  }

  // correlationId is the ConversationId = derived from owner/repo/prNumber.
  const taskKey = `task:${correlationId}`;
  const taskData = (await env.TASKS_KV.get(taskKey, 'json')) as ReviewTask | null;
  if (!taskData) {
    return Response.json({ error: 'Task not found', correlationId }, { status: 404 });
  }

  // Finalize in the background so ADP gets a fast 202.
  ctx.waitUntil(
    (async () => {
      try {
        const token = await getInstallationToken(env, taskData.installationId);

        // Replace the placeholder comment with the full review report,
        // instead of posting a separate PR review + leaving a stub.
        taskData.status = 'completed';
        taskData.completedAt = Date.now();
        if (taskData.placeholderCommentId) {
          await updateIssueComment(
            token,
            taskData.owner,
            taskData.repo,
            taskData.placeholderCommentId,
            review,
          );
        } else {
          // No placeholder to update — fall back to posting a new review.
          await postReview(token, taskData.owner, taskData.repo, taskData.prNumber, review);
        }

        await env.TASKS_KV.put(taskKey, JSON.stringify(taskData));
      } catch (err) {
        console.error(
          `Failed to post review for ${taskData.owner}/${taskData.repo}#${taskData.prNumber}:`,
          err,
        );

        taskData.status = 'failed';
        taskData.error = (err as Error).message;
        taskData.completedAt = Date.now();
        await env.TASKS_KV.put(taskKey, JSON.stringify(taskData));

        // Best-effort: surface the failure on the placeholder comment.
        if (taskData.placeholderCommentId) {
          try {
            const token = await getInstallationToken(env, taskData.installationId);
            await updateIssueComment(
              token,
              taskData.owner,
              taskData.repo,
              taskData.placeholderCommentId,
              renderProgressComment(taskData),
            );
          } catch {
            /* ignore — we already logged the original error */
          }
        }
      }
    })(),
  );

  return Response.json({ status: 'accepted' }, { status: 202 });
}

// ─── Trigger Review Pipeline ────────────────────────────────

async function triggerReview(
  env: Env,
  installationId: number,
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  prDescription: string,
  prAuthor: string,
): Promise<void> {
  // The ADP system prompt (see ADP-Claw-Prompt.md) hard-codes both the
  // /api/adp/progress and /api/adp/callback URLs against this worker's
  // public hostname, so we no longer need to inject them per-request.
  // CALLBACK_BASE_URL is still kept around in env for diagnostics / future
  // routes, but is intentionally unused here.

  // 1. Mint a short-lived (~1 hour) GitHub App installation token.
  //    This token has access to ONLY the repos this installation covers,
  //    with the permissions configured on the GitHub App (Contents:read +
  //    Pull requests:read/write recommended). It is safe to hand to the
  //    ADP agent for a single review run because:
  //      - lifetime is capped at 1 hour by GitHub;
  //      - scope is limited to this installation's repos;
  //      - it cannot be used to access any other user's data.
  const installationToken = await getInstallationToken(env, installationId);

  // 2. Immediately post a sticky placeholder comment so the user sees
  //    feedback within a couple of seconds. We never block ADP triggering
  //    on this — if the comment post fails, we log and continue with no
  //    placeholderCommentId; progress/callback handlers will skip the
  //    update path.
  const startedAt = Date.now();
  const initialTask: ReviewTask = {
    id: '', // filled in below once we know the conversationId
    installationId,
    owner,
    repo,
    prNumber,
    status: 'pending',
    createdAt: startedAt,
    progressLog: [],
  };

  try {
    const { id: commentId } = await postIssueComment(
      installationToken,
      owner,
      repo,
      prNumber,
      renderProgressComment(initialTask),
    );
    initialTask.placeholderCommentId = commentId;
  } catch (err) {
    console.error(
      `Failed to post placeholder comment for ${owner}/${repo}#${prNumber}:`,
      err,
    );
  }

  // 3. Trigger ADP. The agent receives the installation token and the
  //    ConversationId via the prompt; it learns *what* to do (5-step SOP)
  //    and *where* to call back from the ADP system prompt itself.
  //
  //    triggerADPReview returns synchronously with the conversationId so we
  //    can persist the task to KV BEFORE the ADP HTTP call completes. This
  //    avoids a race where progress/callback arrives before the task exists.
  const { conversationId, promise: adpPromise } = triggerADPReview(
    env,
    (cid) =>
      buildReviewPrompt(
        owner,
        repo,
        prNumber,
        prTitle,
        prDescription,
        installationToken,
        cid,
        env.ADP_APP_KEY,
      ),
    owner,
    repo,
    prNumber,
    prAuthor,
  );

  // 4. Persist task context keyed by conversationId so progress/callback
  //    handlers can find it. Must happen BEFORE the ADP call resolves to
  //    prevent a race with incoming progress/callback requests.
  initialTask.id = conversationId;
  await env.TASKS_KV.put(`task:${conversationId}`, JSON.stringify(initialTask));

  // 5. Now await the ADP trigger call — if it fails we mark the task as failed.
  try {
    await adpPromise;
  } catch (err) {
    console.error(`ADP trigger failed for ${owner}/${repo}#${prNumber}:`, err);
    initialTask.status = 'failed';
    initialTask.error = (err as Error).message;
    initialTask.completedAt = Date.now();
    await env.TASKS_KV.put(`task:${conversationId}`, JSON.stringify(initialTask));
    // Best-effort: update the placeholder comment with the failure.
    if (initialTask.placeholderCommentId) {
      try {
        await updateIssueComment(
          installationToken,
          owner,
          repo,
          initialTask.placeholderCommentId,
          renderProgressComment(initialTask),
        );
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── Rendering ──────────────────────────────────────────────

const STAGE_ICONS: Record<string, string> = {
  planning: '🧭',
  fetching: '📥',
  analyzing: '🔎',
  summarizing: '📝',
  callback: '✅',
};

/**
 * Render the sticky placeholder comment for a task. Called on three
 * occasions: initial post, every progress update, and final completion.
 */
function renderProgressComment(task: ReviewTask): string {
  const elapsedSec = Math.max(
    0,
    Math.round(((task.completedAt ?? Date.now()) - task.createdAt) / 1000),
  );
  const lines: string[] = [];

  // ── Header ──
  lines.push('<div align="center">');
  lines.push('');
  if (task.status === 'completed') {
    lines.push('### ✅ Oops Code Review');
    lines.push('');
    lines.push(`**Review completed** · ⏱️ ${formatDuration(elapsedSec)}`);
  } else if (task.status === 'failed') {
    lines.push('### ❌ Oops Code Review');
    lines.push('');
    lines.push(`**Review failed** · ⏱️ ${formatDuration(elapsedSec)}`);
  } else {
    lines.push('### 🔍 Oops Code Review');
    lines.push('');
    lines.push(`**Reviewing this PR…** · ⏱️ ${formatDuration(elapsedSec)}`);
  }
  lines.push('');
  lines.push('</div>');
  lines.push('');
  lines.push('---');

  // ── Error callout (failed only) ──
  if (task.status === 'failed') {
    lines.push('');
    lines.push(`> ❌ Error: \`${escapeMd(task.error ?? 'unknown')}\``);
  }

  // ── Progress table ──
  const log = task.progressLog ?? [];
  if (log.length > 0) {
    const openAttr = task.status === 'pending' ? ' open' : '';
    lines.push('');
    lines.push(`<details${openAttr}><summary>📋 Progress</summary>`);
    lines.push('');
    lines.push('| Time | Stage | Detail |');
    lines.push('|---:|:---:|---|');
    for (const entry of log) {
      const t = new Date(entry.at).toISOString().slice(11, 19); // HH:MM:SS
      const icon = entry.stage ? (STAGE_ICONS[entry.stage] ?? '·') : '·';
      const stageLabel = entry.stage ? ` ${escapeMd(entry.stage)}` : '';
      lines.push(`| \`${t}\` | ${icon}${stageLabel} | ${escapeMd(entry.message)} |`);
    }
    lines.push('');
    lines.push('</details>');
  }

  // ── Completion note ──
  if (task.status === 'completed') {
    lines.push('');
    lines.push('> 📄 Final report updated in this comment.');
  }

  // ── Footer ──
  lines.push('');
  lines.push('<div align="center">');
  lines.push('');
  lines.push('<sub>Oops Code Review · Powered by <a href="https://adp.cloud.tencent.com/"><b>Tencent Cloud ADP</b></a></sub>');
  lines.push('');
  lines.push('</div>');

  return lines.join('\n');
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Lightweight Markdown escaping for user-supplied progress strings to
 * avoid breaking the rendered comment (e.g. accidental headings, lists,
 * or HTML tags from the agent).
 */
function escapeMd(s: string): string {
  return s
    .replace(/[<>]/g, (c) => (c === '<' ? '&lt;' : '&gt;'))
    .replace(/\r?\n/g, ' ');
}
