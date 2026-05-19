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
 * Derive the ADP WebSocket base URL from the HTTP trigger URL.
 * e.g. https://wss.lke.cloud.tencent.com/adp/v2/chat
 *   -> https://wss.lke.cloud.tencent.com/adp/v2/chat/conn
 */
function wsBaseUrl(triggerUrl: string): string {
  return triggerUrl.replace(/\/+$/, '') + '/conn';
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
): { conversationId: string; requestId: string; promise: Promise<{ recordId?: string }> } {
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

  const promise = (async (): Promise<{ recordId?: string }> => {
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
    //
    // We also parse the first response.created event to extract the RecordId,
    // which is needed later to send stop_generation via WebSocket.
    let recordId: string | undefined;
    if (resp.body) {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!recordId && value) {
            // Each SSE chunk may contain one or more "data: {...}" lines.
            const text = decoder.decode(value, { stream: true });
            for (const line of text.split('\n')) {
              if (!line.startsWith('data:')) continue;
              try {
                const json = JSON.parse(line.slice(5).trim()) as {
                  Type?: string;
                  Response?: { RecordId?: string };
                };
                if (json.Type === 'response.created' && json.Response?.RecordId) {
                  recordId = json.Response.RecordId;
                }
              } catch {
                // non-JSON SSE comment or keep-alive — ignore
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    return { recordId };
  })();

  return { conversationId, requestId, promise };
}

/**
 * Send a stop_generation signal to ADP via Socket.IO (polling transport).
 *
 * ADP's WebSocket endpoint uses Socket.IO v4 (EIO=4). We use the HTTP
 * long-polling fallback which is fully compatible with Cloudflare Workers
 * (no native WebSocket client needed):
 *
 *   1. GET  .../conn/?EIO=4&transport=polling          → handshake, get sid
 *   2. POST .../conn/?EIO=4&transport=polling&sid=...  → send "40" (connect)
 *   3. POST .../conn/?EIO=4&transport=polling&sid=...  → send stop_generation
 *   4. Done — no need to poll for response.
 *
 * This is best-effort: ADP may already be done by the time we call this,
 * or the session may have expired. Errors are logged but not re-thrown.
 */
export async function stopADPReview(
  env: Env,
  conversationId: string,
  recordId: string,
): Promise<void> {
  const triggerUrl = env.ADP_SSE_URL || 'https://wss.lke.cloud.tencent.com/adp/v2/chat';
  const base = wsBaseUrl(triggerUrl);
  const eio = 'EIO=4&transport=polling';

  // ── Step 1: Socket.IO handshake ──────────────────────────────
  let sid: string;
  try {
    const handshake = await fetch(`${base}/?${eio}`, { method: 'GET' });
    if (!handshake.ok) {
      console.warn(`stopADPReview: handshake failed ${handshake.status}`);
      return;
    }
    const text = await handshake.text();
    // Socket.IO polling response: "96:{...json...}"  (length-prefixed)
    const jsonStart = text.indexOf('{');
    const parsed = JSON.parse(text.slice(jsonStart)) as { sid?: string };
    if (!parsed.sid) {
      console.warn(`stopADPReview: no sid in handshake response`);
      return;
    }
    sid = parsed.sid;
  } catch (err) {
    console.warn(`stopADPReview: handshake error`, err);
    return;
  }

  const pollUrl = `${base}/?${eio}&sid=${sid}`;

  // ── Step 2: Send Socket.IO connect packet "40" ───────────────
  try {
    await fetch(pollUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: '40',
    });
  } catch (err) {
    console.warn(`stopADPReview: connect packet error`, err);
    return;
  }

  // ── Step 3: Send stop_generation ─────────────────────────────
  // Socket.IO message packet: "42" + JSON payload
  const stopPayload = JSON.stringify([
    'stop_generation',
    { StopGeneration: { RecordId: recordId } },
  ]);

  try {
    const stopResp = await fetch(pollUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: `42${stopPayload}`,
    });
    console.log(
      `stopADPReview: sent stop_generation for ConversationId=${conversationId} RecordId=${recordId}, status=${stopResp.status}`,
    );
  } catch (err) {
    console.warn(`stopADPReview: stop_generation send error`, err);
  }
}

