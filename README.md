# Oops GitHub App

自建 GitHub App 实现 CodeRabbit 式代码审查，后端部署在 Cloudflare Workers，LLM 审查由腾讯云 ADP 智能体自主完成。

## 架构

```
GitHub Webhook → Worker (验签/存上下文/触发ADP)
                        │
                        ↓
                   ADP 智能体自主运行
                   (下载仓库 → Review → 生成报告)
                        │
                        ↓
                   ADP 回调 Worker (/api/adp/callback)
                        │
                        ↓
                   Worker 发 GitHub Review Comment
```

## 核心流程

1. **GitHub Webhook** — 接收 `pull_request` (opened/synchronize) 和 `issue_comment` (@mention)
2. **存上下文到 KV** — 将 installation_id、owner、repo、pr_number 存入 KV，key 为 correlation_id
3. **触发 ADP** — 发送 prompt（含仓库信息和回调地址），ADP 自主下载仓库并 review
4. **ADP 回调** — ADP 完成后 POST 最终报告到 `/api/adp/callback`
5. **发 Review** — Worker 从 KV 取出上下文，用 Installation Token 发 GitHub Review

## API 端点

| 路径 | 方法 | 说明 |
|------|------|------|
| `/` | GET | 健康检查 |
| `/api/webhook` | POST | GitHub Webhook 回调 |
| `/api/adp/callback` | POST | ADP 审查完成回调 |

## ADP 回调格式

ADP 审查完成后 POST 到 `/api/adp/callback`：

```json
{
  "correlationId": "abc123def456...",
  "review": "## 代码审查报告\n\n### 安全漏洞\n..."
}
```

## 部署步骤

### 1. 安装依赖

```bash
npm install
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create TASKS_KV
```

将输出的 `id` 填入 `wrangler.toml` 中的 `[[kv_namespaces]]` 配置。

### 3. 配置环境变量

所有变量通过 Cloudflare Dashboard > Workers > Settings > Variables 配置：

| 变量 | 说明 |
|------|------|
| `GITHUB_APP_ID` | GitHub App ID（数字） |
| `GITHUB_APP_NAME` | Bot 名称，用于 @mention 匹配 |
| `ADP_SSE_URL` | ADP SSE 接口地址（默认 `https://wss.lke.cloud.tencent.com/adp/v2/chat`） |
| `CALLBACK_BASE_URL` | Worker 公网地址（如 `https://oops-app.denox.cc`） |

### 4. 设置 Secrets

```bash
# GitHub App RSA 私钥（base64 编码）
# PowerShell: [Convert]::ToBase64String([IO.File]::ReadAllBytes("private-key.pem"))
npx wrangler secret put GITHUB_PRIVATE_KEY

# GitHub Webhook Secret
npx wrangler secret put GITHUB_WEBHOOK_SECRET

# ADP 应用 AppKey
npx wrangler secret put ADP_APP_KEY
```

### 5. 本地开发

```bash
npm run dev
```

使用 smee.io 或 ngrok 转发 Webhook 到本地：

```bash
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:8787/api/webhook
```

### 6. 部署

```bash
npm run deploy
```

部署后将 Worker URL 配置到 GitHub App 的 Webhook URL。

## GitHub App 配置

在 [GitHub App 设置页](https://github.com/settings/apps/new) 创建 App，关键配置：

**权限：**
- Pull requests: Read & Write
- Contents: Read
- Issues: Read & Write
- Metadata: Read

**Webhook 事件：**
- `pull_request`
- `issue_comment`

## 项目结构

```
src/
├── types.ts      # 类型定义 (Env, ReviewTask)
├── jwt.ts        # JWT 生成 (WebCrypto RS256)
├── verify.ts     # Webhook 签名验证 (HMAC-SHA256)
├── github.ts     # GitHub API (Installation Token, Review)
├── adp.ts        # ADP 触发（异步，不等结果）
├── prompt.ts     # Prompt 构建（含仓库信息和回调地址）
└── index.ts      # 主入口（Webhook + ADP 回调）
```
