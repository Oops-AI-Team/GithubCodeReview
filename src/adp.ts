import { Env } from './types';

/**
 * Trigger ADP agent to start a code review.
 * ADP will autonomously clone the repo, review the PR, and call back with results.
 * This function returns immediately — it does NOT wait for ADP to finish.
 */
export async function triggerADPReview(
  env: Env,
  prompt: string,
  correlationId: string,
  callbackUrl: string,
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
    // Pass callback info so ADP agent knows where to send the final report
    CallbackUrl: callbackUrl,
    CorrelationId: correlationId,
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

  // We don't need to parse the SSE stream — ADP will callback when done.
  // Just consume the body to avoid leaking the connection.
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  await resp.text().catch(() => {});
}
