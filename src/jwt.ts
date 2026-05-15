import { Env } from "./types";

/**
 * RSA-SHA256 sign using WebCrypto API (Cloudflare Workers compatible).
 * Returns base64url-encoded signature.
 *
 * GitHub Apps download keys in PKCS#1 format ("-----BEGIN RSA PRIVATE KEY-----"),
 * but WebCrypto only accepts PKCS#8 ("-----BEGIN PRIVATE KEY-----"). We detect
 * PKCS#1 and wrap it into PKCS#8 in-memory before importing.
 */
async function rsaSha256Sign(
  payload: string,
  privateKeyPem: string
): Promise<string> {
  const isPkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(privateKeyPem);

  const pemBody = privateKeyPem
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "");

  const binaryStr = atob(pemBody);
  let der: Uint8Array<ArrayBuffer> = new Uint8Array(new ArrayBuffer(binaryStr.length));
  for (let i = 0; i < binaryStr.length; i++) {
    der[i] = binaryStr.charCodeAt(i);
  }

  if (isPkcs1) {
    der = pkcs1ToPkcs8(der);
  }

  const key = await crypto.subtle.importKey(
    "pkcs8",
    der.buffer as ArrayBuffer,
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

/**
 * Wrap a PKCS#1 RSAPrivateKey blob into a PKCS#8 PrivateKeyInfo blob.
 *
 * PKCS#8 structure (DER):
 *   SEQUENCE {
 *     INTEGER 0,                                // version
 *     SEQUENCE {                                // AlgorithmIdentifier
 *       OID 1.2.840.113549.1.1.1 (rsaEncryption),
 *       NULL
 *     },
 *     OCTET STRING { <pkcs1 RSAPrivateKey DER> }
 *   }
 *
 * The AlgorithmIdentifier prefix is a fixed byte sequence; we just need to
 * compute the outer SEQUENCE / OCTET STRING lengths.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  // Fixed prefix: version(0) + AlgorithmIdentifier(rsaEncryption, NULL).
  const algIdentifier = new Uint8Array([
    0x02, 0x01, 0x00, // INTEGER 0 (version)
    0x30, 0x0d,       // SEQUENCE (13 bytes)
    0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, // OID rsaEncryption
    0x05, 0x00,       // NULL
  ]);

  const octetStringHeader = encodeAsn1Length(pkcs1.length);
  const octetStringTotal = 1 /*tag*/ + octetStringHeader.length + pkcs1.length;

  const innerLen = algIdentifier.length + octetStringTotal;
  const outerHeader = encodeAsn1Length(innerLen);

  const out = new Uint8Array(new ArrayBuffer(1 /*outer SEQUENCE tag*/ + outerHeader.length + innerLen));
  let off = 0;
  out[off++] = 0x30; // SEQUENCE
  out.set(outerHeader, off); off += outerHeader.length;
  out.set(algIdentifier, off); off += algIdentifier.length;
  out[off++] = 0x04; // OCTET STRING
  out.set(octetStringHeader, off); off += octetStringHeader.length;
  out.set(pkcs1, off);
  return out;
}

/** Encode an ASN.1 DER length (short form for <128, long form otherwise). */
function encodeAsn1Length(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
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

  // GitHub requires `iss` to be an INTEGER (the App ID).
  // Cloudflare secrets/vars come in as strings, so coerce explicitly —
  // a string `"iss":"123"` is rejected with "Bad credentials".
  const appId = Number(env.GITHUB_APP_ID);
  if (!Number.isInteger(appId) || appId <= 0) {
    throw new Error(
      `GITHUB_APP_ID must be a positive integer, got: ${JSON.stringify(env.GITHUB_APP_ID)}`,
    );
  }

  const header = { alg: "RS256", typ: "JWT" };
  const payload = { iss: appId, iat: now - 60, exp: now + 10 * 60 };

  const headerBuf = new TextEncoder().encode(JSON.stringify(header));
  const payloadBuf = new TextEncoder().encode(JSON.stringify(payload));
  const encodedHeader = base64urlEncode(headerBuf.buffer as ArrayBuffer);
  const encodedPayload = base64urlEncode(payloadBuf.buffer as ArrayBuffer);

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await rsaSha256Sign(signingInput, privateKey);

  return `${signingInput}.${signature}`;
}
