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
 * "Smart mode" (the exported `smartBridge.smartEnabled`, flipped by the
 * sibling `smart-router` plugin's chatbox button) tightens the tier
 * thresholds: the MAIN agent escalates to `reasoning` earlier and on the first
 * errored tool, while SUBAGENTS (sessions whose `meta.origin === 'subagent'`)
 * keep their reasoning budget and bias toward `fast`/`standard`. That is the
 * "most capable per task, optimizing cost" shape the button advertises.
 *
 * @module model-router
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'model-router';
export const inject = ['llm'];

/**
 * "Smart mode" switch, shared in-process. The router OWNS this object; the
 * optional sibling `smart-router` plugin imports it and flips `smartEnabled`
 * from its chatbox button / `/smartrouter` command. The dependency points
 * from the add-on to the core (never the other way round), so the router
 * loads and runs identically whether or not smart-router is mounted.
 */
export const smartBridge = {
  smartEnabled: false,
  /** A subagent session is marked by the harness with `meta.origin === 'subagent'`. */
  isSubagent: (session) => session?.meta?.origin === 'subagent',
};

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
 * decision can be explained. `smart` and `isSubagent` only widen the signal
 * set — the threshold for "reasoning" vs "standard" vs "fast" is the separate
 * `pickTier` step, so the score is comparable across modes.
 * @param {string} prompt
 * @param {object} h - heuristics config
 * @param {object} [ctx]
 * @param {boolean} [ctx.smart] - smart mode on
 * @param {boolean} [ctx.isSubagent] - the call is for a subagent session
 */
export function classifyPrompt(prompt, h, { smart = false, isSubagent = false } = {}) {
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

  // Smart mode: subagents get an extra cost-aware signal — a long reasoning-
  // keyword match inside a subagent is more likely "narrow lookup" than
  // "design", so we dampen it. The main agent gets a small bump for code
  // fences (they tend to matter more there). These are score modifiers; the
  // final tier mapping is in `pickTier`.
  if (smart) {
    if (isSubagent) {
      if (rHits.length > 0 && words < h.longPromptWords) { reasoning = Math.max(0, reasoning - 1); reasons.push('smart mode: subagent keyword hit dampened (likely a narrow lookup)'); }
      if (words > 0 && words <= h.shortPromptWords) { fast += 1; reasons.push('smart mode: subagent short prompt pushed toward fast'); }
    } else if (codeFence && questions <= 1) { reasoning += 1; reasons.push('smart mode: main-agent code fence emphasised'); }
  }

  let tier = 'standard';
  if (reasoning >= 3) tier = 'reasoning';
  else if (fast >= 2 && reasoning === 0) tier = 'fast';
  return { tier, reasons, signals: { words, codeFence, questions, reasoningScore: reasoning, fastScore: fast, smart, isSubagent } };
}

/**
 * Map a prompt classification to a tier under the given mode. Kept separate
 * from `classifyPrompt` so the scoring is comparable across modes and tests
 * can pin one without the other.
 *
 *   auto, main agent:    reasoning>=3 → reasoning, fast>=2 (no reasoning) → fast
 *   auto, subagent:      same as main agent — no mode-specific bias
 *   smart, main agent:   reasoning>=2 → reasoning (capability-first), fast>=2 (no reasoning) → fast
 *   smart, subagent:     reasoning>=2 (after damping) AND words>longPromptWords → reasoning;
 *                        otherwise fast>=2 (no reasoning) → fast;
 *                        else standard (cost-first for subagents)
 *
 * The defaults (`config.defaultTier`) still apply when neither threshold fires.
 */
export function pickTier(classification, h, { smart = false, isSubagent = false, defaultTier = 'standard' } = {}) {
  const { tier: baseTier, signals: s } = classification;
  const reasoning = s?.reasoningScore ?? 0;
  const fast = s?.fastScore ?? 0;
  if (!smart) {
    if (isSubagent) reasonsAdd(classification, 'auto mode: subagent routed by the standard thresholds');
    return baseTier === 'reasoning' || baseTier === 'fast' ? baseTier : defaultTier;
  }
  if (isSubagent) {
    // "Genuinely hard" for a subagent: post-damping reasoning score is at
    // least 2 AND the prompt is longer than `longPromptWords`. The damping in
    // `classifyPrompt` already knocks -1 off for keyword hits on short
    // prompts, so reaching R>=2 here means the prompt is keyword-rich AND
    // long. Short keyword hits stay at standard (and short non-keyword
    // prompts get pushed toward fast by the score bump).
    if (reasoning >= 2 && s.words > h.longPromptWords) {
      reasonsAdd(classification, `smart: subagent genuinely hard (score ${reasoning}, ${s.words} words) → reasoning`);
      return 'reasoning';
    }
    if (fast >= 2 && reasoning === 0) {
      reasonsAdd(classification, 'smart: subagent on a small prompt → fast');
      return 'fast';
    }
    reasonsAdd(classification, 'smart: subagent stays on standard (cost-first)');
    return 'standard';
  }
  // smart, main agent
  if (reasoning >= 2) {
    reasonsAdd(classification, `smart: main-agent reasoning threshold lowered to 2 (score ${reasoning})`);
    return 'reasoning';
  }
  if (fast >= 2 && reasoning === 0) {
    reasonsAdd(classification, 'smart: main-agent short prompt → fast');
    return 'fast';
  }
  return baseTier === 'reasoning' ? 'reasoning' : defaultTier;
}

function reasonsAdd(classification, reason) {
  if (Array.isArray(classification.reasons)) classification.reasons.push(reason);
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
    const isSubagent = smartBridge.isSubagent(session);
    const smart = smartBridge.smartEnabled === true;

    const pin = state.pins.get(agent.id);
    const sticky = state.sticky.get(agent.id);
    if (pin !== undefined) {
      tier = pin; reasons.push(`pinned by /router pin ${pin}`);
    } else if (config.stickyWithinTurn && sticky !== undefined && sticky.turn === turn) {
      tier = sticky.tier; reasons.push(`sticky within turn (chosen at step 1)`);
    } else {
      const prompt = latestHumanPrompt(session);
      const c = classifyPrompt(prompt, config.heuristics, { smart, isSubagent });
      tier = pickTier(c, config.heuristics, { smart, isSubagent, defaultTier: config.defaultTier });
      signals = c.signals; reasons.push(...c.reasons);
      if (smart) reasons.push('smart mode: orchestration ON — main agent capability-first, subagents cost-first');
    }
    // Smart mode: escalate after the FIRST errored tool (capability-first for
    // the main agent). The user's `escalateOnToolErrors` is the floor.
    const escalateAt = smart ? Math.min(1, config.escalateOnToolErrors) : config.escalateOnToolErrors;
    if (pin === undefined && escalateAt > 0 && stats.toolErrors >= escalateAt && tier !== 'reasoning') {
      tier = 'reasoning';
      reasons.push(smart
        ? `${stats.toolErrors} tool error${stats.toolErrors === 1 ? '' : 's'} this turn → smart-mode escalation`
        : `${stats.toolErrors} tool errors this turn → escalate`);
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
      smart, isSubagent,
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
            const smart = smartBridge.smartEnabled === true;
            const lines = [`model-router: mode=${state.mode}${pin ? `, pinned=${pin}` : ''}, smart=${smart ? 'on' : 'off'}, sticky=${config.stickyWithinTurn}, auxiliary=${config.auxiliaryTier}`];
            const header = agent.session.requestHeader();
            const provider = header?.config.provider;
            const profile = provider ? config.profiles[provider] : undefined;
            if (profile) lines.push(`profile for ${provider}: ` + TIERS.map((t) => `${t}=${profile[t]?.model ?? '-'}`).join(', '));
            else lines.push(`no profile for provider "${provider ?? 'unknown'}" — requests are not rerouted`);
            if (last) lines.push(`last decision (turn ${last.turn}, step ${last.step}): ${last.tier} → ${fmtRoute(last.to)}${smart && last.isSubagent ? ' (subagent)' : ''} — ${last.reasons.join('; ')}`);
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
