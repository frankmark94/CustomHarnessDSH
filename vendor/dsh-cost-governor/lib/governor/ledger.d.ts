/**
 * Cost ledger — a DERIVED aggregate over the `costUsage` projection.
 *
 * The ledger holds one contribution per live session (its `byModel`/`byDay`
 * view + workspace key), set wholesale from the projection change feed and
 * seeded on cold start. Every rollup is computed on demand by summing those
 * contributions against the active price catalog, so there is exactly one
 * source of truth (the projection) and no parallel fold to drift.
 *
 * @module dsh-cost-governor/governor
 */
import type { SessionId } from "@deepseek-ai/dsh-session";
import { type CostUsageView } from "../projection/cost-usage.js";
import { type PriceCatalog } from "../pricing/price.js";
import type { CostRollup } from "../types.js";
export declare class CostLedger {
    private readonly catalog;
    private sessions;
    constructor(catalog: PriceCatalog);
    /** Replace one session's whole contribution (projection view + workspace). */
    setSession(sessionId: SessionId, workspaceKey: string, view: CostUsageView): void;
    /** Drop a session that left the store. */
    removeSession(sessionId: SessionId): void;
    private byModelTotal;
    private byDayTotal;
    sessionRollup(sessionId: SessionId): CostRollup;
    globalRollup(): CostRollup;
    /** Sum of cost over the given day keys (the current budget period). */
    spendAcross(dayKeys: string[]): number;
    workspaceRollup(workspaceKey: string): CostRollup;
    /** All day keys across every session, sorted ascending. */
    dayKeys(): string[];
    /** CSV export of the global per-model rollup. */
    exportCsv(): string;
}
//# sourceMappingURL=ledger.d.ts.map