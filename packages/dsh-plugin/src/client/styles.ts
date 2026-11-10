/**
 * The plugin's styles.
 *
 * The browser bundle carries plain CSS instead of a utility framework: the
 * retired app's Tailwind classes are not available here, and the harness
 * already owns a token set. Every colour is a harness token with a neutral
 * fallback, so the panels follow the shell's light/dark theme.
 */
const CSS = `
.ts-root {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 20px;
}
.ts-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.ts-segments {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12));
}
.ts-segment {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  padding: 4px 10px;
  border-radius: 6px;
  cursor: pointer;
  font: inherit;
}
.ts-segment:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ts-segment[aria-selected='true'] {
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.9));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
}
.ts-meta {
  color: var(--dsw-alias-label-secondary, inherit);
  font-size: 12px;
}
.ts-section { display: flex; flex-direction: column; gap: 6px; }
.ts-section-title {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 12px;
  letter-spacing: 0.04em;
}
.ts-list { display: flex; flex-direction: column; gap: 4px; }
.ts-chip {
  flex: 0 0 auto;
  padding: 1px 6px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--dsw-alias-label-secondary, inherit);
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.12));
}
.ts-chip.is-urgent { color: var(--dsw-alias-state-business-primary, inherit); }
.ts-chip.is-important { color: var(--dsw-alias-brand-primary, inherit); }
.ts-chip.is-overdue { color: var(--dsw-alias-state-business-primary, inherit); }
.ts-chip.is-done { color: var(--dsw-alias-label-secondary, inherit); }
.ts-empty { color: var(--dsw-alias-label-secondary, inherit); padding: 8px 0; }
.ts-quadrants {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}
.ts-quadrant {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 120px;
  padding: 8px;
  border-radius: 10px;
  background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.06));
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
}
.ts-quadrant.is-hover {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary, rgba(64, 128, 255, 0.6));
  background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1));
}
.ts-quadrant-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.ts-drag-card { position: relative; }
.ts-drag-card.is-dragging {
  z-index: 20;
  cursor: grabbing;
  opacity: 0.92;
}
.ts-button {
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  background: transparent;
  color: inherit;
  border-radius: 6px;
  padding: 3px 10px;
  cursor: pointer;
  font: inherit;
}
.ts-button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.12)); }
.ts-button:disabled { opacity: 0.45; cursor: default; }
.ts-button.is-primary {
  color: var(--dsw-alias-label-on-solid, #fff);
  background: var(--dsw-alias-state-business-primary, #4080ff);
  border-color: transparent;
}
.ts-button.is-danger { color: var(--dsw-alias-state-business-primary, inherit); }

/* ── task card ─────────────────────────────────────────────────────────── */
.ts-card {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-1, transparent);
  box-shadow: inset 0 0 0 1px var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
  cursor: pointer;
}
.ts-card:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1)); }
.ts-card.is-selected {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary, rgba(64, 128, 255, 0.7));
}
.ts-card.is-active {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-brand-primary, rgba(64, 128, 255, 0.7));
}
.ts-card.is-overdue {
  box-shadow: inset 0 0 0 1px var(--dsw-alias-state-business-primary, rgba(255, 160, 60, 0.55));
}
.ts-card-main { flex: 1 1 auto; min-width: 0; }
.ts-card-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ts-card.is-done .ts-card-title {
  color: var(--dsw-alias-label-dimmed, inherit);
  text-decoration: line-through;
}
.ts-card-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}
.ts-card-time {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 11px;
  white-space: nowrap;
}
.ts-card-actions { display: flex; flex: 0 0 auto; gap: 2px; }
.ts-icon {
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-tertiary, inherit);
  cursor: pointer;
  padding: 0 2px;
  font: inherit;
  line-height: 1;
}
.ts-icon:hover { color: var(--dsw-alias-label-primary, inherit); }
.ts-icon.is-grip { cursor: grab; touch-action: none; }
.ts-icon.is-grip:active { cursor: grabbing; }
.ts-icon.is-star { color: var(--dsw-alias-label-tertiary, inherit); }
.ts-icon.is-star[aria-pressed='true'] { color: var(--dsw-alias-state-warning, #f5a623); }
.ts-icon.is-danger:hover { color: var(--dsw-alias-state-business-primary, inherit); }
.ts-check {
  flex: 0 0 auto;
  width: 16px;
  height: 16px;
  margin-top: 2px;
  border-radius: 50%;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.4));
  background: transparent;
  color: var(--dsw-alias-label-on-solid, #fff);
  cursor: pointer;
  font-size: 10px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.ts-check[aria-pressed='true'] {
  background: var(--dsw-alias-state-business-primary, #4080ff);
  border-color: transparent;
}

/* ── form controls ─────────────────────────────────────────────────────── */
.ts-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-1, rgba(255, 255, 255, 0.9));
  color: inherit;
  font: inherit;
  padding: 4px 8px;
}
.ts-input:focus {
  outline: none;
  border-color: var(--dsw-alias-state-business-primary, #4080ff);
}
.ts-textarea { resize: vertical; font-family: inherit; }
.ts-title-input { font-size: 14px; font-weight: 500; }
.ts-field { display: flex; flex-direction: column; gap: 4px; }
.ts-field-label {
  color: var(--dsw-alias-label-tertiary, inherit);
  font-size: 12px;
}
.ts-field-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.ts-inline { display: flex; align-items: center; gap: 6px; }
.ts-checkline { display: flex; align-items: center; gap: 6px; }
.ts-tag-picker { display: flex; flex-wrap: wrap; gap: 4px; }
.ts-tag {
  border: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  border-radius: 999px;
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  font: inherit;
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
}
.ts-tag.is-on {
  background: var(--dsw-alias-bg-layer-2, rgba(127, 127, 127, 0.16));
  color: var(--dsw-alias-label-primary, inherit);
}

/* ── modal ─────────────────────────────────────────────────────────────── */
.ts-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.28);
}
.ts-modal {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: min(420px, calc(100vw - 32px));
  max-height: calc(100vh - 64px);
  overflow-y: auto;
  padding: 16px;
  border-radius: 12px;
  background: var(--dsw-alias-bg-base, #fff);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.24);
}
.ts-modal-title { font-size: 14px; font-weight: 600; }
.ts-modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

/* ── detail drawer ─────────────────────────────────────────────────────── */
.ts-drawer-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  background: rgba(0, 0, 0, 0.18);
}
.ts-drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 55;
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(380px, calc(100vw - 24px));
  overflow-y: auto;
  padding: 16px;
  border-left: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24));
  background: var(--dsw-alias-bg-base, #fff);
}
.ts-drawer-head { display: flex; align-items: center; justify-content: space-between; }
.ts-drawer-foot {
  display: flex;
  gap: 8px;
  margin-top: auto;
  padding-top: 8px;
  border-top: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
}
.ts-subtasks { display: flex; flex-direction: column; gap: 2px; }
.ts-subtask { display: flex; align-items: center; gap: 6px; }
.ts-subtask .is-done {
  color: var(--dsw-alias-label-dimmed, inherit);
  text-decoration: line-through;
}
.ts-subtask .ts-icon { margin-left: auto; }
.ts-entries { display: flex; flex-direction: column; gap: 2px; }
.ts-entry { display: flex; align-items: center; gap: 6px; }
.ts-entry .ts-icon { margin-left: auto; }

/* ── page ──────────────────────────────────────────────────────────────── */
.ts-page {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-height: 0;
  color: var(--dsw-alias-label-primary, inherit);
  font-size: 13px;
  line-height: 20px;
}
.ts-page-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.16));
}
.ts-page-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
}
`;

let injected = false;

/**
 * Inject the plugin stylesheet once per page.
 * The loader removes plugin-owned tags on unload, so the tag is marked with
 * the plugin id.
 */
export function injectStyles(): void {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  if (
    document.querySelector('style[data-plugin-css="dsh-plugin-tiny-schedule/styles.css"]') !== null
  )
    return;
  const tag = document.createElement('style');
  tag.dataset.plugin = 'dsh-plugin-tiny-schedule';
  tag.dataset.pluginCss = 'dsh-plugin-tiny-schedule/styles.css';
  tag.textContent = CSS;
  document.head.appendChild(tag);
}
