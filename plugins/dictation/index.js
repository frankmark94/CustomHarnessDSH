/**
 * dictation — host half.
 *
 * Speech-to-text for the chat composer. The browser records; this host
 * forwards audio to the selected STT provider with a key resolved through the
 * harness credentials service, so no key is ever sent to the browser.
 *
 * Routes (prefix /dictation, gated by connection.requestRejection like git-lens):
 *   GET  /dictation/providers   catalog of STT engines with availability
 *   GET  /dictation/settings    the saved dictation settings
 *   POST /dictation/settings    merge + save (JSON body)
 *   POST /dictation/transcribe?provider&model&language[&prompt]
 *        body: raw audio bytes (content-type audio/webm etc.) → { text }
 *
 * Engines:
 *   - `browser`  — the browser's own SpeechRecognition (Chrome/Edge). No key,
 *                  interim results in real time. Handled entirely client-side.
 *   - catalog entries (OpenAI, Groq, Mistral by default) — OpenAI-compatible
 *                  `POST {baseURL}/audio/transcriptions` (multipart). Available
 *                  when the entry's `apiKeyEnv` resolves through the credentials
 *                  service or the launch environment (the same key the Models
 *                  page stores for that provider).
 *   - `custom`   — user-supplied baseURL + apiKeyEnv, same wire format.
 *
 * Settings live in $DSH_HOME/dictation/settings.json (not the session log).
 */
import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'dictation';
export const inject = ['webServer'];

const EngineSchema = z.object({
  id: z.string().required(),
  label: z.string().required(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string().required(),
  models: z.array(z.string()).default([]),
  /** Route id on the Models page whose key this reuses (display only). */
  providerRoute: z.string(),
});

export const Config = z.object({
  prefix: z.string().default('/dictation'),
  settingsFile: z.string(),
  maxAudioBytes: z.natural().default(25 * 1024 * 1024),
  timeoutMs: z.natural().default(60000),
  engines: z.array(EngineSchema).default([
    { id: 'openai', label: 'OpenAI', baseURL: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', providerRoute: 'openai', models: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'] },
    { id: 'groq', label: 'Groq', baseURL: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', providerRoute: 'groq', models: ['whisper-large-v3-turbo', 'whisper-large-v3'] },
    { id: 'mistral', label: 'Mistral', baseURL: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', providerRoute: 'mistral', models: ['voxtral-mini-latest'] },
  ]),
});

export const DEFAULT_SETTINGS = Object.freeze({
  enabled: false,
  engine: 'browser',       // 'browser' | catalog engine id | 'custom'
  model: '',
  language: '',            // BCP-47 or ISO-639-1; '' = auto
  chunkSeconds: 4,         // server engines: audio is sent in chunks this long
  custom: { baseURL: '', apiKeyEnv: '', model: '' },
});

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

export function mergeSettings(current, patch) {
  const next = { ...DEFAULT_SETTINGS, ...current, ...patch, custom: { ...DEFAULT_SETTINGS.custom, ...(current?.custom ?? {}), ...(patch?.custom ?? {}) } };
  next.enabled = next.enabled === true;
  next.engine = typeof next.engine === 'string' ? next.engine : 'browser';
  next.model = typeof next.model === 'string' ? next.model : '';
  next.language = typeof next.language === 'string' ? next.language.trim() : '';
  next.chunkSeconds = Math.min(30, Math.max(2, Number(next.chunkSeconds) || 4));
  return next;
}

/** Resolve the engine used for a transcription request. */
export function resolveEngine(config, settings, engineId) {
  const id = engineId ?? settings.engine;
  if (id === 'custom') {
    const c = settings.custom ?? {};
    if (!c.baseURL || !c.apiKeyEnv) return undefined;
    return { id: 'custom', label: 'Custom (OpenAI-compatible)', baseURL: c.baseURL.replace(/\/+$/, ''), apiKeyEnv: c.apiKeyEnv, models: c.model ? [c.model] : [] };
  }
  const e = (config.engines ?? []).find((x) => x.id === id);
  return e ? { ...e, baseURL: e.baseURL.replace(/\/+$/, '') } : undefined;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export function apply(ctx, config = {}) {
  const routePath = config.prefix.replace(/\/+$/, '');
  const settingsFile = config.settingsFile ?? join(process.env.DSH_HOME ?? process.cwd(), 'dictation', 'settings.json');

  let settings = (() => {
    try { return mergeSettings(JSON.parse(readFileSync(settingsFile, 'utf8')), {}); } catch { return mergeSettings({}, {}); }
  })();
  function save(next) {
    settings = next;
    try {
      mkdirSync(dirname(settingsFile), { recursive: true });
      writeFileSync(`${settingsFile}.tmp`, JSON.stringify(next, null, 2));
      renameSync(`${settingsFile}.tmp`, settingsFile);
    } catch (error) { ctx.logger.warn(`dictation: could not save settings: ${error?.message ?? error}`); }
  }

  async function keyFor(ref) {
    if (!ref) return undefined;
    const credentials = ctx.get('credentials');
    try {
      const hit = await credentials?.resolve?.(ref);
      if (hit?.value) return hit.value;
    } catch { /* fall through */ }
    return process.env[ref] || undefined;
  }

  async function providers() {
    const out = [{ id: 'browser', label: 'Browser speech recognition', models: ['default'], available: true, note: 'Chrome / Edge built-in engine. No key, live interim results. Audio is processed by the browser vendor.' }];
    for (const e of config.engines ?? []) {
      const key = await keyFor(e.apiKeyEnv);
      out.push({ id: e.id, label: e.label, models: e.models, available: key !== undefined, apiKeyEnv: e.apiKeyEnv, providerRoute: e.providerRoute ?? null, note: key !== undefined ? `Key ${e.apiKeyEnv} is configured.` : `Store ${e.apiKeyEnv} (add the "${e.providerRoute ?? e.id}" provider on the Models page, or export it in start-dsh.cmd).` });
    }
    const c = settings.custom ?? {};
    const customKey = c.apiKeyEnv ? await keyFor(c.apiKeyEnv) : undefined;
    out.push({ id: 'custom', label: 'Custom (OpenAI-compatible)', models: c.model ? [c.model] : [], available: Boolean(c.baseURL && c.apiKeyEnv && customKey), apiKeyEnv: c.apiKeyEnv || null, baseURL: c.baseURL || null, note: c.baseURL && c.apiKeyEnv ? (customKey ? 'Configured.' : `Key ${c.apiKeyEnv} is not set.`) : 'Set a base URL and the env/credential name of its key.' });
    return out;
  }

  async function transcribe(engine, bytes, contentType, { model, language, prompt }) {
    const key = await keyFor(engine.apiKeyEnv);
    if (!key) throw Object.assign(new Error(`no key for ${engine.apiKeyEnv}`), { status: 412 });
    const ext = /ogg/.test(contentType) ? 'ogg' : /mp4|m4a/.test(contentType) ? 'm4a' : /wav/.test(contentType) ? 'wav' : /mpeg|mp3/.test(contentType) ? 'mp3' : 'webm';
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: contentType || 'audio/webm' }), `chunk.${ext}`);
    form.append('model', model || engine.models[0] || 'whisper-1');
    form.append('response_format', 'json');
    if (language) form.append('language', language.split('-')[0]);
    if (prompt) form.append('prompt', prompt.slice(0, 800));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    try {
      const res = await fetch(`${engine.baseURL}/audio/transcriptions`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal: controller.signal });
      const text = await res.text();
      if (!res.ok) throw Object.assign(new Error(`${engine.label}: HTTP ${res.status} ${text.slice(0, 300)}`), { status: 502 });
      try { return { text: JSON.parse(text).text ?? '' }; } catch { return { text }; }
    } finally { clearTimeout(timer); }
  }

  // -- HTTP ---------------------------------------------------------------------
  function send(res, status, body) {
    const json = JSON.stringify(body);
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(json) });
    res.end(json);
  }
  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0; const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > limit) { reject(Object.assign(new Error('body too large'), { status: 413 })); req.destroy(); } else chunks.push(c); });
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }
  async function handler(req, res) {
    const connection = ctx.get('connection');
    const rejection = connection?.requestRejection?.(req);
    if (rejection === 401 && typeof connection.writeUnauthorized === 'function') return connection.writeUnauthorized(req, res);
    if (rejection !== undefined) return send(res, rejection, { error: rejection === 403 ? 'forbidden' : 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://localhost');
    const op = url.pathname.slice(routePath.length + 1).replace(/\/+$/, '');
    const method = req.method ?? 'GET';
    try {
      switch (`${method} ${op}`) {
        case 'GET providers': return send(res, 200, { providers: await providers() });
        case 'GET settings': return send(res, 200, { settings });
        case 'POST settings': {
          const body = JSON.parse((await readBody(req, 64 * 1024)).toString('utf8') || '{}');
          save(mergeSettings(settings, body));
          ctx.logger.info(`dictation: settings saved (enabled=${settings.enabled}, engine=${settings.engine}, model=${settings.model || '-'})`);
          return send(res, 200, { settings });
        }
        case 'POST transcribe': {
          const engine = resolveEngine(config, settings, url.searchParams.get('engine') ?? undefined);
          if (!engine) return send(res, 400, { error: 'no server-side engine selected (the browser engine transcribes locally)' });
          const bytes = await readBody(req, config.maxAudioBytes);
          if (bytes.length < 200) return send(res, 200, { text: '' });
          const out = await transcribe(engine, bytes, req.headers['content-type'] ?? 'audio/webm', {
            model: url.searchParams.get('model') ?? settings.model, language: url.searchParams.get('language') ?? settings.language, prompt: url.searchParams.get('prompt') ?? '',
          });
          return send(res, 200, out);
        }
        default: return send(res, 404, { error: 'unknown route' });
      }
    } catch (error) {
      const status = error?.status ?? 500;
      if (status >= 500) ctx.logger.warn(`dictation: ${op} failed: ${error?.message ?? error}`);
      return send(res, status, { error: String(error?.message ?? error) });
    }
  }
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: routePath, handler }), 'dictation: routes');
  ctx.logger.info(`dictation: ready; enabled=${settings.enabled}, engine=${settings.engine}; ${config.engines.length} server engines in the catalog`);
}
