/**
 * provider-login — browser half. Renders a sign-in control on every Models
 * page provider card whose route has a registered authorization flow
 * (GitHub Copilot today). Starts the flow, shows each notice — the device
 * code with a Copy button and the verification page as a link — answers
 * prompts, and reports the stored grant.
 */
window.__ModuleLoader__.load({
  id: 'provider-login',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;
    const css = `
.pl-root{margin-top:8px;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:10px;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary)}
.pl-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.pl-btn{border:.5px solid var(--dsw-alias-border-l4);height:28px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:14px;align-items:center;gap:6px;padding:0 12px;font-size:12.5px;display:inline-flex;white-space:nowrap}
.pl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.pl-btn:disabled{opacity:.5;cursor:default}
.pl-btn[data-primary="1"]{background:#238636;border-color:#238636;color:#fff}.pl-btn[data-primary="1"]:hover:not(:disabled){background:#2ea043}
.pl-badge{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary)}
.pl-badge[data-tone="ok"]{color:#16a34a}.pl-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#ef4444)}.pl-badge[data-tone="warn"]{color:#d97706}
.pl-code{font-family:var(--ds-font-family-code);font-size:22px;letter-spacing:.12em;font-weight:600;padding:6px 12px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);user-select:all}
.pl-muted{color:var(--dsw-alias-label-tertiary)}
.pl-notice{margin:6px 0}
.pl-input{height:28px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-base);color:inherit;padding:0 8px;font:inherit;min-width:220px}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="provider-login"]') === null) {
      const tag = document.createElement('style'); tag.dataset.plugin = 'provider-login'; tag.dataset.pluginCss = 'provider-login'; tag.textContent = css; document.head.appendChild(tag);
    }

    async function api(op, params = {}, init = {}) {
      const q = new URLSearchParams(params);
      const res = await fetch(`/provider-login/${op}?${q}`, { headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok && res.status !== 202) { const e = new Error(body.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
      return body;
    }

    // flows list shared by every card, refreshed lazily
    let flowsCache = { at: 0, promise: null };
    function loadFlows(force) {
      if (!force && flowsCache.promise && Date.now() - flowsCache.at < 10000) return flowsCache.promise;
      flowsCache = { at: Date.now(), promise: api('flows').then((b) => b.flows).catch(() => []) };
      return flowsCache.promise;
    }

    function CopyButton({ text }) {
      const [done, setDone] = React.useState(false);
      return h('button', { className: 'pl-btn', onClick: async () => { try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard blocked */ } } }, done ? 'Copied ✓' : 'Copy code');
    }

    function Prompt({ prompt, onAnswer }) {
      const [value, setValue] = React.useState('');
      if (prompt.kind === 'select') {
        return h('div', { className: 'pl-notice' }, h('div', null, prompt.message), h('div', { className: 'pl-row', style: { marginTop: 4 } },
          prompt.options.map((o) => h('button', { key: o.id, className: 'pl-btn', title: o.description ?? undefined, onClick: () => onAnswer({ value: o.id }) }, o.label)),
          h('button', { className: 'pl-btn', onClick: () => onAnswer({ decline: true }) }, 'Decline')));
      }
      return h('div', { className: 'pl-notice' }, h('div', null, prompt.message), h('div', { className: 'pl-row', style: { marginTop: 4 } },
        h('input', { className: 'pl-input', type: prompt.kind === 'secret' ? 'password' : 'text', placeholder: prompt.placeholder ?? '', value, onChange: (e) => setValue(e.target.value), onKeyDown: (e) => { if (e.key === 'Enter') onAnswer({ value }); } }),
        h('button', { className: 'pl-btn', 'data-primary': '1', onClick: () => onAnswer({ value }) }, 'Submit'),
        h('button', { className: 'pl-btn', onClick: () => onAnswer({ decline: true }) }, 'Decline')));
    }

    function LoginCard({ provider }) {
      const routeId = provider?.provider;
      const [flow, setFlow] = React.useState(undefined);
      const [attempt, setAttempt] = React.useState(null);
      const [signedIn, setSignedIn] = React.useState(false);
      const [busy, setBusy] = React.useState(false);
      const [err, setErr] = React.useState(null);

      const refresh = React.useCallback(async (force) => {
        const list = await loadFlows(force);
        const f = list.find((x) => x.providerId === routeId) ?? null;
        setFlow(f);
        if (f) { setSignedIn(f.signedIn); setAttempt(f.attempt); }
      }, [routeId]);
      React.useEffect(() => { refresh(false); }, [refresh]);

      // poll while an attempt is running
      React.useEffect(() => {
        if (!flow || attempt?.status !== 'running') return undefined;
        let alive = true;
        const t = setInterval(async () => {
          try { const s = await api('status', { key: flow.key }); if (!alive) return; setAttempt(s.attempt); setSignedIn(s.signedIn); if (s.attempt?.status !== 'running') { flowsCache.at = 0; } } catch (e) { if (alive) setErr(e.message); }
        }, 1500);
        return () => { alive = false; clearInterval(t); };
      }, [flow, attempt?.status]);

      if (!flow) return null;
      const start = async (methodId) => {
        setBusy(true); setErr(null);
        try { const b = await api('begin', { key: flow.key, method: methodId }, { method: 'POST' }); setAttempt(b.attempt); }
        catch (e) { setErr(e.message); } finally { setBusy(false); }
      };
      const cancel = async () => { try { await api('cancel', { key: flow.key }, { method: 'POST' }); } catch (e) { setErr(e.message); } };
      const signOut = async () => { setBusy(true); try { const r = await api('signout', { key: flow.key }, { method: 'POST' }); setSignedIn(r.signedIn); flowsCache.at = 0; } catch (e) { setErr(e.message); } finally { setBusy(false); } };
      const answer = async (body) => { try { await api('answer', { key: flow.key }, { method: 'POST', body: JSON.stringify(body) }); } catch (e) { setErr(e.message); } };

      const running = attempt?.status === 'running';
      const latest = attempt?.notices?.slice().reverse().find((n) => n.code || n.url) ?? null;
      const last = attempt?.notices?.[attempt.notices.length - 1] ?? null;
      const status = signedIn ? h('span', { className: 'pl-badge', 'data-tone': 'ok' }, 'signed in') : h('span', { className: 'pl-badge', 'data-tone': 'warn' }, 'not signed in');

      return h('div', { className: 'pl-root' },
        h('div', { className: 'pl-row' },
          h('strong', null, flow.label), status,
          h('span', { className: 'pl-muted' }, 'OAuth — no API key needed'),
          h('span', { style: { marginLeft: 'auto' } }),
          !running ? flow.methods.map((m) => h('button', { key: m.id, className: 'pl-btn', 'data-primary': m.id === 'oauth' && !signedIn ? '1' : undefined, disabled: busy, onClick: () => start(m.id) }, signedIn ? `Re-sign in (${m.label})` : (m.id === 'oauth' ? `Sign in with ${/copilot|github/i.test(flow.label) ? 'GitHub' : m.label}` : m.label))) : h('button', { className: 'pl-btn', onClick: cancel }, 'Cancel'),
          signedIn && !running ? h('button', { className: 'pl-btn', disabled: busy, onClick: signOut }, 'Sign out') : null),
        running && latest ? h('div', { className: 'pl-notice' },
          h('div', null, latest.message),
          h('div', { className: 'pl-row', style: { marginTop: 6 } },
            latest.code ? h('span', { className: 'pl-code' }, latest.code) : null,
            latest.code ? h(CopyButton, { text: latest.code }) : null,
            latest.url ? h('a', { className: 'pl-btn', 'data-primary': latest.code ? undefined : '1', href: latest.url, target: '_blank', rel: 'noreferrer' }, `Open ${latest.url.replace(/^https?:\/\//, '')}`) : null),
          h('div', { className: 'pl-muted', style: { marginTop: 4 } }, 'Copy the code, open the page, paste it there and approve. This panel updates by itself when GitHub confirms.')) : null,
        running && !latest ? h('div', { className: 'pl-muted pl-notice' }, last?.message ?? 'Starting sign-in…') : null,
        running && attempt?.prompt ? h(Prompt, { prompt: attempt.prompt, onAnswer: answer }) : null,
        !running && attempt ? h('div', { className: 'pl-notice' }, attempt.status === 'authorized' ? h('span', { className: 'pl-badge', 'data-tone': 'ok' }, 'Signed in — click "Fetch available models" on this card to load the model list')
          : attempt.status === 'cancelled' ? h('span', { className: 'pl-badge' }, 'Sign-in cancelled')
            : h('span', { className: 'pl-badge', 'data-tone': 'err' }, `Sign-in failed: ${attempt.error ?? 'unknown error'}`)) : null,
        err ? h('div', { className: 'pl-badge', 'data-tone': 'err' }, err) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // Dispatched with the settings namespace as key on every pi-ai provider card;
        // LoginCard renders nothing for routes without a registered flow.
        ctx.slots.inject('settings.models.provider-card', () => ctx.slots.register({
          name: 'settings.models.provider-card',
          key: 'llm-pi-ai',
        }, LoginCard));
      },
    };
  },
});
