import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Project, Task } from '@tiny-schedule/shared';

/** 把任务标题格式化为日历事件标题 */
export function formatCalendarTitle(taskTitle: string, projectTitle?: string): string {
  const proj = projectTitle?.trim();
  if (!proj) return taskTitle;
  return `[${proj}] ${taskTitle}`;
}

/** Y  M  D  → +1 天(YYYY-MM-DD)。 */
function addOneDay(yyyyMmDd: string): string {
  const parts = yyyyMmDd.split('-').map(Number);
  const y = parts[0] ?? 1970;
  const m = parts[1] ?? 1;
  const d = parts[2] ?? 1;
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** 当前源文件绝对目录(ESM 标准,bun + Electron 都支持)。 */
const SOURCE_DIR = dirname(fileURLToPath(import.meta.url));

/** 解析 event-helper 二进制路径。
 *  不靠猜 dev/prod,而是按存在性在候选里选真实存在的那个:
 *  1. `process.env.TINY_SCHEDULE_EVENT_HELPER`(显式覆盖,测试 / CI 用)
 *  2. packaged:`process.resourcesPath/bin/event-helper`
 *     (electron-builder extraResources 默认解压到 Contents/Resources/)
 *  3. dev:相对此源文件 src/main/macos/calendar.ts → packages/app/bin/event-helper
     (esbuild 把所有 main 进程代码 bundle 到 out/main/main.js,所以 import.meta.url
     指向 packages/app/out/main/,往上 2 层 .. 就是 packages/app/)
 *
 *  **关键陷阱**:electron-vite dev 模式下 `process.resourcesPath` 指向
 *  `node_modules/electron/dist/Electron.app/Contents/Resources`,也含 `.app/`,
 *  单纯用字符串判断会误中。所以走 "候选 + existsSync" 模式 + 优先用 env 覆盖。
 *
 *  不依赖 `electron` API,所以能在 bun:test 下被单元测试文件 import。
 */
export function eventHelperPath(): string {
  const candidates = [
    process.env.TINY_SCHEDULE_EVENT_HELPER,
    join(process.resourcesPath ?? '', 'bin', 'event-helper'), // packaged
    join(SOURCE_DIR, '..', '..', 'bin', 'event-helper'), // dev
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return candidates[candidates.length - 1] ?? 'event-helper';
}

/** Swift CLI 协议(对应 Sources/event-helper/main.swift) */
interface SwiftOutputSuccess {
  ok: true;
  eventId: string;
}
interface SwiftOutputFailure {
  ok: false;
  code: 'permission-denied' | 'calendar-app-unavailable' | 'unknown';
  message: string;
}
type SwiftOutput = SwiftOutputSuccess | SwiftOutputFailure;

/** spawn event-helper,stdin 传任务,stdout 读 JSON。超时 15s(权限弹窗给足时间) */
function runHelper(input: { title: string; dueDay: string; notes: string }): Promise<SwiftOutput> {
  return new Promise((resolve, reject) => {
    const bin = eventHelperPath();
    const child = spawn(bin, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15_000,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`event-helper exited ${code}: ${stderr.trim()}`));
        return;
      }
      // Swift CLI 输出单行 JSON
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(`event-helper empty stdout; stderr: ${stderr.trim()}`));
        return;
      }
      try {
        resolve(JSON.parse(trimmed) as SwiftOutput);
      } catch (_err) {
        reject(
          new Error(
            `event-helper output not JSON: ${trimmed.slice(0, 200)}; stderr: ${stderr.trim()}`,
          ),
        );
      }
    });
    child.stdin.write(JSON.stringify(input));
    child.stdin.end();
  });
}

/** 主入口:把任务写入 macOS 默认日历 */
export async function addTaskToMacCalendar(input: {
  task: Task;
  project: Project | undefined;
}): Promise<
  | { ok: true; eventId: string }
  | {
      ok: false;
      code: 'no-dueDay' | 'permission-denied' | 'calendar-app-unavailable' | 'unknown';
      message: string;
    }
> {
  if (!input.task.dueDay) {
    return { ok: false, code: 'no-dueDay', message: '任务没有截止日期' };
  }
  const title = formatCalendarTitle(input.task.title, input.project?.title);
  try {
    const result = await runHelper({
      title,
      dueDay: input.task.dueDay,
      notes: input.task.notes,
    });
    if (result.ok) {
      return { ok: true, eventId: result.eventId };
    }
    return { ok: false, code: result.code, message: result.message };
  } catch (err) {
    return {
      ok: false,
      code: 'unknown',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 纯函数:把 YYYY-MM-DD 加一天。给 main 进程日志/调试用,Swift CLI 自己也算。 */
export { addOneDay };
