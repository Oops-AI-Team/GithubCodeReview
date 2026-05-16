/**
 * Compute HMAC-SHA256 of `payload` using `secret`, returning
 * `sha256=<hex-digest>` — the same format used by both GitHub
 * webhooks and ADP callback signatures.
 */
async function computeHmacSha256(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return `sha256=${Array.from(new Uint8Array(mac))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')}`;
}

/**
 * Timing-safe string comparison.
 * Returns true iff `a` and `b` are identical (constant-time).
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Verify GitHub Webhook signature using HMAC-SHA256.
 * Returns true if the signature is valid.
 */
export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Promise<boolean> {
  if (!signature) return false;
  const computed = await computeHmacSha256(payload, secret);
  return timingSafeEqual(computed, signature);
}

/**
 * Verify ADP callback/progress request signature.
 *
 * The ADP agent must include an `X-ADP-Signature-256` header containing
 * `sha256=<hex-HMAC-SHA256(requestBody, adpAppKey)>`. This function
 * recomputes the HMAC and does a timing-safe comparison.
 */
export async function verifyADPSignature(
  payload: string,
  signature: string,
  adpAppKey: string,
): Promise<boolean> {
  if (!signature) return false;
  const computed = await computeHmacSha256(payload, adpAppKey);
  return timingSafeEqual(computed, signature);
}
