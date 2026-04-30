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
import { redactText, redactContext } from "../dist/transform/redactor.js";

const SAMPLE_SESSION_DIR = path.join(
  os.homedir(),
  ".claude",
  "projects",
  "C--Users-ddoon-Desktop-context-switching",
);

async function findAnyClaudeSession() {
  try {
    const entries = await fs.readdir(SAMPLE_SESSION_DIR);
    const jsonl = entries.find((e) => e.endsWith(".jsonl"));
    if (!jsonl) return null;
    return path.join(SAMPLE_SESSION_DIR, jsonl);
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-branch-"));
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
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "harness-linear-"));
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
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "harness-mailbox-"));
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
