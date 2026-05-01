import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
/**
 * Codex CLI sessions live at:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl
 *
 * Verified line shapes (2026-04-30, Codex CLI 0.125.0):
 *
 *   {timestamp, type:"session_meta",
 *    payload:{id, timestamp, cwd, originator, cli_version, source,
 *             model_provider, base_instructions:{text}}}
 *
 *   {timestamp, type:"response_item",
 *    payload:{type:"message", role:"user"|"assistant"|"developer",
 *             content:[{type:"input_text"|"output_text", text}]}}
 *
 *   {timestamp, type:"response_item",
 *    payload:{type:"function_call", name, arguments:string-JSON, call_id}}
 *
 *   {timestamp, type:"response_item",
 *    payload:{type:"function_call_output", call_id, output:string}}
 *
 *   {timestamp, type:"event_msg", payload:{type:"user_message"|"task_started"|
 *             "task_complete"|"token_count"|"error", ...}}
 *
 *   {timestamp, type:"turn_context", payload:{model, reasoning_effort, ...}}
 */
const CODEX_SESSIONS_DIR = path.join(os.homedir(), ".codex", "sessions");
export class CodexAdapter {
    id = "codex";
    // ─── SourceAdapter ────────────────────────────────────────────────
    async extract(locator) {
        const filePath = await this.resolveSessionPath(locator);
        const raw = await fs.readFile(filePath, "utf8");
        const lines = raw.split("\n").filter((l) => l.trim().length > 0);
        const messages = [];
        let sessionId;
        let model;
        let capturedAt;
        let cwd;
        let summary;
        for (const line of lines) {
            let entry;
            try {
                entry = JSON.parse(line);
            }
            catch {
                continue;
            }
            const type = entry.type;
            const payload = entry.payload;
            const ts = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
            capturedAt ??= ts;
            if (type === "session_meta" && payload) {
                if (typeof payload.id === "string")
                    sessionId = payload.id;
                if (typeof payload.cwd === "string")
                    cwd = payload.cwd;
                const bi = payload.base_instructions;
                if (bi && typeof bi.text === "string" && bi.text.length > 0) {
                    summary ??= bi.text;
                }
                continue;
            }
            if (type === "turn_context" && payload) {
                if (typeof payload.model === "string")
                    model ??= payload.model;
                continue;
            }
            if (type === "response_item" && payload) {
                const msg = responseItemToMessage(payload, ts);
                if (msg)
                    messages.push(msg);
                continue;
            }
            // event_msg, etc → skip (user_message duplicates response_item;
            // task_started/complete/token_count are runtime events).
        }
        return {
            schemaVersion: "0.1",
            source: { tool: "codex", model, sessionId, capturedAt, cwd },
            summary,
            messages,
            metadata: { sourceFile: filePath },
        };
    }
    async listSessions() {
        const out = [];
        await walkRollouts(CODEX_SESSIONS_DIR, async (file, stat) => {
            const m = file.match(/-([0-9a-f-]{36})\.jsonl$/i);
            if (m && m[1])
                out.push({ id: m[1], updatedAt: stat.mtime.toISOString() });
        });
        return out;
    }
    async resolveSessionPath(locator) {
        if (!locator) {
            throw new Error("codex: --session is required (UUID or .jsonl path)");
        }
        if (locator.endsWith(".jsonl"))
            return locator;
        let found = null;
        await walkRollouts(CODEX_SESSIONS_DIR, async (file, _stat, fullPath) => {
            if (!found && file.includes(locator))
                found = fullPath;
        });
        if (found)
            return found;
        throw new Error(`Could not find Codex rollout for "${locator}" under ${CODEX_SESSIONS_DIR}`);
    }
    // ─── TargetAdapter ────────────────────────────────────────────────
    async inject(context) {
        const now = new Date();
        const yyyy = String(now.getUTCFullYear());
        const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
        const dd = String(now.getUTCDate()).padStart(2, "0");
        const dir = path.join(CODEX_SESSIONS_DIR, yyyy, mm, dd);
        await fs.mkdir(dir, { recursive: true });
        const sessionId = crypto.randomUUID();
        const ts = now.toISOString().replace(/[:.]/g, "-");
        const filePath = path.join(dir, `rollout-${ts}-${sessionId}.jsonl`);
        const lines = buildCodexJsonl(context, sessionId, now);
        await fs.writeFile(filePath, lines.join("\n") + "\n", "utf8");
        // Pre-register the thread row so `codex resume <id>` (TUI) finds it
        // immediately. Without this, TUI resume looks the id up in
        // ~/.codex/state_5.sqlite first and fails with "No saved session
        // found"; only `codex exec resume` was bootstrapping the row before.
        const sqliteResult = await tryRegisterCodexThread({
            sessionId,
            filePath,
            context,
        });
        const sqliteNote = sqliteResult.ok
            ? `(Pre-registered in ~/.codex/state_5.sqlite — TUI resume works immediately.)`
            : `(Could not pre-register in sqlite: ${sqliteResult.error}.\n` +
                `   First TUI resume may say "No saved session found"; bootstrap once with:\n` +
                `     codex exec --skip-git-repo-check resume ${sessionId} "ping"\n` +
                `   On Node 22.x, set NODE_OPTIONS=--experimental-sqlite to enable auto-registration.)`;
        return {
            locator: filePath,
            hint: `Resume in a real terminal (TUI):\n` +
                `  codex resume ${sessionId}\n` +
                `${sqliteNote}\n` +
                `\n` +
                `Or run a single non-interactive turn (verified working):\n` +
                `  codex exec --skip-git-repo-check resume ${sessionId} "<your prompt>"\n` +
                `\n` +
                `If resume rejects the file (rare; format may have changed), use the prompt fallback:\n` +
                `  can-bridge pipe --from <src> --session <id> --to codex --as-prompt > seed.md`,
            details: {
                sessionId,
                filePath,
                sqliteRegistered: sqliteResult.ok,
            },
        };
    }
}
const CODEX_STATE_DB = path.join(os.homedir(), ".codex", "state_5.sqlite");
async function tryRegisterCodexThread(opts) {
    // node:sqlite is built-in but requires --experimental-sqlite on Node 22.x
    // (stable on Node 23+). If the import fails for any reason — flag missing,
    // older Node, etc. — silently degrade: the rollout file is still written,
    // and `codex exec resume` will bootstrap the row on first use.
    let DatabaseSync;
    try {
        ({ DatabaseSync } = await import("node:sqlite"));
    }
    catch (err) {
        return {
            ok: false,
            error: `node:sqlite not loadable (${err instanceof Error ? err.message : String(err)})`,
        };
    }
    try {
        await fs.access(CODEX_STATE_DB);
    }
    catch {
        return { ok: false, error: "state_5.sqlite not found (codex never run on this machine?)" };
    }
    let db;
    try {
        db = new DatabaseSync(CODEX_STATE_DB);
        const cwd = opts.context.source.cwd ?? process.cwd();
        const firstUser = findFirstUserText(opts.context) ?? "";
        const title = firstUser.slice(0, 200);
        const nowSec = Math.floor(Date.now() / 1000);
        const nowMs = Date.now();
        db.prepare(`INSERT OR REPLACE INTO threads (
        id, rollout_path, created_at, updated_at, source, model_provider,
        cwd, title, sandbox_policy, approval_mode, tokens_used,
        has_user_event, archived, cli_version, first_user_message,
        memory_mode, model, created_at_ms, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(opts.sessionId, opts.filePath, nowSec, nowSec, "can-bridge-import", "openai", cwd, title, '{"type":"read-only"}', "on-request", 0, 0, 0, "0.0.1", firstUser, "enabled", opts.context.source.model ?? null, nowMs, nowMs);
        return { ok: true };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
    finally {
        db?.close();
    }
}
function findFirstUserText(ctx) {
    for (const m of ctx.messages) {
        if (m.role !== "user")
            continue;
        for (const b of m.content) {
            if (b.type === "text" && b.text.length > 0)
                return b.text;
        }
    }
    return null;
}
// ─── helpers ─────────────────────────────────────────────────────────
async function walkRollouts(root, visit) {
    let years;
    try {
        years = await fs.readdir(root);
    }
    catch {
        return;
    }
    for (const y of years) {
        const yPath = path.join(root, y);
        let months;
        try {
            months = await fs.readdir(yPath);
        }
        catch {
            continue;
        }
        for (const m of months) {
            const mPath = path.join(yPath, m);
            let days;
            try {
                days = await fs.readdir(mPath);
            }
            catch {
                continue;
            }
            for (const d of days) {
                const dPath = path.join(mPath, d);
                let files;
                try {
                    files = await fs.readdir(dPath);
                }
                catch {
                    continue;
                }
                for (const f of files) {
                    if (!f.startsWith("rollout-") || !f.endsWith(".jsonl"))
                        continue;
                    const full = path.join(dPath, f);
                    const stat = await fs.stat(full);
                    await visit(f, stat, full);
                }
            }
        }
    }
}
function responseItemToMessage(payload, ts) {
    const itemType = payload.type;
    if (itemType === "message") {
        const role = payload.role;
        const content = payload.content;
        if (!Array.isArray(content))
            return null;
        let normRole;
        if (role === "user")
            normRole = "user";
        else if (role === "assistant")
            normRole = "assistant";
        else if (role === "developer" || role === "system")
            normRole = "system";
        else
            return null;
        const blocks = [];
        for (const c of content) {
            if (!c || typeof c !== "object")
                continue;
            const cb = c;
            const t = cb.type;
            if ((t === "input_text" || t === "output_text") &&
                typeof cb.text === "string" &&
                cb.text.length > 0) {
                blocks.push({ type: "text", text: cb.text });
            }
        }
        if (blocks.length === 0)
            return null;
        return { role: normRole, content: blocks, timestamp: ts };
    }
    if (itemType === "function_call") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const name = typeof payload.name === "string" ? payload.name : "unknown";
        let input = undefined;
        if (typeof payload.arguments === "string") {
            try {
                input = JSON.parse(payload.arguments);
            }
            catch {
                input = payload.arguments;
            }
        }
        else {
            input = payload.arguments;
        }
        return {
            role: "assistant",
            content: [{ type: "tool_use", id: callId, name, input }],
            timestamp: ts,
        };
    }
    if (itemType === "function_call_output") {
        const callId = typeof payload.call_id === "string" ? payload.call_id : undefined;
        const rawOutput = typeof payload.output === "string"
            ? payload.output
            : JSON.stringify(payload.output);
        // The inject side encodes Anthropic isError:true by prefixing "[error] ".
        // Decode it back so a Codex → Norm → ... round-trip is lossless.
        const errorPrefix = "[error] ";
        const isError = rawOutput.startsWith(errorPrefix);
        const output = isError ? rawOutput.slice(errorPrefix.length) : rawOutput;
        return {
            role: "user",
            content: [
                { type: "tool_result", toolUseId: callId, output, isError },
            ],
            timestamp: ts,
        };
    }
    return null;
}
function buildCodexJsonl(context, sessionId, now) {
    const out = [];
    const ts = now.toISOString();
    const cwd = context.source.cwd ?? process.cwd();
    out.push(JSON.stringify({
        timestamp: ts,
        type: "session_meta",
        payload: {
            id: sessionId,
            timestamp: ts,
            cwd,
            originator: "can-bridge",
            cli_version: "0.2.0",
            source: "can-bridge-import",
            model_provider: "openai",
            base_instructions: { text: buildBaseInstructions(context) },
        },
    }));
    for (const msg of context.messages) {
        const items = messageToResponseItems(msg);
        for (const item of items) {
            out.push(JSON.stringify({
                timestamp: msg.timestamp ?? ts,
                type: "response_item",
                payload: item,
            }));
        }
        if (msg.role === "user") {
            const text = textOf(msg);
            if (text) {
                out.push(JSON.stringify({
                    timestamp: msg.timestamp ?? ts,
                    type: "event_msg",
                    payload: {
                        type: "user_message",
                        message: text,
                        images: [],
                        local_images: [],
                        text_elements: [],
                    },
                }));
            }
        }
    }
    return out;
}
function buildBaseInstructions(ctx) {
    const lines = [];
    lines.push(`This session was imported from ${ctx.source.tool}` +
        (ctx.source.model ? ` (original model: ${ctx.source.model})` : "") +
        ".");
    if (ctx.source.sessionId) {
        lines.push(`Original session id: ${ctx.source.sessionId}`);
    }
    if (ctx.summary) {
        lines.push("");
        lines.push("Summary of prior conversation:");
        lines.push(ctx.summary);
    }
    return lines.join("\n");
}
function messageToResponseItems(msg) {
    const items = [];
    // 1. Plain text (and optional thinking) → one message item.
    const textChunks = [];
    for (const b of msg.content) {
        if (b.type === "text")
            textChunks.push(b.text);
        // thinking blocks deliberately dropped — internal to source model.
    }
    if (textChunks.length > 0) {
        let role = "user";
        if (msg.role === "assistant")
            role = "assistant";
        else if (msg.role === "system")
            role = "developer";
        const blockType = role === "assistant" ? "output_text" : "input_text";
        items.push({
            type: "message",
            role,
            content: [{ type: blockType, text: textChunks.join("\n\n") }],
        });
    }
    // 2. Each tool_use → function_call item.
    for (const b of msg.content) {
        if (b.type === "tool_use") {
            items.push({
                type: "function_call",
                name: b.name,
                arguments: typeof b.input === "string"
                    ? b.input
                    : JSON.stringify(b.input ?? {}),
                call_id: b.id ?? `call_${crypto.randomUUID().replace(/-/g, "")}`,
            });
        }
    }
    // 3. Each tool_result → function_call_output item.
    for (const b of msg.content) {
        if (b.type === "tool_result") {
            const prefix = b.isError ? "[error] " : "";
            items.push({
                type: "function_call_output",
                call_id: b.toolUseId ?? "",
                output: prefix + b.output,
            });
        }
    }
    return items;
}
function textOf(msg) {
    return msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n\n")
        .trim();
}
//# sourceMappingURL=codex.js.map