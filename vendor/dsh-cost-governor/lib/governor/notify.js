export class Notifier {
    webhookUrl;
    constructor(webhookUrl) {
        this.webhookUrl = webhookUrl;
    }
    get enabled() {
        return typeof this.webhookUrl === "string" && this.webhookUrl.length > 0;
    }
    async notify(status, kind) {
        if (!this.enabled)
            return;
        const url = this.webhookUrl;
        const emoji = kind === "over" ? "🚨" : "⚠️";
        const payload = {
            text: `${emoji} **DSH budget ${kind}**\n` +
                `Period: ${status.period}\n` +
                `Spent: $${status.spentUsd.toFixed(2)} / $${status.budgetUsd.toFixed(2)} ` +
                `(${(status.ratio * 100).toFixed(1)}%)\n` +
                `Action: ${status.hardAction}`,
        };
        try {
            await fetch(url, {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
                signal: AbortSignal.timeout(5000),
            });
        }
        catch (error) {
            // Fail-soft: never let a notification failure affect the harness.
            console.warn(`[dsh-cost-governor] notify failed: ${String(error)}`);
        }
    }
}
//# sourceMappingURL=notify.js.map