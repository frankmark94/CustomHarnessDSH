/**
 * token-ledger — token (and dollar) accounting for every model call.
 *
 * Before each call it prices the request the harness is about to send
 * (system prompt + tool schemas + messages, using the same fixed
 * 4-chars-per-token heuristic as the built-in token meter) and adds an
 * expected-output allowance (a running average per model). After the call it
 * records the provider's exact usage, the variance against the estimate, and
 * keeps running totals per session, per model, and across all sessions.
 *
 * How it plugs in: the `llm/stream` waterfall wraps every streaming model
 * call. The listener reads the frozen request, forwards the chunk stream
 * untouched, and observes the `usage` and `finish` chunks on the way past.
 * Nothing is written into the session log (this harness version refuses to
 * reload logs carrying unknown event types), so the ledger keeps its own JSON
 * files under `<ledgerDir>` and answers the `/tokens` command.
 *
 * Prices come from `config.pricing` first, then from the model catalog that
 * ships with the harness's pi-ai adapter (`@earendil-works/pi-ai`).
 *
 * @module token-ledger
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'token-ledger';
export const inject = ['llm'];

export const Config = z.object({
  /** Directory for ledger files. Defaults to `$DSH_HOME/token-ledger`. */
  ledgerDir: z.string(),
  /** Output allowance used before a model has any observed history. */
  expectedOutputTokens: z.number().default(600),
  /** Per-call log line in the harness log (`log`) or nothing (`silent`). */
  announce: z.union(['log', 'silent']).default('log'),
  /** Manual price overrides per `provider/model`, USD per 1M tokens. */
  pricing: z.dict(z.object({
    input: z.number().required(),
    output: z.number().required(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  })).default({}),
  /** Harness provider route → pi-ai catalog name, for automatic pricing. */
  catalogProviders: z.dict(z.string()).default({ 'deepseek-official': 'deepseek' }),
  /** Calls kept per session in the ledger file's history. */
  historyLimit: z.number().default(200),
});

// ---------------------------------------------------------------------------
// Estimation (mirrors @deepseek-ai/dsh-token-meter's fixed heuristic)
// ---------------------------------------------------------------------------
const CHARS_PER_TOKEN = 4;
const BLOCK_OVERHEAD = 4;
const ROLE_OVERHEAD = 4;

function estimateContent(blocks) {
  let tokens = 0;
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD; break;
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN) + Math.ceil(block.arguments.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD; break;
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD; break;
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN);
    }
  }
  return tokens;
}

/** Price one fully assembled request. */
export function estimateRequest(options, meter) {
  const system = options.system ? Math.ceil(options.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD : 0;
  const tools = options.tools?.length ? Math.ceil(JSON.stringify(options.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD : 0;
  let messages = 0;
  for (const m of options.messages ?? []) {
    messages += meter?.estimateMessage ? meter.estimateMessage(m) : estimateContent(m.content) + ROLE_OVERHEAD;
  }
  return { system, tools, messages, input: system + tools + messages };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
const catalogCache = new Map();

async function catalogPrice(provider, model, catalogProviders) {
  const catalog = catalogProviders[provider] ?? provider;
  if (!catalogCache.has(catalog)) {
    catalogCache.set(catalog, (async () => {
      try {
        const mod = await import(`@earendil-works/pi-ai/providers/${catalog}.models`);
        const exportName = `${catalog.toUpperCase().replace(/-/g, '_')}_MODELS`;
        return mod[exportName] ?? Object.values(mod)[0] ?? {};
      } catch {
        return {};
      }
    })());
  }
  const models = await catalogCache.get(catalog);
  const entry = models?.[model] ?? (Array.isArray(models) ? models.find((m) => m.id === model) : undefined);
  return entry?.cost;
}

/** USD for one usage record under a price card (per-1M-token rates). */
export function costUsd(usage, price) {
  if (!price) return undefined;
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return (usage.inputTokens * price.input
    + cacheRead * (price.cacheRead ?? price.input)
    + cacheWrite * (price.cacheWrite ?? price.input)
    + usage.outputTokens * price.output) / 1e6;
}

// ---------------------------------------------------------------------------
// Ledger state
// ---------------------------------------------------------------------------
function emptyTotals() {
  return {
    calls: 0,
    expected: { input: 0, output: 0, total: 0, usd: 0 },
    actual: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0, usd: 0, estimatedCalls: 0 },
  };
}

function addTotals(t, call) {
  t.calls += 1;
  t.expected.input += call.expected.input;
  t.expected.output += call.expected.output;
  t.expected.total += call.expected.total;
  t.expected.usd += call.expected.usd ?? 0;
  const a = call.actual;
  t.actual.input += a.inputTokens;
  t.actual.cacheRead += a.cacheReadTokens ?? 0;
  t.actual.cacheWrite += a.cacheWriteTokens ?? 0;
  t.actual.output += a.outputTokens;
  t.actual.reasoning += a.reasoningTokens ?? 0;
  t.actual.total += a.totalTokens;
  t.actual.usd += call.actual.usd ?? 0;
  if (call.usageSource === 'estimated') t.actual.estimatedCalls += 1;
}

function readJson(file, fallback) {
  try { return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback; } catch { return fallback; }
}

function writeJsonAtomic(file, value) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, file);
}

const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));
const usd = (n) => (n === undefined || n === 0 ? '' : ` ($${n < 0.01 ? n.toFixed(4) : n.toFixed(3)})`);
const pct = (actual, expected) => (expected === 0 ? '' : ` ${actual >= expected ? '+' : ''}${Math.round(((actual - expected) / expected) * 100)}%`);

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------
export function apply(ctx, config = {}) {
  const ledgerDir = config.ledgerDir ?? join(process.env.DSH_HOME ?? process.cwd(), 'token-ledger');
  const sessionsDir = join(ledgerDir, 'sessions');
  try { mkdirSync(sessionsDir, { recursive: true }); } catch { /* best-effort */ }
  const totalsFile = join(ledgerDir, 'totals.json');

  const totals = readJson(totalsFile, { since: new Date().toISOString(), ...emptyTotals(), byModel: {}, byDay: {} });
  const sessions = new Map(); // sessionId -> ledger
  const outputAverages = new Map(); // provider/model -> EMA of output tokens
  for (const [route, m] of Object.entries(totals.byModel)) if (m.calls > 0) outputAverages.set(route, m.actual.output / m.calls);

  let flushTimer;
  const dirty = new Set();
  function scheduleFlush(sessionId) {
    dirty.add(sessionId);
    if (flushTimer !== undefined) return;
    flushTimer = setTimeout(flush, 1500);
  }
  function flush() {
    flushTimer = undefined;
    try {
      writeJsonAtomic(totalsFile, totals);
      for (const id of dirty) {
        const s = sessions.get(id);
        if (s) writeJsonAtomic(join(sessionsDir, `${id}.json`), s);
      }
    } catch (error) {
      ctx.logger.warn(`token-ledger: could not write ledger files: ${error?.message ?? error}`);
    }
    dirty.clear();
  }
  ctx.effect(() => () => { if (flushTimer !== undefined) clearTimeout(flushTimer); flush(); }, 'token-ledger: flush on dispose');

  function sessionLedger(sessionId) {
    let s = sessions.get(sessionId);
    if (s === undefined) {
      s = readJson(join(sessionsDir, `${sessionId}.json`), { sessionId, started: new Date().toISOString(), ...emptyTotals(), byModel: {}, history: [] });
      sessions.set(sessionId, s);
    }
    return s;
  }

  async function priceFor(provider, model) {
    const route = `${provider}/${model}`;
    return config.pricing[route] ?? (await catalogPrice(provider, model, config.catalogProviders));
  }

  function expectedOutputFor(route, options) {
    const avg = outputAverages.get(route) ?? config.expectedOutputTokens;
    return Math.round(options.maxTokens !== undefined ? Math.min(avg, options.maxTokens) : avg);
  }

  function complete(call, s) {
    const route = call.route;
    addTotals(s, call);
    addTotals(totals, call);
    s.byModel[route] ??= emptyTotals();
    addTotals(s.byModel[route], call);
    totals.byModel[route] ??= emptyTotals();
    addTotals(totals.byModel[route], call);
    const day = call.time.slice(0, 10);
    totals.byDay[day] ??= emptyTotals();
    addTotals(totals.byDay[day], call);
    s.history.push(call);
    if (s.history.length > config.historyLimit) s.history.splice(0, s.history.length - config.historyLimit);
    if (call.usageSource === 'provider') {
      const prev = outputAverages.get(route);
      outputAverages.set(route, prev === undefined ? call.actual.outputTokens : prev * 0.7 + call.actual.outputTokens * 0.3);
    }
    scheduleFlush(s.sessionId);
  }

  // -- the waterfall listener -------------------------------------------------
  ctx.on('llm/stream', async function* (options, next) {
    const sessionId = options.sessionId !== undefined ? String(options.sessionId) : `aux:${options.purpose ?? 'adhoc'}`;
    const route = `${options.provider}/${options.model}`;
    const est = estimateRequest(options, ctx.get('tokenMeter'));
    const expectedOutput = expectedOutputFor(route, options);
    const price = await priceFor(options.provider, options.model);
    const s = sessionLedger(sessionId);
    // Calls can overlap (a session-title request runs beside the main one), so
    // number them as they start rather than from the completed-call count.
    s.issued = (s.issued ?? s.calls) + 1;
    const seq = s.issued;
    const expected = {
      ...est, output: expectedOutput, total: est.input + expectedOutput,
      usd: price ? costUsd({ inputTokens: est.input, outputTokens: expectedOutput }, price) : undefined,
    };
    const runningExpected = s.expected.total + expected.total;
    if (config.announce === 'log') {
      ctx.logger.info(`token-ledger: call #${seq} ${route}${options.purpose ? ` [${options.purpose}]` : ''} expected ≈ ${fmt(est.input)} in (system ${fmt(est.system)}, tools ${fmt(est.tools)}, messages ${fmt(est.messages)}) + ${fmt(expectedOutput)} out = ${fmt(expected.total)}${usd(expected.usd)}; session expected total → ${fmt(runningExpected)}`);
    }

    const started = Date.now();
    let usage;
    let finish = 'interrupted';
    let outChars = 0;
    try {
      for await (const chunk of next()) {
        switch (chunk.type) {
          case 'usage': usage = chunk.usage; break;
          case 'text-delta': case 'reasoning-delta': outChars += chunk.text.length; break;
          case 'tool-call-delta': outChars += chunk.argumentsDelta.length; break;
          case 'finish': finish = chunk.reason.kind; break;
        }
        yield chunk;
      }
    } finally {
      const usageSource = usage ? 'provider' : 'estimated';
      const actual = usage
        ? { ...usage, totalTokens: usage.totalTokens ?? (usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens) }
        : { inputTokens: est.input, outputTokens: Math.ceil(outChars / CHARS_PER_TOKEN), totalTokens: est.input + Math.ceil(outChars / CHARS_PER_TOKEN) };
      actual.usd = price ? costUsd(actual, price) : undefined;
      const call = {
        seq, time: new Date(started).toISOString(), durationMs: Date.now() - started, route,
        provider: options.provider, model: options.model, purpose: options.purpose, finish, usageSource,
        expected, actual, variance: { input: actual.inputTokens + (actual.cacheReadTokens ?? 0) + (actual.cacheWriteTokens ?? 0) - est.input, output: actual.outputTokens - expectedOutput },
      };
      complete(call, s);
      if (config.announce === 'log') {
        const billedIn = actual.inputTokens + (actual.cacheReadTokens ?? 0) + (actual.cacheWriteTokens ?? 0);
        const cache = actual.cacheReadTokens ? `, ${fmt(actual.cacheReadTokens)} cached` : '';
        ctx.logger.info(`token-ledger: call #${seq} ${route} ${usageSource === 'provider' ? 'actual' : 'estimated (no usage reported)'} ${fmt(billedIn)} in${cache} / ${fmt(actual.outputTokens)} out = ${fmt(actual.totalTokens)}${usd(actual.usd)}${pct(actual.totalTokens, expected.total)} vs expected; session total ${fmt(s.actual.total)}${usd(s.actual.usd)} (expected ${fmt(s.expected.total)})`);
      }
    }
  });

  // -- /tokens command --------------------------------------------------------
  function summarize(title, t, byModel) {
    const lines = [
      `${title}: ${t.calls} call${t.calls === 1 ? '' : 's'}`,
      `  expected: ${fmt(t.expected.input)} in + ${fmt(t.expected.output)} out = ${fmt(t.expected.total)} tokens${usd(t.expected.usd)}`,
      `  actual:   ${fmt(t.actual.input + t.actual.cacheRead + t.actual.cacheWrite)} in (${fmt(t.actual.cacheRead)} cache hits) + ${fmt(t.actual.output)} out (${fmt(t.actual.reasoning)} reasoning) = ${fmt(t.actual.total)} tokens${usd(t.actual.usd)}${pct(t.actual.total, t.expected.total)} vs expected`,
    ];
    if (t.actual.estimatedCalls > 0) lines.push(`  (${t.actual.estimatedCalls} call(s) reported no usage; those rows are heuristic)`);
    const routes = Object.entries(byModel ?? {}).sort((a, b) => b[1].actual.total - a[1].actual.total);
    if (routes.length > 0) {
      lines.push('  by model:');
      for (const [route, m] of routes) lines.push(`    ${route}: ${m.calls} calls, ${fmt(m.actual.total)} tokens${usd(m.actual.usd)} (avg ${fmt(m.actual.total / m.calls)}/call)`);
    }
    return lines;
  }

  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'tokens',
      description: 'Token ledger: session totals | all | last [n] | reset',
      input: { hint: '[all|last [n]|reset]' },
      handler: ({ agent, rawInput }) => {
        const [verb, arg] = rawInput.trim().split(/\s+/);
        const sid = String(agent.session.id);
        const s = sessionLedger(sid);
        switch (verb ?? '') {
          case '': return { kind: 'success', text: summarize('This session', s, s.byModel).join('\n') };
          case 'all': {
            const lines = summarize(`All sessions since ${totals.since.slice(0, 10)}`, totals, totals.byModel);
            const days = Object.entries(totals.byDay).sort().slice(-7);
            if (days.length) { lines.push('  last days:'); for (const [d, t] of days) lines.push(`    ${d}: ${t.calls} calls, ${fmt(t.actual.total)} tokens${usd(t.actual.usd)}`); }
            lines.push(`  ledger files: ${ledgerDir}`);
            return { kind: 'success', text: lines.join('\n') };
          }
          case 'last': {
            const n = Math.max(1, Math.min(50, Number(arg) || 5));
            const rows = s.history.slice(-n).map((c) => `#${c.seq} ${c.route}${c.purpose ? ` [${c.purpose}]` : ''}: expected ${fmt(c.expected.total)} → ${c.usageSource === 'provider' ? 'actual' : 'est.'} ${fmt(c.actual.totalTokens)}${usd(c.actual.usd)} (${fmt(c.actual.inputTokens + (c.actual.cacheReadTokens ?? 0))} in / ${fmt(c.actual.outputTokens)} out, ${c.finish}, ${(c.durationMs / 1000).toFixed(1)}s)`);
            return { kind: 'success', text: rows.length ? rows.join('\n') : 'No calls recorded in this session yet.' };
          }
          case 'reset': {
            const fresh = { sessionId: sid, started: new Date().toISOString(), ...emptyTotals(), byModel: {}, history: [] };
            sessions.set(sid, fresh); scheduleFlush(sid);
            return { kind: 'success', text: 'token-ledger: session counters reset (all-time totals unchanged).' };
          }
          default: return { kind: 'error', text: 'Usage: /tokens [all|last [n]|reset]' };
        }
      },
    }), 'token-ledger: /tokens command');
  });

  ctx.logger.info(`token-ledger: ready; all-time ${totals.calls} calls, ${fmt(totals.actual.total)} tokens${usd(totals.actual.usd)}; files in ${ledgerDir}`);
}
