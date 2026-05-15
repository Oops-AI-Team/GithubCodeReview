import { Env } from './types';

/**
 * Trigger ADP agent to start a code review.
 * Sets ConversationId = correlationId so the agent can use it as correlationId in callback.
 * This function returns immediately after confirming ADP received the request.
 */
export async function triggerADPReview(
  env: Env,
  prompt: string,
  correlationId: string,
): Promise<void> {
  const url = env.ADP_SSE_URL || 'https://wss.lke.cloud.tencent.com/adp/v2/chat';

  const requestBody = {
    RequestId: correlationId,
    ConversationId: correlationId,
    AppKey: env.ADP_APP_KEY,
    VisitorId: 'oops-github-app-bot',
    Contents: [{ Type: 'text', Text: prompt }],
    Stream: 'enable',
    Incremental: false,
  };

  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(requestBody),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`ADP trigger request failed: ${resp.status} ${text}`);
  }

  // Consume the body to free the connection.
  // ADP runs autonomously — it will callback via /api/adp/callback when done.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  await resp.text().catch(() => {});
}
