export interface Env {
  // Secrets (set via Cloudflare Dashboard or `wrangler secret put`)
  GITHUB_PRIVATE_KEY: string; // base64-encoded RSA PEM
  GITHUB_WEBHOOK_SECRET: string;
  ADP_APP_KEY: string; // ADP 应用 AppKey

  // Vars (set via Cloudflare Dashboard)
  GITHUB_APP_ID: string;
  GITHUB_APP_NAME: string; // bot mention name, e.g. "oops-github-app"
  ADP_SSE_URL: string; // default: https://wss.lke.cloud.tencent.com/adp/v2/chat
  CALLBACK_BASE_URL: string; // e.g. https://oops-app.denox.cc

  // KV namespace for async task context
  TASKS_KV: KVNamespace;
}

/** Review task context stored in KV, used when ADP callback arrives */
export interface ReviewTask {
  id: string; // correlation_id
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  status: 'pending' | 'completed' | 'failed';
  createdAt: number;
  completedAt?: number;
  error?: string;
}
