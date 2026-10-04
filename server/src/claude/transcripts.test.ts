import { expect, test } from "bun:test";
import { normalizeRow } from "../ocx/store";
import { collectEntries } from "./transcripts";

const usage = {
  input_tokens: 2,
  cache_creation_input_tokens: 2375,
  cache_read_input_tokens: 63268,
  output_tokens: 168,
  output_tokens_details: { thinking_tokens: 40 },
  service_tier: "standard",
};
const block = (content: string) => JSON.stringify({
  type: "assistant",
  requestId: "req_1",
  sessionId: "sess-1",
  timestamp: "2026-10-04T16:44:49.068Z",
  message: { id: "msg_1", model: "claude-opus-5-5", stop_reason: "tool_use", usage, content: [{ type: content }] },
});

test("Claude Code transcript lines normalize to the same RequestRow shape as ocx rows", () => {
  const transcript = [
    JSON.stringify({ type: "user", message: { content: "hi" } }),
    block("thinking"),
    block("tool_use"),
    JSON.stringify({ type: "assistant", requestId: "req_2", timestamp: "2026-10-04T16:45:00Z", message: { model: "<synthetic>", usage } }),
    "{\"type\":\"assistant\",\"torn",
  ].join("\n");

  const entries = collectEntries([transcript, transcript]);
  expect(entries).toHaveLength(1);
  const row = normalizeRow(entries[0]!);

  // An ocx row carrying the same request, in ocx's own usage vocabulary.
  const ocxRow = normalizeRow({
    requestId: "req_1",
    timestamp: Date.parse("2026-10-04T16:44:49.068Z"),
    provider: "anthropic",
    model: "claude-opus-5-5",
    conversationId: "sess-1",
    status: 200,
    usageStatus: "reported",
    usage: {
      inputTokens: 65645,
      outputTokens: 168,
      cacheReadInputTokens: 63268,
      cacheCreationInputTokens: 2375,
      reasoningOutputTokens: 40,
    },
  });

  expect(Object.keys(row).sort()).toEqual(Object.keys(ocxRow).sort());
  for (const key of ["id", "ts", "provider", "model", "conversationId", "ok", "inputTokens", "outputTokens",
    "cacheReadTokens", "cacheWriteTokens", "reasoningTokens", "totalTokens", "usageStatus"] as const) {
    expect(row[key]).toEqual(ocxRow[key]);
  }
  expect(row.serviceTier).toBe("standard");
  expect(row.closeReason).toBe("tool_use");
});
