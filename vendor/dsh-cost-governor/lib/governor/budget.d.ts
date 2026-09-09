/**
 * Budget governance: pure status math + a threshold-crossing governor.
 *
 * The governor is deliberately side-effect-light and testable: it computes a
 * `BudgetStatus` from (spent, config) and emits cordis events when the state
 * crosses a warn/hard boundary. Enforcement (blocking new requests / steering
 * to a cheaper model) is exposed as a decision method for the LLM waterfall to
 * consult, so the policy logic stays in one place and the wiring point stays
 * swappable.
 *
 * @module dsh-cost-governor/governor
 */
import type { Context } from "@deepseek-ai/cordis";
import type { BudgetConfig, BudgetStatus } from "../types.js";
/** Declared cordis events this plugin emits (consumed by UI and notifiers). */
declare module "@deepseek-ai/cordis" {
    interface Events {
        /** Emitted whenever the budget state for the active period changes. */
        "usage-cost/budget-status"(status: BudgetStatus): void;
        /** Emitted on the first crossing into `warn`. */
        "usage-cost/budget-warn"(status: BudgetStatus): void;
        /** Emitted on the first crossing into `over`. */
        "usage-cost/budget-over"(status: BudgetStatus): void;
    }
}
export declare function periodKeyOf(period: BudgetConfig["period"], timeMs: number): string;
export declare function computeBudgetStatus(spentUsd: number, budgetUsd: number, config: BudgetConfig): BudgetStatus;
export declare class BudgetGovernor {
    private readonly ctx;
    private readonly config;
    private lastState;
    constructor(ctx: Context, config: BudgetConfig);
    /** Recompute from a fresh spend figure; emits events only on transitions. */
    update(spentUsd: number): BudgetStatus;
    /** Enforcement decision for the request waterfall to consult. */
    gate(status: BudgetStatus): {
        allow: boolean;
        reason?: string;
    };
}
//# sourceMappingURL=budget.d.ts.map