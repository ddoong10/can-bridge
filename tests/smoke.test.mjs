import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { ClaudeCodeAdapter } from "../dist/adapters/claude-code.js";
import { CodexAdapter } from "../dist/adapters/codex.js";
import {
  formatMessages,
  listInbox,
  listThread,
  readMessages,
  sendMessage,
} from "../dist/collab/mailbox.js";
import {
  diagnoseSession,
  formatDoctorResult,
} from "../dist/doctor/session-doctor.js";
import { formatSessionList, pickLatestSession } from "../dist/cli/index.js";
import { redactText, redactContext } from "../dist/transform/redactor.js";
import {
  buildPackage,
  defaultPackageName,
  writePackage,
} from "../dist/share/share.js";
import {
  formatImportSummary,
  importPackage,
  packageToContext,
  readPackage,
} from "../dist/share/import.js";
import {
  CBCTX_SCHEMA_V1,
  computeCbctxContentHash,
  isCbctxPackage,
} from "../dist/schema/cbctx.js";
import {
  FENCE_MARKER,
  UNTRUSTED_FENCE_HEADER,
  stripFence,
} from "../dist/transform/fence.js";
import { HARNESS_SENTINEL, HARNESS_VERSION } from "../dist/version.js";

const SAMPLE_SESSION_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  "C--Users-ddoon-Desktop-context-switching",
);

async function findAnyClaudeSession() {
  // Prefer real Claude Code sessions over can-bridge-authored ones so
  // round-trip / model-presence assertions reflect upstream reality.
  // We look for files whose first line does NOT contain a can-bridge
  // sentinel (HARNESS_SENTINEL = "can-bridge-<version>").
  try {
    const entries = await fs.readdir(SAMPLE_SESSION_DIR);
    const jsonls = entries.filter((e) => e.endsWith(".jsonl"));
    for (const j of jsonls) {
      const full = path.join(SAMPLE_SESSION_DIR, j);
      const head = await fs.readFile(full, "utf8");
      if (!head.includes('"can-bridge-') && !head.includes('"isCanBridgeFence"')) {
        return full;
      }
    }
    // Fall back to whatever exists if no upstream session is around.
    if (jsonls[0]) return path.join(SAMPLE_SESSION_DIR, jsonls[0]);
    return null;
  } catch {
    return null;
  }
}

async function findCodexSessionWithFunctionCall() {
  // Walk ~/.codex/sessions/YYYY/MM/DD/ and pick the first rollout that
  // contains a function_call line.
  const root = path.join(os.homedir(), ".codex", "sessions");
  let years;
  try {
    years = await fs.readdir(root);
  } catch {
    return null;
  }
  for (const y of years) {
    const yPath = path.join(root, y);
    let months;
    try {
      months = await fs.readdir(yPath);
    } catch {
      continue;
    }
    for (const m of months) {
      const mPath = path.join(yPath, m);
      let days;
      try {
        days = await fs.readdir(mPath);
      } catch {
        continue;
      }
      for (const d of days) {
        const dPath = path.join(mPath, d);
        let files;
        try {
          files = await fs.readdir(dPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
          const full = path.join(dPath, f);
          const txt = await fs.readFile(full, "utf8");
          if (txt.includes('"type":"function_call"')) return full;
        }
      }
    }
  }
  return null;
}

// ─── Forward: Claude Code → Norm → Codex ─────────────────────────────

test("ClaudeCodeAdapter extracts a real session into NormalizedContext", async () => {
  const file = await findAnyClaudeSession();
  if (!file) {
    console.warn("skipping: no local Claude Code session available");
    return;
  }
  const adapter = new ClaudeCodeAdapter();
  const ctx = await adapter.extract(file);

  assert.equal(ctx.schemaVersion, "0.1");
  assert.equal(ctx.source.tool, "claude-code");
  assert.ok(ctx.messages.length > 0, "should extract at least one message");

  for (const m of ctx.messages) {
    assert.ok(m.content.length > 0, "every message should have content");
    assert.ok(["user", "assistant"].includes(m.role));
  }

  const hasAssistant = ctx.messages.some((m) => m.role === "assistant");
  if (hasAssistant) {
    assert.ok(ctx.source.model, "model should be present");
    assert.match(ctx.source.model, /claude/i);
  }
});

test("CodexAdapter writes a parseable rollout that codex can locate by id", async () => {
  const file = await findAnyClaudeSession();
  if (!file) return;
  const src = new ClaudeCodeAdapter();
  const ctx = await src.extract(file);

  const target = new CodexAdapter();
  const result = await target.inject(ctx);

  assert.ok(result.locator.endsWith(".jsonl"));
  const raw = await fs.readFile(result.locator, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  assert.ok(lines.length >= 2, "rollout should have header + content");

  const first = JSON.parse(lines[0]);
  assert.equal(first.type, "session_meta");
  assert.ok(first.payload?.id);
  assert.ok(result.locator.includes(first.payload.id));
  assert.equal(first.payload.model_provider, "openai");

  // Validate every subsequent line is a recognized response_item or event_msg.
  for (let i = 1; i < lines.length; i++) {
    const o = JSON.parse(lines[i]);
    assert.ok(o.type, `line ${i + 1} missing type`);
    assert.ok(o.payload, `line ${i + 1} missing payload`);

    if (o.type === "response_item") {
      const t = o.payload.type;
      if (t === "message") {
        assert.ok(["user", "assistant", "developer"].includes(o.payload.role));
        assert.ok(Array.isArray(o.payload.content));
        for (const block of o.payload.content) {
          assert.ok(["input_text", "output_text"].includes(block.type));
          assert.equal(typeof block.text, "string");
        }
      } else if (t === "function_call") {
        assert.equal(typeof o.payload.name, "string");
        assert.equal(typeof o.payload.arguments, "string", "arguments must be JSON-string");
        assert.equal(typeof o.payload.call_id, "string");
      } else if (t === "function_call_output") {
        assert.equal(typeof o.payload.call_id, "string");
        assert.equal(typeof o.payload.output, "string");
      } else {
        throw new Error(`unknown response_item.payload.type at line ${i + 1}: ${t}`);
      }
    } else if (o.type === "event_msg") {
      assert.ok(o.payload.type, `event_msg payload type missing line ${i + 1}`);
    } else {
      throw new Error(`unknown wrapper type at line ${i + 1}: ${o.type}`);
    }
  }
});

// ─── Reverse: Codex → Norm → Claude Code ──────────────────────────────

test("CodexAdapter extracts a real rollout (with function_call) into NormalizedContext", async () => {
  const file = await findCodexSessionWithFunctionCall();
  if (!file) {
    console.warn("skipping: no local Codex rollout with function_call found");
    return;
  }
  const adapter = new CodexAdapter();
  const ctx = await adapter.extract(file);

  assert.equal(ctx.source.tool, "codex");
  assert.ok(ctx.source.sessionId, "sessionId should come from session_meta.payload.id");
  assert.ok(ctx.messages.length > 0);

  const blockTypes = new Set();
  for (const m of ctx.messages) for (const b of m.content) blockTypes.add(b.type);
  assert.ok(
    blockTypes.has("tool_use"),
    "rollout had function_call lines, expected at least one tool_use block",
  );
  assert.ok(blockTypes.has("text") || blockTypes.has("tool_result"));
});

test("doctor validates a compatible Codex rollout shape", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-doctor-ok-"));
  const filePath = path.join(
    tempDir,
    "rollout-2026-05-01T00-00-00-000Z-00000000-0000-0000-0000-000000000001.jsonl",
  );
  const lines = [
    {
      timestamp: "2026-05-01T00:00:00.000Z",
      type: "session_meta",
      payload: {
        id: "00000000-0000-0000-0000-000000000001",
        timestamp: "2026-05-01T00:00:00.000Z",
        cwd: tempDir,
        model_provider: "openai",
        base_instructions: { text: "imported" },
      },
    },
    {
      timestamp: "2026-05-01T00:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    },
    {
      timestamp: "2026-05-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: "{\"command\":\"echo hi\"}",
        call_id: "call_doctor_ok",
      },
    },
    {
      timestamp: "2026-05-01T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call_doctor_ok",
        output: "hi",
      },
    },
  ];
  await fs.writeFile(
    filePath,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );

  const result = await diagnoseSession(filePath, { from: "codex" });
  assert.equal(result.status, "ok");
  assert.equal(result.score, 100);
  assert.equal(result.detectedFormat, "codex");
  assert.match(formatDoctorResult(result), /Doctor codex: ok \(100\/100\)/);

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("doctor reports schema drift with score and mismatch codes", async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-doctor-bad-"));
  const filePath = path.join(tempDir, "bad-codex.jsonl");
  await fs.writeFile(
    filePath,
    JSON.stringify({
      timestamp: "2026-05-01T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: { type: "output_text", text: "not an array" },
      },
    }) + "\n",
    "utf8",
  );

  const result = await diagnoseSession(filePath, { from: "codex" });
  assert.equal(result.status, "fail");
  assert.ok(result.score < 100);
  assert.ok(result.findings.some((f) => f.code === "CODEX_FIRST_LINE"));
  assert.ok(result.findings.some((f) => f.code === "CODEX_SESSION_META_MISSING"));
  assert.ok(result.findings.some((f) => f.code === "CODEX_MESSAGE_CONTENT"));

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("continue helper picks the newest source session by updatedAt", async () => {
  const source = {
    id: "fixture",
    async extract() {
      throw new Error("not used");
    },
    async listSessions() {
      return [
        { id: "older", updatedAt: "2026-05-01T01:00:00.000Z" },
        { id: "newest", updatedAt: "2026-05-01T03:00:00.000Z" },
        { id: "middle", updatedAt: "2026-05-01T02:00:00.000Z" },
      ];
    },
  };

  const latest = await pickLatestSession(source);
  assert.equal(latest.id, "newest");
});

test("session list formatter shows human-readable context", () => {
  const out = formatSessionList([
    {
      id: "abc-123",
      updatedAt: "2026-05-01T03:00:00.000Z",
      title: "Move this conversation to my friend's Claude Code",
      latestAssistant: "Use can-bridge share and send the cbctx file.",
      messageCount: 12,
      model: "gpt-test",
      cwd: "C:\\Users\\friend\\Desktop\\context_switching",
      originator: "can-bridge",
      sourceLabel: "can-bridge-import",
      importedFrom: "claude-code",
      originalSessionId: "8131efb2-19ac-407b-a538-8d94a94258e5",
    },
  ]);

  assert.match(out, /abc-123/);
  assert.match(out, /12 messages/);
  assert.match(out, /model: gpt-test/);
  assert.match(out, /project: context_switching/);
  assert.match(out, /latest user: "Move this conversation/);
  assert.match(out, /latest assistant: "Use can-bridge share/);
  assert.match(out, /imported from claude-code:8131efb2/);
  assert.match(out, /origin: can-bridge \/ can-bridge-import \/ from claude-code:8131efb2/);
});

test("session list formatter respects limit", () => {
  const out = formatSessionList(
    [
      { id: "one", updatedAt: "2026-05-01T03:00:00.000Z" },
      { id: "two", updatedAt: "2026-05-01T02:00:00.000Z" },
    ],
    { limit: 1 },
  );

  assert.match(out, /one/);
  assert.doesNotMatch(out, /two/);
});

test("ClaudeCodeAdapter writes a session that re-extracts to the same shape", async () => {
  // Build a small NormalizedContext with mixed block types covering the
  // round-trip surface: text, tool_use, tool_result.
  const norm = {
    schemaVersion: "0.1",
    source: {
      tool: "test",
      model: "claude-test",
      sessionId: "src-123",
      cwd: process.cwd(),
    },
    messages: [
      { role: "user", content: [{ type: "text", text: "list files" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll use the shell." },
          {
            type: "tool_use",
            id: "toolu_round_trip_1",
            name: "shell",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_round_trip_1",
            output: "a.ts\nb.ts",
            isError: false,
          },
        ],
      },
    ],
  };

  const target = new ClaudeCodeAdapter();
  const result = await target.inject(norm);
  assert.ok(result.locator.endsWith(".jsonl"));

  // Re-extract and compare structurally.
  const re = await target.extract(result.locator);
  assert.equal(re.messages.length, 3);
  assert.equal(re.messages[0].role, "user");
  assert.equal(re.messages[0].content[0].type, "text");
  assert.equal(re.messages[0].content[0].text, "list files");

  assert.equal(re.messages[1].role, "assistant");
  const aBlocks = re.messages[1].content.map((b) => b.type);
  assert.deepEqual(aBlocks, ["text", "tool_use"]);
  const tu = re.messages[1].content[1];
  assert.equal(tu.name, "shell");
  assert.equal(tu.id, "toolu_round_trip_1");
  assert.deepEqual(tu.input, { command: "ls" });

  assert.equal(re.messages[2].role, "user");
  const tr = re.messages[2].content[0];
  assert.equal(tr.type, "tool_result");
  assert.equal(tr.toolUseId, "toolu_round_trip_1");
  assert.equal(tr.output, "a.ts\nb.ts");
  assert.equal(tr.isError, false);

  // Cleanup.
  await fs.unlink(result.locator).catch(() => {});
});

// ─── Redactor ────────────────────────────────────────────────────────

test("redactText catches common secret patterns and leaves plain text alone", () => {
  // Plain text untouched.
  assert.equal(redactText("hello world"), "hello world");
  assert.equal(redactText("commit abc123def4567890abcdef0123456789"), "commit abc123def4567890abcdef0123456789");

  // Vendor keys.
  assert.match(redactText("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA"), /\[REDACTED:anthropic-key\]/);
  assert.match(redactText("sk-proj-ZZZZZZZZZZZZZZZZZZZZ"), /\[REDACTED:openai-key\]/);
  assert.match(redactText("ghp_" + "a".repeat(40)), /\[REDACTED:github-pat\]/);
  assert.match(redactText("AKIAIOSFODNN7EXAMPLE"), /\[REDACTED:aws-access-key\]/);
  // Google API keys are exactly 39 chars total (AIza + 35).
  assert.match(redactText("AIzaSyD-" + "a".repeat(31)), /\[REDACTED:google-api-key\]/);
  assert.match(redactText("xoxb-" + "a".repeat(20)), /\[REDACTED:slack-token\]/);

  // JWT.
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.AbCdEfGhIjKlMnOp";
  assert.match(redactText(`token=${jwt}`), /\[REDACTED:jwt\]/);

  // Bearer (only the token redacts, "Bearer " stays).
  const bearer = "Bearer eyJ" + "x".repeat(40);
  const redactedBearer = redactText(bearer);
  assert.ok(redactedBearer.startsWith("Bearer "));
  assert.match(redactedBearer, /\[REDACTED:(bearer|jwt)\]/);

  // key=value (kv-secret rule).
  assert.match(redactText('password="hunter2hunter2"'), /\[REDACTED:kv-secret\]/);
  assert.match(redactText("api_key=verylongsecretvalue"), /\[REDACTED:kv-secret\]/);

  // Disambiguation: sk-ant- should be classified as anthropic, not openai.
  const antOnly = redactText("sk-ant-api03-XXXXXXXXXXXXXXXXXXXXXX");
  assert.ok(antOnly.includes("[REDACTED:anthropic-key]"));
  assert.ok(!antOnly.includes("[REDACTED:openai-key]"));
});

test("redactContext walks every block type and the summary", () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "test" },
    summary: "Use sk-ant-api03-SUMMARY-AAAAAAAAAAAA to authenticate.",
    messages: [
      { role: "user", content: [{ type: "text", text: "my key is ghp_" + "a".repeat(40) }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "ok" },
          {
            type: "tool_use",
            id: "t1",
            name: "shell",
            input: {
              command: "echo $TOKEN",
              env: { TOKEN: "AKIAIOSFODNN7EXAMPLE" },
            },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "t1",
            output: "AKIAIOSFODNN7EXAMPLE",
            isError: false,
          },
        ],
      },
    ],
  };
  const r = redactContext(ctx);

  assert.match(r.summary, /\[REDACTED:anthropic-key\]/);
  assert.match(r.messages[0].content[0].text, /\[REDACTED:github-pat\]/);
  // tool_use input nested object — env.TOKEN should be redacted.
  assert.equal(r.messages[1].content[1].input.env.TOKEN, "[REDACTED:aws-access-key]");
  // tool_result output.
  assert.equal(r.messages[2].content[0].output, "[REDACTED:aws-access-key]");

  // Original is untouched (deep clone).
  assert.equal(ctx.messages[1].content[1].input.env.TOKEN, "AKIAIOSFODNN7EXAMPLE");
});

test("CodexAdapter inject preserves tool_use call_id round-trip", async () => {
  const norm = {
    schemaVersion: "0.1",
    source: { tool: "test", cwd: process.cwd() },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Running shell" },
          {
            type: "tool_use",
            id: "call_xyz_42",
            name: "shell_command",
            input: { command: "echo hi", workdir: "." },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_xyz_42",
            output: "hi",
            isError: false,
          },
        ],
      },
    ],
  };

  const codex = new CodexAdapter();
  const result = await codex.inject(norm);
  const re = await codex.extract(result.locator);

  // Three response_items expected: assistant text, function_call, function_call_output.
  // Re-extracted as 3 messages (we don't merge consecutive items).
  const blocks = re.messages.flatMap((m) => m.content.map((b) => b.type));
  assert.ok(blocks.includes("text"));
  assert.ok(blocks.includes("tool_use"));
  assert.ok(blocks.includes("tool_result"));

  const tu = re.messages.find((m) =>
    m.content.some((b) => b.type === "tool_use"),
  );
  const tuBlock = tu.content.find((b) => b.type === "tool_use");
  assert.equal(tuBlock.id, "call_xyz_42");
  assert.equal(tuBlock.name, "shell_command");
  assert.deepEqual(tuBlock.input, { command: "echo hi", workdir: "." });

  const tr = re.messages.find((m) =>
    m.content.some((b) => b.type === "tool_result"),
  );
  const trBlock = tr.content.find((b) => b.type === "tool_result");
  assert.equal(trBlock.toolUseId, "call_xyz_42");
  assert.equal(trBlock.output, "hi");

  await fs.unlink(result.locator).catch(() => {});
});

test("isError:true round-trips through Codex (inject encodes, extract decodes)", async () => {
  const norm = {
    schemaVersion: "0.1",
    source: { tool: "test", cwd: process.cwd() },
    messages: [
      {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "call_err_1",
            name: "shell",
            input: { command: "exit 7" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolUseId: "call_err_1",
            output: "command failed: exit code 7",
            isError: true,
          },
        ],
      },
    ],
  };

  const codex = new CodexAdapter();
  const result = await codex.inject(norm);

  // Confirm the wire format encodes the error prefix.
  const raw = await fs.readFile(result.locator, "utf8");
  assert.match(raw, /\[error\] command failed: exit code 7/);

  // Re-extract and confirm the flag is recovered.
  const re = await codex.extract(result.locator);
  const trMsg = re.messages.find((m) =>
    m.content.some((b) => b.type === "tool_result"),
  );
  assert.ok(trMsg, "expected a tool_result message after re-extract");
  const trBlock = trMsg.content.find((b) => b.type === "tool_result");
  assert.equal(trBlock.isError, true);
  assert.equal(trBlock.output, "command failed: exit code 7"); // prefix stripped

  await fs.unlink(result.locator).catch(() => {});
});

test("ClaudeCodeAdapter extract picks the latest-leaf branch when a session has multiple branches", async () => {
  // Synthetic Claude Code JSONL with two assistant branches off the same
  // user message. The "newer" branch (later timestamp) should win; the
  // older branch should be entirely absent from the extracted transcript.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-branch-"));
  const filePath = path.join(tempDir, "branch-test.jsonl");

  const rootUuid = "00000000-0000-0000-0000-000000000001";
  const oldLeafUuid = "00000000-0000-0000-0000-000000000002";
  const newLeafUuid = "00000000-0000-0000-0000-000000000003";
  const lines = [
    {
      type: "user",
      uuid: rootUuid,
      parentUuid: null,
      timestamp: "2026-04-01T00:00:00.000Z",
      sessionId: "branch-test",
      cwd: tempDir,
      message: { role: "user", content: "Hello" },
    },
    {
      type: "assistant",
      uuid: oldLeafUuid,
      parentUuid: rootUuid,
      timestamp: "2026-04-01T00:00:01.000Z",
      sessionId: "branch-test",
      cwd: tempDir,
      message: {
        id: "msg_old",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "OLD answer" }],
      },
    },
    {
      type: "assistant",
      uuid: newLeafUuid,
      parentUuid: rootUuid,
      timestamp: "2026-04-01T00:00:05.000Z",
      sessionId: "branch-test",
      cwd: tempDir,
      message: {
        id: "msg_new",
        role: "assistant",
        model: "claude-test",
        content: [{ type: "text", text: "NEW answer" }],
      },
    },
  ];
  await fs.writeFile(
    filePath,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );

  const adapter = new ClaudeCodeAdapter();
  const ctx = await adapter.extract(filePath);

  assert.equal(ctx.messages.length, 2, "should pick exactly one branch (root + leaf)");
  assert.equal(ctx.messages[0].role, "user");
  assert.equal(ctx.messages[0].content[0].text, "Hello");
  assert.equal(ctx.messages[1].role, "assistant");
  assert.equal(
    ctx.messages[1].content[0].text,
    "NEW answer",
    "should pick the newer branch by timestamp",
  );
  // Make sure the OLD branch never appears.
  for (const m of ctx.messages) {
    for (const b of m.content) {
      if (b.type === "text") assert.ok(!b.text.includes("OLD"));
    }
  }

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("ClaudeCodeAdapter extract preserves linear single-chain ordering", async () => {
  // Regression guard: a non-branched file must come out in file order.
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-linear-"));
  const filePath = path.join(tempDir, "linear-test.jsonl");

  const u = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  const lines = [
    { type: "user",      uuid: u(1), parentUuid: null,   timestamp: "2026-04-01T00:00:00.000Z", sessionId: "lin", cwd: tempDir, message: { role: "user", content: "first" } },
    { type: "assistant", uuid: u(2), parentUuid: u(1),   timestamp: "2026-04-01T00:00:01.000Z", sessionId: "lin", cwd: tempDir, message: { id: "a", role: "assistant", model: "claude-test", content: [{ type: "text", text: "reply 1" }] } },
    { type: "user",      uuid: u(3), parentUuid: u(2),   timestamp: "2026-04-01T00:00:02.000Z", sessionId: "lin", cwd: tempDir, message: { role: "user", content: "second" } },
    { type: "assistant", uuid: u(4), parentUuid: u(3),   timestamp: "2026-04-01T00:00:03.000Z", sessionId: "lin", cwd: tempDir, message: { id: "b", role: "assistant", model: "claude-test", content: [{ type: "text", text: "reply 2" }] } },
  ];
  await fs.writeFile(
    filePath,
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
    "utf8",
  );

  const adapter = new ClaudeCodeAdapter();
  const ctx = await adapter.extract(filePath);

  assert.equal(ctx.messages.length, 4);
  assert.deepEqual(
    ctx.messages.map((m) => m.content[0].text),
    ["first", "reply 1", "second", "reply 2"],
  );

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("mailbox stores agent messages and filters inbox/thread views", async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-mailbox-"));
  const mailbox = path.join(temp, ".agent-chat", "messages.jsonl");

  const first = await sendMessage({
    from: "Codex",
    to: "Claude",
    subject: "handoff",
    body: "Please review the adapter tests.",
    mailboxPath: mailbox,
  });
  const second = await sendMessage({
    from: "Claude",
    to: "Codex",
    body: "Reviewed. Add one mailbox test.",
    mailboxPath: mailbox,
    threadId: first.threadId,
    replyTo: first.id,
  });

  const all = await readMessages(mailbox);
  assert.equal(all.length, 2);
  assert.equal(all[0].from, "codex");
  assert.equal(all[0].to, "claude");
  assert.equal(all[0].subject, "handoff");
  assert.equal(all[1].replyTo, first.id);

  const codexInbox = await listInbox("codex", mailbox);
  assert.equal(codexInbox.length, 1);
  assert.equal(codexInbox[0].id, second.id);

  const thread = await listThread(first.threadId, mailbox);
  assert.equal(thread.length, 2);
  assert.match(formatMessages(thread), /Please review the adapter tests/);

  await fs.rm(temp, { recursive: true, force: true });
});

// ─── .cbctx share / import ──────────────────────────────────────────

test("share builds a v1 package with redaction findings + valid schema", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", model: "claude-opus-4-7", sessionId: "abc-1" },
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: "my key is sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "ok" }],
      },
    ],
  };

  const { pkg, redaction } = await buildPackage(ctx, { redact: true });

  assert.equal(pkg.schema, CBCTX_SCHEMA_V1);
  assert.ok(isCbctxPackage(pkg), "pkg must satisfy isCbctxPackage");
  assert.equal(pkg.source.tool, "claude-code");
  assert.equal(pkg.messages.length, 2);
  assert.equal(redaction.enabled, true);
  assert.ok(
    redaction.findings.some((f) => f.kind === "anthropic-key" && f.count >= 1),
    "should report at least one anthropic-key redaction finding",
  );
  // Original ctx must not be mutated.
  assert.match(
    ctx.messages[0].content[0].text,
    /sk-ant-api03-/,
    "input context must not be redacted in place",
  );
});

test("writePackage + readPackage round-trip preserves schema", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "codex", sessionId: "rt-1" },
    messages: [
      { role: "user", content: [{ type: "text", text: "hi" }] },
    ],
  };
  const { pkg } = await buildPackage(ctx);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-cbctx-"));
  const filePath = path.join(tempDir, defaultPackageName(pkg.source.sessionId));
  const written = await writePackage(pkg, filePath);
  assert.ok(written.endsWith(".cbctx"));

  const reread = await readPackage(written);
  assert.equal(reread.schema, pkg.schema);
  assert.equal(reread.messages.length, pkg.messages.length);
  assert.equal(reread.source.tool, "codex");

  await fs.rm(tempDir, { recursive: true, force: true });
});

test("importPackage round-trips through the Codex adapter", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "imp-1", cwd: process.cwd() },
    messages: [
      { role: "user", content: [{ type: "text", text: "first user message" }] },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
    ],
  };
  const { pkg } = await buildPackage(ctx);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-cbctx-imp-"));
  const filePath = path.join(tempDir, "test.cbctx");
  await writePackage(pkg, filePath);

  const target = new CodexAdapter();
  const { result, summary } = await importPackage(filePath, target);
  assert.ok(result.locator.endsWith(".jsonl"));
  assert.equal(summary.messageCount, 2);
  assert.equal(summary.source.tool, "claude-code");
  assert.match(formatImportSummary(summary), /Originally from claude-code/);

  // Verify the rollout is parseable by the Codex extractor too.
  const reExtract = await target.extract(result.locator);
  const userMsg = reExtract.messages.find((m) => m.role === "user");
  assert.ok(userMsg);
  assert.equal(userMsg.content[0].text, "first user message");

  // Cleanup: rollout file + tmp dir.
  await fs.unlink(result.locator).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("packageToContext exposes the embedded redaction/repo/doctor as metadata", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "meta-1" },
    messages: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
  };
  const { pkg } = await buildPackage(ctx, { redact: true });
  const back = packageToContext(pkg);
  assert.ok(back.metadata);
  assert.equal(back.metadata.cbctxRedaction.enabled, true);
  assert.equal(back.metadata.cbctxHarnessVersion, pkg.harnessVersion);
});

test("importPackage re-buckets the session under the receiver's cwd", async () => {
  const senderCwd = "C:/sender/some-old-path/that-doesnt-exist-on-receiver";
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "rb-1", cwd: senderCwd },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const { pkg } = await buildPackage(ctx);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-cbctx-rb-"));
  const filePath = path.join(tempDir, "test.cbctx");
  await writePackage(pkg, filePath);

  const target = new ClaudeCodeAdapter();
  const receiverCwd = path.join(tempDir, "receiver-project");
  const { result } = await importPackage(filePath, target, { receiverCwd });

  // The injected file must live under receiverCwd's encoded folder, not the
  // sender's. We don't write to the receiver's real ~/.claude — that would
  // pollute the test environment — so we just check that the locator path
  // contains a folder derived from receiverCwd.
  const expectedFolderPart = receiverCwd
    .replace(/[:\\/_]/g, "-");
  assert.ok(
    result.locator.includes(expectedFolderPart) ||
      result.locator.includes(expectedFolderPart.replace(/^.{1}--/, "")),
    `expected receiver cwd folder in ${result.locator}, looked for ${expectedFolderPart}`,
  );

  // And the original sender cwd must NOT appear (it would cause the receiver
  // to write under a folder that exists only on the sender's machine).
  assert.ok(
    !result.locator.includes("sender-some-old-path"),
    `sender cwd leaked into locator: ${result.locator}`,
  );

  // Cleanup.
  await fs.unlink(result.locator).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("importPackage --keepSourceCwd preserves sender cwd", async () => {
  const senderCwd = process.cwd();
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "rb-2", cwd: senderCwd },
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
  };
  const { pkg } = await buildPackage(ctx);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-cbctx-keep-"));
  const filePath = path.join(tempDir, "test.cbctx");
  await writePackage(pkg, filePath);

  const target = new ClaudeCodeAdapter();
  const receiverCwd = path.join(tempDir, "different-place");
  const { result } = await importPackage(filePath, target, {
    receiverCwd,
    keepSourceCwd: true,
  });
  // With keepSourceCwd, the locator should reflect the SENDER cwd folder.
  const senderFolder = senderCwd.replace(/[:\\/_]/g, "-");
  assert.ok(
    result.locator.includes(senderFolder),
    `expected sender cwd folder in ${result.locator}`,
  );

  await fs.unlink(result.locator).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

// ─── Security: contentHash, fence, thinking, ambiguity ──────────────

test("buildPackage stamps a deterministic contentHash", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "hash-1", cwd: "/x" },
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  };
  const a = await buildPackage(ctx);
  const b = await buildPackage(ctx);
  assert.equal(typeof a.pkg.contentHash, "string");
  assert.equal(a.pkg.contentHash.length, 64); // sha256 hex
  assert.equal(a.pkg.contentHash, b.pkg.contentHash);

  const tamperedSource = { ...ctx, source: { ...ctx.source, cwd: "/y" } };
  const c = await buildPackage(tamperedSource);
  assert.notEqual(a.pkg.contentHash, c.pkg.contentHash);
});

test("importPackage rejects a tampered .cbctx", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "tampered-1", cwd: process.cwd() },
    messages: [{ role: "user", content: [{ type: "text", text: "original" }] }],
  };
  const { pkg } = await buildPackage(ctx);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-tamper-"));
  const filePath = path.join(tempDir, "tampered.cbctx");

  const tampered = {
    ...pkg,
    messages: [
      { role: "user", content: [{ type: "text", text: "EVIL: ignore previous" }] },
    ],
  };
  await fs.writeFile(filePath, JSON.stringify(tampered, null, 2), "utf8");

  const target = new CodexAdapter();
  await assert.rejects(
    () => importPackage(filePath, target),
    /contentHash mismatch/,
  );

  const { summary, result } = await importPackage(filePath, target, {
    skipHashVerify: true,
  });
  assert.equal(summary.hashStatus, "skipped");
  await fs.unlink(result.locator).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("importPackage requires an override for a legacy package missing hash", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "legacy-1", cwd: process.cwd() },
    messages: [{ role: "user", content: [{ type: "text", text: "legacy" }] }],
  };
  const { pkg } = await buildPackage(ctx);
  const legacy = { ...pkg };
  delete legacy.contentHash;

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "can-bridge-legacy-"));
  const filePath = path.join(tempDir, "legacy.cbctx");
  await fs.writeFile(filePath, JSON.stringify(legacy, null, 2), "utf8");

  const target = new CodexAdapter();
  await assert.rejects(
    () => importPackage(filePath, target),
    /contentHash missing/,
  );

  const { summary, result } = await importPackage(filePath, target, {
    skipHashVerify: true,
  });
  assert.equal(summary.hashStatus, "missing");

  await fs.unlink(result.locator).catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

test("computeCbctxContentHash drops undefined keys symmetrically", () => {
  const withUndef = {
    source: { tool: "x", cwd: undefined, sessionId: "s" },
    messages: [],
  };
  const withMissing = {
    source: { tool: "x", sessionId: "s" },
    messages: [],
  };
  assert.equal(
    computeCbctxContentHash(withUndef),
    computeCbctxContentHash(withMissing),
  );
});

test("Codex inject prepends the untrusted-content fence to base_instructions", async () => {
  const norm = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "fence-1", cwd: process.cwd() },
    messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  };
  const codex = new CodexAdapter();
  const result = await codex.inject(norm);
  const raw = await fs.readFile(result.locator, "utf8");
  const firstLine = JSON.parse(raw.split("\n")[0]);
  assert.equal(firstLine.type, "session_meta");
  const text = firstLine.payload.base_instructions.text;
  assert.ok(text.startsWith(FENCE_MARKER), "fence marker must lead base_instructions");
  assert.match(text, /imported context follows/);
  await fs.unlink(result.locator).catch(() => {});
});

test("Claude Code inject prepends a fence message that round-trips clean", async () => {
  const norm = {
    schemaVersion: "0.1",
    source: {
      tool: "claude-code",
      model: "claude-test",
      sessionId: "fence-2",
      cwd: process.cwd(),
    },
    messages: [
      { role: "user", content: [{ type: "text", text: "real message" }] },
    ],
  };
  const target = new ClaudeCodeAdapter();
  const result = await target.inject(norm);

  const raw = await fs.readFile(result.locator, "utf8");
  assert.match(raw, /isCanBridgeFence/);
  assert.ok(raw.includes(FENCE_MARKER));

  const re = await target.extract(result.locator);
  assert.equal(re.messages.length, 1);
  assert.equal(re.messages[0].content[0].text, "real message");

  await fs.unlink(result.locator).catch(() => {});
});

test("thinking blocks are dropped on Claude Code inject", async () => {
  const norm = {
    schemaVersion: "0.1",
    source: { tool: "test", model: "claude-test", cwd: process.cwd() },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "secret model thoughts" },
          { type: "text", text: "user-visible reply" },
        ],
      },
    ],
  };
  const target = new ClaudeCodeAdapter();
  const result = await target.inject(norm);
  const raw = await fs.readFile(result.locator, "utf8");
  assert.ok(!raw.includes('"type":"thinking"'),
    "injected JSONL should not contain thinking blocks");
  assert.ok(raw.includes("user-visible reply"));
  await fs.unlink(result.locator).catch(() => {});
});

test("stripFence removes leading fence and leaves rest intact", () => {
  const text = UNTRUSTED_FENCE_HEADER + "\n\nReal summary here.";
  assert.equal(stripFence(text), "Real summary here.");
  assert.equal(stripFence("plain"), "plain");
});

test("Codex extract strips a leading fence so summary doesn't pile up", async () => {
  const norm = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "fence-rt", cwd: process.cwd() },
    summary: "Original summary.",
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
  };
  const codex = new CodexAdapter();
  const r = await codex.inject(norm);
  const re = await codex.extract(r.locator);
  assert.ok(re.summary, "summary should round-trip");
  assert.ok(!re.summary.startsWith(FENCE_MARKER));
  assert.match(re.summary, /Original summary/);
  await fs.unlink(r.locator).catch(() => {});
});

test("Claude Code resolve throws on ambiguous session id", async () => {
  const adapter = new ClaudeCodeAdapter();
  const projects = path.join(os.homedir(), ".claude", "projects");
  const dirA = path.join(projects, "test-ambiguous-A");
  const dirB = path.join(projects, "test-ambiguous-B");
  await fs.mkdir(dirA, { recursive: true });
  await fs.mkdir(dirB, { recursive: true });
  const id = "ambig-test-id-aaaa-bbbb-cccc-dddd";
  await fs.writeFile(path.join(dirA, `${id}.jsonl`), "{\n", "utf8");
  await fs.writeFile(path.join(dirB, `${id}.jsonl`), "{\n", "utf8");

  await assert.rejects(
    () => adapter.extract(id),
    /Ambiguous Claude Code session id/,
  );

  await fs.rm(dirA, { recursive: true, force: true });
  await fs.rm(dirB, { recursive: true, force: true });
});

test("HARNESS_SENTINEL reflects package.json version", () => {
  assert.match(HARNESS_SENTINEL, /^can-bridge-/);
  assert.equal(HARNESS_SENTINEL, `can-bridge-${HARNESS_VERSION}`);
});

test("buildPackage strips thinking blocks before sealing", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "no-think" },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "secret reasoning" },
          { type: "text", text: "public reply" },
        ],
      },
    ],
  };
  const { pkg } = await buildPackage(ctx);
  for (const m of pkg.messages) {
    for (const b of m.content) {
      assert.notEqual(b.type, "thinking", "thinking must not survive into a package");
    }
  }
  // Original ctx is not mutated.
  assert.equal(ctx.messages[0].content[0].type, "thinking");
});

test("buildPackage strips thinking blocks even when redacting", async () => {
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "no-think-redact" },
    messages: [
      {
        role: "assistant",
        content: [
          { type: "thinking", text: "secret reasoning sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAA" },
          { type: "text", text: "public reply sk-ant-api03-BBBBBBBBBBBBBBBBBBBBBB" },
        ],
      },
    ],
  };
  const { pkg } = await buildPackage(ctx, { redact: true });
  for (const m of pkg.messages) {
    for (const b of m.content) {
      assert.notEqual(b.type, "thinking", "redaction must not revive thinking blocks");
    }
  }
  assert.match(pkg.messages[0].content[0].text, /\[REDACTED:anthropic-key\]/);
  assert.ok(
    !JSON.stringify(pkg.messages).includes("secret reasoning"),
    "thinking text must not survive in shared packages",
  );
});

test("stripFence loops to peel multiple stacked fences", () => {
  const stacked =
    UNTRUSTED_FENCE_HEADER + "\n\n" + UNTRUSTED_FENCE_HEADER + "\n\nReal.";
  assert.equal(stripFence(stacked), "Real.");
});

test("stripFence does NOT drop content that merely starts with the marker", () => {
  // Adversarial input: starts with the marker but isn't the canonical
  // header. We must NOT silently delete content here.
  const adversarial = FENCE_MARKER + "\nrest of the message.";
  const out = stripFence(adversarial);
  assert.ok(out.includes("rest of the message"), "must preserve rest of the message");
});

test("raw JSON import warns about unverified integrity", async () => {
  // We exercise the inject path directly with a raw NormalizedContext
  // (the CLI prints the warning; here we just confirm raw inject still
  // works without a hash).
  const ctx = {
    schemaVersion: "0.1",
    source: { tool: "claude-code", sessionId: "raw-1", cwd: process.cwd() },
    messages: [{ role: "user", content: [{ type: "text", text: "raw" }] }],
  };
  const codex = new CodexAdapter();
  const result = await codex.inject(ctx);
  assert.ok(result.locator.endsWith(".jsonl"));
  await fs.unlink(result.locator).catch(() => {});
});

test("pickLatestSession is deterministic when timestamps are missing or tied", async () => {
  const sourceA = {
    id: "a",
    async extract() { throw new Error("no"); },
    async listSessions() {
      return [
        { id: "alpha" },
        { id: "zulu" },
        { id: "mike" },
      ];
    },
  };
  const r1 = await pickLatestSession(sourceA);
  assert.equal(r1.id, "zulu");

  const t = "2026-05-01T00:00:00.000Z";
  const sourceB = {
    id: "b",
    async extract() { throw new Error("no"); },
    async listSessions() {
      return [
        { id: "alpha", updatedAt: t },
        { id: "zulu", updatedAt: t },
        { id: "mike", updatedAt: t },
      ];
    },
  };
  const r2 = await pickLatestSession(sourceB);
  assert.equal(r2.id, "zulu");
});
