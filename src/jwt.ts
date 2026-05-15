import { Env } from "./types";

/**
 * RSA-SHA256 sign using WebCrypto API (Cloudflare Workers compatible).
 * Returns base64url-encoded signature.
 */
async function rsaSha256Sign(
  payload: string,
  privateKeyPem: string
): Promise<string> {
  const pemBody = privateKeyPem
    .replace(/-----BEGIN.*?-----/g, "")
    .replace(/-----END.*?-----/g, "")
    .replace(/\s/g, "");

  const binaryStr = atob(pemBody);
  const binaryDer = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    binaryDer[i] = binaryStr.charCodeAt(i);
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    binaryDer.buffer,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(payload)
  );

  return base64urlEncode(signature);
}

function base64urlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Normalize the GITHUB_PRIVATE_KEY secret into a PEM string.
 *
 * Accepted input formats (we try them in order):
 *   1. Raw PEM with real newlines (paste-from-file style).
 *   2. Raw PEM with literal "\n" sequences (common when stored in env vars).
 *   3. Single-line base64 of the entire PEM file (legacy format).
 *
 * Never call atob() blindly — PEM contains "-----BEGIN..." and newlines
 * which are NOT valid base64 and will throw InvalidCharacterError.
 */
function normalizePrivateKey(raw: string): string {
  if (!raw) throw new Error("GITHUB_PRIVATE_KEY is empty");

  // Case 1 & 2: looks like a PEM already.
  if (raw.includes("-----BEGIN")) {
    // Convert literal "\n" → real newlines (in case it was stored that way).
    return raw.replace(/\\n/g, "\n");
  }

  // Case 3: assume single-line base64 of the PEM file.
  try {
    const decoded = atob(raw.replace(/\s+/g, ""));
    if (decoded.includes("-----BEGIN")) return decoded;
  } catch {
    // fall through
  }

  throw new Error(
    "GITHUB_PRIVATE_KEY format not recognized. Expected PEM (-----BEGIN ...-----) or base64-encoded PEM.",
  );
}

/**
 * Generate a GitHub App JWT (valid for max 10 minutes).
 * Uses RS256 signing via WebCrypto.
 */
export async function generateJWT(env: Env): Promise<string> {
  const privateKey = normalizePrivateKey(env.GITHUB_PRIVATE_KEY);
  const now = Math.floor(Date.now() / 1000);

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: env.GITHUB_APP_ID, iat: now - 60, exp: now + 10 * 60 };

  const headerBuf = new TextEncoder().encode(JSON.stringify(header));
  const payloadBuf = new TextEncoder().encode(JSON.stringify(payload));
  const encodedHeader = base64urlEncode(headerBuf.buffer as ArrayBuffer);
  const encodedPayload = base64urlEncode(payloadBuf.buffer as ArrayBuffer);

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await rsaSha256Sign(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}
