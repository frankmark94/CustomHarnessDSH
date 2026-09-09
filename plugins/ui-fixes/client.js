/**
 * ui-fixes — browser half. CSS overrides for third-party UI plugins.
 *
 * TokenLedger (dsh-tokenledger) paints its popover, tooltip and dialog with
 * `color-mix(var(--dsw-alias-bg-overlay) 90%, transparent)`. On the harness
 * version it was written for that token was a surface colour; in this build
 * (0.1.2-rc.1) `--dsw-alias-bg-overlay` is the mid-grey scrim `#61666b`, so
 * the panel rendered as a translucent grey box with the sidebar bleeding
 * through. Repaint those three surfaces with the opaque layer tokens the
 * harness's own popovers use. Loaded after the plugin's own stylesheet (the
 * module graph orders it later), and every rule is scoped to `.tkl_*` classes.
 *
 * Edit this file and the harness hot-reloads it within ~500 ms.
 */
window.__ModuleLoader__.load({
  id: 'ui-fixes',
  factory: () => {
    const css = `
/* TokenLedger: opaque surfaces instead of a 90% grey scrim */
.tkl_panel{background:var(--dsw-alias-bg-layer-1,#232324)!important;border-color:var(--dsw-alias-border-l2)!important}
.tkl_dlg{background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important}
.tkl_tip{background:var(--dsw-alias-bg-layer-2,#2c2c2e)!important}
`;
    if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css="ui-fixes"]') === null) {
      const tag = document.createElement('style');
      tag.dataset.plugin = 'ui-fixes';
      tag.dataset.pluginCss = 'ui-fixes';
      tag.textContent = css;
      document.head.appendChild(tag);
    }
    return { inject: [], apply() { /* CSS only */ } };
  },
});
