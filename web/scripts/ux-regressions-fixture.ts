/** Additional synthetic history for the real browser/API regression, never a personal ledger. */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export async function addUxRegressionHistory(home: string) {
  const cwd = join(home, "work", "ux-regression");
  await mkdir(join(cwd, ".git"), { recursive: true });
  const now = Date.now();
  const rows = Array.from({ length: 21 }, (_, index) => {
    const daysAgo = 20 - index;
    const inputTokens = daysAgo === 10 ? 10_000_000 : 10_000 + index * 1000;
    return { requestId: `ux-regression-${index}`, timestamp: now - daysAgo * 86_400_000 - 3_600_000,
      cwd, conversationId: "ux-regression-session", inboundProtocol: "responses", provider: "openai", model: "gpt-6-luna",
      effectiveEffort: "medium", status: 200, usageStatus: "reported", cacheProvenance: "observed",
      routeDecision: { routeKind: "native" },
      usage: { inputTokens, outputTokens: 1000, cacheReadInputTokens: 1000, cacheCreationInputTokens: 0, reasoningOutputTokens: 300, totalTokens: inputTokens + 1000 } };
  });
  await appendFile(join(home, "usage.jsonl"), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}
