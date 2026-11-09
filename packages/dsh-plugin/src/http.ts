/**
 * The browser-facing HTTP surface.
 *
 * dsh has no typed Host↔Client bridge for out-of-tree plugins, so the browser
 * half reads and writes through one small same-origin JSON endpoint under
 * `/ts/api`. The handler runs in the host process and calls the same service
 * methods the agent's tools call — one write path, one projection path.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
// Type-only: brings the host web server's Context merge (ctx.webServer).
import type {} from '@deepseek-ai/dsh-host-webserver';
import type { TaskTrackerService } from './service/service.ts';
import type { RegisteredTools } from './tools/index.ts';

const PREFIX = '/ts';

interface ActionBody {
  type: string;
  [key: string]: unknown;
}

/**
 * Register the plugin's routes.
 * @param ctx - Host context carrying the web server.
 * @param service - The task tracker service the routes act through.
 * @returns a disposer that removes the routes.
 */
export function registerHttpRoutes(
  ctx: Context,
  service: TaskTrackerService,
  tools: RegisteredTools,
): () => void {
  return ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      res.setHeader('content-type', 'application/json; charset=utf-8');

      if (req.method === 'GET' && path === '/ts/api/state') {
        res.statusCode = 200;
        res.end(JSON.stringify(service.snapshot()));
        return;
      }

      if (req.method === 'GET' && path === '/ts/api/tools') {
        res.statusCode = 200;
        res.end(JSON.stringify({ names: tools.names }));
        return;
      }

      if (req.method === 'POST' && path === '/ts/api/action') {
        try {
          const body = await readJson(req);
          const result = await applyAction(service, body);
          res.statusCode = 200;
          res.end(JSON.stringify({ ok: true, result }));
        } catch (error) {
          res.statusCode = 400;
          res.end(
            JSON.stringify({
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: `no route for ${req.method ?? 'GET'} ${path}` }));
    },
  });
}

async function applyAction(service: TaskTrackerService, action: ActionBody): Promise<unknown> {
  switch (action.type) {
    case 'task.create':
      return service.upsertTask({
        title: String(action.title ?? ''),
        ...(action.projectId !== undefined ? { projectId: String(action.projectId) } : {}),
        ...(action.dueDay !== undefined ? { dueDay: String(action.dueDay) || undefined } : {}),
        ...(action.isImportant !== undefined ? { isImportant: action.isImportant === true } : {}),
        ...(action.notes !== undefined ? { notes: String(action.notes) } : {}),
        ...(action.tagIds !== undefined ? { tagIds: (action.tagIds as string[]) ?? [] } : {}),
        ...(action.parentTaskId !== undefined ? { parentTaskId: String(action.parentTaskId) } : {}),
        ...(action.timeEstimateMinutes !== undefined
          ? { timeEstimate: Number(action.timeEstimateMinutes) * 60_000 }
          : {}),
      });
    case 'task.patch':
      return service.updateTask(String(action.id), {
        ...(action.title !== undefined ? { title: String(action.title) } : {}),
        ...(action.projectId !== undefined ? { projectId: String(action.projectId) } : {}),
        ...(action.dueDay !== undefined
          ? { dueDay: action.dueDay === null ? null : String(action.dueDay) }
          : {}),
        ...(action.isImportant !== undefined ? { isImportant: action.isImportant === true } : {}),
        ...(action.notes !== undefined ? { notes: String(action.notes) } : {}),
        ...(action.tagIds !== undefined ? { tagIds: (action.tagIds as string[]) ?? [] } : {}),
        ...(action.timeEstimateMinutes !== undefined
          ? { timeEstimate: Number(action.timeEstimateMinutes) * 60_000 }
          : {}),
      });
    case 'task.complete':
      return service.setTaskDone(String(action.id), true);
    case 'task.uncomplete':
      return service.setTaskDone(String(action.id), false);
    case 'task.delete':
      await service.deleteTask(String(action.id));
      return { id: String(action.id) };
    case 'order':
      await service.setOrder(String(action.viewKey), (action.ids as string[]) ?? []);
      return { viewKey: String(action.viewKey) };
    case 'idea.complete':
      return service.completeIdea(String(action.id));
    case 'idea.discard':
      return service.discardIdea(String(action.id));
    case 'idea.reopen':
      return service.reopenIdea(String(action.id));
    case 'idea.close':
      return service.closeIdea(
        String(action.id),
        (action.result as 'validated' | 'invalidated' | 'partial') ?? 'validated',
        action.text !== undefined ? String(action.text) : undefined,
      );
    case 'timer.start':
      return service.startTimer(String(action.taskId));
    case 'timer.pause':
      return service.pauseTimer();
    case 'timer.resume':
      return service.resumeTimer();
    case 'timer.stop':
      return service.stopTimer();
    case 'time.add':
      return service.logTime({
        taskId: String(action.taskId),
        minutes: Number(action.minutes ?? 0),
        ...(action.date !== undefined ? { date: String(action.date) } : {}),
      });
    case 'time.delete':
      await service.deleteTimeEntry(String(action.id));
      return { id: String(action.id) };
    default:
      throw new Error(`unknown action '${action.type}'`);
  }
}

async function readJson(req: IncomingMessage): Promise<ActionBody> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.trim() === '') return { type: '' };
  return JSON.parse(raw) as ActionBody;
}
