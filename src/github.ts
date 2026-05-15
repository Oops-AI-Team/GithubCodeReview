import { Env } from './types';
import { generateJWT } from './jwt';

// ─── Installation Token ──────────────────────────────────────

interface TokenResponse {
  token: string;
  expires_at: string;
}

export async function getInstallationToken(env: Env, installationId: number): Promise<string> {
  const jwt = await generateJWT(env);

  const resp = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OopsGitHubApp',
      },
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to get installation token: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as TokenResponse;
  return data.token;
}

// ─── Fetch PR Diff ───────────────────────────────────────────

export async function fetchPRDiff(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3.diff',
        'User-Agent': 'OopsGitHubApp',
      },
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to fetch PR diff: ${resp.status} ${text}`);
  }

  return resp.text();
}

// ─── Post Review Comment ─────────────────────────────────────

export async function postReview(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OopsGitHubApp',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body, event: 'COMMENT' }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to post review: ${resp.status} ${text}`);
  }
}
