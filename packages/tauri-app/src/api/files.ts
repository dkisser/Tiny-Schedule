import { ask, open, save } from '@tauri-apps/plugin-dialog';
import { readFile, readTextFile, writeTextFile } from '@tauri-apps/plugin-fs';
import {
  dropStaleTiming,
  type ExportMarkdownReq,
  ExportMarkdownReqSchema,
  type ExportMarkdownResult,
  type ImportRunResult,
  type RendererApi,
} from '@tiny-schedule/shared';
import type { DataStore } from '@/bridge/dataStore';
import {
  exportProjectTaskList,
  exportWorklog,
  mergeImport,
  normalizeBackup,
} from '@/bridge/importExport';
import { migrateRemoveTodayTag } from '@/bridge/migrations';

/**
 * The file slice: Super Productivity import, Markdown export, avatar picking.
 *
 * Each handler is a transcription of its counterpart in
 * packages/app/src/main/ipcHandlers.ts. The only substitutions are the three
 * Electron APIs that no longer exist — `dialog.showOpenDialog` becomes
 * `plugin-dialog`'s `open()`, `dialog.showSaveDialog` becomes `save()`, and
 * `fs.promises.readFile`/`writeFile` become plugin-fs calls. The decision logic
 * around them (merge confirmation, default filenames, mime derivation) is
 * unchanged.
 *
 * Picked and saved paths need no capability entry: `plugin-dialog` adds what
 * the user chose to the fs scope itself, which is why reading an arbitrary
 * backup works even though the capability file only names the data directories.
 */

/** Image extensions the avatar picker offers, matching the Electron original. */
const AVATAR_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif'];

export interface FilesApiDeps {
  /**
   * Called when the import had to drop a running timer, mirroring the
   * `Ipc.timerChanged` push the Electron main process sent. Owned by the
   * coordinator's wiring because the event channel is a shared concern.
   */
  onTimerChanged?: () => void;
}

export function createFilesApi(
  store: DataStore,
  deps: FilesApiDeps = {},
): Pick<RendererApi, 'importRun' | 'exportMarkdown' | 'selectAvatar'> {
  return {
    importRun: async (): Promise<ImportRunResult> => {
      const picked = await open({
        title: '导入 Super Productivity 备份',
        filters: [{ name: 'JSON', extensions: ['json'] }],
      });
      // `open` returns a single path here (no `multiple`), null when cancelled.
      if (!picked) return { ok: false, error: 'CANCELLED' };
      try {
        const raw = JSON.parse(await readTextFile(picked));
        const { data: imported, counts } = normalizeBackup(raw);
        const taskCount = Object.keys((await store.get()).tasks).length;
        if (taskCount > 0) {
          const confirmed = await ask(
            `导入将追加合并到当前 ${taskCount} 个任务中（ID 相同时以导入数据为准，现有 AI 会话与其余任务保留）。`,
            { title: '本地已有数据', okLabel: '合并', cancelLabel: '取消' },
          );
          if (!confirmed) return { ok: false, error: 'CANCELLED' };
        }
        // The merge keeps the current activeTimer while letting an imported
        // task win an id collision, so it can hand us a done task that is still
        // being timed. Sweep it here rather than leaving the state for a later
        // write to clean up, and tell the renderer so its clock stops too.
        const hadTimer = !!(await store.get()).activeTimer;
        const result = await store.update((d) =>
          dropStaleTiming(migrateRemoveTodayTag(mergeImport(d, imported))),
        );
        if (hadTimer && !result.data.activeTimer) deps.onTimerChanged?.();
        return { ok: true, counts };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    exportMarkdown: async (raw: unknown): Promise<ExportMarkdownResult> => {
      // Parsed against the contract before anything else, as `api/data.ts` does
      // per call: with the ipcMain loop gone the zod guard lives at the call
      // site. Without it an unrecognised `mode` is not an error — it falls
      // through to the worklog branch and silently exports a different report
      // than the caller asked for.
      const req = ExportMarkdownReqSchema.parse(raw) as ExportMarkdownReq;
      const data = await store.get();
      let content: string;
      let defaultName: string;
      try {
        if (req.mode === 'projectList') {
          if (!req.projectId) return { savedPath: null, error: 'MISSING_PROJECT_ID' };
          content = exportProjectTaskList(data, req.projectId);
          defaultName = `${data.projects[req.projectId]?.title ?? 'project'}-任务清单.md`;
        } else {
          const from = req.from ?? '1970-01-01';
          const to = req.to ?? '2999-12-31';
          content = exportWorklog(data, { from, to, projectId: req.projectId });
          defaultName = `工作日志-${from}-${to}.md`;
        }
      } catch (err) {
        return { savedPath: null, error: err instanceof Error ? err.message : String(err) };
      }
      const path = await save({ defaultPath: defaultName });
      // No `error` key on cancel, matching the original: the UI distinguishes
      // "user backed out" from "it failed" by the absence of the field.
      if (!path) return { savedPath: null };
      await writeTextFile(path, content);
      return { savedPath: path };
    },

    selectAvatar: async (): Promise<string | null> => {
      const filePath = await open({
        title: '选择头像图片',
        filters: [{ name: '图片', extensions: AVATAR_EXTENSIONS }],
      });
      if (!filePath) return null;
      // plugin-fs `readFile` returns raw bytes; base64 needs the binary, not the
      // UTF-8 decoded text `readTextFile` would mangle.
      const bytes = await readFile(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? 'png';
      const mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : `image/${ext}`;
      return `data:${mime};base64,${bytesToBase64(bytes)}`;
    },
  };
}

/**
 * Base64 without `btoa` on a large binary: `String.fromCharCode(...bytes)` blows
 * the argument limit on a multi-megabyte photo, so it is chunked. WebKit's
 * `btoa` is not used at all — it only takes a Latin-1 string, and going through
 * it would mean materialising the whole file as a JS string first.
 */
function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
