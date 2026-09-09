/**
 * ui-fixes — host half.
 *
 * Nothing to do on the host: this plugin exists so the harness's client-module
 * registry finds `package.json` → `dsh.client` and serves `client.js`, which
 * injects CSS overrides for third-party UI plugins. See client.js.
 */
import z from '@deepseek-ai/schemastery';

export const name = 'ui-fixes';
export const inject = [];
export const Config = z.object({});

export function apply(ctx) {
  ctx.logger.info('ui-fixes: ready (client-side CSS overrides only)');
}
