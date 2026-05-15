import { Env, ReviewTask } from './types';
import { verifyWebhookSignature } from './verify';
import { getInstallationToken, postReview } from './github';
import { triggerADPReview } from './adp';
import { buildReviewPrompt, generateCorrelationId } from './prompt';

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

    // ADP callback endpoint — ADP calls this when review is complete
    if (url.pathname === '/api/adp/callback' && request.method === 'POST') {
      return handleADPCallback(request, env, ctx);
    }

    return new Response('Not Found', { status: 404 });
  },
};

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

          if (!installationId || !owner || !repo || !prNumber) {
            return new Response('Missing required fields', { status: 400 });
          }

          ctx.waitUntil(
            triggerReview(env, installationId, owner, repo, prNumber, prTitle, prDescription)
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
          const botName = env.GITHUB_APP_NAME ? `@${env.GITHUB_APP_NAME}` : '@oops-github-app';
          console.log(`botName="${botName}", commentBody="${commentBody}"`);

          if (!commentBody.toLowerCase().includes(botName.toLowerCase())) {
            return new Response('Not a bot mention', { status: 200 });
          }

          const installationId = payload.installation?.id;
          const owner = payload.repository?.owner?.login;
          const repo = payload.repository?.name;
          const prNumber = payload.issue?.number;
          const prTitle = payload.issue?.title ?? '';
          const prDescription = payload.issue?.body ?? '';

          if (!installationId || !owner || !repo || !prNumber) {
            return new Response('Missing required fields', { status: 400 });
          }

          ctx.waitUntil(
            triggerReview(env, installationId, owner, repo, prNumber, prTitle, prDescription)
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

// ─── ADP Callback Handler ───────────────────────────────────

async function handleADPCallback(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  let body: string;
  try {
    body = await request.text();
  } catch {
    return Response.json({ error: 'Failed to read request body' }, { status: 400 });
  }

  let data: { correlationId?: string; review?: string };
  try {
    data = JSON.parse(body);
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const { correlationId, review } = data;
  if (!correlationId || !review) {
    return Response.json({ error: 'Missing correlationId or review' }, { status: 400 });
  }

  // Load task context from KV
  const taskData = await env.TASKS_KV.get(`task:${correlationId}`, 'json') as ReviewTask | null;
  if (!taskData) {
    return Response.json({ error: 'Task not found' }, { status: 404 });
  }

  // Post review to GitHub in background
  ctx.waitUntil(
    (async () => {
      try {
        const token = await getInstallationToken(env, taskData.installationId);
        await postReview(token, taskData.owner, taskData.repo, taskData.prNumber, review);

        // Update task status
        taskData.status = 'completed';
        taskData.completedAt = Date.now();
        await env.TASKS_KV.put(`task:${correlationId}`, JSON.stringify(taskData));
      } catch (err) {
        console.error(`Failed to post review for ${taskData.owner}/${taskData.repo}#${taskData.prNumber}:`, err);

        taskData.status = 'failed';
        taskData.error = (err as Error).message;
        taskData.completedAt = Date.now();
        await env.TASKS_KV.put(`task:${correlationId}`, JSON.stringify(taskData));
      }
    })()
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
): Promise<void> {
  const correlationId = generateCorrelationId();
  const callbackUrl = `${env.CALLBACK_BASE_URL}/api/adp/callback`;

  // 1. Store task context in KV (needed when ADP callback arrives)
  const task: ReviewTask = {
    id: correlationId,
    installationId,
    owner,
    repo,
    prNumber,
    status: 'pending',
    createdAt: Date.now(),
  };
  await env.TASKS_KV.put(`task:${correlationId}`, JSON.stringify(task));

  // 2. Build prompt with repo info and callback URL
  const prompt = buildReviewPrompt(owner, repo, prNumber, prTitle, prDescription, callbackUrl);

  // 3. Trigger ADP agent (returns immediately, ADP will callback when done)
  await triggerADPReview(env, prompt, correlationId);
}
