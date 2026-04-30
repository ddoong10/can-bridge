# Open Questions

Update this doc as we resolve each one — the answers drive code changes in
`src/adapters/claude-code.ts` and `src/adapters/codex.ts`.

## Resolved 2026-04-30 (verified against local session files)

### Claude Code session format
- **Path**: `~/.claude/projects/<project-folder-name>/<session-uuid>.jsonl`.
  Project folder name is the absolute cwd with `:`, `\\`, `/`, **and `_`**
  each replaced by `-`. Example:
  `C:\Users\ddoon\Desktop\context_switching` →
  `C--Users-ddoon-Desktop-context-switching`. The underscore→dash mapping
  is non-obvious and easy to miss; both source-folder lookup and target
  inject must use the same encoding.
- **Wrapper line shape** (relevant fields):
  `{ type, uuid, parentUuid, timestamp, sessionId, cwd, gitBranch, version,
     message?, attachment? }`
- **Type values observed**: `permission-mode`, `attachment`, `user`,
  `assistant`, `file-history-snapshot`. Only `user` and `assistant` are
  transcript content; the rest are session config / hook output / file
  snapshots and must be skipped.
- **`message.content`** is either a plain string OR an array of blocks.
  Block types: `text`, `thinking`, `tool_use`, `tool_result`. (`tool_result`
  appears inside *user* messages, since the user "returns" tool output to
  the assistant.)
- **Multi-line assistant turns**: a single assistant turn can be split
  across multiple JSONL lines that share the same `message.id`. The adapter
  coalesces them by id.
- **Model name**: `message.model` on assistant lines (e.g. `claude-opus-4-7`).
- **`parentUuid`** forms a tree but in practice we iterate file order;
  branch handling is a v1 problem.

### Codex CLI rollout format
- **Path**: `~/.codex/sessions/YYYY/MM/DD/rollout-<iso-ts>-<uuid>.jsonl`
  (UTC date in the path).
- **Every line is wrapped**: `{timestamp, type, payload}`.
- **First line**: `type:"session_meta"`,
  `payload:{id, timestamp, cwd, originator, cli_version, source,
             model_provider, base_instructions:{text}}`.
  The `id` UUID matches the filename UUID; that is the value passed to
  `codex resume <id>`.
- **Message lines**: `type:"response_item"`,
  `payload:{type:"message", role, content:[{type:"input_text"|"output_text", text}]}`.
  Role is `user` / `assistant` / `developer`. `developer` carries permissions
  / collaboration-mode preambles in real sessions.
- **User-typed messages** are also recorded as
  `type:"event_msg", payload:{type:"user_message", message, images, ...}` —
  a redundant copy. We mirror this for fidelity.
- **Other line types observed in real sessions** (NOT emitted by us):
  `event_msg(task_started|task_complete|user_message|error)`,
  `turn_context` (per-turn config snapshot).
  These appear runtime-only; resume probably regenerates them as new turns
  are processed. Untested.

## Resolved 2026-04-30 (continued — actual `codex exec resume` test)

- **`codex exec resume <uuid>` accepts our authored rollouts.** Verified by
  resuming `68331f71-...` and asking Codex (gpt-5.5) to recall the first
  message — it returned the original Claude Code prompt verbatim. So
  rollouts WITHOUT `event_msg(task_started/task_complete)` envelopes are
  fine for the read path.
- **`codex exec` is the non-interactive subcommand.** Use `codex exec resume
  <id> "<prompt>"` for end-to-end tests from a regular shell. Pass
  `--skip-git-repo-check` *between* `exec` and `resume` (it is a per-mode
  flag, not global).

## Resolved 2026-04-30 (write-back actually works)

After inspecting `~/.codex/state_5.sqlite` directly (table `threads`, 27
columns, primary key `id`):

- **Codex auto-registers a thread row** the first time `codex exec resume
  <uuid>` runs against an unknown rollout. It populates id, rollout_path,
  cwd, title (= first user message), first_user_message, model_provider,
  cli_version (read from our `session_meta.payload.cli_version`),
  source ("unknown" because codex doesn't recognize "harness-import"),
  and the live model/reasoning_effort/sandbox_policy from the resume
  invocation. We do NOT need to INSERT manually.
- **Write-back to the rollout file actually succeeds.** Re-running resume
  grew the file from 315,213 → 319,180 bytes and appended a fresh
  `response_item` (assistant), `event_msg(token_count)`, and
  `event_msg(task_complete)` with a new turn_id.
- **The `failed to record rollout items: thread <uuid> not found` error
  is cosmetic** — it comes from a *secondary* sync to other tables
  (likely `stage1_outputs`, the memory/summary cache). Main append path
  is unaffected.

End-to-end Claude Code → Codex → resume → write-back is verified.

## Resolved 2026-04-30 (bidirectional + tool calls)

After grepping `~/.codex/sessions/**/*.jsonl` for `"type":"function_call"`,
five real rollouts contained tool calls. Inspected one directly:

- **`function_call` shape** (verified line):
  ```
  {"timestamp":"...","type":"response_item",
   "payload":{"type":"function_call",
              "name":"shell_command",
              "arguments":"{\"command\":\"...\",\"workdir\":\"...\",\"timeout_ms\":120000}",
              "call_id":"call_cHu2pIYErjyocW2tbnaEujVC"}}
  ```
  `arguments` is a **JSON-encoded string**, not an object. `call_id` is the
  cross-reference key (analogue of Anthropic's `tool_use.id`).
- **`function_call_output` shape**:
  ```
  {"timestamp":"...","type":"response_item",
   "payload":{"type":"function_call_output",
              "call_id":"call_A3AdGqlWMIedsPB3gWGietda",
              "output":"Exit code: 0\nWall time: 2.5 seconds\nOutput:\n..."}}
  ```
  No `is_error` field — error encoded into the output text. We prefix
  `[error] ` when projecting Anthropic `is_error: true`.

- **Both adapters now act as both Source and Target**, so:
  `harness pipe --from codex --session <uuid> --to claude-code`
  works end-to-end (verified on a 158-message Codex session).

- **Mapping table**:
  | Anthropic block (Claude Code)                       | OpenAI Responses item (Codex)                                  |
  |-----------------------------------------------------|---------------------------------------------------------------|
  | `tool_use { id, name, input: object }`              | `function_call { call_id, name, arguments: string-JSON }`     |
  | `tool_result { tool_use_id, content, is_error }`    | `function_call_output { call_id, output: string }` (`[error] ` prefix when `is_error`) |

- **Round-trip preservation** (smoke tests):
  - Norm → Claude Code → Norm: `tool_use.id` and `tool_result.toolUseId`
    preserved verbatim, `input` parsed back to object.
  - Norm → Codex → Norm: `call_id` preserved, `arguments` round-trips
    through stringify/parse, `output` preserved.

- **Codex → Claude Code injection accepted by picker**: a 158-message
  Codex rollout was injected as
  `~/.claude/projects/C--Users-ddoon-Desktop-context-switching/fa4c37c0-...jsonl`,
  and `claude --resume` listed it in the picker (size 288.9KB and first
  user message text both matched the injected content). Confirms that the
  wrapper shape we emit (`{type, uuid, parentUuid, timestamp, sessionId,
  cwd, version, message}`) is sufficient — no sqlite/index registration
  needed on the Claude Code side.

## Resolved 2026-04-30 (continued — round-trip closure & branch handling)

- **Codex `function_call_output` extract decodes `[error] ` prefix.**
  When a `function_call_output` payload starts with `[error] `, the prefix
  is stripped and the resulting `tool_result` block has `isError: true`.
  Closes the lossy translation noted earlier — Norm → Codex → Norm now
  preserves `isError`. Test: `tests/smoke.test.mjs` "isError:true round-trips through Codex".
  **Caveat (architect-flagged)**: if a real tool happens to emit output
  whose literal first 8 characters are `[error] ` AND `isError === false`,
  the round-trip will mis-classify it as `isError: true`. No real case
  observed yet; if encountered, switch to a double-prefix escape or a
  side-channel field.
- **Claude Code `parentUuid` branch handling.** `extract()` now indexes
  every line by uuid, walks parent chains skipping non-message
  intermediaries (attachment/permission-mode/file-history-snapshot), finds
  all leaves, picks the leaf with the latest timestamp, and walks the
  chain back to root. Single-chain files behave exactly as before
  (regression-tested). Test: "extract picks the latest-leaf branch when a
  session has multiple branches" + "extract preserves linear single-chain
  ordering".

## Prior art (cross-checked with Codex 2026-04-30)

The closest neighbor we found is
[`bakhtiersizhaev/ai-session-bridge`](https://github.com/bakhtiersizhaev/ai-session-bridge):
direct Claude Code ↔ Codex JSONL conversion with tool-call mapping. Per
its own README, Claude → Codex resume is **"not yet verified"** —
`can-bridge` confirmed both directions end-to-end on a real machine. Two
adjacent projects exist in nearby spaces:
[`Urus1201/codex-bridge-mcp`](https://github.com/Urus1201/codex-bridge-mcp)
(read-only via MCP) and
[`cx994/ccb`](https://github.com/cx994/ccb) (orchestration UX).

## Still unresolved
- [ ] **`harness doctor`** — schema-drift detector. Scan a session file
      for known structural markers (e.g. session_meta.payload.id,
      response_item content blocks of type input_text/output_text); exit
      non-zero with a punch-list if format has drifted. Most-likely v1
      blocker per Codex prior-art review (silent failures kill trust).
- [ ] Long contexts: at what message count do we want to auto-summarize
      before injecting? Probably model/target-dependent.
- [ ] System prompts: Claude Code may have implicit system prompts
      (CLAUDE.md etc.). Should we preserve them, or let the target apply
      its own?
- [ ] Privacy: session files may contain secrets pasted into chat. Add a
      redactor pass before injection? Opt-in or default-on?
- [ ] Branch selection: when a Claude Code session has multiple branches
      via `parentUuid`, which is "the" conversation? Latest leaf?
- [ ] Claude Code `summary` line type — not observed in our sample; may
      appear when sessions are auto-summarized. Worth re-checking on
      longer sessions.
