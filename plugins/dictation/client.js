/**
 * dictation — browser half.
 *
 *  - Settings → Dictation: enable switch, engine + model selector (only engines
 *    the harness can reach are selectable), language, chunk length, custom
 *    OpenAI-compatible endpoint, microphone test.
 *  - A mic button in the composer (conversation.input.right) that appears only
 *    when dictation is enabled and the chosen engine is available. Click to
 *    start: a panel above the composer shows a live waveform and the growing
 *    transcript, and the text streams into the draft as it is recognised.
 *    Click again (or Esc) to stop.
 *
 * Engines: `browser` uses the page's SpeechRecognition (interim results in
 * real time). Server engines record with MediaRecorder in short complete
 * chunks and POST each to /dictation/transcribe; the reply is appended.
 */
window.__ModuleLoader__.load({
  id: 'dictation',
  factory: (require) => {
    const React = require('react');
    const h = React.createElement;

    const css = `
.dc-page{display:flex;flex-direction:column;gap:0;color:var(--dsw-alias-label-primary);font-size:14px;line-height:22px}
.dc-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:12px;padding:16px 0;display:flex}
.dc-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;display:flex}
.dc-title{font-weight:400}.dc-desc{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dc-select,.dc-input{background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);border:none;border-radius:18px;padding:0 14px;font-size:14px;min-width:200px}
.dc-input{border-radius:12px}
.dc-switch{width:44px;height:26px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);border:none;position:relative;cursor:pointer;flex:none}
.dc-switch>i{position:absolute;top:3px;left:3px;width:20px;height:20px;border-radius:999px;background:var(--dsw-alias-label-tertiary);transition:left .15s}
.dc-switch[data-on="1"]{background:#238636}.dc-switch[data-on="1"]>i{left:21px;background:#fff}
.dc-badge{font-size:10.5px;line-height:16px;padding:0 6px;border-radius:999px;background:var(--dsw-alias-bg-module-platform);color:var(--dsw-alias-label-secondary);white-space:nowrap;margin-left:6px}
.dc-badge[data-tone="ok"]{color:#16a34a}.dc-badge[data-tone="warn"]{color:#d97706}.dc-badge[data-tone="err"]{color:var(--dsw-alias-state-error-primary,#ef4444)}
.dc-btn{border:.5px solid var(--dsw-alias-border-l4);height:32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);cursor:pointer;background:0 0;border-radius:18px;align-items:center;gap:6px;padding:0 12px;font-size:13px;display:inline-flex;white-space:nowrap}
.dc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}.dc-btn:disabled{opacity:.5;cursor:default}
.dc-mic{width:32px;height:32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:999px;background:0 0;color:var(--dsw-alias-label-primary);cursor:pointer;display:inline-flex;align-items:center;justify-content:center;flex:none;position:relative}
.dc-mic:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dc-mic[data-on="1"]{background:rgba(239,68,68,.15);border-color:#ef4444;color:#ef4444}
.dc-mic[data-on="1"]::after{content:"";position:absolute;inset:-4px;border-radius:999px;border:1.5px solid rgba(239,68,68,.6);animation:dc-ring 1.4s ease-out infinite}
@keyframes dc-ring{0%{transform:scale(.9);opacity:.9}100%{transform:scale(1.35);opacity:0}}
.dc-panel{position:fixed;z-index:50;width:min(560px,calc(100vw - 32px));background:var(--dsw-alias-bg-layer-1,#232324);border:.5px solid var(--dsw-alias-border-l2);border-radius:14px;box-shadow:var(--dsw-shadow-lv2,0 8px 24px rgba(0,0,0,.4));padding:12px 14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:19px}
.dc-panelHead{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dc-panelHead .dc-dot{width:8px;height:8px;border-radius:999px;background:#ef4444;animation:dc-pulse 1.2s ease-in-out infinite}
@keyframes dc-pulse{0%,100%{opacity:1}50%{opacity:.35}}
.dc-wave{width:100%;height:56px;border-radius:10px;background:var(--dsw-alias-bg-module-platform);display:block}
.dc-text{margin-top:8px;max-height:140px;overflow:auto;white-space:pre-wrap;word-break:break-word}
.dc-text .dc-interim{color:var(--dsw-alias-label-tertiary)}
.dc-muted{color:var(--dsw-alias-label-tertiary);font-size:12px}
.dc-err{color:var(--dsw-alias-state-error-primary,#ef4444);font-size:12px;margin-top:6px}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="dictation"]') === null) {
      const tag = document.createElement('style'); tag.dataset.plugin = 'dictation'; tag.dataset.pluginCss = 'dictation'; tag.textContent = css; document.head.appendChild(tag);
    }

    // ---- shared state -----------------------------------------------------
    async function api(op, init = {}, params = {}) {
      const q = new URLSearchParams(params);
      const res = await fetch(`/dictation/${op}${q.toString() ? `?${q}` : ''}`, { headers: { accept: 'application/json', ...(init.headers ?? {}) }, ...init });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) { const e = new Error(body.error ?? `HTTP ${res.status}`); e.status = res.status; throw e; }
      return body;
    }
    const shared = { settings: undefined, providers: undefined, listeners: new Set(), loading: null };
    function notify() { for (const fn of shared.listeners) fn(); }
    function load(force) {
      if (shared.loading && !force) return shared.loading;
      shared.loading = Promise.all([api('settings'), api('providers')]).then(([s, p]) => { shared.settings = s.settings; shared.providers = p.providers; notify(); }).catch(() => { shared.settings ??= null; shared.providers ??= []; notify(); }).finally(() => { shared.loading = null; });
      return shared.loading;
    }
    async function saveSettings(patch) {
      const s = await api('settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      shared.settings = s.settings; notify();
      return s.settings;
    }
    function useShared() {
      const [, tick] = React.useState(0);
      React.useEffect(() => { const fn = () => tick((n) => n + 1); shared.listeners.add(fn); if (shared.settings === undefined) load(false); return () => shared.listeners.delete(fn); }, []);
      return shared;
    }
    const hasBrowserSR = () => typeof window !== 'undefined' && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
    function engineAvailable(settings, providers) {
      if (!settings?.enabled) return false;
      const p = (providers ?? []).find((x) => x.id === settings.engine);
      if (!p) return false;
      if (p.id === 'browser') return hasBrowserSR();
      return p.available === true;
    }

    // ---- settings page ------------------------------------------------------
    const Row = ({ title, desc, children }) => h('div', { className: 'dc-row' }, h('div', { className: 'dc-rowText' }, h('div', { className: 'dc-title' }, title), desc ? h('div', { className: 'dc-desc' }, desc) : null), children);
    const Switch = ({ on, onChange }) => h('button', { type: 'button', className: 'dc-switch', 'data-on': on ? '1' : undefined, role: 'switch', 'aria-checked': on ? 'true' : 'false', onClick: () => onChange(!on) }, h('i'));

    function DictationSettings() {
      const s = useShared();
      const [testing, setTesting] = React.useState(null);
      const settings = s.settings; const providers = s.providers ?? [];
      if (settings === undefined) return h('div', { className: 'dc-page' }, h('div', { className: 'dc-muted' }, 'Loading…'));
      if (settings === null) return h('div', { className: 'dc-page' }, h('div', { className: 'dc-err' }, 'The dictation host routes did not answer. Is the plugin mounted and the server restarted?'));
      const engine = providers.find((p) => p.id === settings.engine);
      const models = engine?.models ?? [];
      const available = engineAvailable(settings, providers);
      const set = (patch) => saveSettings(patch).catch(() => {});
      const testMic = async () => {
        setTesting('asking…');
        try { const st = await navigator.mediaDevices.getUserMedia({ audio: true }); st.getTracks().forEach((t) => t.stop()); setTesting('microphone OK'); }
        catch (e) { setTesting(`microphone blocked: ${e.message}`); }
      };
      return h('div', { className: 'dc-page' },
        h(Row, { title: 'Enable dictation', desc: 'Shows a microphone button in the chat composer when the selected engine is available.' }, h(Switch, { on: settings.enabled, onChange: (v) => set({ enabled: v }) })),
        h(Row, { title: 'Speech-to-text engine', desc: engine?.note ?? 'Pick where audio is transcribed.' },
          h('select', { className: 'dc-select', value: settings.engine, onChange: (e) => { const p = providers.find((x) => x.id === e.target.value); set({ engine: e.target.value, model: p?.models?.[0] ?? '' }); } },
            providers.map((p) => { const ok = p.id === 'browser' ? hasBrowserSR() : p.available; return h('option', { key: p.id, value: p.id }, `${p.label}${ok ? '' : ' (not available)'}`); }))),
        settings.engine !== 'browser' ? h(Row, { title: 'Model', desc: engine ? (engine.available ? 'Models this engine serves for transcription.' : engine.note) : '' },
          models.length ? h('select', { className: 'dc-select', value: settings.model || models[0], onChange: (e) => set({ model: e.target.value }) }, models.map((m) => h('option', { key: m, value: m }, m)))
            : h('input', { className: 'dc-input', placeholder: 'model id', value: settings.model, onChange: (e) => set({ model: e.target.value }) })) : null,
        settings.engine === 'custom' ? h(React.Fragment, null,
          h(Row, { title: 'Custom base URL', desc: 'OpenAI-compatible; audio goes to {baseURL}/audio/transcriptions.' }, h('input', { className: 'dc-input', placeholder: 'https://host/v1', defaultValue: settings.custom.baseURL, onBlur: (e) => set({ custom: { baseURL: e.target.value.trim() } }) })),
          h(Row, { title: 'Key name', desc: 'Credential / env var name holding its API key (stored on the Models page or exported in start-dsh.cmd).' }, h('input', { className: 'dc-input', placeholder: 'MY_STT_API_KEY', defaultValue: settings.custom.apiKeyEnv, onBlur: (e) => set({ custom: { apiKeyEnv: e.target.value.trim() } }) })),
          h(Row, { title: 'Custom model' }, h('input', { className: 'dc-input', placeholder: 'whisper-1', defaultValue: settings.custom.model, onBlur: (e) => set({ custom: { model: e.target.value.trim() }, model: e.target.value.trim() }) }))) : null,
        h(Row, { title: 'Language', desc: 'BCP-47 tag such as en-US; leave blank for automatic.' }, h('input', { className: 'dc-input', placeholder: 'auto', defaultValue: settings.language, onBlur: (e) => set({ language: e.target.value.trim() }) })),
        settings.engine !== 'browser' ? h(Row, { title: 'Chunk length', desc: 'Server engines receive audio in chunks of this many seconds; shorter feels more live, longer transcribes better.' }, h('input', { className: 'dc-input', type: 'number', min: 2, max: 30, style: { minWidth: 90 }, defaultValue: settings.chunkSeconds, onBlur: (e) => set({ chunkSeconds: Number(e.target.value) }) })) : null,
        h(Row, { title: 'Status', desc: available ? 'Dictation is on. The mic button is in the composer, left of the model picker.' : (settings.enabled ? 'Enabled, but the selected engine is not available here.' : 'Disabled.') },
          h('span', null, h('span', { className: 'dc-badge', 'data-tone': available ? 'ok' : settings.enabled ? 'warn' : undefined }, available ? 'ready' : settings.enabled ? 'engine unavailable' : 'off'),
            h('button', { className: 'dc-btn', style: { marginLeft: 10 }, onClick: testMic }, 'Test microphone'), testing ? h('span', { className: 'dc-muted', style: { marginLeft: 8 } }, testing) : null)));
    }

    // ---- recorder -------------------------------------------------------------
    /** Mic + analyser shared by both engines; server engines also run a chunked MediaRecorder. */
    function createRecorder({ engine, model, language, chunkSeconds, onText, onError, onLevel }) {
      let stream; let audioCtx; let analyser; let raf; let recorder; let stopped = false; let recognition;
      let finalText = ''; let interim = ''; let inflight = 0;
      const emit = () => onText(finalText, interim);
      const stopTracks = () => { stream?.getTracks().forEach((t) => t.stop()); };
      async function start() {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
        audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const src = audioCtx.createMediaStreamSource(stream);
        analyser = audioCtx.createAnalyser(); analyser.fftSize = 1024; src.connect(analyser);
        const buf = new Uint8Array(analyser.fftSize);
        const loop = () => { if (stopped) return; analyser.getByteTimeDomainData(buf); onLevel(buf); raf = requestAnimationFrame(loop); };
        loop();
        if (engine === 'browser') startBrowser(); else startChunks();
      }
      function startBrowser() {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        recognition = new SR();
        recognition.continuous = true; recognition.interimResults = true; if (language) recognition.lang = language;
        recognition.onresult = (ev) => {
          let fin = ''; let tmp = '';
          for (let i = 0; i < ev.results.length; i++) { const r = ev.results[i]; if (r.isFinal) fin += r[0].transcript + ' '; else tmp += r[0].transcript; }
          finalText = fin; interim = tmp; emit();
        };
        recognition.onerror = (ev) => { if (ev.error !== 'no-speech' && ev.error !== 'aborted') onError(`speech recognition: ${ev.error}`); };
        recognition.onend = () => { if (!stopped) { try { recognition.start(); } catch { /* restarted too fast */ } } };
        recognition.start();
      }
      function pickMime() { for (const m of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) if (window.MediaRecorder?.isTypeSupported?.(m)) return m; return ''; }
      function startChunks() {
        const mime = pickMime();
        const cycle = () => {
          if (stopped) return;
          recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
          const parts = [];
          recorder.ondataavailable = (e) => { if (e.data && e.data.size > 0) parts.push(e.data); };
          recorder.onstop = async () => {
            const blob = new Blob(parts, { type: recorder.mimeType || mime || 'audio/webm' });
            if (blob.size > 1000) {
              inflight += 1; interim = inflight ? '…' : ''; emit();
              try {
                const q = new URLSearchParams({ engine, model: model ?? '', language: language ?? '', prompt: finalText.slice(-600) });
                const res = await fetch(`/dictation/transcribe?${q}`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
                if (body.text) finalText += (finalText && !finalText.endsWith(' ') ? ' ' : '') + body.text.trim();
              } catch (e) { onError(e.message); }
              finally { inflight -= 1; interim = inflight ? '…' : ''; emit(); }
            }
            if (!stopped) cycle();
          };
          recorder.start();
          setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, Math.max(2, chunkSeconds) * 1000);
        };
        cycle();
      }
      function stop() {
        stopped = true;
        cancelAnimationFrame(raf);
        try { recognition?.stop(); } catch { /* ignore */ }
        try { if (recorder && recorder.state === 'recording') recorder.stop(); } catch { /* ignore */ }
        setTimeout(() => { stopTracks(); audioCtx?.close?.(); }, 400);
      }
      return { start, stop, text: () => finalText };
    }

    // ---- waveform -------------------------------------------------------------
    function Wave({ levelRef }) {
      const ref = React.useRef(null);
      React.useEffect(() => {
        let raf; const canvas = ref.current; const ctx = canvas.getContext('2d');
        const draw = () => {
          const w = canvas.width = canvas.clientWidth * devicePixelRatio; const hgt = canvas.height = canvas.clientHeight * devicePixelRatio;
          ctx.clearRect(0, 0, w, hgt);
          const buf = levelRef.current;
          ctx.lineWidth = 2 * devicePixelRatio; ctx.strokeStyle = '#ef4444'; ctx.beginPath();
          if (buf) { const step = buf.length / w; for (let x = 0; x < w; x++) { const v = (buf[Math.floor(x * step)] - 128) / 128; const y = hgt / 2 + v * (hgt / 2 - 4); x === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); } }
          else { ctx.moveTo(0, hgt / 2); ctx.lineTo(w, hgt / 2); }
          ctx.stroke();
          raf = requestAnimationFrame(draw);
        };
        draw();
        return () => cancelAnimationFrame(raf);
      }, [levelRef]);
      return h('canvas', { ref, className: 'dc-wave' });
    }

    // ---- mic button ------------------------------------------------------------
    function MicButton({ useInput, inputActions }) {
      const s = useShared();
      const draft = useInput((st) => st.draft);
      const [on, setOn] = React.useState(false);
      const [text, setText] = React.useState({ fin: '', tmp: '' });
      const [err, setErr] = React.useState(null);
      const [pos, setPos] = React.useState(null);
      const btnRef = React.useRef(null); const recRef = React.useRef(null); const baseRef = React.useRef(''); const levelRef = React.useRef(null); const draftRef = React.useRef(draft);
      draftRef.current = draft;
      const settings = s.settings; const providers = s.providers;
      const available = engineAvailable(settings, providers);
      const stop = React.useCallback(() => { recRef.current?.stop(); recRef.current = null; setOn(false); }, []);
      const start = async () => {
        setErr(null);
        const base = draftRef.current ?? '';
        baseRef.current = base && !/\s$/.test(base) ? `${base} ` : base;
        const r = btnRef.current?.getBoundingClientRect();
        if (r) setPos({ left: Math.max(16, Math.min(window.innerWidth - 16 - 560, r.right - 560)), bottom: window.innerHeight - r.top + 10 });
        const rec = createRecorder({
          engine: settings.engine, model: settings.model, language: settings.language, chunkSeconds: settings.chunkSeconds,
          onLevel: (buf) => { levelRef.current = buf; },
          onError: (m) => setErr(m),
          onText: (fin, tmp) => { setText({ fin, tmp }); inputActions.setDraft(baseRef.current + fin + (tmp && tmp !== '…' ? tmp : '')); },
        });
        recRef.current = rec; setText({ fin: '', tmp: '' }); setOn(true);
        try { await rec.start(); } catch (e) { setErr(e.message); stop(); }
      };
      React.useEffect(() => { if (!on) return undefined; const key = (e) => { if (e.key === 'Escape') stop(); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, [on, stop]);
      React.useEffect(() => () => { recRef.current?.stop(); }, []);
      if (!available && !on) return null;
      const engineLabel = providers?.find((p) => p.id === settings?.engine)?.label ?? settings?.engine;
      return h(React.Fragment, null,
        h('button', { ref: btnRef, type: 'button', className: 'dc-mic', 'data-on': on ? '1' : undefined, title: on ? 'Stop dictation (Esc)' : `Dictate (${engineLabel}${settings?.model ? ` · ${settings.model}` : ''})`, 'aria-pressed': on ? 'true' : 'false', onClick: () => (on ? stop() : start()) },
          h('svg', { viewBox: '0 0 16 16', width: 15, height: 15, fill: 'currentColor', 'aria-hidden': true },
            h('path', { d: 'M8 1a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3zm5 7a5 5 0 0 1-4.25 4.94V15h-1.5v-2.06A5 5 0 0 1 3 8h1.5a3.5 3.5 0 0 0 7 0H13z' }))),
        on && pos ? h('div', { className: 'dc-panel', style: { left: pos.left, bottom: pos.bottom } },
          h('div', { className: 'dc-panelHead' }, h('span', { className: 'dc-dot' }), h('strong', null, 'Listening'), h('span', { className: 'dc-muted' }, `· ${engineLabel}${settings?.model ? ` · ${settings.model}` : ''}`), h('span', { style: { marginLeft: 'auto' } }), h('button', { className: 'dc-btn', onClick: stop }, 'Stop')),
          h(Wave, { levelRef }),
          h('div', { className: 'dc-text' }, text.fin || text.tmp ? h(React.Fragment, null, text.fin, h('span', { className: 'dc-interim' }, text.tmp)) : h('span', { className: 'dc-muted' }, 'Speak — the transcript appears here and in the message box.')),
          err ? h('div', { className: 'dc-err' }, err) : null) : null);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dictation', order: 45, label: 'Dictation' }, DictationSettings));
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({ name: 'conversation.input.right', id: 'dictation-mic', order: -5, label: 'Dictate' }, MicButton));
      },
    };
  },
});
