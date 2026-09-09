# DeepSeek Harness — local setup

Configured for **OpenRouter** on 2026-08-19.

## Start it

Double-click **`start-dsh.cmd`**.

First run downloads `@deepseek-ai/dsh` via `npx` (~1 min). After that it's a few
seconds. The UI opens at **http://127.0.0.1:3080** — open that in your browser.

Requires **Node.js LTS** (https://nodejs.org). Nothing else to install.

## First time in the UI

1. Click **Choose workspace** → add this `DeepSeekHarness` folder → select it.
   The message box stays greyed out until a workspace is picked.
2. In the model picker, choose **OpenRouter → deepseek/deepseek-chat**
   (or `deepseek-r1` for the reasoning model).
3. Send a message.

## What's in here

| File | Purpose |
|---|---|
| `settings.yaml` | Registers OpenRouter as a custom OpenAI-compatible provider |
| `start-dsh.cmd` | Sets `DSH_HOME` to this folder + the API key, then launches the web UI |
| `.gitignore` | Keeps credentials and harness state out of version control |

`start-dsh.cmd` points `DSH_HOME` at this folder, which is why the harness reads
the `settings.yaml` here rather than the default `%USERPROFILE%\.dsh`.

## Third-party plugins installed into the web profile (not in git)

These live in `profiles/web/node_modules` and are registered in
`profiles/web/package.json` → `dsh.profile.bundles`, so a fresh clone must
re-add them (run from this folder; `-w` because pnpm sees the profile as a
workspace root; `--config.auto-install-peers=false` because the harness
packages they peer on are already here):

```
set DSH=node node_modules/@deepseek-ai/dsh/lib/bin.js
%DSH% plugin --profile web add -w "github:zh667/TokenLedger"
%DSH% plugin --profile web add -w dsh-context@latest
%DSH% plugin --profile web add -w @nanmicoder/dsh-agent-teams@0.1.16-rc.1
%DSH% plugin --profile web add -w @paradoxsch/dsh-worktree@alpha
%DSH% plugin --profile web add -w dsh-better-sidebar@latest --config.auto-install-peers=false
```

| Plugin | What you get |
|---|---|
| [dsh-context](https://github.com/bowenliang123/dsh-context) | Context-window composition dashboard: what the model is carrying (system prompt, tool schemas, skills, conversation, injections), token estimates vs provider-reported usage, compactions, model changes |
| [dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | Captain + member agents with dependency-aware tasks, persistent state (`.agent-teams/` in the workspace), messaging and a live UI |
| [dsh-worktree](https://github.com/paradoxSCH/dsh-worktree) | Durable Git worktrees for agents (`.dsh-worktrees/` in the workspace) with the create → work → review → validate → apply → finish lifecycle; adds the `subagent_worktree` tool and `/worktree` commands |
| [DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | Right sidebar with file viewer/editor, terminal (needs `node-pty`), side chat, Git and subagent tabs; other plugins can register tabs |
| [dsh-cost-governor](https://github.com/yushuosun/dsh-cost-governor) | Vendored under `vendor/` (not on npm): budget per period with warn/hard ratios and a `costUsage` projection; `notify-only` until wired to the router |

Restart `start-dsh.cmd` after adding any of them.

## Third-party plugin: TokenLedger (usage dashboard)

[zh667/TokenLedger](https://github.com/zh667/TokenLedger) is installed into the
`web` profile (not into this folder's `plugins/`), so it is **not** in git.
On a fresh clone, after `npm install`, run once:

```
node node_modules/@deepseek-ai/dsh/lib/bin.js plugin --profile web add -w "github:zh667/TokenLedger"
```

(`-w` is needed because pnpm treats the profile as a workspace root.) Restart
`start-dsh.cmd`; a **Token Ledger** button appears at the bottom of the sidebar
and `/tokenledger` works in the chat (`/tokenledger diagnostics` shows route
attribution). It keeps its data in `tokenledger.sqlite` here (ignored by git).
Update / remove with `plugin --profile web update dsh-tokenledger` / `remove dsh-tokenledger`.

## Local plugins (model router + token ledger)

Two plugins in **`plugins/`** are mounted for every profile by the home-level
**`cordis.patch.yml`** in this folder (the harness reads it from `DSH_HOME`;
edits apply live, code changes need a restart).

| Plugin | Purpose | In the chat |
|---|---|---|
| `plugins/model-router` | Routes each call to a fast / standard / reasoning model on the session's provider | `/router status`, `/router pin reasoning`, `/router off` |
| `plugins/token-ledger` | Expected-vs-actual token (and USD) accounting per call, session, model, day | `/tokens`, `/tokens all`, `/tokens last 10` |

Tier models per provider are under `profiles:` in `cordis.patch.yml`. Ledger
files land in `token-ledger/`, routing decisions in `model-router/decisions.jsonl`.
Details: `plugins/README.md`.

## Adjusting models

The model list in `settings.yaml` is a starting set. To see everything your key
can reach: **Settings → Models → OpenRouter → Fetch available models**. Or edit
`settings.yaml` directly — changes apply on the next request, no restart needed.

Any model that accepts images needs `input: [text, image]` on its entry,
otherwise attachments are refused before sending.

## The API key

It lives in `start-dsh.cmd` as an environment variable, not in `settings.yaml`.
`.gitignore` excludes `.credentials.yaml`, but **not** `start-dsh.cmd` — so if
you ever push this folder anywhere, strip the key first or move it to a
user-level environment variable and delete that line.

Rotate at https://openrouter.ai/keys if it leaks.

## Notes

- The harness is **v0.1.0-rc.7, a developer preview** — DeepSeek warns of
  breaking changes between releases. `start-dsh.cmd` pins `@latest`; change it
  to `@0.1.0-rc.7` if an update ever breaks your setup.
- Docs: https://github.com/deepseek-ai/deepseek-harness
- Provider config reference: `docs/user/guide/providers.md` in that repo.

## If it doesn't work

### `MISSING_CREDENTIAL ... provider route "deepseek-official"`

This is the most likely error you'll hit, and it does **not** mean the setup is broken.

`deepseek-official` is a separate built-in route from the `llm-deepseek` plugin.
It is the factory default, it only accepts a real DeepSeek platform key, and it
has nothing to do with the OpenRouter provider configured here.

Fix: pick an **OpenRouter** model in the model picker, then **start a new
session**. A session that has already sent a request keeps the model recorded in
its own log, so the old session will keep failing no matter what you change.

### Other issues

| Symptom | Fix |
|---|---|
| OpenRouter missing from Settings → Models | Add it via **Add a custom provider**: id `openrouter`, base URL `https://openrouter.ai/api/v1`, protocol `openai-completions`, paste the key |
| `400 MissingSessionID ... missing x-opencode-session` on every OpenCode Go turn | OpenCode Go requires that header and this harness build never sends it. `settings.yaml` pins one under `llm-pi-ai.providers.opencode-go.headers` — make sure that block is still there (it hot-reloads, no restart needed) |
| `UNKNOWN_MODEL` | Model slug isn't in `settings.yaml`; add it or pick another |
| 401 on "Fetch available models" | Key rejected by OpenRouter — check it at openrouter.ai/keys |
| Composer stays greyed out | No workspace selected — see step 1 above |
| Port 3080 in use | Run `npx @deepseek-ai/dsh web --port 3081` from this folder |
