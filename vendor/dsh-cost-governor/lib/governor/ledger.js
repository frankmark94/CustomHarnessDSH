import { emptyBuckets, } from "../projection/cost-usage.js";
import { computeViewCost } from "../pricing/price.js";
function addInto(target, source) {
    for (const [key, buckets] of Object.entries(source)) {
        const prev = target[key] ?? emptyBuckets();
        target[key] = {
            input: prev.input + buckets.input,
            output: prev.output + buckets.output,
            cacheRead: prev.cacheRead + buckets.cacheRead,
            cacheWrite: prev.cacheWrite + buckets.cacheWrite,
            reasoning: prev.reasoning + buckets.reasoning,
        };
    }
}
/** Fold a bucket map into a rollup using the active catalog. */
function rollup(map, catalog) {
    const { total, perModel, unpriced } = computeViewCost(map, catalog);
    const aggregates = Object.entries(map)
        .map(([key, buckets]) => {
        const slash = key.indexOf("/");
        return {
            key,
            provider: slash < 0 ? "" : key.slice(0, slash),
            model: slash < 0 ? key : key.slice(slash + 1),
            buckets,
            costUsd: perModel[key] ?? 0,
            unpriced: perModel[key] === undefined ? [key] : [],
        };
    })
        .sort((a, b) => b.costUsd - a.costUsd);
    let input = 0;
    let output = 0;
    let tokens = 0;
    for (const b of Object.values(map)) {
        input += b.input + b.cacheRead + b.cacheWrite;
        output += b.output;
        tokens += b.input + b.output + b.cacheRead + b.cacheWrite;
    }
    return {
        totalCostUsd: total,
        totalInputTokens: input,
        totalOutputTokens: output,
        totalTokens: tokens,
        byModel: aggregates,
        unpriced,
    };
}
export class CostLedger {
    catalog;
    sessions = new Map();
    constructor(catalog) {
        this.catalog = catalog;
    }
    /** Replace one session's whole contribution (projection view + workspace). */
    setSession(sessionId, workspaceKey, view) {
        this.sessions.set(sessionId, {
            workspaceKey,
            byModel: view.byModel,
            byDay: view.byDay,
        });
    }
    /** Drop a session that left the store. */
    removeSession(sessionId) {
        this.sessions.delete(sessionId);
    }
    byModelTotal() {
        const total = {};
        for (const s of this.sessions.values())
            addInto(total, s.byModel);
        return total;
    }
    byDayTotal() {
        const total = {};
        for (const s of this.sessions.values()) {
            for (const [day, map] of Object.entries(s.byDay)) {
                const t = (total[day] ??= {});
                addInto(t, map);
            }
        }
        return total;
    }
    sessionRollup(sessionId) {
        const s = this.sessions.get(sessionId);
        return rollup(s?.byModel ?? {}, this.catalog);
    }
    globalRollup() {
        return rollup(this.byModelTotal(), this.catalog);
    }
    /** Sum of cost over the given day keys (the current budget period). */
    spendAcross(dayKeys) {
        const byDay = this.byDayTotal();
        let total = 0;
        for (const key of dayKeys) {
            total += computeViewCost(byDay[key] ?? {}, this.catalog).total;
        }
        return total;
    }
    workspaceRollup(workspaceKey) {
        const map = {};
        for (const s of this.sessions.values()) {
            if (s.workspaceKey === workspaceKey)
                addInto(map, s.byModel);
        }
        return rollup(map, this.catalog);
    }
    /** All day keys across every session, sorted ascending. */
    dayKeys() {
        return Object.keys(this.byDayTotal()).sort();
    }
    /** CSV export of the global per-model rollup. */
    exportCsv() {
        const r = this.globalRollup();
        const header = "provider,model,input_tokens,output_tokens,cache_read,cache_write,reasoning,cost_usd";
        const rows = r.byModel.map((m) => [
            m.provider,
            m.model,
            m.buckets.input,
            m.buckets.output,
            m.buckets.cacheRead,
            m.buckets.cacheWrite,
            m.buckets.reasoning,
            m.costUsd.toFixed(4),
        ].join(","));
        return [header, ...rows].join("\n");
    }
}
//# sourceMappingURL=ledger.js.map