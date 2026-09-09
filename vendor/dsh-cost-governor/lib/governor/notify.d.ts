/**
 * Fail-soft webhook notifier for budget events. A notification is a best-effort
 * fire-and-forget POST; any failure (no network, non-2xx, timeout) is logged and
 * swallowed — cost governance must never crash the session over a notification.
 *
 * @module dsh-cost-governor/governor
 */
import type { BudgetStatus } from "../types.js";
export declare class Notifier {
    private readonly webhookUrl?;
    constructor(webhookUrl?: string | undefined);
    get enabled(): boolean;
    notify(status: BudgetStatus, kind: "warn" | "over"): Promise<void>;
}
//# sourceMappingURL=notify.d.ts.map