const PATTERNS = [
    { kind: "anthropic-key", re: /sk-ant-[A-Za-z0-9_\-]{20,}/g },
    // OpenAI keys but NOT the sk-ant- form — negative lookahead.
    { kind: "openai-key", re: /sk-(?!ant-)[A-Za-z0-9_\-]{20,}/g },
    { kind: "github-pat", re: /gh[psoru]_[A-Za-z0-9]{36,}/g },
    { kind: "aws-access-key", re: /\bAKIA[A-Z0-9]{16}\b/g },
    { kind: "google-api-key", re: /\bAIza[A-Za-z0-9_\-]{35}\b/g },
    { kind: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9\-]{10,}/g },
    {
        kind: "jwt",
        re: /\beyJ[A-Za-z0-9_\-]{8,}\.eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g,
    },
    {
        kind: "bearer",
        re: /\bBearer\s+([A-Za-z0-9_\-\.]{20,})\b/g,
        group: 1,
    },
    // key=value pairs where the key looks sensitive.
    {
        kind: "kv-secret",
        re: /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?([^"'\s,;}]{8,})/gi,
        group: 1,
    },
];
export function redactText(input) {
    if (!input)
        return input;
    let out = input;
    for (const p of PATTERNS) {
        if (p.group != null) {
            const groupIndex = p.group;
            out = out.replace(p.re, (match, ...rest) => {
                // rest layout: capture groups, then offset, then full string
                // The capture we want is at index group-1 of the captures array.
                const captured = rest[groupIndex - 1];
                if (typeof captured !== "string")
                    return match;
                return match.replace(captured, `[REDACTED:${p.kind}]`);
            });
        }
        else {
            out = out.replace(p.re, `[REDACTED:${p.kind}]`);
        }
    }
    return out;
}
/** Returns a deep-copied, redacted clone — does not mutate the input. */
export function redactContext(ctx) {
    const messages = ctx.messages.map((m) => ({
        role: m.role,
        timestamp: m.timestamp,
        metadata: m.metadata,
        content: m.content.map(redactBlock),
    }));
    return {
        ...ctx,
        summary: ctx.summary ? redactText(ctx.summary) : ctx.summary,
        messages,
    };
}
function redactBlock(b) {
    if (b.type === "text")
        return { type: "text", text: redactText(b.text) };
    if (b.type === "thinking") {
        return { type: "thinking", text: redactText(b.text) };
    }
    if (b.type === "tool_use") {
        return {
            type: "tool_use",
            id: b.id,
            name: b.name,
            input: redactDeep(b.input),
        };
    }
    if (b.type === "tool_result") {
        return {
            type: "tool_result",
            toolUseId: b.toolUseId,
            output: redactText(b.output),
            isError: b.isError,
        };
    }
    return b;
}
function redactDeep(v) {
    if (typeof v === "string")
        return redactText(v);
    if (Array.isArray(v))
        return v.map(redactDeep);
    if (v && typeof v === "object") {
        const out = {};
        for (const [k, val] of Object.entries(v)) {
            out[k] = redactDeep(val);
        }
        return out;
    }
    return v;
}
//# sourceMappingURL=redactor.js.map