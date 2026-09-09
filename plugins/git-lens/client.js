/**
 * git-lens — browser half. A "Git" tab beside Chat and Trajectory.
 *
 * Reads the session's workspace directory from the sessions store and polls
 * the host's /git-lens/ routes (same-origin, cookie-authenticated). Nothing
 * here can change the repository except the explicit Fetch button, which
 * only runs `git fetch --prune`.
 *
 * Hand-written in the harness's client-module form; edits hot-reload.
 */
window.__ModuleLoader__.load({
  id: 'git-lens',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    // ---- styles -----------------------------------------------------------
    const css = `
.gl-root{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:12.5px;line-height:18px}
.gl-top{display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:10px 16px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.gl-repo{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}
.gl-repo a{color:inherit;text-decoration:none}.gl-repo a:hover{text-decoration:underline}
.gl-kv{display:flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary)}
.gl-mono{font-family:var(--ds-font-family-code);font-size:12px}
.gl-badge{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.gl-badge[data-tone="ok"]{color:#16a34a}.gl-badge[data-tone="warn"]{color:#d97706}.gl-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#ef4444)}.gl-badge[data-tone="info"]{color:#3b82f6}
.gl-btn{border:.5px solid var(--dsw-alias-border-l4);height:28px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:14px;align-items:center;gap:6px;padding:0 12px;font-size:12.5px;display:inline-flex;white-space:nowrap}
.gl-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.gl-btn:disabled{opacity:.5;cursor:default}
.gl-right{margin-left:auto;display:flex;gap:8px;align-items:center}
.gl-body{display:grid;grid-template-columns:minmax(260px,34%) 1fr;flex:1;min-height:0}
.gl-list{border-right:.5px solid var(--dsw-alias-border-l2);overflow-y:auto;min-height:0}
.gl-detail{overflow:auto;min-height:0;padding:10px 16px}
.gl-tabs{display:flex;gap:2px;padding:8px 10px 4px;position:sticky;top:0;background:var(--dsw-alias-bg-base);z-index:1}
.gl-tab{border:none;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;padding:4px 10px;border-radius:8px;font:inherit;font-size:12.5px}
.gl-tab:hover{background:var(--dsw-alias-interactive-bg-hover)}.gl-tab[data-on="1"]{background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-primary);font-weight:500}
.gl-group{color:var(--dsw-alias-label-tertiary);font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;padding:8px 14px 2px}
.gl-row{display:flex;align-items:center;gap:8px;padding:4px 14px;cursor:pointer;min-width:0}
.gl-row:hover{background:var(--dsw-alias-interactive-bg-hover)}.gl-row[data-on="1"]{background:var(--dsw-alias-bg-module-platform)}
.gl-st{width:14px;text-align:center;font-family:var(--ds-font-family-code);font-size:11px;font-weight:700;flex:none}
.gl-st[data-s="M"]{color:#d97706}.gl-st[data-s="A"],.gl-st[data-s="?"]{color:#16a34a}.gl-st[data-s="D"]{color:#ef4444}.gl-st[data-s="R"],.gl-st[data-s="C"]{color:#3b82f6}.gl-st[data-s="U"]{color:#ef4444}
.gl-path{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;direction:rtl;text-align:left}
.gl-path>span{direction:ltr;unicode-bidi:bidi-override}
.gl-num{flex:none;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary);font-size:11.5px}
.gl-add{color:#16a34a}.gl-del{color:#ef4444}
.gl-commit{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:6px 14px;cursor:pointer;border-bottom:.5px solid var(--dsw-alias-border-l1)}
.gl-commit:hover{background:var(--dsw-alias-interactive-bg-hover)}.gl-commit[data-on="1"]{background:var(--dsw-alias-bg-module-platform)}
.gl-commit .gl-sub{grid-column:1/3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gl-commit .gl-meta{grid-column:1/3;color:var(--dsw-alias-label-tertiary);font-size:11.5px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.gl-ref{font-size:10.5px;padding:0 5px;border-radius:6px;background:var(--dsw-alias-bg-module-platform);color:#3b82f6}
.gl-ref[data-head="1"]{color:#16a34a}.gl-ref[data-remote="1"]{color:#d97706}.gl-ref[data-tag="1"]{color:#a855f7}
.gl-pre{font-family:var(--ds-font-family-code);font-size:11.5px;line-height:17px;white-space:pre;overflow:auto;margin:0;background:var(--dsw-alias-markdown-code-block);border-radius:10px;padding:8px 0}
.gl-ln{display:block;padding:0 12px;min-width:max-content}
.gl-ln[data-t="+"]{background:rgba(34,197,94,.13);color:#4ade80}.gl-ln[data-t="-"]{background:rgba(239,68,68,.13);color:#f87171}
.gl-ln[data-t="@"]{color:#60a5fa;background:rgba(59,130,246,.08)}.gl-ln[data-t="h"]{color:var(--dsw-alias-label-tertiary)}
.gl-h{display:flex;align-items:center;gap:8px;margin:0 0 8px;font-size:13px;font-weight:500;flex-wrap:wrap}
.gl-h .gl-right{margin-left:auto}
.gl-msg{white-space:pre-wrap;margin:6px 0 10px;color:var(--dsw-alias-label-secondary)}
.gl-empty{color:var(--dsw-alias-label-tertiary);padding:16px}
.gl-blame{display:grid;grid-template-columns:auto auto auto 1fr;font-family:var(--ds-font-family-code);font-size:11.5px;line-height:17px;background:var(--dsw-alias-markdown-code-block);border-radius:10px;overflow:auto;padding:8px 0}
.gl-blame>span{padding:0 8px;white-space:pre}
.gl-blame .gl-bsha{color:#60a5fa}.gl-blame .gl-bau{color:var(--dsw-alias-label-secondary);max-width:140px;overflow:hidden;text-overflow:ellipsis}.gl-blame .gl-bln{color:var(--dsw-alias-label-tertiary);text-align:right}
.gl-blame [data-alt="1"]{background:rgba(255,255,255,.025)}
.gl-err{border:.5px solid var(--dsw-alias-state-error-primary,#ef4444);border-radius:10px;padding:8px 10px;margin:8px 16px}
.gl-stash{padding:4px 14px;color:var(--dsw-alias-label-secondary)}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="git-lens"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'git-lens'; tag.dataset.pluginCss = 'git-lens'; tag.textContent = css;
      document.head.appendChild(tag);
    }

    // ---- helpers ----------------------------------------------------------
    const ago = (unix) => {
      if (!unix) return '';
      const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60); if (m < 60) return `${m}m ago`;
      const hr = Math.floor(m / 60); if (hr < 48) return `${hr}h ago`;
      const d = Math.floor(hr / 24); if (d < 30) return `${d}d ago`;
      const mo = Math.floor(d / 30); if (mo < 12) return `${mo}mo ago`;
      return `${Math.floor(mo / 12)}y ago`;
    };
    async function api(op, cwd, params = {}, init = {}) {
      const q = new URLSearchParams({ cwd, ...params });
      const res = await fetch(`/git-lens/${op}?${q}`, { headers: { accept: 'application/json' }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(body.error ?? `HTTP ${res.status}`); e.status = res.status; e.body = body; throw e; }
      return body;
    }
    function usePoll(fn, deps, intervalMs) {
      const [state, setState] = React.useState({ data: undefined, error: null, loading: true });
      const tick = React.useRef(0);
      const refresh = React.useCallback(async () => {
        const id = ++tick.current;
        try { const data = await fn(); if (id === tick.current) setState({ data, error: null, loading: false }); }
        catch (error) { if (id === tick.current) setState((s) => ({ data: s.data, error, loading: false })); }
      }, deps); // eslint-disable-line
      React.useEffect(() => {
        let alive = true;
        refresh();
        const timer = setInterval(() => { if (alive && document.visibilityState === 'visible') refresh(); }, intervalMs);
        const onFocus = () => refresh();
        window.addEventListener('focus', onFocus);
        return () => { alive = false; clearInterval(timer); window.removeEventListener('focus', onFocus); };
      }, [refresh, intervalMs]);
      return { ...state, refresh };
    }
    const Badge = ({ tone, children, title }) => h('span', { className: 'gl-badge', 'data-tone': tone, title }, children);
    const Ref = ({ name }) => {
      const head = name.startsWith('HEAD -> ');
      const label = head ? name.slice(8) : name.replace(/^tag: /, '');
      return h('span', { className: 'gl-ref', 'data-head': head ? '1' : undefined, 'data-remote': /^[\w.-]+\/[^ ]/.test(label) && !head ? '1' : undefined, 'data-tag': name.startsWith('tag: ') ? '1' : undefined }, label);
    };
    function DiffText({ text }) {
      const lines = React.useMemo(() => (text ?? '').split('\n'), [text]);
      return h('pre', { className: 'gl-pre' }, lines.map((l, i) => {
        const t = l.startsWith('+++') || l.startsWith('---') ? 'h' : l[0] === '+' ? '+' : l[0] === '-' ? '-' : l.startsWith('@@') ? '@' : (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file') || l.startsWith('deleted') || l.startsWith('rename') || l.startsWith('similarity')) ? 'h' : undefined;
        return h('span', { key: i, className: 'gl-ln', 'data-t': t }, l === '' ? ' ' : l);
      }));
    }
    const GithubIcon = () => h('svg', { viewBox: '0 0 16 16', width: 16, height: 16, 'aria-hidden': true, fill: 'currentColor' },
      h('path', { d: 'M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z' }));

    // ---- header -------------------------------------------------------------
    function RepoHeader({ s, refresh, cwd }) {
      const [fetching, setFetching] = React.useState(false);
      const [fetchMsg, setFetchMsg] = React.useState(null);
      const doFetch = async () => {
        setFetching(true); setFetchMsg(null);
        try { const r = await api('fetch', cwd, {}, { method: 'POST' }); setFetchMsg(r.output ? r.output.split('\n').slice(-1)[0] : 'up to date'); await refresh(); }
        catch (e) { setFetchMsg(`fetch failed: ${e.message}`); }
        finally { setFetching(false); }
      };
      const r = s.remote;
      const repoLabel = r?.owner && r?.repo ? `${r.owner}/${r.repo}` : (r?.url ?? 'no remote');
      return h('div', { className: 'gl-top' },
        h('div', { className: 'gl-repo' },
          r?.kind === 'github' ? h(GithubIcon) : h('span', null, '⎇'),
          r?.webUrl ? h('a', { href: r.webUrl, target: '_blank', rel: 'noreferrer', title: r.url }, repoLabel) : h('span', { title: r?.url }, repoLabel)),
        h('div', { className: 'gl-kv' }, h('span', null, 'branch'), h('span', { className: 'gl-mono' }, s.branch ?? '—'),
          s.upstream ? h('span', { className: 'gl-mono', style: { color: 'var(--dsw-alias-label-tertiary)' } }, `→ ${s.upstream}`) : h(Badge, { tone: 'warn' }, 'no upstream')),
        s.ahead ? h(Badge, { tone: 'info', title: 'commits to push' }, `↑${s.ahead}`) : null,
        s.behind ? h(Badge, { tone: 'warn', title: 'commits to pull' }, `↓${s.behind}`) : null,
        s.dirty ? h(Badge, { tone: 'warn' }, `${s.dirty} changed`) : h(Badge, { tone: 'ok' }, 'clean'),
        s.head ? h('div', { className: 'gl-kv', title: s.head.sha }, h('span', { className: 'gl-mono' }, s.head.short), h('span', null, s.head.subject), h('span', null, `· ${s.head.author} · ${ago(s.head.time)}`)) : null,
        h('div', { className: 'gl-right' },
          fetchMsg ? h('span', { className: 'gl-kv' }, fetchMsg) : null,
          h('button', { className: 'gl-btn', onClick: () => refresh(), title: 'Re-read git status' }, '↻ Refresh'),
          h('button', { className: 'gl-btn', disabled: fetching, onClick: doFetch, title: 'git fetch --prune' }, fetching ? 'Fetching…' : '⇣ Fetch'),
          r?.webUrl ? h('a', { className: 'gl-btn', href: r.webUrl, target: '_blank', rel: 'noreferrer' }, 'Open on ' + (r.kind === 'github' ? 'GitHub' : r.host)) : null));
    }

    // ---- changes ------------------------------------------------------------
    function ChangesList({ cwd, selected, onSelect }) {
      const { data, error } = usePoll(() => api('status', cwd), [cwd], 5000);
      if (error) return h('div', { className: 'gl-err' }, error.message);
      if (!data) return h('div', { className: 'gl-empty' }, 'Loading…');
      const groups = [['Conflicts', (e) => e.kind === 'conflict'], ['Staged', (e) => e.kind !== 'untracked' && e.kind !== 'conflict' && e.x !== '.'], ['Unstaged', (e) => e.kind !== 'untracked' && e.kind !== 'conflict' && e.y !== '.'], ['Untracked', (e) => e.kind === 'untracked']];
      const any = data.entries.length > 0;
      return h(React.Fragment, null,
        !any ? h('div', { className: 'gl-empty' }, 'Working tree clean.') : null,
        groups.map(([label, pred]) => {
          const items = data.entries.filter(pred);
          if (items.length === 0) return null;
          const staged = label === 'Staged';
          return h(React.Fragment, { key: label },
            h('div', { className: 'gl-group' }, `${label} · ${items.length}`),
            items.map((e) => {
              const code = staged ? e.x : (e.kind === 'untracked' ? '?' : e.kind === 'conflict' ? 'U' : e.y);
              const stat = staged ? e.stagedStat : e.unstagedStat;
              const key = `${staged ? 's' : 'w'}:${e.path}`;
              return h('div', { key, className: 'gl-row', 'data-on': selected === key ? '1' : undefined, onClick: () => onSelect({ key, path: e.path, staged, from: e.from }) },
                h('span', { className: 'gl-st', 'data-s': code }, code),
                h('span', { className: 'gl-path', title: e.path }, h('span', null, e.from ? `${e.from} → ${e.path}` : e.path)),
                stat ? h('span', { className: 'gl-num' }, stat.add !== null ? h('span', { className: 'gl-add' }, `+${stat.add} `) : null, stat.del !== null ? h('span', { className: 'gl-del' }, `−${stat.del}`) : null) : null);
            }));
        }));
    }
    function FileDetail({ cwd, sel }) {
      const [mode, setMode] = React.useState('diff');
      const { data, error, loading } = usePoll(() => (mode === 'blame' ? api('blame', cwd, { path: sel.path }) : api('diff', cwd, { path: sel.path, staged: sel.staged ? '1' : '0' })), [cwd, sel.key, mode], 10000);
      return h('div', null,
        h('div', { className: 'gl-h' }, h('span', { className: 'gl-mono' }, sel.path), h(Badge, {}, sel.staged ? 'staged' : 'working tree'),
          h('div', { className: 'gl-right' }, h('button', { className: 'gl-btn', onClick: () => setMode(mode === 'diff' ? 'blame' : 'diff') }, mode === 'diff' ? 'Blame' : 'Diff'))),
        error ? h('div', { className: 'gl-err' }, error.message) : loading && !data ? h('div', { className: 'gl-empty' }, 'Loading…')
          : mode === 'blame' ? h(BlameView, { data }) : h(React.Fragment, null, data.text ? h(DiffText, { text: data.text }) : h('div', { className: 'gl-empty' }, 'No textual diff (binary, or no change on this side).'), data.truncated ? h('div', { className: 'gl-empty' }, 'Diff truncated.') : null));
    }
    function BlameView({ data }) {
      if (!data?.lines) return null;
      let last = null; let alt = 0;
      return h('div', null,
        h('div', { className: 'gl-blame' }, data.lines.flatMap((l) => {
          if (l.sha !== last) { alt ^= 1; last = l.sha; }
          const a = alt ? '1' : undefined;
          return [
            h('span', { key: `s${l.n}`, className: 'gl-bsha', 'data-alt': a, title: `${l.sha} — ${l.summary}` }, l.sha),
            h('span', { key: `a${l.n}`, className: 'gl-bau', 'data-alt': a, title: l.author }, l.author),
            h('span', { key: `d${l.n}`, className: 'gl-bln', 'data-alt': a }, `${ago(l.time)} ${l.n}`),
            h('span', { key: `t${l.n}`, 'data-alt': a }, l.text === '' ? ' ' : l.text),
          ];
        })),
        data.truncated ? h('div', { className: 'gl-empty' }, 'Blame truncated.') : null);
    }

    // ---- commits ------------------------------------------------------------
    function CommitsList({ cwd, selected, onSelect }) {
      const [skip, setSkip] = React.useState(0);
      const [pages, setPages] = React.useState([]);
      const { data, error, refresh } = usePoll(() => api('log', cwd, { n: '30', skip: '0' }), [cwd], 15000);
      React.useEffect(() => { setPages([]); setSkip(0); }, [cwd]);
      const commits = [...(data?.commits ?? []), ...pages.flat()];
      const loadMore = async () => { const next = (data?.next ?? 30) + pages.length * 30; const more = await api('log', cwd, { n: '30', skip: String(next) }); setPages((p) => [...p, more.commits]); setSkip(next); };
      if (error) return h('div', { className: 'gl-err' }, error.message);
      if (!data) return h('div', { className: 'gl-empty' }, 'Loading…');
      return h(React.Fragment, null,
        commits.map((c) => h('div', { key: c.sha, className: 'gl-commit', 'data-on': selected === c.sha ? '1' : undefined, onClick: () => onSelect(c.sha) },
          h('div', { className: 'gl-sub' }, c.subject),
          h('div', { className: 'gl-meta' }, h('span', { className: 'gl-mono' }, c.short), h('span', null, c.author), h('span', null, ago(c.time)), c.parents.length > 1 ? h(Badge, {}, 'merge') : null, c.refs.map((r) => h(Ref, { key: r, name: r }))))),
        data.next !== null ? h('div', { style: { padding: 10 } }, h('button', { className: 'gl-btn', onClick: loadMore }, 'Load older')) : null);
    }
    function CommitDetail({ cwd, sha }) {
      const { data, error, loading } = usePoll(() => api('show', cwd, { sha }), [cwd, sha], 60000);
      if (error) return h('div', { className: 'gl-err' }, error.message);
      if (!data || loading && !data) return h('div', { className: 'gl-empty' }, 'Loading…');
      const adds = data.files.reduce((a, f) => a + (f.add ?? 0), 0); const dels = data.files.reduce((a, f) => a + (f.del ?? 0), 0);
      return h('div', null,
        h('div', { className: 'gl-h' }, h('span', { className: 'gl-mono' }, data.short), h('span', null, data.author), h('span', { style: { color: 'var(--dsw-alias-label-tertiary)' } }, ago(data.time)), data.refs.map((r) => h(Ref, { key: r, name: r })),
          h('div', { className: 'gl-right' }, h('span', { className: 'gl-num' }, `${data.files.length} files `, h('span', { className: 'gl-add' }, `+${adds} `), h('span', { className: 'gl-del' }, `−${dels}`)))),
        h('div', { className: 'gl-msg' }, data.message),
        data.files.map((f) => h('div', { key: f.path, className: 'gl-row', style: { padding: '2px 0', cursor: 'default' } }, h('span', { className: 'gl-path' }, h('span', null, f.path)), h('span', { className: 'gl-num' }, h('span', { className: 'gl-add' }, `+${f.add ?? '·'} `), h('span', { className: 'gl-del' }, `−${f.del ?? '·'}`)))),
        h('div', { style: { height: 10 } }),
        h(DiffText, { text: data.text }), data.truncated ? h('div', { className: 'gl-empty' }, 'Patch truncated.') : null);
    }

    // ---- branches -----------------------------------------------------------
    function BranchesList({ cwd, stashes }) {
      const { data, error } = usePoll(() => api('branches', cwd), [cwd], 20000);
      if (error) return h('div', { className: 'gl-err' }, error.message);
      if (!data) return h('div', { className: 'gl-empty' }, 'Loading…');
      return h(React.Fragment, null,
        h('div', { className: 'gl-group' }, `Local · ${data.local.length}`),
        data.local.map((b) => h('div', { key: b.name, className: 'gl-row', style: { cursor: 'default' }, 'data-on': b.current ? '1' : undefined },
          h('span', { className: 'gl-st', 'data-s': b.current ? 'A' : undefined }, b.current ? '●' : ''),
          h('span', { className: 'gl-path', title: b.subject }, h('span', null, b.name, b.upstream ? ` → ${b.upstream}` : '', b.track ? ` ${b.track}` : '')),
          h('span', { className: 'gl-num' }, `${b.short} · ${ago(b.time)}`))),
        h('div', { className: 'gl-group' }, `Remote · ${data.remote.length}`),
        data.remote.slice(0, 40).map((b) => h('div', { key: b.name, className: 'gl-row', style: { cursor: 'default' } }, h('span', { className: 'gl-st' }, ''), h('span', { className: 'gl-path', title: b.subject }, h('span', null, b.name)), h('span', { className: 'gl-num' }, `${b.short} · ${ago(b.time)}`))),
        h('div', { className: 'gl-group' }, `Stashes · ${stashes.length}`),
        stashes.length === 0 ? h('div', { className: 'gl-stash' }, 'none') : stashes.map((s) => h('div', { key: s.ref, className: 'gl-stash' }, h('span', { className: 'gl-mono' }, s.ref), ` ${s.subject} · ${ago(s.time)}`)));
    }

    // ---- view -----------------------------------------------------------------
    function GitView({ sessionId, useSessions }) {
      const cwd = useSessions((list) => list.byId[sessionId]?.cwd);
      const [tab, setTab] = React.useState('changes');
      const [file, setFile] = React.useState(null);
      const [sha, setSha] = React.useState(null);
      const { data: s, error, refresh } = usePoll(() => (cwd ? api('summary', cwd) : Promise.resolve(undefined)), [cwd], 5000);
      if (!cwd) return h('div', { className: 'gl-empty' }, 'This session has no workspace directory.');
      if (error) return h('div', { className: 'gl-err' }, error.status === 401 ? 'Not authenticated: reopen the URL printed by dsh web.' : error.status === 400 ? `The harness refused this directory: ${error.message}` : error.status === 404 ? `Not a git repository: ${cwd}` : `git-lens: ${error.message}`);
      if (!s) return h('div', { className: 'gl-empty' }, 'Reading repository…');
      if (!s.isRepo) return h('div', { className: 'gl-empty' }, `Not a git repository: ${cwd}`);
      const tabs = [['changes', `Changes${s.dirty ? ` · ${s.dirty}` : ''}`], ['commits', 'Commits'], ['branches', 'Branches']];
      return h('div', { className: 'gl-root' },
        h(RepoHeader, { s, refresh, cwd }),
        h('div', { className: 'gl-body' },
          h('div', { className: 'gl-list' },
            h('div', { className: 'gl-tabs' }, tabs.map(([id, label]) => h('button', { key: id, className: 'gl-tab', 'data-on': tab === id ? '1' : undefined, onClick: () => setTab(id) }, label))),
            tab === 'changes' ? h(ChangesList, { cwd, selected: file?.key, onSelect: setFile })
              : tab === 'commits' ? h(CommitsList, { cwd, selected: sha, onSelect: setSha })
                : h(BranchesList, { cwd, stashes: s.stashes })),
          h('div', { className: 'gl-detail' },
            tab === 'changes' ? (file ? h(FileDetail, { cwd, sel: file, key: file.key }) : h('div', { className: 'gl-empty' }, s.dirty ? 'Select a file to see its diff or blame.' : 'Nothing to show: the working tree is clean.'))
              : tab === 'commits' ? (sha ? h(CommitDetail, { cwd, sha, key: sha }) : h('div', { className: 'gl-empty' }, 'Select a commit.'))
                : h('div', { className: 'gl-empty' }, `Repository root: ${s.root}`, h('br'), `Remote: ${s.remote?.url ?? 'none'}`))));
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'git-lens',
          order: 20,
          label: 'Git',
        }, GitView));
      },
    };
  },
});
