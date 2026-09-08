/**
 * model-router — picks the cheapest model that is likely good enough for each
 * model call, per provider.
 *
 * How it plugs in: the DeepSeek Harness exposes an `agent/request` waterfall
 * that runs right before every model call. `await next()` yields the call
 * config the loop would use (the session's selected provider/model); returning
 * a different config switches the model for that request. The loop logs the
 * changed `request/header` itself, so the session log stays reconstructable.
 *
 * Tier profiles are keyed by provider (`profiles.<provider>.<tier>`), so the
 * router follows whichever provider the session is on and never crosses
 * providers unless a tier entry explicitly names one.
 *
 * Decisions are explainable: every one is written to
 * `<logDir>/decisions.jsonl` and to the harness log, and `/router` shows the
 * latest decision for the current session.
 *
 * @module model-router
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'model-router';
export const inject = ['llm'];

/**
 * Latest routing decision per session id, shared in-process with sibling
 * plugins (the harness-panel projection reads tier + reasons from here when it
 * folds the matching `request/header` event). Best-effort: empty after a
 * restart until the next decision.
 */
export const recentDecisions = new Map();

const TIERS = ['fast', 'standard', 'reasoning'];

const TierSchema = z.object({
  /** Model id on the profile's provider (or on `provider` when given). */
  model: z.string().required(),
  /** Optional cross-provider route for this tier. */
  provider: z.string(),
  /** Optional adapter-owned reasoning effort id to request on this tier. */
  reasoningEffort: z.string(),
});

export const Config = z.object({
  /** `auto` routes every loop request; `off` leaves the selected model alone. */
  mode: z.union(['auto', 'off']).default('auto'),
  /** Tier profiles keyed by the session's provider route. */
  profiles: z.dict(z.object({
    fast: TierSchema,
    standard: TierSchema,
    reasoning: TierSchema,
  })).default({}),
  /** Tier used when the classifier has no strong signal. */
  defaultTier: z.union(TIERS).default('standard'),
  /** Keep the tier chosen at step 1 for the rest of the turn (protects KV-cache reuse). */
  stickyWithinTurn: z.boolean().default(true),
  /** Escalate to `reasoning` once this many tool calls errored in the current turn (0 = never). */
  escalateOnToolErrors: z.number().default(2),
  /** Tier for auxiliary calls (compaction, session titles); `off` leaves them on the session model. */
  auxiliaryTier: z.union([...TIERS, 'off']).default('fast'),
  heuristics: z.object({
    shortPromptWords: z.number().default(25),
    longPromptWords: z.number().default(120),
    reasoningKeywords: z.array(z.string()).default([
      'design', 'architect', 'plan', 'why', 'debug', 'root cause', 'prove', 'trade-off', 'tradeoff',
      'optimi', 'refactor', 'migrat', 'complex', 'analy', 'compare', 'strategy', 'review', 'security',
      'performance', 'algorithm', 'math', 'derive', 'in depth', 'carefully', 'step by step', 'edge case',
      'race condition', 'concurren', 'investigate', 'diagnose', 'evaluate', 'spec', 'rfc',
    ]),
    fastKeywords: z.array(z.string()).default([
      'hi', 'hello', 'thanks', 'thank you', 'ok', 'okay', 'yes', 'no', 'list', 'show', 'print', 'what is',
      'rename', 'run', 'open', 'cat', 'ls', 'status', 'summarize', 'tldr', 'format', 'typo', 'lint',
    ]),
  }).default({}),
  /** Directory for `decisions.jsonl`. Defaults to `$DSH_HOME/model-router`. */
  logDir: z.string(),
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** Pull the plain text of the latest human prompt out of the session log. */
function latestHumanPrompt(session) {
  const events = session.snapshotEvents(Math.max(0, session.seq - 2000));
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== 'user/message' || e.data?.source?.kind !== 'user') continue;
    return e.data.content
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/** Count steps and errored tool results inside the current turn. */
function turnStats(session, turn) {
  const events = session.snapshotEvents(Math.max(0, session.seq - 2000));
  let steps = 0;
  let toolErrors = 0;
  let toolCalls = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type === 'turn/start' && e.data.turn === turn) break;
    if (e.data?.turn !== undefined && e.data.turn !== turn) continue;
    if (e.type === 'step/start') steps++;
    if (e.type === 'tool/call') toolCalls++;
    if (e.type === 'tool/result' && (e.data.error !== undefined || e.data.message?.content?.[0]?.isError)) toolErrors++;
  }
  return { steps, toolCalls, toolErrors };
}

/**
 * Score a prompt. Returns the tier plus the signals that produced it so the
 * decision can be explained.
 * @param {string} prompt
 * @param {object} h - heuristics config
 */
export function classifyPrompt(prompt, h) {
  const text = prompt.trim();
  const lower = text.toLowerCase();
  const words = text.length === 0 ? 0 : text.split(/\s+/).length;
  const codeFence = /```/.test(text);
  const questions = (text.match(/\?/g) ?? []).length;
  const reasons = [];
  let reasoning = 0;
  let fast = 0;

  const rHits = h.reasoningKeywords.filter((k) => lower.includes(k));
  if (rHits.length > 0) { reasoning += Math.min(rHits.length, 3); reasons.push(`reasoning keywords: ${rHits.slice(0, 4).join(', ')}`); }
  if (words > h.longPromptWords) { reasoning += 2; reasons.push(`long prompt (${words} words)`); }
  else if (words > h.longPromptWords / 2) { reasoning += 1; reasons.push(`medium prompt (${words} words)`); }
  if (questions >= 2) { reasoning += 1; reasons.push(`${questions} questions`); }
  if (codeFence) { reasoning += 1; reasons.push('contains a code block'); }

  if (words > 0 && words <= h.shortPromptWords && !codeFence) { fast += 2; reasons.push(`short prompt (${words} words)`); }
  const fHits = h.fastKeywords.filter((k) => lower === k || lower.startsWith(k + ' ') || lower.startsWith(k + ',') || lower.startsWith(k + '!'));
  if (fHits.length > 0) { fast += 1; reasons.push(`simple opener: "${fHits[0]}"`); }

  let tier = 'standard';
  if (reasoning >= 3) tier = 'reasoning';
  else if (fast >= 2 && reasoning === 0) tier = 'fast';
  return { tier, reasons, signals: { words, codeFence, questions, reasoningScore: reasoning, fastScore: fast } };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

function fmtRoute(c) {
  return `${c.provider}/${c.model}${c.reasoningEffort ? ` (${c.reasoningEffort})` : ''}`;
}

export function apply(ctx, config = {}) {
  const logDir = config.logDir ?? join(process.env.DSH_HOME ?? process.cwd(), 'model-router');
  try { mkdirSync(logDir, { recursive: true }); } catch { /* logging is best-effort */ }
  const decisionsFile = join(logDir, 'decisions.jsonl');

  /** Runtime state: mode toggle, per-agent pins, per-agent sticky tier, last decision per session. */
  const state = {
    mode: config.mode,
    pins: new Map(),      // agent.id -> tier
    sticky: new Map(),    // agent.id -> { turn, tier }
    last: new Map(),      // sessionId -> decision
    warnedProviders: new Set(),
  };

  function record(decision) {
    state.last.set(decision.sessionId, decision);
    recentDecisions.set(decision.sessionId, decision);
    try { appendFileSync(decisionsFile, JSON.stringify(decision) + '\n'); } catch { /* best-effort */ }
    const arrow = decision.changed ? `${fmtRoute(decision.from)} → ${fmtRoute(decision.to)}` : `${fmtRoute(decision.to)} (unchanged)`;
    ctx.logger.info(`model-router: turn ${decision.turn} step ${decision.step} → ${decision.tier}: ${arrow} — ${decision.reasons.join('; ')}`);
  }

  function registeredProviders() {
    return new Set(ctx.llm.listProviders().map((p) => p.id));
  }

  /** The user's explicit, not-yet-consumed picker choice for this session (undefined when none). */
  function explicitPick(session) {
    try {
      const projections = ctx.get('sessionProjections');
      const pending = projections?.stateOf(session, 'modelSelection')?.pending;
      return pending === null || pending === undefined ? undefined : pending;
    } catch {
      return undefined;
    }
  }

  /** Resolve a tier entry into a full call config, or undefined when the route is not mounted. */
  function resolveTier(base, profile, tier) {
    const entry = profile[tier];
    if (entry === undefined) return undefined;
    const provider = entry.provider ?? base.provider;
    if (!registeredProviders().has(provider)) {
      if (!state.warnedProviders.has(provider)) {
        state.warnedProviders.add(provider);
        ctx.logger.warn(`model-router: tier "${tier}" names provider "${provider}" which is not registered; leaving requests on ${fmtRoute(base)}`);
      }
      return undefined;
    }
    const sameModel = provider === base.provider && entry.model === base.model;
    return {
      provider,
      model: entry.model,
      // Efforts and output caps are model-specific: carry them over only when
      // the model is unchanged, otherwise let the adapter materialize defaults.
      ...(entry.reasoningEffort !== undefined ? { reasoningEffort: entry.reasoningEffort }
        : sameModel && base.reasoningEffort !== undefined ? { reasoningEffort: base.reasoningEffort } : {}),
      ...(sameModel && base.maxTokens !== undefined ? { maxTokens: base.maxTokens } : {}),
      ...(base.temperature !== undefined ? { temperature: base.temperature } : {}),
      ...(base.stop !== undefined ? { stop: base.stop } : {}),
    };
  }

  // -- loop requests ---------------------------------------------------------
  // Registered with prepend=true so this listener is the OUTERMOST link of the
  // waterfall no matter when it registers. The harness's api-session controller
  // installs its own agent/request listener per agent that force-applies the
  // "model selection" (an explicit picker choice, else the last logged
  // request/header). Without prepend, a live patch reload re-registers this
  // plugin AFTER that listener and every routing decision is silently undone.
  ctx.on('agent/request', async (payload, next) => {
    const base = await next();
    if (state.mode === 'off') return base;
    const { agent, turn, step } = payload;
    const session = agent.session;
    // An explicit pick in the model picker is honoured for the turn it lands on.
    // The harness clears the pick once a request/header with that model is
    // logged, so routing resumes automatically on the following turn.
    const pending = explicitPick(session);
    if (pending !== undefined && pending.provider === base.provider && pending.model === base.model) {
      record({
        time: new Date().toISOString(), sessionId: String(session.id), turn, step, tier: 'kept', changed: false,
        from: base, to: base, reasons: ['explicit model pick in the picker → honoured for this turn'], signals: {}, turnStats: turnStats(session, turn),
      });
      return base;
    }
    const profile = config.profiles[base.provider];
    if (profile === undefined) {
      if (!state.warnedProviders.has(`profile:${base.provider}`)) {
        state.warnedProviders.add(`profile:${base.provider}`);
        ctx.logger.warn(`model-router: no tier profile for provider "${base.provider}"; add one under profiles in cordis.patch.yml`);
      }
      return base;
    }

    const stats = turnStats(session, turn);
    const reasons = [];
    let tier;
    let signals = {};

    const pin = state.pins.get(agent.id);
    const sticky = state.sticky.get(agent.id);
    if (pin !== undefined) {
      tier = pin; reasons.push(`pinned by /router pin ${pin}`);
    } else if (config.stickyWithinTurn && sticky !== undefined && sticky.turn === turn) {
      tier = sticky.tier; reasons.push(`sticky within turn (chosen at step 1)`);
    } else {
      const prompt = latestHumanPrompt(session);
      const c = classifyPrompt(prompt, config.heuristics);
      tier = c.tier; signals = c.signals; reasons.push(...c.reasons);
      if (c.reasons.length === 0) { tier = config.defaultTier; reasons.push('no strong signal → default tier'); }
    }
    if (pin === undefined && config.escalateOnToolErrors > 0 && stats.toolErrors >= config.escalateOnToolErrors && tier !== 'reasoning') {
      tier = 'reasoning'; reasons.push(`${stats.toolErrors} tool errors this turn → escalate`);
    }

    let target = resolveTier(base, profile, tier);
    if (target === undefined) { target = base; reasons.push('tier route unavailable → kept selection'); }

    // Context-window guard: never route into a model the current context cannot fit.
    const meter = ctx.get('tokenMeter');
    if (meter !== undefined && target !== base) {
      try {
        const pressure = meter.measure(session).totalTokens;
        const info = await ctx.llm.resolveModelInfo(target.provider, target.model, payload.signal);
        const window = info.context?.contextWindow;
        if (window !== undefined && pressure > window * 0.9) {
          reasons.push(`context ${pressure} tokens exceeds ${target.model}'s window (${window}) → kept selection`);
          target = base; tier = 'kept';
        }
      } catch (error) {
        reasons.push(`model info unavailable (${error?.message ?? error}); proceeding`);
      }
    }

    state.sticky.set(agent.id, { turn, tier });
    const changed = target.provider !== base.provider || target.model !== base.model || target.reasoningEffort !== base.reasoningEffort;
    record({
      time: new Date().toISOString(), sessionId: String(session.id), turn, step, tier, changed,
      from: base, to: target, reasons, signals, turnStats: stats,
    });
    return target;
  }, true /* prepend: stay outermost — see comment above */);

  // -- auxiliary requests (compaction summaries, session titles) -------------
  const routed = new WeakSet();
  ctx.on('llm/stream', function (options, next) {
    if (config.auxiliaryTier === 'off' || state.mode === 'off') return next();
    if (options.purpose === undefined || routed.has(options)) return next();
    const profile = config.profiles[options.provider];
    const entry = profile?.[config.auxiliaryTier];
    if (entry === undefined) return next();
    const provider = entry.provider ?? options.provider;
    if (!registeredProviders().has(provider) || (provider === options.provider && entry.model === options.model)) return next();
    const { reasoningEffort: _effort, maxTokens: _max, ...rest } = options;
    const rerouted = { ...rest, provider, model: entry.model, ...(entry.reasoningEffort ? { reasoningEffort: entry.reasoningEffort } : {}) };
    routed.add(rerouted);
    ctx.logger.info(`model-router: ${options.purpose} request → ${config.auxiliaryTier}: ${options.provider}/${options.model} → ${provider}/${entry.model}`);
    return this.stream(rerouted);
  });

  // -- housekeeping ----------------------------------------------------------
  ctx.on('agent/disposed', ({ agent }) => { state.pins.delete(agent.id); state.sticky.delete(agent.id); });

  // -- /router command (only where the commands service is composed) ---------
  ctx.inject(['commands'], (cctx) => {
    cctx.effect(() => cctx.commands.register({
      name: 'router',
      description: 'Model router: status | on | off | pin <fast|standard|reasoning> | auto',
      input: { hint: '[status|on|off|pin <tier>|auto]' },
      handler: ({ agent, rawInput }) => {
        const [verb, arg] = rawInput.trim().split(/\s+/);
        switch (verb ?? '') {
          case 'on': state.mode = 'auto'; return { kind: 'success', text: 'model-router: on (auto).' };
          case 'off': state.mode = 'off'; return { kind: 'success', text: 'model-router: off — requests use the selected model.' };
          case 'pin':
            if (!TIERS.includes(arg)) return { kind: 'error', text: `Usage: /router pin <${TIERS.join('|')}>` };
            state.pins.set(agent.id, arg); return { kind: 'success', text: `model-router: pinned this session to the ${arg} tier.` };
          case 'auto': state.pins.delete(agent.id); return { kind: 'success', text: 'model-router: pin cleared; back to automatic routing.' };
          case '': case 'status': {
            const sid = String(agent.session.id);
            const last = state.last.get(sid);
            const pin = state.pins.get(agent.id);
            const lines = [`model-router: mode=${state.mode}${pin ? `, pinned=${pin}` : ''}, sticky=${config.stickyWithinTurn}, auxiliary=${config.auxiliaryTier}`];
            const header = agent.session.requestHeader();
            const provider = header?.config.provider;
            const profile = provider ? config.profiles[provider] : undefined;
            if (profile) lines.push(`profile for ${provider}: ` + TIERS.map((t) => `${t}=${profile[t]?.model ?? '-'}`).join(', '));
            else lines.push(`no profile for provider "${provider ?? 'unknown'}" — requests are not rerouted`);
            if (last) lines.push(`last decision (turn ${last.turn}, step ${last.step}): ${last.tier} → ${fmtRoute(last.to)} — ${last.reasons.join('; ')}`);
            else lines.push('no decisions yet in this session');
            lines.push(`decision log: ${decisionsFile}`);
            return { kind: 'success', text: lines.join('\n') };
          }
          default: return { kind: 'error', text: 'Usage: /router [status|on|off|pin <tier>|auto]' };
        }
      },
    }), 'model-router: /router command');
  });

  const providers = Object.keys(config.profiles);
  ctx.logger.info(`model-router: ready (mode=${state.mode}); profiles for ${providers.length ? providers.join(', ') : 'no providers — add profiles to cordis.patch.yml'}`);
}
