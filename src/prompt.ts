import { Env } from './types';

/**
 * Build the review prompt sent to ADP agent.
 * The agent will autonomously clone the repo and review the PR,
 * then call back with the final review report.
 *
 * Note: correlationId is passed as ADP API's ConversationId parameter,
 * the agent should use its own ConversationId as the correlationId in the callback.
 */
export function buildReviewPrompt(
  owner: string,
  repo: string,
  prNumber: number,
  prTitle: string,
  prDescription: string,
  callbackUrl: string,
): string {
  return `你是一个专业的代码审查助手。请对以下 GitHub Pull Request 进行全面代码审查。

## 任务信息
- **仓库**: ${owner}/${repo}
- **PR #${prNumber}**: ${prTitle}
- **描述**: ${prDescription || '(无描述)'}

## 审查步骤
1. 克隆仓库 \`${owner}/${repo}\`，切换到 PR #${prNumber} 的分支
2. 阅读变更的文件和 diff
3. 从以下维度进行审查：
   - **安全漏洞** — SQL 注入、XSS、硬编码密钥、不安全的加密等
   - **逻辑错误与 Bug** — 竞态条件、空指针解引用、边界错误
   - **代码质量** — 命名规范、代码重复、可读性
   - **性能问题** — 低效算法、不必要的内存分配、N+1 查询
   - **最佳实践** — 错误处理、类型安全、测试建议

## 输出要求
审查完成后，请将最终报告以 POST 请求发送到以下回调地址：

**回调 URL**: ${callbackUrl}
**请求方法**: POST
**请求头**: Content-Type: application/json
**请求体格式**:
\`\`\`json
{
  "correlationId": "<你的ConversationId>",
  "review": "这里是完整的 Markdown 格式审查报告"
}
\`\`\`

请确保引用具体的文件名和行范围，要具体且有建设性。如果代码看起来没有问题，请简要说明。`;
}

/**
 * Generate a correlation ID for ADP ConversationId.
 * ADP requires 32-64 chars matching ^[a-zA-Z0-9_-]{32,64}$
 */
export function generateCorrelationId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
