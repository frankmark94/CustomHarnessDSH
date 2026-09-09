/**
 * harness-panel — browser half.
 *
 * Takes over the right-hand `details` column with a live dashboard. Data comes
 * from session projections the host broadcasts: our own `harnessPanel` (turns,
 * tools, spend, model + router reasons, issues) plus the harness's
 * `contextPressure` and `todos`.
 *
 * Trade-off, on purpose: the shipped Details panel only ever showed the tool
 * you clicked in the chat (and was empty the rest of the time). This panel
 * carries its own tool timeline instead — click a row here to inspect it —
 * because the chat's selection lives in ui-chat's private store.
 *
 * Hand-written in the harness's client-module form (no build step). Only the
 * modules the shell seeds are requirable: react, react-dom, the cordis client,
 * dsh-client-store, dsh-client-ui-slots, dsh-client-ui-primitives.
 */
window.__ModuleLoader__.load({
  id: 'harness-panel',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // ---- styles -----------------------------------------------------------
    const css = `
.hp-root{border-left:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);display:flex;flex-direction:column;height:100%;min-width:0;font-size:12.5px;line-height:18px}
.hp-header{display:flex;align-items:center;gap:8px;padding:14px 12px 10px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.hp-title{font-size:14px;font-weight:500;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hp-close{width:28px;height:28px;border:none;border-radius:999px;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;display:grid;place-items:center;flex:none}
.hp-close:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hp-body{flex:1;min-height:0;overflow-y:auto;padding:8px 12px 16px}
.hp-sec{margin:10px 0 14px}
.hp-sec-h{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;margin-bottom:6px}
.hp-sec-h .hp-badge{margin-left:auto}
.hp-row{display:flex;gap:8px;align-items:baseline;justify-content:space-between;padding:2px 0}
.hp-k{color:var(--dsw-alias-label-tertiary);flex:none}
.hp-v{font-variant-numeric:tabular-nums;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-mono{font-family:var(--ds-font-family-code);font-size:12px}
.hp-dot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-tertiary);flex:none}
.hp-dot[data-on="1"]{background:#22c55e;box-shadow:0 0 0 3px rgba(34,197,94,.18);animation:hp-pulse 1.4s ease-in-out infinite}
.hp-dot[data-err="1"]{background:var(--dsw-alias-state-error-primary,#ef4444)}
@keyframes hp-pulse{0%,100%{opacity:1}50%{opacity:.45}}
.hp-badge{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.hp-badge[data-tone="ok"]{color:#16a34a}
.hp-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.hp-badge[data-tone="warn"]{color:#d97706}
.hp-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.hp-bar{height:6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);overflow:hidden;margin:4px 0}
.hp-bar>i{display:block;height:100%;background:#3b82f6;border-radius:999px;transition:width var(--ds-transition-duration-slow,.3s)}
.hp-bar>i[data-tone="warn"]{background:#d97706}.hp-bar>i[data-tone="err"]{background:#ef4444}.hp-bar>i[data-tone="ok"]{background:#22c55e}
.hp-tool{display:flex;gap:8px;align-items:center;padding:4px 6px;margin:0 -6px;border-radius:8px;cursor:pointer}
.hp-tool:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hp-tool[data-open="1"]{background:var(--dsw-alias-bg-module-platform)}
.hp-tool .hp-name{font-weight:500;flex:none}
.hp-tool .hp-sum{color:var(--dsw-alias-label-tertiary);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-tool .hp-dur{color:var(--dsw-alias-label-tertiary);flex:none;font-variant-numeric:tabular-nums}
.hp-pre{background:var(--dsw-alias-markdown-code-block);font-family:var(--ds-font-family-code);font-size:11.5px;line-height:17px;white-space:pre-wrap;word-break:break-word;border-radius:10px;margin:4px 0 8px;padding:10px 12px;max-height:260px;overflow:auto}
.hp-pre[data-error="1"]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.hp-issue{border:.5px solid var(--dsw-alias-state-error-primary,#ef4444);border-radius:10px;padding:8px 10px;margin-top:4px}
.hp-issue .hp-hint{color:var(--dsw-alias-label-secondary);margin-top:4px}
.hp-empty{color:var(--dsw-alias-label-tertiary);padding:4px 0}
.hp-turn{display:grid;grid-template-columns:28px 1fr auto auto;gap:6px;align-items:baseline;padding:2px 0}
.hp-turn .hp-tm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hp-turn .hp-tc{color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}
.hp-muted{color:var(--dsw-alias-label-tertiary)}
/* header toggle: mirrors the shipped "Session log" utility button */
.hp-toggle{border:.5px solid var(--dsw-alias-border-l4);height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:6px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex;white-space:nowrap}
.hp-toggle:hover{background:var(--dsw-alias-interactive-bg-hover)}
.hp-toggle[data-open="1"]{background:var(--dsw-alias-bg-module-platform)}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="harness-panel"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'harness-panel';
      tag.dataset.pluginCss = 'harness-panel';
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- formatting ------------------------------------------------------
    const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(Math.round(n ?? 0)));
    const fmtUsd = (n) => (n === undefined || n === null ? '—' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
    const fmtDur = (ms) => {
      if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
      const s = Math.max(0, Math.round(ms / 1000));
      if (s < 60) return `${s}s`;
      const m = Math.floor(s / 60);
      return m < 60 ? `${m}m${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
    };
    const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);

    function useNow(active) {
      const [now, setNow] = React.useState(Date.now());
      React.useEffect(() => {
        if (!active) return undefined;
        const id = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(id);
      }, [active]);
      return active ? now : Date.now();
    }

    // ---- sections --------------------------------------------------------
    const Section = ({ title, badge, children }) => h('section', { className: 'hp-sec' },
      h('div', { className: 'hp-sec-h' }, title, badge ?? null),
      children);
    const Row = ({ k, v, mono }) => h('div', { className: 'hp-row' }, h('span', { className: 'hp-k' }, k), h('span', { className: `hp-v${mono ? ' hp-mono' : ''}` }, v));
    const Badge = ({ tone, children }) => h('span', { className: 'hp-badge', 'data-tone': tone }, children);
    const Bar = ({ value, tone }) => h('div', { className: 'hp-bar' }, h('i', { style: { width: `${Math.min(100, Math.max(0, value))}%` }, 'data-tone': tone }));

    function NowSection({ p, running, now }) {
      const c = p.current;
      const elapsed = running && c.startedAt ? now - c.startedAt : null;
      const stepElapsed = running && c.stepStartedAt ? now - c.stepStartedAt : null;
      const runningTool = p.tools.find((t) => t.endedAt === null);
      const route = c.model ? `${c.provider}/${c.model}` : '—';
      return h(Section, { title: 'Now', badge: h(Badge, { tone: running ? 'ok' : undefined }, running ? 'working' : 'idle') },
        h(Row, { k: 'State', v: running ? `turn ${c.turn} · step ${c.step} · ${fmtDur(elapsed)}` : (c.turn ? `turn ${c.turn} done` : 'no turns yet') }),
        h(Row, { k: 'Model', v: route, mono: true }),
        c.tier ? h(Row, { k: 'Tier', v: c.tier }) : null,
        c.reasons?.length ? h('div', { className: 'hp-chips' }, c.reasons.map((r, i) => h(Badge, { key: i }, r))) : null,
        runningTool ? h(Row, { k: 'Tool', v: `${runningTool.name} · ${fmtDur(now - runningTool.startedAt)}`, mono: true })
          : (running && stepElapsed !== null ? h(Row, { k: 'Waiting on', v: `model · ${fmtDur(stepElapsed)}` }) : null));
    }

    function ContextSection({ pressure }) {
      if (!pressure || !pressure.contextWindow) return null;
      const used = pressure.projectedTokens ?? pressure.pressureTokens ?? 0;
      const window = pressure.contextWindow;
      const percent = pct(used, window);
      const tone = percent > 85 ? 'err' : percent > 65 ? 'warn' : undefined;
      return h(Section, { title: 'Context', badge: h(Badge, { tone }, `${percent}%`) },
        h(Bar, { value: percent, tone }),
        h(Row, { k: 'Next request', v: `${fmtTok(used)} of ${fmtTok(window)}` }));
    }

    function SpendSection({ p }) {
      const t = p.totals;
      const tok = t.tokens;
      const billedIn = tok.input + tok.cacheRead + tok.cacheWrite;
      const cacheHit = pct(tok.cacheRead, billedIn);
      const unpriced = Object.values(p.byModel).some((m) => !m.priced);
      const led = p.ledger;
      const delta = led && led.expectedUsd > 0 ? Math.round(((led.actualUsd - led.expectedUsd) / led.expectedUsd) * 100) : null;
      return h(Section, { title: 'Spend', badge: h(Badge, {}, fmtUsd(t.usd)) },
        h(Row, { k: 'Session', v: `${fmtUsd(t.usd)} · ${t.calls} call${t.calls === 1 ? '' : 's'}` }),
        led ? h(Row, { k: 'Expected', v: `${fmtUsd(led.expectedUsd)}${delta === null ? '' : ` (${delta > 0 ? '+' : ''}${delta}%)`}` }) : null,
        h(Row, { k: 'Tokens', v: `${fmtTok(billedIn)} in · ${fmtTok(tok.output)} out` }),
        billedIn > 0 ? h(Row, { k: 'Cache hit', v: `${cacheHit}%` }) : null,
        p.today ? h(Row, { k: 'Today', v: `${fmtUsd(p.today.usd)} · ${p.today.calls} calls` }) : null,
        p.allTime ? h(Row, { k: 'All time', v: `${fmtUsd(p.allTime.usd)} · ${p.allTime.calls} calls` }) : null,
        Object.entries(p.byModel).sort((a, b) => b[1].usd - a[1].usd).map(([route, m]) =>
          h(Row, { key: route, k: h('span', { className: 'hp-mono' }, route.split('/').slice(1).join('/')), v: `${m.priced ? fmtUsd(m.usd) : 'unpriced'} · ${m.calls}×` })),
        unpriced ? h('div', { className: 'hp-muted' }, 'Some models have no catalog price; add them under pricing in cordis.patch.yml.') : null);
    }

    function ToolsSection({ p, now }) {
      const [open, setOpen] = React.useState(null);
      const [follow, setFollow] = React.useState(true);
      const turn = p.current.turn;
      const tools = p.tools.filter((t) => t.turn === turn);
      const list = tools.length ? tools : p.tools.slice(-12);
      const errors = list.filter((t) => t.isError).length;
      const latest = list.length ? list[list.length - 1].callId : null;
      const shown = follow ? latest : open;
      const badge = errors ? h(Badge, { tone: 'err' }, `${errors} error${errors === 1 ? '' : 's'}`) : h(Badge, {}, `${list.length}`);
      return h(Section, { title: tools.length ? 'Tools this turn' : 'Recent tools', badge },
        list.length === 0 ? h('div', { className: 'hp-empty' }, 'No tool calls yet.') : null,
        list.slice().reverse().map((t) => {
          const isOpen = shown === t.callId;
          const dur = t.endedAt ? t.endedAt - t.startedAt : now - t.startedAt;
          return h(React.Fragment, { key: t.callId },
            h('div', { className: 'hp-tool', 'data-open': isOpen ? '1' : undefined, onClick: () => { setFollow(false); setOpen(isOpen ? null : t.callId); } },
              h('span', { className: 'hp-dot', 'data-on': t.endedAt ? undefined : '1', 'data-err': t.isError ? '1' : undefined }),
              h('span', { className: 'hp-name hp-mono' }, t.name),
              h('span', { className: 'hp-sum' }, t.summary),
              h('span', { className: 'hp-dur' }, fmtDur(dur))),
            isOpen ? h('div', null,
              t.args ? h('pre', { className: 'hp-pre' }, prettyJson(t.args)) : null,
              t.endedAt === null ? h('div', { className: 'hp-muted' }, 'Running…')
                : h('pre', { className: 'hp-pre', 'data-error': t.isError ? '1' : undefined }, t.result || '(no output)')) : null);
        }),
        list.length && !follow ? h('div', { className: 'hp-muted', style: { cursor: 'pointer' }, onClick: () => setFollow(true) }, 'Follow latest') : null);
    }

    function prettyJson(raw) {
      try { return JSON.stringify(JSON.parse(raw), null, 2); } catch { return raw; }
    }

    function TurnsSection({ p, now }) {
      const turns = p.turns.slice().reverse().slice(0, 12);
      if (turns.length === 0) return null;
      return h(Section, { title: 'Turns', badge: h(Badge, {}, `${p.turns.length}`) },
        turns.map((t) => {
          const dur = (t.endedAt ?? now) - t.startedAt;
          const err = t.outcome?.kind === 'error';
          const billed = t.tokens.input + t.tokens.cacheRead + t.tokens.cacheWrite;
          return h('div', { className: 'hp-turn', key: t.turn, title: err ? t.outcome.message : undefined },
            h('span', { className: 'hp-tc' }, `#${t.turn}`),
            h('span', { className: 'hp-tm hp-mono' }, t.model ?? '—', t.tier ? h('span', { className: 'hp-muted' }, ` · ${t.tier}`) : null),
            h('span', { className: 'hp-tc' }, `${fmtTok(billed)}/${fmtTok(t.tokens.output)} · ${fmtUsd(t.usd)}`),
            err ? h(Badge, { tone: 'err' }, 'error') : h('span', { className: 'hp-tc' }, `${fmtDur(dur)}${t.toolErrors ? ` · ${t.toolErrors}⚠` : ''}`));
        }));
    }

    function TodosSection({ todos }) {
      if (!Array.isArray(todos) || todos.length === 0) return null;
      const done = todos.filter((t) => t.status === 'completed').length;
      const active = todos.find((t) => t.status === 'in_progress');
      return h(Section, { title: 'Plan', badge: h(Badge, { tone: done === todos.length ? 'ok' : undefined }, `${done}/${todos.length}`) },
        h(Bar, { value: pct(done, todos.length), tone: 'ok' }),
        active ? h(Row, { k: 'Now', v: active.content }) : null,
        todos.filter((t) => t.status === 'pending').slice(0, 3).map((t, i) => h(Row, { key: i, k: 'Next', v: t.content })));
    }

    function IssuesSection({ p }) {
      const e = p.lastError;
      const badges = [];
      if (p.retries) badges.push(h(Badge, { key: 'r', tone: 'warn' }, `${p.retries} retr${p.retries === 1 ? 'y' : 'ies'}`));
      if (p.compactions) badges.push(h(Badge, { key: 'c' }, `${p.compactions} compaction${p.compactions === 1 ? '' : 's'}`));
      if (!e && badges.length === 0) return null;
      return h(Section, { title: 'Issues', badge: badges.length ? h('span', null, badges) : null },
        e ? h('div', { className: 'hp-issue' },
          h('div', { className: 'hp-mono' }, `${e.code ?? 'error'} · turn ${e.turn}`),
          h('div', null, e.message),
          e.hint ? h('div', { className: 'hp-hint' }, e.hint) : null) : null);
    }

    // ---- repo line (from the git-lens plugin's routes; hidden when absent) ----
    function RepoSection({ cwd }) {
      const [s, setS] = React.useState(undefined);
      React.useEffect(() => {
        if (!cwd) return undefined;
        let alive = true;
        const load = () => fetch(`/git-lens/summary?cwd=${encodeURIComponent(cwd)}`, { headers: { accept: 'application/json' } })
          .then((r) => (r.ok ? r.json() : null)).then((d) => { if (alive) setS(d); }).catch(() => { if (alive) setS(null); });
        load();
        const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
        return () => { alive = false; clearInterval(t); };
      }, [cwd]);
      if (!s || !s.isRepo) return null;
      const r = s.remote;
      const label = r?.owner && r?.repo ? `${r.owner}/${r.repo}` : (r?.url ?? 'no remote');
      const ago = (unix) => { const m = Math.max(0, Math.floor((Date.now() / 1000 - unix) / 60)); return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.floor(m / 60)}h ago` : `${Math.floor(m / 1440)}d ago`; };
      return h(Section, { title: 'Repo', badge: s.dirty ? h(Badge, { tone: 'warn' }, `${s.dirty} changed`) : h(Badge, { tone: 'ok' }, 'clean') },
        h(Row, { k: r?.kind === 'github' ? 'GitHub' : 'Remote', v: r?.webUrl ? h('a', { href: r.webUrl, target: '_blank', rel: 'noreferrer', style: { color: 'inherit' } }, label) : label, mono: true }),
        h(Row, { k: 'Branch', v: `${s.branch ?? '—'}${s.ahead ? ` ↑${s.ahead}` : ''}${s.behind ? ` ↓${s.behind}` : ''}${s.upstream ? '' : ' (no upstream)'}`, mono: true }),
        s.head ? h(Row, { k: 'HEAD', v: `${s.head.short} · ${s.head.subject}`, mono: true }) : null,
        s.head ? h(Row, { k: 'Committed', v: `${ago(s.head.time)} by ${s.head.author}` }) : null,
        h('div', { className: 'hp-muted' }, 'Details in the Git tab.'));
    }

    // ---- panel -----------------------------------------------------------
    // The column starts closed in the shipped layout and only opens on a tool
    // click. A dashboard wants to be visible while the agent works, so open it
    // when a session view mounts — unless the user closed it during this page
    // load, which we respect for the rest of the visit. The header "Harness"
    // button toggles it back at any time; `ctx.layout` exposes no open/closed
    // read, so we track what we asked for ourselves.
    let userClosed = false;
    const panelState = { open: false, listeners: new Set() };
    function setPanelOpen(open) {
      panelState.open = open;
      for (const fn of panelState.listeners) fn(open);
    }
    function usePanelOpen() {
      const [open, setOpen] = React.useState(panelState.open);
      React.useEffect(() => {
        panelState.listeners.add(setOpen);
        return () => panelState.listeners.delete(setOpen);
      }, []);
      return open;
    }

    function HeaderToggle({ openDetails, closeDetails }) {
      const open = usePanelOpen();
      return h('button', {
        type: 'button', className: 'hp-toggle', 'data-open': open ? '1' : undefined,
        title: open ? 'Hide the Harness panel' : 'Show the Harness panel',
        onClick: () => {
          if (open) { userClosed = true; closeDetails(); setPanelOpen(false); }
          else { userClosed = false; openDetails(); setPanelOpen(true); }
        },
      }, h('span', { className: 'hp-dot', 'data-on': open ? '1' : undefined, style: { width: 7, height: 7 } }), 'Harness');
    }

    function HarnessPanel({ useProjection, useSession, useSessions, sessionId, closeDetails, openDetails }) {
      const cwd = useSessions((list) => list.byId[sessionId]?.cwd);
      React.useEffect(() => {
        if (!userClosed) { try { openDetails(); setPanelOpen(true); } catch { /* layout not wired yet */ } }
      }, []);
      const p = useProjection('harnessPanel');
      const pressure = useProjection('contextPressure');
      const todos = useProjection('todos');
      const running = useSession((s) => s.running) === true;
      const active = running || p?.current?.running === true || (p?.tools ?? []).some((t) => t.endedAt === null);
      const now = useNow(active);
      const status = p?.lastError && p.turns.length && p.turns[p.turns.length - 1]?.outcome?.kind === 'error';
      return h('div', { className: 'hp-root' },
        h('div', { className: 'hp-header' },
          h('span', { className: 'hp-dot', 'data-on': active ? '1' : undefined, 'data-err': !active && status ? '1' : undefined }),
          h('div', { className: 'hp-title' }, 'Harness'),
          h('button', { type: 'button', className: 'hp-close', 'aria-label': 'Close', onClick: () => { userClosed = true; closeDetails(); setPanelOpen(false); } },
            h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': true },
              h('path', { d: 'M4 4l8 8M12 4l-8 8', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' })))),
        h('div', { className: 'hp-body' },
          p === undefined
            ? h('div', { className: 'hp-empty' }, 'Waiting for the harness-panel projection… (is the plugin mounted and the server restarted?)')
            : h(React.Fragment, null,
              h(NowSection, { p, running: active, now }),
              h(IssuesSection, { p }),
              h(RepoSection, { cwd }),
              h(ContextSection, { pressure }),
              h(ToolsSection, { p, now }),
              h(SpendSection, { p }),
              h(TodosSection, { todos }),
              h(TurnsSection, { p, now }))));
    }

    return {
      inject: ['slots', 'layout'],
      apply(ctx) {
        // A single slot renders its LOWEST-priority entry. ui-chat's DetailsPanel
        // sits at 0; a second entry at 0 makes the later registration throw, so
        // shadow explicitly from below.
        ctx.slots.inject('details', () => ctx.slots.register({
          name: 'details',
          priority: -10,
          inject: () => ({
            closeDetails: () => ctx.layout.closeDetails(),
            openDetails: () => ctx.layout.openDetails(),
          }),
        }, HarnessPanel));
        // "Harness" toggle in the session header, left of "Session log".
        ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
          name: 'conversation.session.header.utilities',
          id: 'harness-panel-toggle',
          order: -10,
          label: 'Harness',
          inject: () => ({
            openDetails: () => ctx.layout.openDetails(),
            closeDetails: () => ctx.layout.closeDetails(),
          }),
        }, HeaderToggle));
      },
    };
  },
});
