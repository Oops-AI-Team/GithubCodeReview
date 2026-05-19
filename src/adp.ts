import { Env } from './types';

/**
 * Generate a unique ConversationId for each review run (32-64 chars, ^[a-zA-Z0-9_-]+$).
 *
 * Each review gets its own ConversationId so that ADP always starts a fresh
 * conversation — re-triggering a review on the same PR must NOT reuse the
 * existing ADP conversation (the agent would skip re-analysis otherwise).
 *
 * Strategy:
 *   - Build a sanitized prefix `pr_{owner}_{repo}_{prNumber}_`
 *   - Append a random hex suffix (crypto.randomUUID) for uniqueness
 *   - Trim/pad the prefix so the total length lands in [32, 64]
 */
function generateConversationId(owner: string, repo: string, prNumber: number): string {
  const sanitized = `pr_${owner}_${repo}_${prNumber}`.replace(/[^a-zA-Z0-9_-]/g, '_');
  // 16-char random hex for per-run uniqueness
  const randomHex = crypto.randomUUID().replace(/-/g, '').slice(0, 16);

  const suffix = `_${randomHex}`;
  const maxPrefix = 64 - suffix.length; // 48
  const minPrefix = 32 - suffix.length; // 15

  let prefix = sanitized;
  if (prefix.length > maxPrefix) prefix = prefix.slice(0, maxPrefix);
  if (prefix.length < minPrefix) prefix = prefix + '_'.repeat(minPrefix - prefix.length);

  const id = prefix + suffix;
  if (!/^[a-zA-Z0-9_-]{32,64}$/.test(id)) {
    throw new Error(`Generated ConversationId is invalid: ${id}`);
  }
  return id;
}

/**
 * Generate a RequestId (32-64 chars, ^[a-zA-Z0-9_-]+$).
 */
function generateRequestId(conversationId: string): string {
  const uuid = crypto.randomUUID().replace(/-/g, '');
  return `${conversationId.slice(0, 8)}_${uuid}`;
}

/**
 * Trigger ADP agent to start a code review.
 *
 * `promptBuilder` receives the resolved ConversationId so the prompt can
 * embed it (the agent must echo it back as `correlationId` in the callback).
 *
 * Each review gets a unique ConversationId so ADP always starts a fresh
 * conversation — re-triggering a review on the same PR must NOT reuse the
 * existing ADP conversation.
 *
 * Returns `{ conversationId, requestId, promise }` synchronously so the caller
 * can persist the task to KV *before* awaiting the ADP HTTP call. This avoids
 * a race where progress/callback arrives before the task exists in KV.
 *
 * NOTE: the prompt may contain a short-lived GitHub installation token —
 * keep logging minimal and do NOT log the prompt body.
 */
export function triggerADPReview(
  env: Env,
  promptBuilder: (conversationId: string) => string,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthor: string,
): { conversationId: string; requestId: string; promise: Promise<void> } {
  const url = env.ADP_SSE_URL || 'https://wss.lke.cloud.tencent.com/adp/v2/chat';
  const conversationId = generateConversationId(owner, repo, prNumber);
  const requestId = generateRequestId(conversationId);
  const prompt = promptBuilder(conversationId);

  const requestBody = {
    RequestId: requestId,
    ConversationId: conversationId,
    AppKey: env.ADP_APP_KEY,
    VisitorId: prAuthor,
    Contents: [{ Type: 'text', Text: prompt }],
    Stream: 'enable',
    Incremental: false,
  };

  // Log only metadata; never log `prompt` (contains a short-lived token).
  console.log(
    `ADP request: ConversationId=${conversationId}, RequestId=${requestId}, VisitorId=${prAuthor}, promptLen=${prompt.length}`,
  );

  const promise = (async (): Promise<void> => {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`ADP trigger request failed: ${resp.status} ${text}`);
    }

    // Must drain the SSE stream to keep the connection alive for the full
    // agent session. If we return without reading, Cloudflare Workers GCs the
    // fetch connection and ADP cancels the in-flight task — causing the
    // placeholder comment to stay stuck at "Reviewing this PR…" forever.
    if (resp.body) {
      const reader = resp.body.getReader();
      try {
        while (true) {
          const { done } = await reader.read();
          if (done) break;
        }
      } finally {
        reader.releaseLock();
      }
    }
  })();

  return { conversationId, requestId, promise };
}
