/**
 * Build the *runtime* portion of the prompt sent to the ADP agent.
 *
 * The agent's behavior — task goals, the 5-step SOP (PLAN / FETCH / ANALYZE
 * / SUMMARIZE / CALLBACK), the progress and callback URL contracts, and the
 * safety rules — lives in the **ADP system prompt** (see
 * `ADP-Claw-Prompt.md`). That stuff is identical for every PR, so we don't
 * waste tokens repeating it on each request.
 *
 * What this function returns is *only* the things that change per-PR:
 *   - which repo and PR
 *   - the short-lived GitHub installation token used to fetch code
 *   - this run's ConversationId, which the agent must echo as
 *     `correlationId` in every progress + callback request
 *
 * Security:
 *   - The token expires automatically in ~1 hour (GitHub-enforced).
 *   - The token is scoped to this installation's repositories only.
 *   - Do NOT log the returned string anywhere; do NOT store it in KV.
 *   - The system prompt explicitly forbids the agent from echoing the token
 *     in any progress / callback / report.
 */
export function buildReviewPrompt(
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  prDescription: string,
  installationToken: string,
  conversationId: string,
  adpAppKey: string,
  userComment?: string,
): string {
  // Authenticated clone URL accepted by GitHub:
  //   https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git
  const cloneUrl = `https://x-access-token:${installationToken}@github.com/${owner}/${repo}.git`;

  const commentSection = userComment
    ? `\n## 用户指定关注点\n用户在触发本次审查时附带了以下问题/要求，请在 ANALYZE 和 SUMMARIZE 阶段重点针对此内容作出回答：\n\n> ${userComment.replace(/\n/g, '\n> ')}\n`
    : '';

  return `# 本次审查任务上下文

请严格按系统提示中的 5 步 SOP（PLAN → FETCH → ANALYZE → SUMMARIZE → CALLBACK）执行，每一步先调用进度接口再开展工作。
${commentSection}
## 仓库与 PR
- **仓库**：${owner}/${repo}
- **PR #${prNumber}**：${prTitle}
- **描述**：${prDescription || '(无描述)'}

## 会话 ID（在所有进度与最终回调中作为 \`correlationId\` 原样回传）
\`\`\`
${conversationId}
\`\`\`

## 签名密钥（用于对进度与回调请求签名）
所有对 /api/adp/progress 和 /api/adp/callback 的请求必须携带 X-ADP-Signature-256 请求头，值为 sha256=<HMAC-SHA256(requestBody, ADP_APP_KEY) 的 hex 编码>。
${'```'}
ADP_APP_KEY = ${adpAppKey}
${'```'}

## 获取代码（任选其一，推荐方式 A）

**方式 A — 直接通过 GitHub API 拿 diff（更快，多数审查场景够用）**：
\`\`\`bash
curl -H "Authorization: Bearer ${installationToken}" \\
     -H "Accept: application/vnd.github.v3.diff" \\
     -H "User-Agent: ADP-CodeReview-Bot" \\
     https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}
\`\`\`

**方式 B — 完整 clone（需要看完整文件上下文时使用）**：
\`\`\`bash
git clone ${cloneUrl}
cd ${repo}
git fetch origin pull/${prNumber}/head:pr-${prNumber}
git checkout pr-${prNumber}
git diff origin/HEAD...pr-${prNumber}
\`\`\`

> 安全提示：上面的 token 仅用于本次代码获取，**严禁**写入进度消息、最终报告、日志或任何外部服务。`;
}
