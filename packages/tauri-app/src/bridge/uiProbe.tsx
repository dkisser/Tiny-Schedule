/**
 * Dev-only harness: mounts the real <App/> and <MarkdownEditor/> inside the
 * Tauri webview and posts what actually rendered back to the mock server.
 * Screenshots were not reachable (no accessibility permission), and text beats
 * a picture here anyway — it distinguishes "cherry-markdown produced its DOM"
 * from "the page is blank".
 */
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import { MarkdownEditor } from '../components/MarkdownEditor';
import '../styles.css';

const errors: string[] = [];
window.addEventListener('error', (e) => errors.push(`${e.message} @ ${e.filename}`));
window.addEventListener('unhandledrejection', (e) => errors.push(`unhandled: ${String(e.reason)}`));

async function report(line: string) {
  const params = new URLSearchParams(location.search);
  const port = params.get('port') ?? '8788';
  console.log(line);
  await tauriFetch(`http://127.0.0.1:${port}/report`, { method: 'POST', body: line }).catch(
    () => undefined,
  );
}

function describe(label: string, root: HTMLElement) {
  const text = (root.textContent ?? '').replace(/\s+/g, ' ').trim();
  return `${label}: children=${root.childElementCount} text="${text.slice(0, 120)}"`;
}

const appMount = document.createElement('div');
appMount.id = 'app-mount';
document.body.append(appMount);

createRoot(appMount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

await new Promise((r) => setTimeout(r, 2500));
await report(describe('App', appMount));
await report(`App html length=${appMount.innerHTML.length}`);

const editorMount = document.createElement('div');
editorMount.id = 'editor-mount';
document.body.append(editorMount);

createRoot(editorMount).render(
  <MarkdownEditor
    initialValue={'# 标题\n\n正文 **加粗**\n\n- 项目一\n- 项目二'}
    onDone={() => undefined}
    onCancel={() => undefined}
  />,
);

await new Promise((r) => setTimeout(r, 2500));
const cherryHost = editorMount.querySelector('div');
const cherryInput = editorMount.querySelector('textarea, .CodeMirror, [contenteditable="true"]');
await report(
  `MarkdownEditor: children=${editorMount.childElementCount} ` +
    `cherryHostChildren=${cherryHost?.childElementCount ?? 0} ` +
    `editableFound=${cherryInput !== null} ` +
    `editorHTMLLength=${cherryHost?.innerHTML.length ?? 0}`,
);
await report(`errors=${errors.length ? errors.join(' | ') : 'none'}`);

// Tailwind 4 generates utilities at build time, so "no white screen" also means
// the utility classes resolve — check a couple of computed values rather than
// trusting that the stylesheet merely loaded.
const probe = document.createElement('div');
probe.className = 'p-4 text-sm font-semibold';
document.body.append(probe);
const style = getComputedStyle(probe);
await report(
  `tailwind: padding=${style.padding} fontSize=${style.fontSize} fontWeight=${style.fontWeight}`,
);
