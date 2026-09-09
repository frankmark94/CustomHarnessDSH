/**
 * git-lens — host half.
 *
 * Read-only git adapter for the web UI. Git state is not in the session log,
 * so the projection channel cannot carry it; instead this plugin registers a
 * prefix route on the harness web server and the browser half polls it:
 *
 *   GET  /git-lens/summary?cwd=    repo root, remote (parsed for GitHub), branch,
 *                                  upstream, ahead/behind, HEAD, dirty counts, stashes
 *   GET  /git-lens/status?cwd=     working-tree entries with +/- line counts
 *   GET  /git-lens/diff?cwd=&path=&staged=1   unified diff of one file
 *   GET  /git-lens/log?cwd=&n=&skip=          commit list
 *   GET  /git-lens/show?cwd=&sha=  one commit: message, file stats, patch (capped)
 *   GET  /git-lens/branches?cwd=   local + remote branches, stashes
 *   GET  /git-lens/blame?cwd=&path=            per-line blame (capped)
 *   POST /git-lens/fetch?cwd=      `git fetch --prune` (the only network call)
 *
 * Every request must pass the same fence as the rest of the UI: the
 * connection service's Host/Origin check and its signed browser-session
 * cookie (`connection.requestRejection`). `cwd` must be an existing directory
 * that is one of the registered workspaces (or inside one); nothing else is
 * accepted. Only `git` is ever executed, with a fixed argv, never a shell.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync, statSync, readFileSync } from 'node:fs';
import { resolve as resolvePath, sep, isAbsolute } from 'node:path';
import z from '@deepseek-ai/schemastery';

const run = promisify(execFile);

export const name = 'git-lens';
export const inject = ['webServer'];

export const Config = z.object({
  /** Route prefix on the harness web server. */
  prefix: z.string().default('/git-lens/'),
  /** Per-command timeout. `git fetch` gets 4× this. */
  timeoutMs: z.natural().default(15000),
  /** Max bytes of diff / patch text returned per request. */
  maxPatchBytes: z.natural().default(300000),
  /** Max blame lines returned. */
  maxBlameLines: z.natural().default(3000),
  /** When false, any existing directory is accepted as cwd (not just registered workspaces). */
  restrictToWorkspaces: z.boolean().default(true),
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** Parse a git remote URL into { host, owner, repo, webUrl } when it looks like a forge URL. */
export function parseRemote(url) {
  if (typeof url !== 'string' || url.trim() === '') return null;
  const raw = url.trim();
  let host; let path;
  let m = raw.match(/^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/); // git@github.com:owner/repo.git
  if (m) { host = m[1]; path = m[2]; }
  else {
    try {
      const u = new URL(raw);
      host = u.hostname; path = u.pathname.replace(/^\/+/, '');
    } catch { return { url: raw, host: null, owner: null, repo: null, webUrl: null, kind: 'other' }; }
  }
  path = path.replace(/\.git$/, '').replace(/\/+$/, '');
  const parts = path.split('/');
  const owner = parts.length >= 2 ? parts[parts.length - 2] : null;
  const repo = parts.length >= 1 ? parts[parts.length - 1] : null;
  const kind = /github\.com$/i.test(host) ? 'github' : /gitlab/i.test(host) ? 'gitlab' : /bitbucket/i.test(host) ? 'bitbucket' : 'other';
  const webUrl = owner && repo && kind !== 'other' ? `https://${host}/${owner}/${repo}` : (owner && repo ? `https://${host}/${owner}/${repo}` : null);
  return { url: raw, host, owner, repo, webUrl, kind };
}

/** Parse `git status --porcelain=v2 --branch -z` output. */
export function parseStatus(text) {
  const out = { branch: {}, entries: [] };
  const chunks = text.split('\0');
  for (let i = 0; i < chunks.length; i++) {
    const line = chunks[i];
    if (line === '') continue;
    if (line.startsWith('# ')) {
      const [key, ...rest] = line.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.ab') {
        const ab = value.match(/\+(\d+) -(\d+)/);
        out.branch.ahead = ab ? Number(ab[1]) : 0;
        out.branch.behind = ab ? Number(ab[2]) : 0;
      } else out.branch[key.replace('branch.', '')] = value;
      continue;
    }
    const type = line[0];
    if (type === '1') {
      const p = line.split(' ');
      out.entries.push({ kind: 'changed', x: p[1][0], y: p[1][1], path: p.slice(8).join(' ') });
    } else if (type === '2') {
      const p = line.split(' ');
      const orig = chunks[++i] ?? '';
      out.entries.push({ kind: 'renamed', x: p[1][0], y: p[1][1], path: p.slice(9).join(' '), from: orig });
    } else if (type === 'u') {
      const p = line.split(' ');
      out.entries.push({ kind: 'conflict', x: p[1][0], y: p[1][1], path: p.slice(10).join(' ') });
    } else if (type === '?') {
      out.entries.push({ kind: 'untracked', x: '?', y: '?', path: line.slice(2) });
    } else if (type === '!') {
      out.entries.push({ kind: 'ignored', x: '!', y: '!', path: line.slice(2) });
    }
  }
  return out;
}

/** Parse `git diff --numstat` into Map path → { add, del }. */
export function parseNumstat(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const [add, del, ...rest] = line.split('\t');
    const path = rest.join('\t');
    map.set(path, { add: add === '-' ? null : Number(add), del: del === '-' ? null : Number(del) });
  }
  return map;
}

/** Parse `git blame --line-porcelain`. */
export function parseBlame(text, maxLines) {
  const lines = [];
  const commits = new Map();
  let current = null;
  for (const raw of text.split('\n')) {
    if (current === null) {
      const m = raw.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
      if (!m) continue;
      current = { sha: m[1], line: Number(m[3]) };
      if (!commits.has(m[1])) commits.set(m[1], {});
      continue;
    }
    if (raw.startsWith('\t')) {
      const meta = commits.get(current.sha);
      lines.push({ n: current.line, sha: current.sha.slice(0, 8), author: meta.author ?? '', time: meta.time ?? null, summary: meta.summary ?? '', text: raw.slice(1) });
      current = null;
      if (lines.length >= maxLines) break;
      continue;
    }
    const meta = commits.get(current.sha);
    if (raw.startsWith('author ')) meta.author = raw.slice(7);
    else if (raw.startsWith('author-time ')) meta.time = Number(raw.slice(12));
    else if (raw.startsWith('summary ')) meta.summary = raw.slice(8);
  }
  return lines;
}

function clipText(text, max) {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + '\n… (truncated)', truncated: true };
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  // The web server matches a prefix route as `path === prefix || path.startsWith(prefix + '/')`,
  // so the registered path must NOT carry a trailing slash.
  const routePath = config.prefix.replace(/\/+$/, '');
  const prefix = `${routePath}/`;

  async function git(cwd, args, { timeout = config.timeoutMs, maxBuffer = 16 * 1024 * 1024 } = {}) {
    try {
      const { stdout } = await run('git', args, { cwd, timeout, maxBuffer, windowsHide: true, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
      return stdout;
    } catch (error) {
      const stderr = String(error?.stderr ?? '').trim();
      const e = new Error(stderr || error?.message || 'git failed');
      e.status = /not a git repository/i.test(stderr) ? 404 : 500;
      e.code = error?.code;
      throw e;
    }
  }

  /** Only registered workspaces (or a directory inside one) may be inspected. */
  function allowedCwd(cwd) {
    if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) return undefined;
    let real;
    try { real = realpathSync(cwd); if (!statSync(real).isDirectory()) return undefined; } catch { return undefined; }
    if (!config.restrictToWorkspaces) return real;
    const registry = ctx.get('workspaceRegistry');
    const roots = [];
    try { for (const w of registry?.list?.() ?? []) if (typeof w?.path === 'string') roots.push(w.path); } catch { /* no registry */ }
    const norm = (p) => p.replace(/[\\/]+$/, '').toLowerCase();
    const target = norm(real);
    for (const root of roots) {
      const r = norm(root);
      if (target === r || target.startsWith(r + sep.toLowerCase()) || target.startsWith(r + '/')) return real;
    }
    return undefined;
  }

  async function summary(cwd) {
    let root;
    try { root = (await git(cwd, ['rev-parse', '--show-toplevel'])).trim(); } catch (error) {
      if (error.status === 404) return { isRepo: false, cwd };
      throw error;
    }
    const [statusText, remotesText, headText, stashText] = await Promise.all([
      git(cwd, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
      git(cwd, ['remote', '-v']).catch(() => ''),
      git(cwd, ['log', '-1', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s']).catch(() => ''),
      git(cwd, ['stash', 'list', '--format=%gd%x1f%at%x1f%s']).catch(() => ''),
    ]);
    const status = parseStatus(statusText);
    const remotes = [];
    for (const line of remotesText.split('\n')) {
      const m = line.match(/^(\S+)\t(\S+) \((fetch|push)\)$/);
      if (m && m[3] === 'fetch') remotes.push({ name: m[1], ...parseRemote(m[2]) });
    }
    const origin = remotes.find((r) => r.name === 'origin') ?? remotes[0] ?? null;
    const counts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };
    for (const e of status.entries) {
      if (e.kind === 'untracked') counts.untracked += 1;
      else if (e.kind === 'conflict') counts.conflicts += 1;
      else { if (e.x !== '.') counts.staged += 1; if (e.y !== '.') counts.unstaged += 1; }
    }
    const h = headText.trim().split('\x1f');
    const stashes = stashText.split('\n').filter(Boolean).map((l) => { const p = l.split('\x1f'); return { ref: p[0], time: Number(p[1]), subject: p[2] }; });
    return {
      isRepo: true, cwd, root,
      remote: origin, remotes,
      branch: status.branch.head ?? null,
      detached: status.branch.head === '(detached)',
      upstream: status.branch.upstream ?? null,
      ahead: status.branch.ahead ?? 0, behind: status.branch.behind ?? 0,
      head: h.length >= 6 ? { sha: h[0], short: h[1], author: h[2], email: h[3], time: Number(h[4]), subject: h[5] } : null,
      counts, dirty: counts.staged + counts.unstaged + counts.untracked + counts.conflicts,
      stashes,
      checkedAt: Date.now(),
    };
  }

  async function statusFiles(cwd) {
    const [statusText, unstagedNs, stagedNs] = await Promise.all([
      git(cwd, ['status', '--porcelain=v2', '-z', '--untracked-files=all']),
      git(cwd, ['diff', '--numstat']).catch(() => ''),
      git(cwd, ['diff', '--numstat', '--cached']).catch(() => ''),
    ]);
    const unstaged = parseNumstat(unstagedNs);
    const staged = parseNumstat(stagedNs);
    const entries = parseStatus(statusText).entries.filter((e) => e.kind !== 'ignored').map((e) => ({
      ...e,
      stagedStat: staged.get(e.path) ?? null,
      unstagedStat: unstaged.get(e.path) ?? null,
    }));
    return { entries };
  }

  async function diff(cwd, path, staged) {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) throw Object.assign(new Error('path required'), { status: 400 });
    let text;
    if (staged) text = await git(cwd, ['diff', '--cached', '--', path]);
    else {
      text = await git(cwd, ['diff', '--', path]);
      if (text === '') {
        // Untracked: render the whole file as added.
        try {
          const content = readFileSync(resolvePath(cwd, path), 'utf8');
          const lines = content.split('\n');
          text = `diff --git a/${path} b/${path}\nnew file\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
        } catch { text = ''; }
      }
    }
    return clipText(text, config.maxPatchBytes);
  }

  async function log(cwd, n, skip) {
    const text = await git(cwd, ['log', `-n${n}`, `--skip=${skip}`, '--date=unix', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%P%x1f%D%x1f%s']);
    const commits = text.split('\n').filter(Boolean).map((l) => {
      const p = l.split('\x1f');
      return { sha: p[0], short: p[1], author: p[2], email: p[3], time: Number(p[4]), parents: p[5] ? p[5].split(' ') : [], refs: p[6] ? p[6].split(', ').filter(Boolean) : [], subject: p[7] };
    });
    return { commits, next: commits.length === n ? skip + n : null };
  }

  async function show(cwd, sha) {
    if (!/^[0-9a-f]{4,40}$/i.test(sha ?? '')) throw Object.assign(new Error('sha required'), { status: 400 });
    const [meta, numstat, patch] = await Promise.all([
      git(cwd, ['show', '-s', '--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%B', sha]),
      git(cwd, ['show', '--numstat', '--format=', sha]),
      git(cwd, ['show', '--format=', '--patch', sha], { maxBuffer: 64 * 1024 * 1024 }),
    ]);
    const p = meta.split('\x1f');
    const files = [...parseNumstat(numstat)].map(([path, s]) => ({ path, ...s }));
    return { sha: p[0], short: p[1], author: p[2], email: p[3], time: Number(p[4]), refs: p[5] ? p[5].split(', ').filter(Boolean) : [], message: (p[6] ?? '').trim(), files, ...clipText(patch, config.maxPatchBytes) };
  }

  async function branches(cwd) {
    const fmt = '%(refname:short)%1f%(HEAD)%1f%(upstream:short)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(subject)';
    const [local, remote] = await Promise.all([
      git(cwd, ['branch', '--format=' + fmt.replace(/%1f/g, '%1f'), '--sort=-committerdate']),
      git(cwd, ['branch', '-r', '--format=%(refname:short)%1f%(objectname:short)%1f%(committerdate:unix)%1f%(subject)', '--sort=-committerdate']).catch(() => ''),
    ]);
    // git's format uses %xx hex escapes; %1f is not one, so use a literal separator instead.
    const parse = (text, keys) => text.split('\n').filter(Boolean).map((l) => { const p = l.split('\x1f'); const o = {}; keys.forEach((k, i) => { o[k] = p[i] ?? ''; }); return o; });
    return { local: parse(local, ['name', 'head', 'upstream', 'track', 'short', 'time', 'subject']).map((b) => ({ ...b, current: b.head === '*', time: Number(b.time) })), remote: parse(remote, ['name', 'short', 'time', 'subject']).map((b) => ({ ...b, time: Number(b.time) })) };
  }

  async function blame(cwd, path) {
    if (typeof path !== 'string' || path === '' || path.includes('\0')) throw Object.assign(new Error('path required'), { status: 400 });
    const text = await git(cwd, ['blame', '--line-porcelain', '--', path], { maxBuffer: 64 * 1024 * 1024 });
    const lines = parseBlame(text, config.maxBlameLines);
    return { path, lines, truncated: lines.length >= config.maxBlameLines };
  }

  async function fetch(cwd) {
    const out = await git(cwd, ['fetch', '--prune'], { timeout: config.timeoutMs * 4 });
    return { ok: true, output: out.trim(), summary: await summary(cwd) };
  }

  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }

  async function handler(req, res) {
    const connection = ctx.get('connection');
    const rejection = connection?.requestRejection?.(req);
    if (rejection === 401 && typeof connection.writeUnauthorized === 'function') return connection.writeUnauthorized(req, res);
    if (rejection !== undefined) return send(res, rejection, { error: rejection === 403 ? 'forbidden' : 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const op = url.pathname.slice(prefix.length).replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    if (op === 'fetch' ? method !== 'POST' : method !== 'GET') return send(res, 405, { error: 'method-not-allowed' });
    const cwd = allowedCwd(url.searchParams.get('cwd'));
    if (cwd === undefined) return send(res, 400, { error: 'cwd must be an existing directory inside a registered workspace' });
    try {
      switch (op) {
        case 'summary': return send(res, 200, await summary(cwd));
        case 'status': return send(res, 200, await statusFiles(cwd));
        case 'diff': return send(res, 200, await diff(cwd, url.searchParams.get('path'), url.searchParams.get('staged') === '1'));
        case 'log': return send(res, 200, await log(cwd, Math.min(200, Number(url.searchParams.get('n') ?? 30) || 30), Number(url.searchParams.get('skip') ?? 0) || 0));
        case 'show': return send(res, 200, await show(cwd, url.searchParams.get('sha')));
        case 'branches': return send(res, 200, await branches(cwd));
        case 'blame': return send(res, 200, await blame(cwd, url.searchParams.get('path')));
        case 'fetch': return send(res, 200, await fetch(cwd));
        default: return send(res, 404, { error: 'unknown route' });
      }
    } catch (error) {
      const status = error?.status ?? 500;
      if (status >= 500) ctx.logger.warn(`git-lens: ${op} failed in ${cwd}: ${error?.message ?? error}`);
      return send(res, status, { error: String(error?.message ?? error), isRepo: status === 404 ? false : undefined });
    }
  }

  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routePath, handler }), 'git-lens: routes');
  ctx.logger.info(`git-lens: ready; routes under ${prefix} (workspace-restricted: ${config.restrictToWorkspaces})`);
}
