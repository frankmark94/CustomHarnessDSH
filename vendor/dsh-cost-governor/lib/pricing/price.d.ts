/**
 * Pure pricing math: raw token buckets × a per-model price → USD.
 * No side effects, no config reads — the single choke point every consumer
 * (host service, client dashboard, CSV export) shares so numbers always agree.
 *
 * @module dsh-cost-governor/pricing
 */
import type { TokenBuckets } from "../projection/cost-usage.js";
/** Per-1M-token USD price for one provider/model route. */
export interface ModelPrice {
    /** USD per 1M uncached input tokens. */
    inputPerM: number;
    /** USD per 1M output tokens. */
    outputPerM: number;
    /** USD per 1M cache-read tokens. */
    cacheReadPerM: number;
    /** USD per 1M cache-write tokens. */
    cacheWritePerM: number;
    /** Optional USD per 1M reasoning tokens; falls back to `outputPerM`. */
    reasoningPerM?: number;
}
/** `provider/model` → price. */
export type PriceCatalog = Record<string, ModelPrice>;
/** Cost of one model's buckets under one price entry, in USD. */
export declare function computeCost(buckets: TokenBuckets, price: ModelPrice): number;
/** Cost of a whole per-model view under a catalog; unknown models price at zero (flagged by caller). */
export declare function computeViewCost(byModel: Record<string, TokenBuckets>, catalog: PriceCatalog): {
    total: number;
    perModel: Record<string, number>;
    unpriced: string[];
};
/** Round to a display-safe cents value (2 decimals, no float dust). */
export declare function roundUsd(usd: number): number;
/** Total tokens across buckets — used for the "efficiency" stat line. */
export declare function totalTokens(buckets: TokenBuckets): number;
//# sourceMappingURL=price.d.ts.map