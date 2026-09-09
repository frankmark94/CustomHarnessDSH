import type { TokenUsage } from "@deepseek-ai/dsh-llm";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
/** Disjoint billing buckets mirrored 1:1 from the harness `TokenUsage`. */
export interface TokenBuckets {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    reasoning: number;
}
/** Raw buckets keyed by `provider/model`. */
export type BucketMap = Record<string, TokenBuckets>;
/** Raw buckets keyed by day (`YYYY-MM-DD`) then by `provider/model`. */
export type DayBucketMap = Record<string, BucketMap>;
/** The projection's public view: raw buckets per model and per day. */
export interface CostUsageView {
    byModel: BucketMap;
    byDay: DayBucketMap;
}
/** An early `usage` chunk sample not yet superseded by a final message. */
interface PendingSample {
    turn: number;
    step: number;
    /** Model that produced the sample (attribution survives a later route change). */
    modelKey: string;
    buckets: TokenBuckets;
}
interface CostUsageState extends CostUsageView {
    /** `provider/model` of the in-flight step's request; null before the first. */
    currentModel: string | null;
    /** Last `usage` chunk for the open step (billed if the step ends without a final sample). */
    pending: PendingSample | null;
}
/** UTC `YYYY-MM-DD` (must match `dayKeyOf` in governor/budget.ts). */
export declare function dayKeyOf(timeMs: number): string;
export declare function billedInputTokens(b: TokenBuckets): number;
export declare function totalOutputTokens(b: TokenBuckets): number;
export declare function totalTokens(b: TokenBuckets): number;
export declare function emptyBuckets(): TokenBuckets;
export declare function modelKey(provider: string, model: string): string;
/** Convert a provider `TokenUsage` sample into disjoint billing buckets. */
export declare function usageToBuckets(usage: TokenUsage): TokenBuckets;
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
export declare const costUsageProjectionDefinition: ProjectionDefinition<"costUsage", CostUsageState>;
declare module "@deepseek-ai/dsh-session-projection/types" {
    interface SessionProjectionMap {
        costUsage: CostUsageView;
    }
}
export {};
//# sourceMappingURL=cost-usage.d.ts.map