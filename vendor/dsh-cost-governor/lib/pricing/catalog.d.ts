/**
 * Built-in default price catalog (USD per 1M tokens).
 *
 * ⚠️  These figures are community-maintained placeholders recorded at authoring
 * time and DO drift. Treat them as sane defaults to be verified against each
 * provider's official price page; every entry is user-overridable via cordis.yml
 * `config.priceCatalog` (merged over this table) or the in-app settings panel.
 *
 * Cache pricing is recorded only where the provider bills it (Anthropic,
 * DeepSeek, OpenAI-compatible gateways). Zero means "not billed separately".
 *
 * @module dsh-cost-governor/pricing
 */
import type { PriceCatalog } from "./price.js";
export declare const DEFAULT_PRICE_CATALOG: PriceCatalog;
//# sourceMappingURL=catalog.d.ts.map