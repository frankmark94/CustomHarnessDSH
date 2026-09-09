/**
 * dsh-cost-governor — cost governance & budget enforcement for DeepSeek Harness.
 *
 * Registers the `costUsage` projection (raw per-model + per-day token buckets)
 * and derives a cost ledger from it: the service seeds from every live session
 * on boot, then follows the projection change feed, so figures survive a
 * restart and never drift from the durable fold.
 *
 * @module dsh-cost-governor
 */
import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { isAgentLoopRequest, } from "@deepseek-ai/dsh-llm";
import { costUsageProjectionDefinition, } from "./projection/cost-usage.js";
import { DEFAULT_PRICE_CATALOG } from "./pricing/catalog.js";
import { CostLedger } from "./governor/ledger.js";
import { BudgetGovernor, periodKeyOf } from "./governor/budget.js";
import { Notifier } from "./governor/notify.js";
export const name = "cost-governor";
const priceSchema = z.object({
    inputPerM: z.number().min(0).required(),
    outputPerM: z.number().min(0).required(),
    cacheReadPerM: z.number().min(0).required(),
    cacheWritePerM: z.number().min(0).required(),
    reasoningPerM: z.number().min(0),
});
const budgetSchema = z.object({
    period: z
        .union([z.const("daily"), z.const("weekly"), z.const("monthly"), z.const("unlimited")])
        .default("monthly"),
    budgetUsd: z.number().min(0).default(20),
    warnRatio: z.number().min(0).max(2).default(0.8),
    hardRatio: z.number().min(0).max(2).default(1.0),
    hardAction: z
        .union([
        z.const("notify-only"),
        z.const("block-new-requests"),
        z.const("steer-to-cheaper-model"),
    ])
        .default("notify-only"),
});
/** Static cordis.yml config schema (schemastery). */
export const Config = z.object({
    currency: z.string().default("USD"),
    budget: budgetSchema.default({
        period: "monthly",
        budgetUsd: 20,
        warnRatio: 0.8,
        hardRatio: 1.0,
        hardAction: "notify-only",
    }),
    notifyWebhook: z.string(),
    priceCatalog: z.dict(priceSchema),
});
export class CostGovernor extends Service {
    static inject = ["sessions", "llm"];
    static Config = Config;
    config;
    catalog;
    ledger;
    governor;
    notifier;
    latestStatus = null;
    constructor(ctx, config) {
        super(ctx, "usageCost");
        this.config = config;
        this.catalog = { ...DEFAULT_PRICE_CATALOG, ...(config.priceCatalog ?? {}) };
        this.ledger = new CostLedger(this.catalog);
        this.governor = new BudgetGovernor(ctx, config.budget);
        this.notifier = new Notifier(config.notifyWebhook);
    }
    async [Service.init]() {
        // Optional projection seam: without it the plugin still loads, but is
        // inert (no data source). Registration, cold-start seed, and the live
        // feed ride a child context that only exists when the seam does.
        this.ctx.inject(["sessionProjections"], (projectionCtx) => {
            projectionCtx.sessionProjections.register(costUsageProjectionDefinition);
            // Cold-start seed: every live session's already-folded view.
            for (const session of this.ctx.sessions.list()) {
                const view = projectionCtx.sessionProjections.snapshot(session).values
                    .costUsage;
                if (view)
                    this.adopt(session.id, session.header.cwd ?? "default", view);
            }
            // Live feed: replace a session's contribution whenever its fold changes.
            projectionCtx.sessionProjections.onChanged((session, key, value) => {
                if (key !== "costUsage")
                    return;
                this.adopt(session.id, session.header.cwd ?? "default", value);
            });
        });
        // Notify on threshold crossings (fail-soft, fire-and-forget).
        this.ctx.on("usage-cost/budget-warn", (s) => void this.notifier.notify(s, "warn"));
        this.ctx.on("usage-cost/budget-over", (s) => void this.notifier.notify(s, "over"));
        // Hard-quota enforcement: short-circuit new model calls when over budget.
        this.ctx.on("llm/stream", (options, next) => {
            const status = this.latestStatus;
            if (!status || !status.blocked)
                return next();
            if (status.hardAction === "steer-to-cheaper-model") {
                // Frozen loop requests cannot be rewritten; steer only hand-built calls.
                const cheaper = isAgentLoopRequest(options) ? null : this.steerToCheaper(options);
                if (cheaper) {
                    options.provider = cheaper.provider;
                    options.model = cheaper.model;
                    return next();
                }
            }
            return this.blockedStream(status);
        });
    }
    /** A single terminal `finish` error chunk that aborts the model call. */
    blockedStream(status) {
        return (async function* () {
            yield {
                type: "finish",
                reason: {
                    kind: "error",
                    failure: {
                        message: `budget exhausted: spent $${status.spentUsd.toFixed(2)} of $${status.budgetUsd.toFixed(2)}`,
                        code: "BUDGET_EXHAUSTED",
                    },
                },
            };
        })();
    }
    /** Cheapest same-provider model in the catalog (by input+output rate). */
    steerToCheaper(options) {
        const prefix = `${options.provider}/`;
        const current = `${options.provider}/${options.model}`;
        let best = null;
        for (const [key, price] of Object.entries(this.catalog)) {
            if (!key.startsWith(prefix) || key === current)
                continue;
            const cost = price.inputPerM + price.outputPerM;
            if (best === null || cost < best.cost)
                best = { key, cost };
        }
        if (!best)
            return null;
        const slash = best.key.indexOf("/");
        return { provider: best.key.slice(0, slash), model: best.key.slice(slash + 1) };
    }
    adopt(sessionId, workspaceKey, view) {
        this.ledger.setSession(sessionId, workspaceKey, view);
        this.latestStatus = this.governor.update(this.currentPeriodSpend());
    }
    /** Sum cost over every ledger day that falls in the current budget period. */
    currentPeriodSpend() {
        const period = this.config.budget.period;
        const nowKey = periodKeyOf(period, Date.now());
        const days = this.ledger
            .dayKeys()
            .filter((d) => periodKeyOf(period, Date.parse(`${d}T00:00:00Z`)) === nowKey);
        return this.ledger.spendAcross(days);
    }
    // ── Public service surface (host consumers; a client Remote wraps these) ──
    budgetStatus() {
        return this.latestStatus;
    }
    globalRollup() {
        return this.ledger.globalRollup();
    }
    sessionRollup(sessionId) {
        return this.ledger.sessionRollup(sessionId);
    }
    exportCsv() {
        return this.ledger.exportCsv();
    }
}
export default CostGovernor;
//# sourceMappingURL=index.js.map