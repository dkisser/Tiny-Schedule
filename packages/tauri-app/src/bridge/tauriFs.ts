import {
  copyFile,
  exists,
  mkdir,
  readFile,
  readTextFile,
  remove,
  rename,
  writeFile,
  writeTextFile,
} from '@tauri-apps/plugin-fs';
import type { FileSystemAdapter } from './fsAdapter';

/**
 * Production {@link FileSystemAdapter}, backed by tauri-plugin-fs.
 *
 * Paths are absolute throughout. The plugin can also resolve against a
 * `BaseDirectory`, but the data directory is itself absolute (it comes from
 * `$HOME`), so there is nothing to anchor to — and anchoring would quietly
 * re-introduce the bundle-id-derived path this migration exists to avoid.
 *
 * Every call is scoped by the capability entries in
 * `src-tauri/capabilities/default.json`, which name the two data directories
 * explicitly rather than granting the whole home directory.
 */
export class TauriFs implements FileSystemAdapter {
  async exists(path: string): Promise<boolean> {
    return exists(path);
  }

  async mkdir(path: string): Promise<void> {
    // recursive: the data directory may not exist on first launch.
    // mode 0o700: the directory holds `.key` alongside `data.json`, and unlike
    // the Electron original — whose Chromium created `userData` at 0700 — this
    // one is created here, so the plugin's default (0o777 masked by the process
    // umask) would leave it world-readable on a fresh install.
    await mkdir(path, { recursive: true, mode: 0o700 });
  }

  async readText(path: string): Promise<string> {
    return readTextFile(path);
  }

  async writeText(path: string, contents: string): Promise<void> {
    await writeTextFile(path, contents);
  }

  async copy(from: string, to: string): Promise<void> {
    await copyFile(from, to);
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  }

  async remove(path: string): Promise<void> {
    await remove(path);
  }

  async writePrivate(path: string, contents: Uint8Array): Promise<void> {
    // mode 0o600, explicitly: tauri-plugin-fs's `writeFile` does take
    // `WriteFileOptions.mode` and passes it to `std::fs::OpenOptions::mode` on
    // unix, and the Electron original wrote the key the same way
    // (`fs.writeFile(keyPath, fresh, { mode: 0o600 })`). The key decrypts every
    // provider's API key in `data.json`, so a 0644 file plus a readable data
    // file hands both to any local account.
    //
    // The mode applies at creation only — `mode` is `open(2)`'s `O_CREAT` mode
    // — so a `.key` written by an earlier build keeps its old permissions. See
    // `keys.ts` for the repair path.
    await writeFile(path, contents, { mode: 0o600 });
  }

  async readBytes(path: string): Promise<Uint8Array> {
    return readFile(path);
  }
}
