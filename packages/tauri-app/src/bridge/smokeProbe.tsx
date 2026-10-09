/**
 * Dev-only smoke harness (wave 2): boots the real bootstrap path against the
 * real data directory, renders the real <App/>, then drives a task CRUD
 * round-trip and reports what landed on disk.
 *
 * It exists because "the port works" has to be shown against a real 186-task
 * dataset, not a fixture: the data path, the schema backfill, the migrations
 * and the store all have to agree with what Electron actually wrote.
 *
 * Logs are POSTed back to the mock server (see scripts/sse-mock.ts) because
 * the webview console is not visible from the terminal.
 */

import { readTextFile } from '@tauri-apps/plugin-fs';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../App';
import { api } from '../api';
import { bootstrap, dataDir } from './bootstrap';
import { joinPath } from './fsAdapter';
import '../styles.css';

const port = new URLSearchParams(location.search).get('port') ?? '8788';

async function report(line: string) {
  console.log(line);
  try {
    await tauriFetch(`http://127.0.0.1:${port}/report`, { method: 'POST', body: line });
  } catch (error) {
    // Swallowing this would make a capability/scope misconfiguration look
    // exactly like an app that never ran, so make it visible on the page.
    document.title = `REPORT FAILED: ${error instanceof Error ? error.message : String(error)}`;
    const pre = document.createElement('pre');
    pre.textContent = `${document.title}\n${line}`;
    document.body.append(pre);
  }
}

const started = Date.now();
function log(message: string) {
  return report(`[${String(Date.now() - started).padStart(5)}ms] ${message}`);
}

// A render-time throw in <App/> unmounts the tree and leaves the probe with an
// empty mount and no clue why. Capture them before rendering so the failure is
// reported rather than showing up as a silently blank window.
const renderErrors: string[] = [];
window.addEventListener('error', (e) => renderErrors.push(`${e.message} @ ${e.filename}`));
window.addEventListener('unhandledrejection', (e) =>
  renderErrors.push(`unhandled: ${String(e.reason)}`),
);

// 1. Boot the real thing: resolves HOME through Rust, opens the store, runs the
//    migrations, installs the data slice. A failure here is the most likely
//    thing to go wrong, so it is reported rather than left as a blank window.
try {
  await bootstrap();
  await log('bootstrap ok');
} catch (error) {
  await log(`BOOTSTRAP FAILED: ${error instanceof Error ? error.message : String(error)}`);
  throw error;
}

const loaded = await api().dataLoad();
await log(
  `dataLoad: tasks=${Object.keys(loaded.tasks).length} projects=${Object.keys(loaded.projects).length} ` +
    `tags=${Object.keys(loaded.tags).length} followUps=${Object.keys(loaded.followUps).length} ` +
    `ideas=${Object.keys(loaded.ideas).length}`,
);
await log(`userName="${loaded.settings.userName}" theme=${loaded.settings.theme}`);

// 2. Render the real App against that data.
const mount = document.createElement('div');
document.body.append(mount);
createRoot(mount).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
await new Promise((r) => setTimeout(r, 3000));
await log(`App rendered: children=${mount.childElementCount} htmlLength=${mount.innerHTML.length}`);
const text = (mount.textContent ?? '').replace(/\s+/g, ' ').trim();
await log(`App text (first 200): "${text.slice(0, 200)}"`);
await log(`render errors: ${renderErrors.length ? renderErrors.join(' | ') : 'none'}`);

// 3. CRUD round-trip against the real on-disk file.
const probeId = `w2-smoke-${Date.now()}`;
const created = await api().taskUpsert({
  id: probeId,
  projectId: 'INBOX_PROJECT',
  tagIds: [],
  subTaskIds: [],
  isDone: false,
  timeEstimate: 0,
  timeSpent: 0,
  timeSpentOnDay: {},
  timeEntries: [],
  notes: '',
  created: Date.now(),
  title: 'W2 冒烟任务',
} as never);
await log(
  `taskUpsert -> ${created.ok ? `${Object.keys(created.data.tasks).length} tasks, new id present=${!!created.data.tasks[probeId]}` : `refused: ${created.error}`}`,
);

// Read it back off disk, not out of the cache, so the assertion is about the file.
const dataPath = joinPath(dataDir(), 'data.json');
const onDisk = JSON.parse(await readTextFile(dataPath));
await log(`on-disk contains probe task: ${!!onDisk.tasks[probeId]}`);
await log(`on-disk tasks total: ${Object.keys(onDisk.tasks).length}`);

const deleted = await api().taskDelete({ id: probeId });
await log(`taskDelete -> present after delete: ${!!deleted.tasks[probeId]}`);

const finalDisk = JSON.parse(await readTextFile(dataPath));
await log(
  `final on-disk: probe removed=${!finalDisk.tasks[probeId]} tasks=${Object.keys(finalDisk.tasks).length}`,
);
await report('SMOKE DONE');
