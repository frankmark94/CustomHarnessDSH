# Local plugins for the DeepSeek Harness

Two plain-ESM cordis plugins, mounted for every profile by `../cordis.patch.yml`
(the home-level patch layer the harness reads from `$DSH_HOME`). They import
only what the harness already installs (`@deepseek-ai/schemastery`, the
pi-ai model catalog), so nothing extra needs installing. Edits to the patch
file apply live; edits to the plugin code need a restart of `start-dsh.cmd`.

| Plugin | What it does | Chat command |
|---|---|---|
| `model-router/` | Chooses a **fast / standard / reasoning** model for each call, per provider | `/router` |
| `token-ledger/` | Adds up **expected** tokens before each call and reconciles with **actual** usage; tallies per session, per model, per day, in tokens and USD | `/tokens` |
| `harness-panel/` | Right-hand live dashboard in the web UI: what is running, model + router tier and reasons, spend, context pressure, tool timeline + inspector, plan progress, turn history, last provider error with a hint | (panel) |

## model-router

Hooks the harness's `agent/request` waterfall — the sanctioned place to swap
the provider/model for one request. The loop logs the changed `request/header`
itself, so sessions stay resumable.

The listener is registered with **prepend** (`ctx.on('agent/request', fn, true)`)
so it is always the outermost link of the waterfall. The harness's session
controller installs a per-agent listener that force-applies the "model
selection" (an explicit picker choice, otherwise the last logged header); in a
cordis waterfall the first-registered listener has the final say, and a live
patch reload re-registers this plugin *after* that one. Without prepend every
routing decision was logged but silently undone. An explicit picker choice
(`sessionProjections.stateOf(session, 'modelSelection').pending`) is honoured
for the turn it lands on — the harness clears it once that model is used, so
automatic routing resumes on the next turn.

How a tier is chosen, in order:

1. `/router pin <tier>` wins for that session.
2. Inside a turn the step-1 tier sticks (`stickyWithinTurn`), so the prompt
   cache keeps working across tool-call steps.
3. Otherwise the latest human prompt is scored: reasoning keywords (design,
   debug, why, trade-off, refactor, …), length, multiple questions and code
   blocks push toward **reasoning**; short prompts with simple openers
   (thanks, list, show, rename, …) go **fast**; everything else is
   `defaultTier`.
4. After `escalateOnToolErrors` errored tool results in the same turn the
   tier is bumped to **reasoning**.
5. A guard checks the target model's context window against the current
   context size (via the harness token meter) and keeps the selected model
   when the context would not fit.

Auxiliary calls (compaction summaries, session titles) are sent to
`auxiliaryTier` through the `llm/stream` waterfall.

Tiers live under `profiles.<provider>` in `cordis.patch.yml`. A tier entry is
`{ model, provider?, reasoningEffort? }`; leaving `provider` out keeps the
session's provider. Providers without a profile are never rerouted (one
warning is logged). Every decision is appended to
`$DSH_HOME/model-router/decisions.jsonl` with its reasons and signals.

`/router status` shows mode, the active profile, and the last decision;
`/router off` / `/router on` toggle routing; `/router pin reasoning` pins;
`/router auto` unpins.

## harness-panel

Two halves in one folder, tied together by `package.json`:

- `index.js` (host) registers the `harnessPanel` **session projection** — a
  pure fold over the session log producing plain JSON: current turn/step and
  whether it is running, the route in use plus the model-router's tier and
  reasons for it (read from the router's exported `recentDecisions` map when
  the matching `request/header` folds), per-turn tokens and USD (prices from
  the pi-ai catalogs), a tool timeline with argument/result excerpts, turn
  outcomes, retries, compactions, and the last provider error with a
  plain-language hint (`hintFor`). The wire `view` merges the token-ledger's
  expected-vs-actual figures and today's / all-time spend from its files.
- `client.js` (browser) is hand-written in the harness's client-module form
  and registers into the `details` slot — the right column. It reads
  `harnessPanel`, `contextPressure` and `todos` through `useProjection` and
  renders: **Now** (state, elapsed, model, tier, reason chips, running tool),
  **Issues**, **Context** (pressure bar), **Tools this turn** (click a row to
  inspect args + output; follows the latest by default), **Spend** (session
  actual vs expected, cache hit, today, all time, per model), **Plan** (todo
  progress), **Turns** (model, tier, tokens, cost, duration, outcome).
- `package.json` declares `dsh.client` (platform `web`) and
  `exports["./client"]` so the harness's client-modules registry serves the
  file and hot-reloads it (~500 ms after a save). Its `name` must equal the
  `id` passed to `__ModuleLoader__.load`.

Trade-off: `details` is a single slot, so this panel replaces the shipped
"Details" column (which only ever showed the tool row you clicked in the
chat, and was empty otherwise). The chat's click still opens the column; the
tool you want is in this panel's own timeline. To get the old panel back,
remove the `harness-panel` row from `cordis.patch.yml`.

Config (`cordis.patch.yml`): `catalogProviders` (route → pi-ai catalog for
pricing), `maxTools`, `maxTurns`, `argsChars`, `resultChars`, `ledgerDir`.
Bump `STATE_VERSION` in `index.js` whenever the fold or state shape changes.

Test without booting: `buildProjection(Config(cfg), prices, decisions)` gives
the definition; replay a decompressed session log through `init`/`apply` and
call `wire.view(state)` (see the replay snippet in the project history).

## vendor/dsh-session-search (third-party, vendored)

Not ours. [Tieboyh/dsh-session-search](https://github.com/Tieboyh/dsh-session-search)
(BSD-3-Clause) ships a committed `lib/` build and is meant to be mounted by
path, so it lives in `../vendor/dsh-session-search` and the top-level patch
mounts `./vendor/dsh-session-search/lib/index.js`. It registers two tools:
`agent_session_search` (case-insensitive literal scan over user/assistant
messages of past dsh, Codex, Claude Code and OpenCode sessions, grouped by
session with a snippet and a message window) and `agent_session_read`. Read-only,
no index. `roots.dsh` is overridden to this home's `sessions/`; `pi` is off
(not installed here). Its `@deepseek-ai/*` peer imports resolve from this
folder's `node_modules`. To update: copy the new `lib/` + `package.json`
over, bump `NOTICE`, restart.

## claude-bridge

Brings Claude Code's files into the system prompt without copying them.
Adapted from [YYTbit/dsh-plugin-claude-bridge](https://github.com/YYTbit/dsh-plugin-claude-bridge)
(MIT); rewritten because upstream keyed memory off the harness process cwd
(always `DSH_HOME`) with the wrong drive-letter case, and used async text
providers that this build's assembler calls synchronously.

- **Memory** (`claude-bridge:memory`, dynamic context, order 130): for the
  session's workspace, `~/.claude/projects/<key>/memory/*.md` where `<key>`
  is the path with `:` dropped and separators → `-`, matched case-insensitively
  (`c--Users-…` and `C--Users-…` both occur). `MEMORY.md` (the index) is
  skipped. Sorted feedback > project > reference > user, capped by
  `maxMemoryBytes` (whole entries).
- **Global instructions** (`claude-bridge:global`, section, order 5):
  `~/.claude/CLAUDE.md` if present. The workspace's own AGENTS.md / CLAUDE.md
  is already injected by the harness's `agent-instructions` plugin.
- **Skills** (`claude-bridge:skills`, dynamic context, order 131): name,
  description, argument hint and path of `~/.claude/skills/<name>/SKILL.md`
  and `extraSkillDirs`.

Files are re-read at most every `cacheMs` per session, so new memories take
effect on the next prompt. **Privacy:** all of it goes to the model provider
with every request; set `enableMemory: false` for workspaces whose memories
must stay local. Helpers exported for tests: `encodeProjectPath`,
`findProjectDir`, `parseFrontmatter`, `loadMemories`, `renderMemories`,
`loadSkills`, `renderSkillCatalog`.

## git-lens

Git / GitHub adapter. Git state is not in the session log, so instead of a
projection the host half registers a **prefix route** on the harness web
server (`ctx.webServer.register({ kind: 'prefix', path: '/git-lens/' })`)
and the browser half polls it.

Routes (all GET, JSON; `cwd` required): `summary` (root, remote parsed into
host/owner/repo/webUrl, branch, upstream, ahead/behind, HEAD, dirty counts,
stashes), `status` (porcelain v2 entries + numstat), `diff?path&staged`,
`log?n&skip`, `show?sha` (message, per-file stats, capped patch),
`branches`, `blame?path` (line-porcelain, capped). `POST fetch` runs
`git fetch --prune` and is the only network call. Guards, in order: the
connection service's `requestRejection(req)` (Host/Origin fence + the signed
browser-session cookie every UI request carries), then `cwd` must be an
existing directory inside a registered workspace (`workspaceRegistry.list()`;
`restrictToWorkspaces: false` lifts that). Only `git` is executed, with a
fixed argv and `GIT_TERMINAL_PROMPT=0`.

Browser half: a **Git** tab beside Chat / Trajectory (`conversation.view`,
id `git-lens`). Header: GitHub repo link, branch → upstream, ↑ahead ↓behind,
dirty/clean, HEAD; Refresh / Fetch / Open on GitHub. Left: Changes (staged /
unstaged / untracked / conflicts with +/−), Commits (30 at a time, refs
decorated, Load older), Branches (local, remote, stashes). Right: file diff
with a Blame toggle, or commit message + file stats + patch. Polling: summary
and status every 5 s while the tab is visible, plus on window focus. The
Harness panel's **Repo** section reads `summary` every 15 s and hides itself
when the routes are absent.

Parsers are exported for tests: `parseRemote`, `parseStatus`, `parseNumstat`,
`parseBlame`. Replay: build a fake ctx with `webServer.register` capturing
the handler and call it with `{ url, method, headers, socket }` / a stub
`res`.

## ui-fixes

Client-only. `client.js` injects a scoped stylesheet that overrides
third-party UI plugins whose theme tokens don't match this harness build.
Currently: TokenLedger's `.tkl_panel` / `.tkl_dlg` / `.tkl_tip` use
`--dsw-alias-bg-overlay` at 90%, which in 0.1.2-rc.1 is the mid-grey scrim
(`#61666b`), so the popover was translucent; the override repaints them with
the opaque `--dsw-alias-bg-layer-1/2` surfaces. Edits hot-reload. Keep every
rule scoped to the target plugin's classes.

## token-ledger

Wraps every streaming model call on the `llm/stream` waterfall. Before the
call it prices the frozen request with the same 4-chars-per-token heuristic
the harness's own token meter uses (system prompt, tool schemas, messages) and
adds an expected-output allowance — a running average of what that model has
produced so far, seeded by `expectedOutputTokens` and capped by `maxTokens`.
After the call it records the adapter's `usage` chunk (input, cache reads and
writes, output, reasoning), the variance against the estimate, duration and
finish reason.

Prices: `pricing["provider/model"]` in the config first, then the catalog the
pi-ai adapter ships (`opencode-go`, `deepseek`, `openrouter`, …). The
`deepseek-official` route maps to the catalog's `deepseek` entry via
`catalogProviders`. Calls whose adapter reports no usage are counted from the
estimate and flagged.

Files (JSON, written atomically, debounced):

- `$DSH_HOME/token-ledger/totals.json` — all-time totals, by model, by day
- `$DSH_HOME/token-ledger/sessions/<sessionId>.json` — per-session totals, by
  model, and the last `historyLimit` calls

`/tokens` prints this session's expected vs actual; `/tokens all` the all-time
picture with the last seven days; `/tokens last 10` the most recent calls;
`/tokens reset` zeroes the session counters (all-time totals are kept).

Nothing is written into the session log: this harness version refuses to
reload a session containing event types it does not know, so the ledger and
the router keep their own files instead.
