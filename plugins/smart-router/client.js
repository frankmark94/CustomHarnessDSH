/**
 * smart-router — browser half.
 *
 * Renders the "Smart Model Router" toggle button in the composer tool row
 * (`conversation.input.right` slot — the compact cluster at the bottom-right
 * of the chatbox, left of the model picker). Clicking it POSTs to
 * /smart-router/state; the host flips the flag the model-router reads, so
 * every subsequent model call (main agent AND subagents) flows through the
 * "capability-first for the main agent, cost-first for subagents"
 * orchestration. State persists in `$DSH_HOME/smart-router/state.json`.
 *
 * The browser polls GET /smart-router/state every 5 s while visible and on
 * window focus, so multiple open tabs stay in sync and a hot-reload that
 * changes the host's defaults is picked up.
 *
 * Hand-written in the harness's client-module form; edits hot-reload.
 */
window.__ModuleLoader__.load({
  id: 'smart-router',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // ---- styles -----------------------------------------------------------
    const css = `
.sr-btn{border:.5px solid var(--dsw-alias-border-l4);height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;justify-content:center;align-items:center;gap:6px;padding:6px 12px;font-size:13px;font-weight:400;line-height:20px;display:inline-flex;white-space:nowrap}
.sr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.sr-btn:disabled{opacity:.6;cursor:default}
.sr-btn[data-on="1"]{background:rgba(59,130,246,.13);border-color:#3b82f6;color:#3b82f6}
.sr-btn[data-on="1"]:hover:not(:disabled){background:rgba(59,130,246,.2)}
.sr-dot{width:8px;height:8px;border-radius:999px;background:var(--dsw-alias-label-tertiary);flex:none;transition:background .15s ease}
.sr-dot[data-on="1"]{background:#3b82f6;box-shadow:0 0 0 3px rgba(59,130,246,.18)}
.sr-spin{display:inline-block;width:10px;height:10px;border-radius:999px;border:1.5px solid var(--dsw-alias-label-tertiary);border-top-color:transparent;animation:sr-spin .8s linear infinite}
@keyframes sr-spin{to{transform:rotate(360deg)}}
.sr-label{font-variant-numeric:tabular-nums}
.sr-label[data-on="1"]{font-weight:500}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="smart-router"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'smart-router';
      tag.dataset.pluginCss = 'smart-router';
      tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- helpers ----------------------------------------------------------
    const TOOLTIP_ON = 'Smart Model Router is ON.\nMain agent: capability-first (escalates to reasoning earlier, on the first tool error).\nSubagents: cost-first (stay on fast/standard unless the prompt is genuinely hard).';
    const TOOLTIP_OFF = 'Smart Model Router is OFF.\nClick to enable optimised orchestration.';

    async function fetchState() {
      const res = await fetch('/smart-router/state', { headers: { accept: 'application/json' }, credentials: 'same-origin' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      return typeof body.smart === 'boolean' ? body.smart : false;
    }

    async function postState(next) {
      const res = await fetch('/smart-router/state', {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ smart: next }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      const body = await res.json().catch(() => ({}));
      return typeof body.smart === 'boolean' ? body.smart : next;
    }

    function SmartRouterButton() {
      const [state, setState] = React.useState(undefined); // undefined = loading
      const [pending, setPending] = React.useState(false);

      const refresh = React.useCallback(async () => {
        try {
          const s = await fetchState();
          setState((prev) => (prev === s ? prev : s));
        } catch { /* connection error: keep current state, do not flicker */ }
      }, []);

      React.useEffect(() => {
        let alive = true;
        refresh();
        const interval = setInterval(() => {
          if (alive && document.visibilityState === 'visible') refresh();
        }, 5000);
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => { alive = false; clearInterval(interval); window.removeEventListener('focus', onFocus); };
      }, [refresh]);

      const on = state === true;
      const label = state === undefined ? 'Smart Router' : `Smart Router: ${on ? 'ON' : 'OFF'}`;

      const handleClick = async () => {
        if (pending || state === undefined) return;
        const next = !on;
        setPending(true);
        const prev = state;
        setState(next); // optimistic
        try {
          const confirmed = await postState(next);
          setState((cur) => (cur === next ? confirmed : cur));
        } catch (error) {
          setState(prev); // roll back
          // eslint-disable-next-line no-console
          console.warn('smart-router: toggle failed:', error);
        } finally {
          setPending(false);
        }
      };

      return h('button', {
        type: 'button',
        className: 'sr-btn',
        'data-on': on ? '1' : undefined,
        title: on ? TOOLTIP_ON : TOOLTIP_OFF,
        'aria-pressed': on ? 'true' : 'false',
        'aria-label': on ? 'Disable Smart Model Router' : 'Enable Smart Model Router',
        onClick: handleClick,
        disabled: pending || state === undefined,
      },
        pending
          ? h('span', { className: 'sr-spin' })
          : h('span', { className: 'sr-dot', 'data-on': on ? '1' : undefined }),
        h('span', { className: 'sr-label', 'data-on': on ? '1' : undefined }, label));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'smart-router-toggle',
          // Order -10 puts us LEFT of the shipped model picker + submit cluster
          // (default order 0). Adjust in cordis.patch.yml's slot order to move.
          order: -10,
          label: 'Smart Router',
        }, SmartRouterButton));
      },
    };
  },
});
