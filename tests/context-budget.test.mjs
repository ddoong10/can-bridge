import { test } from "node:test";
import assert from "node:assert/strict";

import { applyContextBudget } from "../dist/transform/budget.js";
import { buildPackage } from "../dist/share/share.js";
import { packageToContext } from "../dist/share/import.js";

function compactLine(timestamp = "2026-06-03T00:01:00.000Z") {
  return JSON.stringify({
    timestamp,
    type: "compacted",
    payload: { message: "Earlier work was compacted." },
  });
}

function sampleContext() {
  return {
    schemaVersion: "0.1",
    source: {
      tool: "codex",
      sessionId: "source-session",
      cwd: "C:/repo",
      capturedAt: "2026-06-03T00:00:00.000Z",
      model: "gpt-test",
    },
    messages: [
      {
        role: "user",
        timestamp: "2026-06-03T00:00:30.000Z",
        content: [{ type: "text", text: "old request" }],
      },
      {
        role: "assistant",
        timestamp: "2026-06-03T00:02:00.000Z",
        content: [
          { type: "tool_use", id: "call_1", name: "shell_command", input: {} },
        ],
      },
      {
        role: "user",
        timestamp: "2026-06-03T00:02:01.000Z",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_1",
            output: "A".repeat(120) + "TAIL",
          },
        ],
      },
    ],
    raw: {
      tool: "codex",
      lines: [
        JSON.stringify({ timestamp: "2026-06-03T00:00:00.000Z", type: "session_meta" }),
        JSON.stringify({ timestamp: "2026-06-03T00:00:30.000Z", type: "response_item" }),
        compactLine(),
        JSON.stringify({ timestamp: "2026-06-03T00:02:00.000Z", type: "response_item" }),
      ],
    },
  };
}

test("applyContextBudget can trim to post-compaction context and drop native raw", () => {
  const result = applyContextBudget(sampleContext(), {
    sinceCompact: true,
    maxToolOutputChars: 40,
    includeNative: false,
  });

  assert.equal(result.context.messages.length, 2);
  assert.equal(result.context.messages[0].role, "assistant");
  assert.equal(result.context.raw, undefined);
  assert.equal(result.stats.droppedMessages, 1);
  assert.equal(result.stats.droppedRawLines, 3);
  assert.equal(result.stats.truncatedToolOutputs, 1);
  assert.match(
    result.context.messages[1].content[0].output,
    /tool output truncated/,
  );
});

test("buildPackage contextMode slim records a budgeted cbctx without native artifacts", async () => {
  const { pkg } = await buildPackage(sampleContext(), { contextMode: "slim" });

  assert.equal(pkg.messages.length, 2);
  assert.equal(pkg.native, undefined);
  assert.equal(pkg.budget?.mode, "slim");
  assert.equal(pkg.budget?.sinceCompact, true);
  assert.equal(pkg.budget?.nativeIncluded, false);
  assert.equal(pkg.budget?.truncatedToolOutputs, 0);
});

test("packageToContext can ignore native artifacts from an existing cbctx", async () => {
  const { pkg } = await buildPackage(sampleContext());
  assert.equal(pkg.native?.length, 1);

  const full = packageToContext(pkg);
  assert.equal(full.raw?.tool, "codex");

  const normalizedOnly = packageToContext(pkg, { useNative: false });
  assert.equal(normalizedOnly.raw, undefined);
});
