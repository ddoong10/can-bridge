export function applyContextBudget(ctx, opts = {}) {
    let working = ctx;
    const stats = {
        sinceCompact: opts.sinceCompact === true,
        droppedMessages: 0,
        droppedRawLines: 0,
        truncatedToolOutputs: 0,
        omittedToolOutputChars: 0,
        nativeIncluded: opts.includeNative !== false && Boolean(ctx.raw),
    };
    if (opts.sinceCompact) {
        const marker = latestCompactMarker(working.raw?.lines);
        if (marker) {
            const messages = filterMessagesAfterCompact(working.messages, marker.timestamp);
            const rawLines = working.raw
                ? working.raw.lines.slice(marker.index + 1)
                : undefined;
            stats.compactedAt = marker.timestamp;
            stats.droppedMessages = working.messages.length - messages.length;
            stats.droppedRawLines = working.raw
                ? working.raw.lines.length - (rawLines?.length ?? 0)
                : 0;
            working = {
                ...working,
                ...(marker.summary ? { summary: mergeSummary(working.summary, marker.summary) } : {}),
                messages,
                ...(working.raw && rawLines
                    ? { raw: { tool: working.raw.tool, lines: rawLines } }
                    : {}),
            };
        }
    }
    if (opts.maxToolOutputChars !== undefined) {
        const truncated = truncateToolOutputs(working.messages, opts.maxToolOutputChars);
        if (truncated.stats.truncatedToolOutputs > 0) {
            working = { ...working, messages: truncated.messages };
            stats.truncatedToolOutputs += truncated.stats.truncatedToolOutputs;
            stats.omittedToolOutputChars += truncated.stats.omittedToolOutputChars;
        }
    }
    if (opts.includeNative === false && working.raw) {
        working = withoutRaw(working);
        stats.nativeIncluded = false;
    }
    else {
        stats.nativeIncluded = Boolean(working.raw);
    }
    return { context: working, stats };
}
function filterMessagesAfterCompact(messages, compactedAt) {
    if (!compactedAt)
        return messages;
    const compactTime = Date.parse(compactedAt);
    if (Number.isNaN(compactTime))
        return messages;
    return messages.filter((m) => {
        if (!m.timestamp)
            return true;
        const messageTime = Date.parse(m.timestamp);
        return Number.isNaN(messageTime) || messageTime > compactTime;
    });
}
function latestCompactMarker(lines) {
    if (!lines || lines.length === 0)
        return null;
    let latest = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line)
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.type !== "compacted")
            continue;
        const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : undefined;
        const payload = entry.payload;
        const summary = payload && typeof payload.message === "string" && payload.message.trim()
            ? payload.message
            : undefined;
        if (!latest) {
            latest = { index: i, timestamp, summary };
            continue;
        }
        if (isLaterCompact({ index: i, timestamp }, latest)) {
            latest = { index: i, timestamp, summary };
        }
    }
    return latest;
}
function isLaterCompact(candidate, current) {
    const ct = candidate.timestamp ? Date.parse(candidate.timestamp) : NaN;
    const rt = current.timestamp ? Date.parse(current.timestamp) : NaN;
    if (!Number.isNaN(ct) && !Number.isNaN(rt) && ct !== rt)
        return ct > rt;
    if (!Number.isNaN(ct) && Number.isNaN(rt))
        return true;
    if (Number.isNaN(ct) && !Number.isNaN(rt))
        return false;
    return candidate.index > current.index;
}
function truncateToolOutputs(messages, maxChars) {
    let truncatedToolOutputs = 0;
    let omittedToolOutputChars = 0;
    const nextMessages = messages.map((message) => {
        let touched = false;
        const content = message.content.map((block) => {
            if (block.type !== "tool_result" || block.output.length <= maxChars) {
                return block;
            }
            touched = true;
            truncatedToolOutputs++;
            omittedToolOutputChars += block.output.length - maxChars;
            return {
                ...block,
                output: truncateMiddle(block.output, maxChars),
            };
        });
        return touched ? { ...message, content } : message;
    });
    return {
        messages: nextMessages,
        stats: { truncatedToolOutputs, omittedToolOutputChars },
    };
}
function truncateMiddle(text, maxChars) {
    const marker = `\n\n[can-bridge: tool output truncated from ${text.length} ` +
        `to ${maxChars} chars; re-run the tool or re-read the file if exact ` +
        `content is needed]\n\n`;
    if (maxChars <= marker.length + 20) {
        return text.slice(0, maxChars) + marker;
    }
    const keep = maxChars - marker.length;
    const head = Math.ceil(keep * 0.65);
    const tail = Math.max(0, keep - head);
    return text.slice(0, head) + marker + (tail > 0 ? text.slice(-tail) : "");
}
function mergeSummary(existing, compacted) {
    const compactedSummary = "Latest source compaction summary (imported by can-bridge):\n" + compacted;
    if (!existing || existing.trim().length === 0)
        return compactedSummary;
    return existing + "\n\n" + compactedSummary;
}
function withoutRaw(ctx) {
    const { raw: _raw, ...rest } = ctx;
    return rest;
}
//# sourceMappingURL=budget.js.map