/**
 * Build the review prompt sent to the ADP agent.
 *
 * Mode: ADP agent autonomously clones the repository.
 *
 * The Worker mints a short-lived GitHub App installation token and passes it
 * to the agent via the prompt. The agent uses it to clone (works for both
 * public AND private repos covered by the installation), inspects the diff,
 * and POSTs the final Markdown review back to `callbackUrl`.
 *
 * Security notes (read carefully):
 *   - The token expires automatically in ~1 hour (GitHub-enforced).
 *   - The token is scoped to this installation's repositories only.
 *   - Do NOT log this token anywhere; do NOT store it in KV.
 *   - The agent must NOT echo the token back in the review body.
 */
export function buildReviewPrompt(
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  prDescription: string,
  installationToken: string,
  callbackUrl: string,
  conversationId: string,
): string {
  // Authenticated clone URL format accepted by GitHub:
  //   https://x-access-token:<TOKEN>@github.com/<owner>/<repo>.git
  const cloneUrl = `https://x-access-token:${installationToken}@github.com/${owner}/${repo}.git`;

  return `你是一个专业的代码审查助手。请自主完成下列 GitHub Pull Request 的全面代码审查。

## 任务信息
- **仓库**: ${owner}/${repo}
- **PR #${prNumber}**: ${prTitle}
- **描述**: ${prDescription || '(无描述)'}

## 拉取仓库（必须使用提供的 token，否则私有仓库会 401）
请使用以下带 token 的 HTTPS 地址进行 clone（token 已嵌入 URL，有效期约 1 小时）：

\`\`\`bash
git clone ${cloneUrl}
cd ${repo}
git fetch origin pull/${prNumber}/head:pr-${prNumber}
git checkout pr-${prNumber}
git diff origin/HEAD...pr-${prNumber}
\`\`\`

也可以直接调用 GitHub API 获取 diff（推荐，更快）：

\`\`\`bash
curl -H "Authorization: Bearer ${installationToken}" \\
     -H "Accept: application/vnd.github.v3.diff" \\
     -H "User-Agent: ADP-CodeReview-Bot" \\
     https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}
\`\`\`

**安全要求**：
- 严禁在审查报告中回显、打印或泄露上述 token。
- 严禁将 token 写入任何持久化文件或上传到第三方服务。
- 仅将 token 用于本次 clone / API 调用。

## 审查维度
- **安全漏洞** — SQL 注入、XSS、硬编码密钥、不安全的加密、SSRF、路径穿越等
- **逻辑错误与 Bug** — 竞态条件、空指针解引用、边界错误、错误的并发处理
- **代码质量** — 命名规范、重复代码、可读性、不必要的复杂度
- **性能问题** — 低效算法、N+1 查询、不必要的内存分配
- **最佳实践** — 错误处理、类型安全、测试覆盖建议

## 输出要求
审查完成后，请将最终报告以 POST 请求发送到以下回调地址：

**回调 URL**: ${callbackUrl}
**请求方法**: POST
**请求头**: Content-Type: application/json
**请求体格式**（\`correlationId\` 必须严格等于下方给定值）:

\`\`\`json
{
  "correlationId": "${conversationId}",
  "review": "<完整的 Markdown 格式审查报告>"
}
\`\`\`

报告需引用具体文件名与行号区间，建议具体且有建设性。如果代码无明显问题，请简要说明并给出潜在改进建议。`;
}
