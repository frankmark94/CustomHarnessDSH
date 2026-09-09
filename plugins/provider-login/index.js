/**
 * provider-login — host half.
 *
 * The harness's pi-ai adapter registers an *authorization flow* for every
 * catalog provider that ships a login (GitHub Copilot's is GitHub's OAuth
 * device-code flow: "enter this code on github.com/login/device"). The seam
 * (`ctx.authorization`) owns the conversation, but nothing in this web build
 * ever starts it — the Models page only offers an API-key box. This plugin is
 * the missing surface:
 *
 *   GET  /provider-login/flows            registered flows + whether a grant is stored
 *   POST /provider-login/begin?key&method  start an attempt (returns at once; poll status)
 *   GET  /provider-login/status?key        notices so far (message / url / code), pending prompt, outcome
 *   POST /provider-login/answer?key        { value } | { decline: true } for a pending prompt
 *   POST /provider-login/cancel?key        withdraw the running attempt
 *   POST /provider-login/signout?key       delete the stored grant
 *
 * plus `/login <provider>` in the chat for the same thing in text form.
 *
 * Guards as git-lens: connection.requestRejection (Host fence + signed
 * browser-session cookie). Notices never carry secrets by contract; the grant
 * itself is written by the flow through the credentials service.
 */
import { AuthorizationDeclinedError } from '@deepseek-ai/dsh-authorization';
import z from '@deepseek-ai/schemastery';

export const name = 'provider-login';
export const inject = ['authorization', 'webServer'];

export const Config = z.object({
  prefix: z.string().default('/provider-login'),
  /** How long a finished attempt's status stays readable (ms). */
  retainMs: z.natural().default(10 * 60 * 1000),
});

const keyId = (key) => String(key).slice(String(key).indexOf('/') + 1);
const keyScope = (key) => String(key).slice(0, String(key).indexOf('/'));

export function apply(ctx, config = {}) {
  const routePath = config.prefix.replace(/\/+$/, '');
  /** key → attempt state (plain JSON + the pending prompt's resolver). */
  const attempts = new Map();

  function fresh(key, method) {
    return { key, method, status: 'running', startedAt: Date.now(), notices: [], prompt: null, settledAt: null, error: null, resolvePrompt: null };
  }
  const publicState = (a) => a && ({ key: a.key, method: a.method, status: a.status, startedAt: a.startedAt, settledAt: a.settledAt, notices: a.notices, prompt: a.prompt, error: a.error });

  async function hasGrant(key) {
    try { return (await ctx.get('credentials')?.readRecord?.(key)) !== undefined; } catch { return false; }
  }

  async function flows() {
    const out = [];
    for (const f of ctx.authorization.list()) {
      out.push({ key: f.key, providerId: keyId(f.key), scope: keyScope(f.key), label: f.label, methods: f.methods, inFlight: f.inFlight, signedIn: await hasGrant(f.key), attempt: publicState(attempts.get(f.key)) });
    }
    return out;
  }

  function begin(key, method) {
    const existing = attempts.get(key);
    if (existing?.status === 'running') return existing;
    const a = fresh(key, method);
    attempts.set(key, a);
    const interaction = {
      notify: (notice) => { a.notices.push({ at: Date.now(), message: notice.message, url: notice.url ?? null, code: notice.code ?? null }); },
      prompt: (prompt) => new Promise((resolve, reject) => {
        a.prompt = { kind: prompt.kind, message: prompt.message, placeholder: prompt.placeholder ?? null, options: prompt.options ?? null };
        a.resolvePrompt = { resolve, reject };
        prompt.signal?.addEventListener('abort', () => { a.prompt = null; a.resolvePrompt = null; reject(prompt.signal.reason ?? new Error('prompt withdrawn')); }, { once: true });
      }),
    };
    ctx.authorization.begin({ key, method, interaction }).then((outcome) => {
      a.status = outcome.status; a.settledAt = Date.now();
      ctx.logger.info(`provider-login: ${key} ${outcome.status}`);
    }, (error) => {
      a.status = 'failed'; a.settledAt = Date.now(); a.error = String(error?.message ?? error);
      ctx.logger.warn(`provider-login: ${key} failed: ${a.error}`);
    }).finally(() => { a.prompt = null; a.resolvePrompt = null; setTimeout(() => { if (attempts.get(key) === a) attempts.delete(key); }, config.retainMs).unref?.(); });
    return a;
  }

  function answer(key, body) {
    const a = attempts.get(key);
    if (!a?.resolvePrompt) return false;
    const { resolve, reject } = a.resolvePrompt;
    a.prompt = null; a.resolvePrompt = null;
    if (body?.decline) reject(new AuthorizationDeclinedError('declined in the web UI'));
    else resolve(typeof body?.value === 'string' ? body.value : String(body?.value ?? ''));
    return true;
  }

  // -- HTTP surface -----------------------------------------------------------
  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }
  function readBody(req, limit = 4096) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
      req.on('error', reject);
    });
  }
  async function handler(req, res) {
    const connection = ctx.get('connection');
    const rejection = connection?.requestRejection?.(req);
    if (rejection === 401 && typeof connection.writeUnauthorized === 'function') return connection.writeUnauthorized(req, res);
    if (rejection !== undefined) return send(res, rejection, { error: rejection === 403 ? 'forbidden' : 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const op = url.pathname.slice(routePath.length + 1).replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    const wantsPost = op !== 'flows' && op !== 'status';
    if (wantsPost ? method !== 'POST' : method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
    const key = url.searchParams.get('key') ?? '';
    try {
      switch (op) {
        case 'flows': return send(res, 200, { flows: await flows() });
        case 'status': return send(res, 200, { attempt: publicState(attempts.get(key)) ?? null, signedIn: key ? await hasGrant(key) : false });
        case 'begin': {
          if (!ctx.authorization.describe(key)) return send(res, 404, { error: `no authorization flow for "${key}"` });
          const a = begin(key, url.searchParams.get('method') ?? undefined);
          return send(res, 202, { attempt: publicState(a) });
        }
        case 'answer': return send(res, answer(key, await readBody(req)) ? 200 : 409, { ok: true });
        case 'cancel': ctx.authorization.cancel(key); return send(res, 200, { ok: true });
        case 'signout': {
          await ctx.get('credentials')?.deleteRecord?.(key);
          return send(res, 200, { ok: true, signedIn: await hasGrant(key) });
        }
        default: return send(res, 404, { error: 'unknown route' });
      }
    } catch (error) {
      ctx.logger.warn(`provider-login: ${op} failed: ${error?.message ?? error}`);
      return send(res, 500, { error: String(error?.message ?? error) });
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routePath, handler }), 'provider-login: routes');

  // -- /login chat command ------------------------------------------------------
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'login',
      description: 'Sign in to a model provider (OAuth / device code): /login <provider> | /login status | /login cancel <provider>',
      input: { hint: '<provider> | status | cancel <provider>' },
      handler: async ({ rawInput }) => {
        const [verb, arg] = rawInput.trim().split(/\s+/);
        const all = await flows();
        const find = (id) => all.find((f) => f.providerId === id || f.key === id);
        if (!verb || verb === 'status') {
          return { kind: 'success', text: all.length ? all.map((f) => `${f.providerId}: ${f.signedIn ? 'signed in' : 'not signed in'}${f.attempt ? ` (attempt ${f.attempt.status})` : ''} — methods: ${f.methods.map((m) => m.label).join(', ')}`).join('\n') : 'No provider offers a sign-in flow.' };
        }
        if (verb === 'cancel') { const f = find(arg ?? ''); if (!f) return { kind: 'error', text: `Unknown provider "${arg}".` }; ctx.authorization.cancel(f.key); return { kind: 'success', text: `Cancelled ${f.providerId}.` }; }
        const f = find(verb);
        if (!f) return { kind: 'error', text: `No sign-in flow for "${verb}". Known: ${all.map((x) => x.providerId).join(', ') || 'none'}.` };
        const a = begin(f.key, f.methods[0].id);
        // Wait briefly for the first actionable notice (the device code).
        for (let i = 0; i < 40 && !a.notices.some((n) => n.code || n.url) && a.status === 'running'; i++) await new Promise((r) => setTimeout(r, 250));
        const n = a.notices.find((x) => x.code || x.url) ?? a.notices[a.notices.length - 1];
        if (a.status === 'failed') return { kind: 'error', text: `Sign-in failed: ${a.error}` };
        if (!n) return { kind: 'success', text: `Sign-in started for ${f.providerId}; no instructions yet — run /login status.` };
        return { kind: 'success', text: [`Sign in to ${f.label}:`, n.code ? `  Code: ${n.code}` : '', n.url ? `  Open: ${n.url}` : '', `  ${n.message}`, 'The harness keeps polling; the Models page card shows the result.'].filter(Boolean).join('\n') };
      },
    }), 'provider-login: /login');
  });

  ctx.on('authorization/settled', (key, settlement) => { const a = attempts.get(key); if (a && a.status === 'running') { a.status = settlement; a.settledAt = Date.now(); } });
  ctx.logger.info(`provider-login: ready; ${ctx.authorization.list().length} flow(s): ${ctx.authorization.list().map((f) => keyId(f.key)).join(', ')}`);
}
