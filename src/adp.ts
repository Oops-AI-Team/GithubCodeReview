import { Env } from './types';

/**
 * Encode owner/repo/prNumber into a valid ConversationId (32-64 chars, ^[a-zA-Z0-9_-]+$).
 * - Same (owner, repo, prNumber) MUST always produce the same id (so PR conversation context is preserved).
 * - Different PRs MUST produce different ids (no truncation collisions).
 *
 * Strategy:
 *   - Build a sanitized prefix `pr_{owner}_{repo}_{prNumber}_`
 *   - Append a deterministic SHA-256-based suffix derived from the raw key
 *   - Trim/pad the prefix so the total length lands in [32, 64]
 */
async function encodeConversationId(owner: string, repo: string, prNumber: number): Promise<string> {
  const rawKey = `${owner}/${repo}/${prNumber}`;
  const sanitized = `pr_${owner}_${repo}_${prNumber}`.replace(/[^a-zA-Z0-9_-]/g, '_');

  // 16-char hex hash → ensures uniqueness even when prefix gets trimmed
  const hashBuf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawKey));
  const hashHex = Array.from(new Uint8Array(hashBuf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16);

  // Reserve room for "_" + hashHex(16) at the end → 17 chars
  // Total budget: 32..64 → prefix budget: 15..47
  const suffix = `_${hashHex}`;
  const maxPrefix = 64 - suffix.length; // 48
  const minPrefix = 32 - suffix.length; // 15

  let prefix = sanitized;
  if (prefix.length > maxPrefix) prefix = prefix.slice(0, maxPrefix);
  if (prefix.length < minPrefix) prefix = prefix + '_'.repeat(minPrefix - prefix.length);

  const id = prefix + suffix;
  // Final safety check (should always pass)
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
 * ConversationId is PR-based (encoded from owner/repo/prNumber) so same PR shares conversation context.
 * VisitorId uses the PR author name for context.
 * This function returns immediately after confirming ADP received the request.
 */
export async function triggerADPReview(
  env: Env,
  prompt: string,
  owner: string,
  repo: string,
  prNumber: number,
  prAuthor: string,
): Promise<string> {
  const url = env.ADP_SSE_URL || 'https://wss.lke.cloud.tencent.com/adp/v2/chat';
  const conversationId = await encodeConversationId(owner, repo, prNumber);
  const requestId = generateRequestId(conversationId);

  const requestBody = {
    RequestId: requestId,
    ConversationId: conversationId,
    AppKey: env.ADP_APP_KEY,
    VisitorId: prAuthor,
    Contents: [{ Type: 'text', Text: prompt }],
    Stream: 'enable',
    Incremental: false,
  };

  console.log(`ADP request: ConversationId=${conversationId}, RequestId=${requestId}, VisitorId=${prAuthor}`);

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

  // Return conversationId so caller can use it as KV key
  return conversationId;
}
