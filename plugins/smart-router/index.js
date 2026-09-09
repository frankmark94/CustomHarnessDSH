/**
 * smart-router — host half.
 *
 * Owns the on/off toggle for the "Smart Model Router" button in the chat
 * composer (the `conversation.input.right` slot). When ON, the sibling
 * `model-router` plugin picks tiers with an "optimised orchestration":
 *
 *   - MAIN agent: lower threshold to escalate to `reasoning`, and after the
 *     first errored tool call (instead of the user's `escalateOnToolErrors`
 *     floor of two).
 *   - SUBAGENTS (sessions whose `meta.origin === 'subagent'`): reasoning-keyword
 *     hits on short prompts are dampened, short prompts bias toward `fast`,
 *     and only a keyword-rich AND long prompt (post-damping score ≥ 2 and
 *     more than `longPromptWords` words) routes to `reasoning`. Subagents keep their reasoning budget and stay on
 *     `fast`/`standard` otherwise — cost-first.
 *
 * State is a single boolean (`smartEnabled`) read by `model-router` through
 * the shared `smartBridge` object this module exports at top level (the same
 * in-process pattern `model-router` → `harness-panel` uses via
 * `recentDecisions`). The toggle persists in `$DSH_HOME/smart-router/state.json`
 * so it survives restarts, and is exposed to the browser via two routes on
 * the harness webServer:
 *
 *   GET  /smart-router/state   → { smart: boolean, defaultSmart: boolean }
 *   POST /smart-router/state   body { smart?: boolean }  → updated state
 *
 * Both routes sit outside the RPC trust boundary, so they gate themselves with
 * `connection.requestRejection(req)` (Host/Origin + signed browser-session
 * cookie) like `git-lens` does. The host does NOT depend on a specific
 * browser session id: the toggle is process-global.
 *
 * @module smart-router
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';

// The switch itself lives in model-router (the core plugin); this add-on only
// flips it. Importing from the sibling keeps the dependency pointing from the
// optional plugin to the required one, so model-router never waits on us.
import { smartBridge } from '../model-router/index.js';

export const name = 'smart-router';
export const inject = ['webServer'];

export const Config = z.object({
  /** Where the toggle is persisted. Defaults to `$DSH_HOME/smart-router/state.json`. */
  stateFile: z.string(),
  /** Default for `smartEnabled` at first boot (before the file exists). */
  defaultSmart: z.boolean().default(false),
});

const STATE_VERSION = 1;
const STATE_ROUTE = '/smart-router/state';

function defaultState(defaultSmart) {
  return { version: STATE_VERSION, smart: defaultSmart, updatedAt: new Date().toISOString() };
}

function loadState(file, defaultSmart) {
  try {
    const text = readFileSync(file, 'utf8');
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && typeof parsed.smart === 'boolean') {
      return { ...defaultState(defaultSmart), ...parsed };
    }
  } catch { /* missing or corrupt — fall through */ }
  return defaultState(defaultSmart);
}

function saveStateAtomic(file, state) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, file);
  } catch { /* persistence is best-effort */ }
}

export function apply(ctx, config = {}) {
  const stateFile = config.stateFile ?? join(process.env.DSH_HOME ?? process.cwd(), 'smart-router', 'state.json');
  const initial = loadState(stateFile, config.defaultSmart);
  smartBridge.smartEnabled = initial.smart;

  function persist(smart) {
    saveStateAtomic(stateFile, { ...initial, smart, updatedAt: new Date().toISOString() });
  }

  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(json),
    });
    res.end(json);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw === '') return resolve({});
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  async function handler(req, res) {
    // Same-origin + browser-session cookie, like git-lens. The toggle is a
    // user preference, not sensitive data, but the trust boundary still
    // applies — anyone able to set cookies should be authenticated first.
    const connection = ctx.get('connection');
    const rejection = connection?.requestRejection?.(req);
    if (rejection === 401 && typeof connection.writeUnauthorized === 'function') return connection.writeUnauthorized(req, res);
    if (rejection !== undefined) return send(res, rejection, { error: rejection === 403 ? 'forbidden' : 'unauthorized' });

    // Registered as an exact route, so the whole pathname is the route.
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname.replace(/\/+$/, '') !== STATE_ROUTE) return send(res, 404, { error: 'unknown route' });

    const method = req.method ?? 'GET';
    if (method === 'GET') {
      return send(res, 200, { smart: smartBridge.smartEnabled === true, defaultSmart: config.defaultSmart === true });
    }
    if (method === 'POST') {
      let body;
      try { body = await readBody(req); }
      catch { return send(res, 400, { error: 'invalid JSON body' }); }
      const next = body && Object.prototype.hasOwnProperty.call(body, 'smart') ? body.smart : !smartBridge.smartEnabled;
      if (typeof next !== 'boolean') return send(res, 400, { error: 'smart must be a boolean' });
      smartBridge.smartEnabled = next;
      persist(next);
      ctx.logger.info(`smart-router: toggled smart=${next ? 'on' : 'off'}`);
      return send(res, 200, { smart: next });
    }
    return send(res, 405, { error: 'method-not-allowed' });
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: STATE_ROUTE, handler }), 'smart-router: state route');

  // Slash command — kept short so the user can flip the toggle from chat.
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'smartrouter',
      description: 'Smart Model Router: status | on | off',
      input: { hint: '[status|on|off]' },
      handler: ({ rawInput }) => {
        const verb = (rawInput ?? '').trim().split(/\s+/)[0] ?? '';
        switch (verb) {
          case 'on':
            smartBridge.smartEnabled = true; persist(true);
            return { kind: 'success', text: 'smart-router: ON — main agent capability-first, subagents cost-first.' };
          case 'off':
            smartBridge.smartEnabled = false; persist(false);
            return { kind: 'success', text: 'smart-router: OFF — model-router runs in auto mode.' };
          case '': case 'status':
            return { kind: 'success', text: `smart-router: ${smartBridge.smartEnabled ? 'ON' : 'OFF'} (state file: ${stateFile})` };
          default:
            return { kind: 'error', text: 'Usage: /smartrouter [status|on|off]' };
        }
      },
    }), 'smart-router: /smartrouter command');
  });

  ctx.logger.info(`smart-router: ready; smart=${smartBridge.smartEnabled ? 'on' : 'off'} (state file: ${stateFile})`);
}
