/**
 * harness-panel — host half.
 *
 * Registers one session projection (`harnessPanel`) that folds the session
 * log into the compact JSON the browser panel renders: the current turn/step
 * and model, the router's tier + reasons for it, spend in tokens and USD per
 * turn / model / session, the tool timeline with excerpts, turn outcomes,
 * retries, and the last provider error with a plain-language hint.
 *
 * Projections are the harness's sanctioned host→browser push channel: the
 * fold runs on every committed event, the wire `view` is broadcast to every
 * client of the session, and the browser reads it with `useProjection(key)`.
 * The fold is pure over events except for two enrichments that are read from
 * in-process state at fold time and cached in the projection state:
 *   - the model-router's latest decision (tier + reasons) for the session;
 *   - USD prices from the pi-ai model catalog.
 * The wire view additionally merges the token-ledger's expected-vs-actual
 * figures and today's spend from that plugin's files.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';
import { z as zod } from 'zod';
import { recentDecisions } from '../model-router/index.js';

export const name = 'harness-panel';
export const inject = ['sessionProjections'];

export const Config = z.object({
  /** Harness provider route → pi-ai catalog name, for USD pricing. */
  catalogProviders: z.dict(z.string()).default({
    'opencode-go': 'opencode-go',
    'opencode': 'opencode',
    'deepseek-official': 'deepseek',
    'openrouter': 'openrouter',
  }),
  /** Where the token-ledger plugin writes; used for expected-cost figures. */
  ledgerDir: z.string(),
  /** How many tool calls / turns to keep in the wire payload. */
  maxTools: z.natural().default(40),
  maxTurns: z.natural().default(30),
  /** Characters kept from tool arguments / results for the inspector. */
  argsChars: z.natural().default(600),
  resultChars: z.natural().default(1500),
});

const PROJECTION_KEY = 'harnessPanel';
const STATE_VERSION = 3;

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Plain-language hint for a provider error, keyed off its code or message. */
export function hintFor(code, message) {
  const text = `${code ?? ''} ${message ?? ''}`;
  if (/MissingSessionID|x-opencode-session/i.test(text)) return 'OpenCode Go needs the x-opencode-session header. Check the opencode-go headers block in settings.yaml.';
  if (/RegionError|hosted in China/i.test(text)) return 'This model is China-hosted on OpenCode Go and needs the opt-in in your OpenCode workspace, or pick another tier model in cordis.patch.yml.';
  if (/CreditsError|Insufficient balance/i.test(text)) return 'OpenCode Zen has no credit balance. Top up, or switch the provider to opencode-go (your subscription).';
  if (/MISSING_CREDENTIAL|no API key/i.test(text)) return 'No API key stored for this provider. Add it on the Models page.';
  if (/AuthError|Invalid API key|\b401\b|AUTH\b/i.test(text)) return 'The provider rejected the API key. Re-paste the raw key on the Models page (not a URL or a token).';
  if (/RATE_LIMIT|429/i.test(text)) return 'Rate limited by the provider. The retry plugin backs off automatically.';
  if (/CONTEXT_WINDOW|context window|too long/i.test(text)) return 'The conversation no longer fits the model. Compact the session or route to a larger-context model.';
  if (/TRANSPORT|Connection error|ECONNRESET|fetch failed/i.test(text)) return 'Network problem reaching the provider.';
  return undefined;
}

/** Cost in USD for one usage sample under a per-1M price card. */
export function usdFor(usage, price) {
  if (!price || !usage) return 0;
  const input = usage.inputTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return (input * (price.input ?? 0)
    + cacheRead * (price.cacheRead ?? price.input ?? 0)
    + cacheWrite * (price.cacheWrite ?? price.input ?? 0)
    + output * (price.output ?? 0)) / 1e6;
}

function clip(text, max) {
  if (typeof text !== 'string') return '';
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function textOf(content) {
  if (!Array.isArray(content)) return '';
  return content.map((c) => (c?.type === 'text' ? c.text : c?.type === 'image' ? '[image]' : JSON.stringify(c))).join('\n');
}

function summarizeArgs(raw, max) {
  if (typeof raw !== 'string') return '';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      const firstString = Object.values(parsed).find((v) => typeof v === 'string');
      if (typeof firstString === 'string') return clip(firstString.replace(/\s+/g, ' '), max);
    }
  } catch { /* not JSON */ }
  return clip(raw.replace(/\s+/g, ' '), max);
}

const emptyTokens = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 });

function addTokens(t, usage) {
  return {
    input: t.input + (usage.inputTokens ?? 0),
    output: t.output + (usage.outputTokens ?? 0),
    cacheRead: t.cacheRead + (usage.cacheReadTokens ?? 0),
    cacheWrite: t.cacheWrite + (usage.cacheWriteTokens ?? 0),
    reasoning: t.reasoning + (usage.reasoningTokens ?? 0),
  };
}

/**
 * Build the projection definition. `prices` is a Map route → price card that
 * the host fills asynchronously; `decisions` is the router's shared map.
 */
export function buildProjection(config, prices, decisions) {
  const initialState = (header) => ({
    sessionId: String(header?.id ?? ''),
    cwd: header?.cwd ?? null,
    current: { turn: 0, step: 0, running: false, startedAt: null, stepStartedAt: null, provider: null, model: null, tier: null, reasons: [] },
    turns: [],
    tools: [],
    totals: { usd: 0, calls: 0, tokens: emptyTokens() },
    byModel: {},
    retries: 0,
    compactions: 0,
    lastError: null,
    lastEventAt: null,
  });

  function apply(state, event) {
    const { type, data, time } = event;
    switch (type) {
      case 'session': {
        if (!data && event.id) return { ...state, sessionId: String(event.id), cwd: event.cwd ?? state.cwd };
        return state;
      }
      case 'turn/start': {
        // A request/header is only logged when it CHANGES, so a turn that keeps
        // the previous route gets no header event: carry the route forward.
        const turn = { turn: data.turn, startedAt: time, endedAt: null, steps: 0, provider: state.current.provider, model: state.current.model, tier: null, reasons: [], tokens: emptyTokens(), usd: 0, calls: 0, toolCalls: 0, toolErrors: 0, outcome: null };
        const turns = [...state.turns.filter((t) => t.turn !== data.turn), turn].slice(-config.maxTurns);
        return { ...state, turns, current: { ...state.current, turn: data.turn, step: 0, running: true, startedAt: time, stepStartedAt: null, tier: null, reasons: [] }, lastEventAt: time };
      }
      case 'step/start': {
        const turns = state.turns.map((t) => (t.turn === data.turn ? { ...t, steps: Math.max(t.steps, data.step) } : t));
        return { ...state, turns, current: { ...state.current, turn: data.turn, step: data.step, running: true, stepStartedAt: time }, lastEventAt: time };
      }
      case 'request/header': {
        const cfg = data.header?.config ?? {};
        const decision = decisions.get(state.sessionId);
        const matches = decision !== undefined && decision.turn === state.current.turn;
        const tier = matches ? decision.tier : null;
        const reasons = matches ? decision.reasons.slice(0, 4) : [];
        const turns = state.turns.map((t) => (t.turn === state.current.turn ? { ...t, provider: cfg.provider ?? t.provider, model: cfg.model ?? t.model, tier, reasons } : t));
        return { ...state, turns, current: { ...state.current, provider: cfg.provider ?? null, model: cfg.model ?? null, tier, reasons }, lastEventAt: time };
      }
      case 'assistant/message': {
        if (data.usage === undefined) return state;
        const provider = data.message?.source?.provider ?? state.current.provider;
        const model = data.message?.source?.model ?? state.current.model;
        const route = `${provider}/${model}`;
        const usd = usdFor(data.usage, prices.get(route));
        const turns = state.turns.map((t) => (t.turn === data.turn ? { ...t, provider: t.provider ?? provider, model: t.model ?? model, tokens: addTokens(t.tokens, data.usage), usd: t.usd + usd, calls: t.calls + 1 } : t));
        const prev = state.byModel[route] ?? { calls: 0, usd: 0, tokens: emptyTokens(), priced: false };
        const byModel = { ...state.byModel, [route]: { calls: prev.calls + 1, usd: prev.usd + usd, tokens: addTokens(prev.tokens, data.usage), priced: prices.has(route) } };
        const totals = { usd: state.totals.usd + usd, calls: state.totals.calls + 1, tokens: addTokens(state.totals.tokens, data.usage) };
        return { ...state, turns, byModel, totals, lastEventAt: time };
      }
      case 'tool/call': {
        const tool = { callId: data.callId, turn: data.turn, step: data.step, name: data.name, summary: summarizeArgs(data.arguments, 80), args: clip(data.arguments ?? '', config.argsChars), startedAt: time, endedAt: null, isError: false, result: null };
        const tools = [...state.tools, tool].slice(-config.maxTools);
        const turns = state.turns.map((t) => (t.turn === data.turn ? { ...t, toolCalls: t.toolCalls + 1 } : t));
        return { ...state, tools, turns, lastEventAt: time };
      }
      case 'tool/result': {
        const blocks = (data.message?.content ?? []).filter((c) => c?.type === 'tool-result');
        if (blocks.length === 0) return state;
        let tools = state.tools;
        let errors = 0;
        for (const block of blocks) {
          const isError = block.isError === true;
          if (isError) errors += 1;
          tools = tools.map((t) => (t.callId === block.toolCallId ? { ...t, endedAt: time, isError, result: clip(textOf(block.content), config.resultChars) } : t));
        }
        const turns = errors === 0 ? state.turns : state.turns.map((t) => (t.turn === data.turn ? { ...t, toolErrors: t.toolErrors + errors } : t));
        return { ...state, tools, turns, lastEventAt: time };
      }
      case 'turn/end': {
        const reason = data.reason ?? {};
        const error = reason.kind === 'error' ? reason.error ?? {} : null;
        const outcome = error ? { kind: 'error', code: error.code ?? null, message: clip(error.message ?? '', 400) } : { kind: reason.kind ?? 'completed' };
        const turns = state.turns.map((t) => (t.turn === data.turn ? { ...t, endedAt: time, outcome } : t));
        const lastError = error ? { time, turn: data.turn, code: error.code ?? null, message: clip(error.message ?? '', 400), hint: hintFor(error.code, error.message) ?? null } : state.lastError;
        return { ...state, turns, lastError, current: { ...state.current, running: false, stepStartedAt: null }, lastEventAt: time };
      }
      case 'llm/retry': {
        const failure = data.failure ?? {};
        const lastError = { time, turn: data.turn, code: failure.code ?? 'RETRY', message: clip(`retry ${data.retry}/${data.maxRetries}: ${failure.message ?? ''}`, 400), hint: hintFor(failure.code, failure.message) ?? null };
        return { ...state, retries: state.retries + 1, lastError, lastEventAt: time };
      }
      case 'compaction/end':
        return { ...state, compactions: state.compactions + 1, lastEventAt: time };
      default:
        return state;
    }
  }

  // -- wire view: merge the token-ledger's figures (expected vs actual, today) --
  const fileCache = new Map();
  function readJson(path) {
    try {
      const mtime = statSync(path).mtimeMs;
      const cached = fileCache.get(path);
      if (cached !== undefined && cached.mtime === mtime) return cached.value;
      const value = JSON.parse(readFileSync(path, 'utf8'));
      fileCache.set(path, { mtime, value });
      return value;
    } catch {
      return undefined;
    }
  }

  function view(state) {
    const ledger = state.sessionId ? readJson(join(config.ledgerDir, 'sessions', `${state.sessionId}.json`)) : undefined;
    const totals = readJson(join(config.ledgerDir, 'totals.json'));
    const today = new Date().toISOString().slice(0, 10);
    const day = totals?.byDay?.[today];
    return {
      ...state,
      ledger: ledger === undefined ? null : {
        calls: ledger.calls,
        expectedUsd: ledger.expected?.usd ?? 0,
        expectedTokens: ledger.expected?.total ?? 0,
        actualUsd: ledger.actual?.usd ?? 0,
        actualTokens: ledger.actual?.total ?? 0,
      },
      today: day === undefined ? null : { calls: day.calls, usd: day.actual?.usd ?? 0, tokens: day.actual?.total ?? 0 },
      allTime: totals === undefined ? null : { calls: totals.calls, usd: totals.actual?.usd ?? 0, since: totals.since ?? null },
    };
  }

  return {
    key: PROJECTION_KEY,
    stateVersion: STATE_VERSION,
    stateSchema: zod.any(),
    init: (header) => initialState(header),
    apply,
    wire: { viewSchema: zod.any(), view },
  };
}

// ---------------------------------------------------------------------------
// Plugin entry
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const prices = new Map();

  // Prices from the pi-ai catalogs the harness ships (async; the fold reads
  // whatever has loaded — a call priced before its catalog resolves shows as
  // unpriced, which the panel flags rather than silently zeroing).
  for (const [route, catalog] of Object.entries(config.catalogProviders ?? {})) {
    import(`@earendil-works/pi-ai/providers/${catalog}.models`).then((mod) => {
      const table = mod[`${catalog.toUpperCase().replace(/-/g, '_')}_MODELS`];
      if (!table) return;
      for (const [id, m] of Object.entries(table)) if (m?.cost) prices.set(`${route}/${id}`, m.cost);
    }).catch((error) => ctx.logger.warn(`harness-panel: no price catalog for ${route}: ${error?.message ?? error}`));
  }

  const definition = buildProjection(config, prices, recentDecisions);
  ctx.sessionProjections.register(definition);
  ctx.logger.info(`harness-panel: ready; projection "${PROJECTION_KEY}" v${STATE_VERSION}, ledger at ${config.ledgerDir}`);
}
