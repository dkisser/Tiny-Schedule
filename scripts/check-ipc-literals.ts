// Guard (S4): the host boundary must agree on itself.
//
// The Electron build this replaced had a shared table of channel constants, so a
// renamed channel failed `tsc`. The Tauri build has no such table: a Tauri
// command is a bare string on the TS side and a `#[tauri::command]` name on the
// Rust side, and *nothing* checks them against each other. Rename one and the
// call still compiles, still bundles, and fails at runtime — with no type
// error and no test failure to point at the rename.
//
// So this checks the boundary directly: every command the frontend invokes must
// be registered in Rust's `generate_handler!`, and every registered command
// must be reachable from the frontend. Both directions, because each catches a
// different mistake — a stale call is a crash on a path a user can reach, and
// an unreachable registration is dead Rust that misleads the next reader into
// thinking a capability exists.
//
// `focus_main` is intentionally never invoked from TS: Rust calls it internally
// from the menu and window-close paths. It is listed in ALLOW_UNREACHABLE with
// the reason, so the exemption is auditable rather than an omission.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const TS_SCAN_DIR = 'packages/tauri-app/src';
const RUST_ENTRY = 'packages/tauri-app/src-tauri/src/lib.rs';

/** Registered in Rust but never invoked from TS — see the header. */
const ALLOW_UNREACHABLE: Record<string, string> = {
  focus_main: 'called internally by menu.rs and close.rs',
};

/** Extracts the command list out of `generate_handler![ ... ]`, dropping module paths. */
function registeredCommands(): Set<string> {
  const src = readFileSync(join(ROOT, RUST_ENTRY), 'utf8');
  const block = src.match(/generate_handler!\s*\[([^\]]*)\]/);
  if (!block?.[1]) {
    console.error(`${RUST_ENTRY}: no generate_handler! block found — cannot verify the boundary.`);
    process.exit(1);
  }
  return new Set(
    block[1]
      .split(',')
      .map((entry) => entry.trim().split('::').pop() ?? '')
      .filter(Boolean),
  );
}

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(ROOT, dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectFiles(join(dir, entry)));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

/**
 * Every `invoke…('literal')` on the frontend.
 *
 * The prefix is open (`invoke`, `invokeFn`, `invokeCommand`) because the call
 * reaches the host through whichever of those the slice happens to inject, and
 * an alias is not a licence to skip the check. The optional generic is there
 * for `invoke<string>('home_dir')` — without it the most ordinary call site in
 * the codebase reads as "no calls", which would make the unused-registration
 * half of this check fire on everything.
 *
 * Test files are included on purpose: a fake that names a command the host
 * does not have is the same drift, found earlier rather than at runtime.
 */
function invokedCommands(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const file of collectFiles(TS_SCAN_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (const [i, line] of lines.entries()) {
      for (const match of line.matchAll(/\binvoke[A-Za-z]*\s*(?:<[^>]*>)?\(\s*'([A-Za-z_][A-Za-z0-9_]*)'/g)) {
        const cmd = match[1] ?? '';
        found.set(cmd, [...(found.get(cmd) ?? []), `${file}:${i + 1}`]);
      }
    }
  }
  return found;
}

const registered = registeredCommands();
const invoked = invokedCommands();
let violations = 0;

for (const [cmd, sites] of invoked) {
  if (!registered.has(cmd)) {
    console.error(
      `${sites[0]}: invokes "${cmd}", which lib.rs does not register. A renamed Rust command fails here at runtime, not at compile time.`,
    );
    violations += 1;
  }
}

for (const cmd of registered) {
  if (invoked.has(cmd) || cmd in ALLOW_UNREACHABLE) continue;
  console.error(`${RUST_ENTRY}: registers "${cmd}", but nothing in ${TS_SCAN_DIR} invokes it.`);
  violations += 1;
}

if (violations > 0) {
  console.error(`\n${violations} host-boundary mismatch(es) found.`);
  process.exit(1);
}
console.log(
  `check-ipc-literals: OK — ${invoked.size} invoked / ${registered.size} registered command(s) agree.`,
);