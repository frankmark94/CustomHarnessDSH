/**
 * `costUsage` projection unit: a pure, replay-safe fold of provider-reported
 * token usage into per-model AND per-day raw buckets.
 *
 * The unit stores RAW token buckets only — never currency — so cost is derived
 * at view/query time against the active price catalog and a price-table edit
 * re-prices history without refolding the log. `byDay` (UTC `YYYY-MM-DD`) is
 * the durable input to the period budget; `byModel` is the per-session model
 * breakdown. Both survive compaction and cold reads because the fold is pure.
 *
 * @module dsh-cost-governor/projection
 */
import { z } from "zod";
/** UTC `YYYY-MM-DD` (must match `dayKeyOf` in governor/budget.ts). */
export function dayKeyOf(timeMs) {
    const d = new Date(timeMs);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}
export function billedInputTokens(b) {
    return b.input + b.cacheRead + b.cacheWrite;
}
export function totalOutputTokens(b) {
    return b.output;
}
export function totalTokens(b) {
    return billedInputTokens(b) + b.output;
}
export function emptyBuckets() {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
}
export function modelKey(provider, model) {
    return `${provider}/${model}`;
}
/** Convert a provider `TokenUsage` sample into disjoint billing buckets. */
export function usageToBuckets(usage) {
    return {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cacheReadTokens ?? 0,
        cacheWrite: usage.cacheWriteTokens ?? 0,
        reasoning: usage.reasoningTokens ?? 0,
    };
}
function addBuckets(a, b) {
    return {
        input: a.input + b.input,
        output: a.output + b.output,
        cacheRead: a.cacheRead + b.cacheRead,
        cacheWrite: a.cacheWrite + b.cacheWrite,
        reasoning: a.reasoning + b.reasoning,
    };
}
const bucketsSchema = z
    .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    reasoning: z.number().nonnegative(),
})
    .strict();
const pendingSchema = z
    .object({
    turn: z.number().int().nonnegative(),
    step: z.number().int().nonnegative(),
    modelKey: z.string(),
    buckets: bucketsSchema,
})
    .strict();
const stateSchema = z
    .object({
    byModel: z.record(z.string(), bucketsSchema),
    byDay: z.record(z.string(), z.record(z.string(), bucketsSchema)),
    currentModel: z.string().nullable(),
    pending: pendingSchema.nullable(),
})
    .strict();
function commit(state, modelKey, buckets, dayKey) {
    const prevModel = state.byModel[modelKey] ?? emptyBuckets();
    const byModel = { ...state.byModel, [modelKey]: addBuckets(prevModel, buckets) };
    const dayMap = state.byDay[dayKey] ?? {};
    const prevDay = dayMap[modelKey] ?? emptyBuckets();
    const byDay = {
        ...state.byDay,
        [dayKey]: { ...dayMap, [modelKey]: addBuckets(prevDay, buckets) },
    };
    return { ...state, byModel, byDay };
}
/**
 * Model attribution: `request/context` (`{ provider, model }`) and
 * `request/header` (`header.config.provider/model`) are both logged before
 * dispatch, so by the time the matching `assistant/message` lands, the last
 * observed model is the one that produced the usage.
 *
 * Usage accounting: only the FINAL `assistant/message` sample is counted (the
 * step's usage travels with the assembled message). Failed/cancelled steps are
 * picked up by the `pending` early-sample path (see stateVersion 3), not here.
 */
export const costUsageProjectionDefinition = {
    key: "costUsage",
    schema: stateSchema,
    init: () => ({ byModel: {}, byDay: {}, currentModel: null, pending: null }),
    apply: (state, event) => {
        switch (event.type) {
            case "request/context":
                return {
                    ...state,
                    currentModel: modelKey(event.data.provider, event.data.model),
                };
            case "request/header": {
                const cfg = event.data.header.config;
                return { ...state, currentModel: modelKey(cfg.provider, cfg.model) };
            }
            case "assistant/chunk": {
                const chunk = event.data.chunk;
                if (chunk.type !== "usage" || state.currentModel === null)
                    return state;
                // Commit a still-pending sample from a DIFFERENT step (defensive; the
                // step/end finally normally clears it first), then hold this step's
                // early sample until its message or step-end.
                let next = state;
                if (state.pending !== null &&
                    (state.pending.turn !== event.data.turn || state.pending.step !== event.data.step)) {
                    next = commit(state, state.pending.modelKey, state.pending.buckets, dayKeyOf(event.time));
                }
                return {
                    ...next,
                    pending: {
                        turn: event.data.turn,
                        step: event.data.step,
                        modelKey: state.currentModel,
                        buckets: usageToBuckets(chunk.usage),
                    },
                };
            }
            case "assistant/message": {
                const usage = event.data.usage;
                if (state.currentModel === null)
                    return state;
                if (usage !== undefined) {
                    // Final sample replaces the early chunk sample.
                    return {
                        ...commit(state, state.currentModel, usageToBuckets(usage), dayKeyOf(event.time)),
                        pending: null,
                    };
                }
                // No final sample (max-tokens / aborted): bill the early sample if any.
                if (state.pending !== null &&
                    state.pending.turn === event.data.turn &&
                    state.pending.step === event.data.step) {
                    return {
                        ...commit(state, state.pending.modelKey, state.pending.buckets, dayKeyOf(event.time)),
                        pending: null,
                    };
                }
                return state;
            }
            case "step/end": {
                // A step closed without ever assembling a message: bill its early sample.
                if (state.pending === null)
                    return state;
                return {
                    ...commit(state, state.pending.modelKey, state.pending.buckets, dayKeyOf(event.time)),
                    pending: null,
                };
            }
            default:
                return state;
        }
    },
    view: (state) => ({ byModel: state.byModel, byDay: state.byDay }),
    stateVersion: 3,
};
//# sourceMappingURL=cost-usage.js.map