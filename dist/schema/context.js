/**
 * NormalizedContext — the common format that all adapters convert to and from.
 *
 * Design principle: keep the schema *minimal but lossless*. We'd rather carry
 * an opaque `metadata` blob per message than invent fields we'll regret later.
 * If a target adapter needs source-specific info, it can read from `metadata`.
 */
export {};
//# sourceMappingURL=context.js.map