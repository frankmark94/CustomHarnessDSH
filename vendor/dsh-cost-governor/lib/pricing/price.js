import { billedInputTokens } from "../projection/cost-usage.js";
const MILLION = 1_000_000;
/** Cost of one model's buckets under one price entry, in USD. */
export function computeCost(buckets, price) {
    const reasoningRate = price.reasoningPerM ?? price.outputPerM;
    return ((buckets.input / MILLION) * price.inputPerM +
        (buckets.output / MILLION) * price.outputPerM +
        (buckets.cacheRead / MILLION) * price.cacheReadPerM +
        (buckets.cacheWrite / MILLION) * price.cacheWritePerM +
        (buckets.reasoning / MILLION) * reasoningRate);
}
/** Cost of a whole per-model view under a catalog; unknown models price at zero (flagged by caller). */
export function computeViewCost(byModel, catalog) {
    let total = 0;
    const perModel = {};
    const unpriced = [];
    for (const [key, buckets] of Object.entries(byModel)) {
        const price = catalog[key];
        if (price === undefined) {
            unpriced.push(key);
            continue;
        }
        const cost = computeCost(buckets, price);
        perModel[key] = cost;
        total += cost;
    }
    return { total, perModel, unpriced };
}
/** Round to a display-safe cents value (2 decimals, no float dust). */
export function roundUsd(usd) {
    return Math.round((usd + Number.EPSILON) * 100) / 100;
}
/** Total tokens across buckets — used for the "efficiency" stat line. */
export function totalTokens(buckets) {
    return billedInputTokens(buckets) + buckets.output;
}
//# sourceMappingURL=price.js.map