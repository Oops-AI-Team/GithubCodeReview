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

// ─── Issue Comment (used as live "progress" sticky comment) ──
//
// Issue comments and PR review comments are different beasts on GitHub:
//   - Issue comments live on the PR's conversation timeline; can be PATCHed.
//   - Review comments are tied to a diff hunk; we use those for the final
//     report via `postReview` above.
//
// We post ONE issue comment as a placeholder when review starts, then keep
// PATCHing it as the agent reports progress. PATCH replaces the entire body,
// so the caller is responsible for rendering the full comment text each time.

interface IssueCommentResponse {
  id: number;
  html_url: string;
}

export async function postIssueComment(
  token: string,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<{ id: number; htmlUrl: string }> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OopsGitHubApp',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to post issue comment: ${resp.status} ${text}`);
  }

  const data = (await resp.json()) as IssueCommentResponse;
  return { id: data.id, htmlUrl: data.html_url };
}

export async function updateIssueComment(
  token: string,
  owner: string,
  repo: string,
  commentId: number,
  body: string,
): Promise<void> {
  const resp = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OopsGitHubApp',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Failed to update issue comment ${commentId}: ${resp.status} ${text}`);
  }
}
