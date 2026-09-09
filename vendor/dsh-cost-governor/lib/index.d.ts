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
import { Service, type Context } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import type { SessionId } from "@deepseek-ai/dsh-session";
import type { ModelPrice } from "./pricing/price.js";
import type { BudgetConfig, BudgetStatus } from "./types.js";
export declare const name = "cost-governor";
/** Static cordis.yml config schema (schemastery). */
export declare const Config: z<Schemastery.ObjectS<{
    currency: z<string, string>;
    budget: z<Schemastery.ObjectS<{
        period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
        budgetUsd: z<number, number>;
        warnRatio: z<number, number>;
        hardRatio: z<number, number>;
        hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
    }>, Schemastery.ObjectT<{
        period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
        budgetUsd: z<number, number>;
        warnRatio: z<number, number>;
        hardRatio: z<number, number>;
        hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
    }>>;
    notifyWebhook: z<string, string>;
    priceCatalog: z<import("@deepseek-ai/cosmokit").Dict<{
        inputPerM?: number | null | undefined;
        outputPerM?: number | null | undefined;
        cacheReadPerM?: number | null | undefined;
        cacheWritePerM?: number | null | undefined;
        reasoningPerM?: number | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        inputPerM: z<number, number>;
        outputPerM: z<number, number>;
        cacheReadPerM: z<number, number>;
        cacheWritePerM: z<number, number>;
        reasoningPerM: z<number, number>;
    }>, string>>;
}>, Schemastery.ObjectT<{
    currency: z<string, string>;
    budget: z<Schemastery.ObjectS<{
        period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
        budgetUsd: z<number, number>;
        warnRatio: z<number, number>;
        hardRatio: z<number, number>;
        hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
    }>, Schemastery.ObjectT<{
        period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
        budgetUsd: z<number, number>;
        warnRatio: z<number, number>;
        hardRatio: z<number, number>;
        hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
    }>>;
    notifyWebhook: z<string, string>;
    priceCatalog: z<import("@deepseek-ai/cosmokit").Dict<{
        inputPerM?: number | null | undefined;
        outputPerM?: number | null | undefined;
        cacheReadPerM?: number | null | undefined;
        cacheWritePerM?: number | null | undefined;
        reasoningPerM?: number | null | undefined;
    } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
        inputPerM: z<number, number>;
        outputPerM: z<number, number>;
        cacheReadPerM: z<number, number>;
        cacheWritePerM: z<number, number>;
        reasoningPerM: z<number, number>;
    }>, string>>;
}>>;
/** Validated config shape received by the service. */
export interface CostGovernorConfig {
    currency: string;
    budget: BudgetConfig;
    notifyWebhook?: string;
    priceCatalog?: Record<string, ModelPrice>;
}
export declare class CostGovernor extends Service {
    static inject: string[];
    static Config: z<Schemastery.ObjectS<{
        currency: z<string, string>;
        budget: z<Schemastery.ObjectS<{
            period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
            budgetUsd: z<number, number>;
            warnRatio: z<number, number>;
            hardRatio: z<number, number>;
            hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
        }>, Schemastery.ObjectT<{
            period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
            budgetUsd: z<number, number>;
            warnRatio: z<number, number>;
            hardRatio: z<number, number>;
            hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
        }>>;
        notifyWebhook: z<string, string>;
        priceCatalog: z<import("@deepseek-ai/cosmokit").Dict<{
            inputPerM?: number | null | undefined;
            outputPerM?: number | null | undefined;
            cacheReadPerM?: number | null | undefined;
            cacheWritePerM?: number | null | undefined;
            reasoningPerM?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            inputPerM: z<number, number>;
            outputPerM: z<number, number>;
            cacheReadPerM: z<number, number>;
            cacheWritePerM: z<number, number>;
            reasoningPerM: z<number, number>;
        }>, string>>;
    }>, Schemastery.ObjectT<{
        currency: z<string, string>;
        budget: z<Schemastery.ObjectS<{
            period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
            budgetUsd: z<number, number>;
            warnRatio: z<number, number>;
            hardRatio: z<number, number>;
            hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
        }>, Schemastery.ObjectT<{
            period: z<"daily" | "weekly" | "monthly" | "unlimited", "daily" | "weekly" | "monthly" | "unlimited">;
            budgetUsd: z<number, number>;
            warnRatio: z<number, number>;
            hardRatio: z<number, number>;
            hardAction: z<"notify-only" | "block-new-requests" | "steer-to-cheaper-model", "notify-only" | "block-new-requests" | "steer-to-cheaper-model">;
        }>>;
        notifyWebhook: z<string, string>;
        priceCatalog: z<import("@deepseek-ai/cosmokit").Dict<{
            inputPerM?: number | null | undefined;
            outputPerM?: number | null | undefined;
            cacheReadPerM?: number | null | undefined;
            cacheWritePerM?: number | null | undefined;
            reasoningPerM?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict, string>, import("@deepseek-ai/cosmokit").Dict<Schemastery.ObjectT<{
            inputPerM: z<number, number>;
            outputPerM: z<number, number>;
            cacheReadPerM: z<number, number>;
            cacheWritePerM: z<number, number>;
            reasoningPerM: z<number, number>;
        }>, string>>;
    }>>;
    private readonly config;
    private readonly catalog;
    private readonly ledger;
    private readonly governor;
    private readonly notifier;
    private latestStatus;
    constructor(ctx: Context, config: CostGovernorConfig);
    [Service.init](): Promise<void>;
    /** A single terminal `finish` error chunk that aborts the model call. */
    private blockedStream;
    /** Cheapest same-provider model in the catalog (by input+output rate). */
    private steerToCheaper;
    private adopt;
    /** Sum cost over every ledger day that falls in the current budget period. */
    private currentPeriodSpend;
    budgetStatus(): BudgetStatus | null;
    globalRollup(): import("./types.js").CostRollup;
    sessionRollup(sessionId: SessionId): import("./types.js").CostRollup;
    exportCsv(): string;
}
export default CostGovernor;
//# sourceMappingURL=index.d.ts.map