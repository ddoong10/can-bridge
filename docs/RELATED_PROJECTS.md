# Related Projects

Scan date: 2026-04-30.

This is a positioning note for `can-bridge`, not an exhaustive market map. The
goal is to keep the project honest about adjacent open-source work and to make
clear where this repo should differentiate.

## Search Scope

Queries used:

- `Claude Code Codex bridge context handoff agent`
- `AI agent context handoff Claude Codex`
- `MCP Codex bridge Claude Code`
- `AGENTS.md CLAUDE.md context sync`
- `AI_CONTEXT.md AGENTS.md CLAUDE.md`

## Closest Overlap

| Project | What it does | Relationship to this repo |
|---------|--------------|---------------------------|
| [bakhtiersizhaev/ai-session-bridge](https://github.com/bakhtiersizhaev/ai-session-bridge) | Bidirectional Claude Code <-> Codex CLI JSONL conversion with session discovery, previews, tail trimming, and tool-call mapping. | Closest direct prior art. `can-bridge` should differentiate on verified bidirectional resume behavior, normalized schema, branch handling, redaction, and mailbox workflow. |
| [raysonmeng/agent-bridge](https://github.com/raysonmeng/agent-bridge) | Local live bridge between Claude Code and Codex using a Claude-side MCP/channel client plus a persistent daemon that proxies the Codex app-server protocol. | Very close to the "agents talk to each other" idea. It is a real-time bridge; it is not a portable session-file conversion layer. |
| [abhishekgahlot2/codex-claude-bridge](https://github.com/abhishekgahlot2/codex-claude-bridge) | Claude Code Channels plus a Codex MCP tool and localhost web UI for live Claude/Codex conversation. | Another direct live-bridge project. It is currently asymmetric because Codex still relies on tool calls or polling. |
| [cx994/ccb](https://github.com/cx994/ccb) | Split-pane terminal workflow for Claude Code, Codex, Gemini, and OpenCode, with persistent per-agent context and lightweight prompts. | Strong multi-agent workflow overlap. It orchestrates running CLIs rather than translating their persisted session formats. |
| [gergomiklos/heyagent](https://github.com/gergomiklos/heyagent) | Telegram bridge for Claude Code and Codex, including provider switching and session resume flags. | Similar "one control surface for both agents" UX. It focuses on remote chat/notification transport, not context interchange. |
| [BeehiveInnovations/pal-mcp-server](https://github.com/BeehiveInnovations/pal-mcp-server) | MCP provider abstraction layer with `clink` for connecting external CLIs such as Claude Code, Codex CLI, and Gemini CLI. | Broader orchestration and subagent platform. can-bridge can be a lower-level adapter core under this kind of integration. |
| [Urus1201/codex-bridge-mcp](https://github.com/Urus1201/codex-bridge-mcp) | Read-only MCP server that lets Claude Code and other MCP clients list/search/read local Codex sessions. | Good precedent for read-only history access. It does not write converted sessions or preserve a cross-tool normalized context. |
| [tuannvm/codex-mcp-server](https://github.com/tuannvm/codex-mcp-server) | MCP server that exposes Codex CLI to Claude Code and other MCP hosts, including sessions, review, and web search tools. | Useful integration surface. It invokes Codex as a tool; it does not normalize or inject historical sessions across tools. |
| [eLyiN/codex-bridge](https://github.com/eLyiN/codex-bridge) | Lightweight, mostly stateless MCP bridge from MCP clients to the Codex CLI. | Similar MCP wrapper concept, but intentionally simpler and stateless. |
| [AmirShayegh/codex-claude-bridge](https://github.com/AmirShayegh/codex-claude-bridge) | Claude Code MCP server for sending plans, diffs, and staged changes to Codex for review with structured responses. | Focused review workflow, not general context migration. A good example of a narrow, packaged use case. |
| [Winddfall/CoBridge](https://github.com/Winddfall/CoBridge) | VS Code extension plus browser companion flow that syncs web AI chat context into `.cobridge/AI_CONTEXT.md` and updates agent rule files. | Similar "carry context into the IDE" goal. It is browser/editor sync; can-bridge is CLI/session-adapter centric. |
| [rexleimo/rex-cli](https://github.com/rexleimo/rex-cli) | Local-first workflow layer with browser MCP, privacy guard, and a filesystem ContextDB shared across Codex, Claude, Gemini, and OpenCode. | Significant memory/context overlap, but it is a larger platform with wrappers and a ContextDB rather than a small conversion library. |
| [waelmas/codeplow](https://github.com/waelmas/codeplow) | Agent plugins for persistent project memory, Obsidian-backed KBs, documentation audits, and handoff/onboard loops. | Similar context-rot and handoff problem. It curates project memory, while can-bridge preserves and converts chat/session structure. |
| [ivawzh/agents-md](https://github.com/ivawzh/agents-md) | Composable markdown fragments that generate `AGENTS.md` and optionally interop with `CLAUDE.md`. | Adjacent context-file composition work. Relevant if can-bridge adds generated bootstrap files. |
| [czottmann/render-claude-context](https://github.com/czottmann/render-claude-context) | Renders `CLAUDE.md` hierarchy/imports into processed context files for other agents. | Adjacent context-file conversion. Narrower than session conversion, but useful precedent for safe generated files. |

## What Is Distinct Here

`can-bridge` should not claim to be the first Claude/Codex bridge. That space
already has active projects. The stronger claim is:

> A loss-aware context interchange core for coding agents.

The current differentiators are:

- Extracts and injects real local session files for both Claude Code and Codex.
- Uses a common `NormalizedContext` schema rather than treating one agent as a
  subprocess-only tool.
- Preserves tool-call structure at the adapter boundary:
  `tool_use` / `tool_result` <-> `function_call` /
  `function_call_output`.
- Supports a portable prompt fallback when direct session injection is too
  risky or a vendor format changes.
- Includes an explicit repo-local mailbox for simple agent-to-agent messages.
- Keeps the core small enough that MCP servers, editor extensions, daemon
  bridges, and skill/plugin wrappers can sit on top.

## Product Implications

Near-term positioning:

- Lead with "context adapter engine" and "handoff protocol", not "live bridge".
- Treat live Claude/Codex conversation as a later wrapper around the adapter
  core and mailbox.
- Make `docs/RELATED_PROJECTS.md` part of public-release hygiene so messaging
  stays accurate as this space moves.

Good next product layers:

1. MCP wrapper around the existing CLI, so Claude Code, Cursor, VS Code, and
   other MCP clients can call `list`, `export`, `pipe`, and `mailbox`.
2. Generated context-file export, for example `AI_CONTEXT.md` or
   `AGENT_CONTEXT.md`, with explicit opt-in writes.
3. Watch/daemon mode for the mailbox, with per-project config and clear
   process ownership.
4. Editor extension later, if the product wants the CoBridge-style workflow.
5. Plugin/skill packaging as thin installers around the CLI.

## Security Notes

Related projects show a few design traps to avoid:

- Do not expose unauthenticated localhost write APIs with permissive CORS.
- Do not silently rewrite `AGENTS.md`, `CLAUDE.md`, or other rule files.
- Prefer dry-run output before modifying another agent's context files.
- Keep redaction available whenever exporting or sharing transcripts.
- Make persistent daemons opt-in and easy to stop.
