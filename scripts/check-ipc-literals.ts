// Guard (S4): IPC call sites must reference the shared channel constants
// (Ipc.* / IpcInvokeContract.*.ch), never raw string literals. A literal
// channel name can drift from the shared table on either side of the
// process boundary and only fails at runtime.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const SCAN_DIRS = ['packages/app/src/main', 'packages/app/src/preload'];

const CALL_RE =
  /\b(?:ipcMain\.handle|ipcRenderer\.(?:invoke|on|off|once|send)|webContents\.send)\s*\(\s*([^,)]+)/g;
const ALLOWED_ARG = /^(?:Ipc|IpcInvokeContract)\.\w+(?:\.\w+)?$/;
// Opt-out marker for call sites whose channel comes from a safe local
// (e.g. iterating IpcEventChannels or the contract loop). Auditable.
const SKIP_MARKER = 'check-ipc: ok';

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

let violations = 0;
for (const dir of SCAN_DIRS) {
  for (const file of collectFiles(join(ROOT, dir))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      if (line.includes(SKIP_MARKER) || lines[i - 1]?.includes(SKIP_MARKER)) continue;
      CALL_RE.lastIndex = 0;
      for (const match of line.matchAll(CALL_RE)) {
        const arg = (match[1] ?? '').trim();
        if (!ALLOWED_ARG.test(arg)) {
          console.error(`${file}:${i + 1}: IPC call must use Ipc.* constants, got "${arg}"`);
          violations++;
        }
      }
    }
  }
}

if (violations > 0) {
  console.error(`\n${violations} raw IPC channel reference(s) found.`);
  process.exit(1);
}
console.log('check-ipc-literals: OK');
