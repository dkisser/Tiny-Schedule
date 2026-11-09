/**
 * The agent-facing tool surface.
 *
 * Every tool is prefixed `ts_` (the `todo_write` name is taken by the
 * harness's own todo list). The descriptions are the agent's manual: they say
 * what the dates mean, that urgency is derived, and that finishing a task
 * settles its timer.
 */
import type { Context } from '@deepseek-ai/cordis';
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools';
import { isFollowUpDue } from '../domain/followups.ts';
import { incubatingIdeas, openIdeas, resolvedIdeas } from '../domain/ideas.ts';
import {
  applyManualOrder,
  doneTodayCount,
  estimateRemainingMs,
  filterTasks,
  focusSeries7d,
  longTermPool,
  quadrantOf,
  quadrantTasks,
  todayDoneTasks,
  todayTasks,
  workedTodayMs,
} from '../domain/projections.ts';
import { formatMs, localDate, today as todayOf } from '../domain/time.ts';
import type { QuadrantKey, TaskFilter, TaskView } from '../domain/types.ts';
import { QUADRANT_KEYS } from '../domain/types.ts';
import type { TaskTrackerService } from '../service/service.ts';

const QUADRANT_ENUM = [...QUADRANT_KEYS];

/** The shape every task-carrying tool returns. */
const taskSummaryShape = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    project: { type: 'string', required: true },
    dueDay: { type: 'string' },
    important: { type: 'boolean', required: true },
    urgent: { type: 'boolean', required: true },
    quadrant: { type: 'string', required: true, enum: QUADRANT_ENUM },
    done: { type: 'boolean', required: true },
    timeSpentMs: { type: 'integer', required: true },
    notes: { type: 'string' },
  },
} as const;

interface TaskSummary {
  id: string;
  title: string;
  project: string;
  dueDay?: string;
  important: boolean;
  urgent: boolean;
  quadrant: QuadrantKey;
  done: boolean;
  timeSpentMs: number;
  notes?: string;
}

function summarize(task: TaskView, thresholdDays: number, today: string): TaskSummary {
  return {
    id: task.id,
    title: task.title,
    project: task.projectTitle ?? task.projectId,
    ...(task.dueDay !== undefined ? { dueDay: task.dueDay } : {}),
    important: task.isImportant,
    urgent: quadrantOf(task, today, thresholdDays).endsWith('urgent'),
    quadrant: quadrantOf(task, today, thresholdDays),
    done: task.isDone,
    timeSpentMs: task.timeSpent,
    ...(task.notes !== '' ? { notes: task.notes } : {}),
  };
}

function text(value: string): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: value }];
}

/**
 * Register the plugin's tools on the harness tool registry.
 * @param ctx - Host context carrying the tool registry.
 * @param service - The task tracker service the tools read and write through.
 */
export interface RegisteredTools {
  /** The registered tool names, in registration order. */
  names: string[];
  /** Remove every registered tool. */
  dispose: () => void;
}

export function registerTools(ctx: Context, service: TaskTrackerService): RegisteredTools {
  const disposers: (() => void)[] = [];
  const names: string[] = [];
  const register = (definition: ToolDefinition): void => {
    names.push(definition.name);
    disposers.push(ctx.tools.register(definition));
  };
  const settings = () => service.settings;
  const today = () => todayOf();

  const summaries = (tasks: TaskView[]): TaskSummary[] => {
    const threshold = settings().urgencyThresholdDays;
    const day = today();
    return tasks.map((task) => summarize(task, threshold, day));
  };

  register(
    defineTool({
      name: 'ts_query_tasks',
      description:
        "Query the user's tasks. 今日 / 四象限 / 长期池 are three views over the same task set, not separate kinds of work. " +
        'Dates are local calendar days in YYYY-MM-DD. "urgent" is derived (dueDay within the urgency threshold), "important" is stored. ' +
        'Leave every filter out to get the open top-level tasks.',
      parameters: {
        isDone: { type: 'boolean', description: 'Completion state; omit for both.' },
        projectId: { type: 'string', description: 'Restrict to one project.' },
        tagIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict to tasks carrying all of these tags.',
        },
        dueFrom: { type: 'string', description: 'Due at or after this YYYY-MM-DD day.' },
        dueTo: { type: 'string', description: 'Due at or before this YYYY-MM-DD day.' },
        doneFrom: { type: 'string', description: 'Completed at or after this YYYY-MM-DD day.' },
        doneTo: { type: 'string', description: 'Completed at or before this YYYY-MM-DD day.' },
        quadrant: {
          type: 'string',
          enum: QUADRANT_ENUM,
          description: 'Restrict to one Eisenhower cell.',
        },
        longTerm: {
          type: 'boolean',
          description: 'Restrict to the long-term pool (no due day, or due beyond the horizon).',
        },
        includeSubtasks: {
          type: 'boolean',
          description: 'Include subtasks; default is top-level tasks only.',
        },
        limit: { type: 'integer', description: 'Maximum number of tasks to return (default 50).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            tasks: { type: 'array', required: true, items: taskSummaryShape },
          },
        },
        render: (_args, value) =>
          text(
            `${value.count} task(s):\n` +
              value.tasks
                .map(
                  (t) =>
                    `- [${t.done ? 'x' : ' '}] ${t.title} (${t.project}${t.dueDay ? `, due ${t.dueDay}` : ''}${t.urgent ? ', urgent' : ''}${t.important ? ', important' : ''})`,
                )
                .join('\n'),
          ),
      },
      execute(args) {
        const filter: TaskFilter = {
          ...(args.isDone !== undefined ? { isDone: args.isDone } : {}),
          ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          ...(args.tagIds !== undefined ? { tagIds: args.tagIds } : {}),
          ...(args.dueFrom !== undefined ? { dueFrom: args.dueFrom } : {}),
          ...(args.dueTo !== undefined ? { dueTo: args.dueTo } : {}),
          ...(args.doneFrom !== undefined ? { doneFrom: args.doneFrom } : {}),
          ...(args.doneTo !== undefined ? { doneTo: args.doneTo } : {}),
          ...(args.quadrant !== undefined ? { quadrant: args.quadrant } : {}),
          ...(args.longTerm !== undefined ? { longTerm: args.longTerm } : {}),
          ...(args.includeSubtasks !== undefined ? { includeSubtasks: args.includeSubtasks } : {}),
        };
        const threshold = settings().urgencyThresholdDays;
        const horizon = settings().longTermHorizonDays;
        const matched = filterTasks(service.listTasks(), filter, today(), threshold, horizon);
        const limit = typeof args.limit === 'number' ? args.limit : 50;
        const tasks = summaries(matched.slice(0, Math.max(0, limit)));
        return Promise.resolve({ count: tasks.length, tasks });
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_get_summary',
      description:
        "Aggregate the user's work: how much is open, how much is done, where the time went. " +
        'This is the tool to reach for before answering "how is it going" or preparing a retrospective.',
      parameters: {
        scope: {
          type: 'string',
          enum: ['today', 'week', 'range'],
          description: 'today | week | range.',
        },
        from: {
          type: 'string',
          description: 'Range start (YYYY-MM-DD); used when scope is range.',
        },
        to: { type: 'string', description: 'Range end (YYYY-MM-DD); used when scope is range.' },
        projectId: { type: 'string', description: 'Restrict the aggregate to one project.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            scope: { type: 'string', required: true },
            open: { type: 'integer', required: true },
            done: { type: 'integer', required: true },
            timeMs: { type: 'integer', required: true },
            byQuadrant: {
              type: 'object',
              additionalProperties: false,
              required: true,
              properties: {
                'important-urgent': { type: 'integer', required: true },
                'important-notUrgent': { type: 'integer', required: true },
                'notImportant-urgent': { type: 'integer', required: true },
                'notImportant-notUrgent': { type: 'integer', required: true },
              },
            },
            byProject: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  project: { type: 'string', required: true },
                  open: { type: 'integer', required: true },
                  timeMs: { type: 'integer', required: true },
                },
              },
            },
            focus7d: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  date: { type: 'string', required: true },
                  ms: { type: 'integer', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) =>
          text(
            `${value.scope}: ${value.open} open, ${value.done} done, ${formatMs(value.timeMs)} recorded.`,
          ),
      },
      execute(args) {
        const day = today();
        const tasks = service.listTasks();
        const threshold = settings().urgencyThresholdDays;
        const horizon = settings().longTermHorizonDays;
        const scope = typeof args.scope === 'string' ? args.scope : 'today';
        const from =
          typeof args.from === 'string' ? args.from : scope === 'week' ? shiftDay(day, -6) : day;
        const to = typeof args.to === 'string' ? args.to : day;
        const inRange = tasks.filter((t) => {
          if (args.projectId !== undefined && t.projectId !== args.projectId) return false;
          if (t.isDone) {
            return (
              t.doneAt !== undefined && localDate(t.doneAt) >= from && localDate(t.doneAt) <= to
            );
          }
          return true;
        });
        const open = inRange.filter((t) => !t.isDone).length;
        const done = inRange.length - open;
        const timeMs = inRange.reduce((sum, t) => sum + t.timeSpent, 0);
        const cells = quadrantTasks(
          tasks.filter((t) => !t.parentTaskId),
          day,
          threshold,
        );
        const byProject = new Map<string, { open: number; timeMs: number }>();
        for (const task of inRange) {
          const key = task.projectTitle ?? task.projectId;
          const entry = byProject.get(key) ?? { open: 0, timeMs: 0 };
          if (!task.isDone) entry.open += 1;
          entry.timeMs += task.timeSpent;
          byProject.set(key, entry);
        }
        return Promise.resolve({
          scope: `${scope} (${from}..${to})`,
          open,
          done,
          timeMs,
          byQuadrant: {
            'important-urgent': cells['important-urgent'].length,
            'important-notUrgent': cells['important-notUrgent'].length,
            'notImportant-urgent': cells['notImportant-urgent'].length,
            'notImportant-notUrgent': cells['notImportant-notUrgent'].length,
          },
          byProject: [...byProject.entries()].map(([project, v]) => ({ project, ...v })),
          focus7d: focusSeries7d(tasks, day),
        });
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_list_projects',
      description: "List the user's projects with their archive state.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            projects: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  archived: { type: 'boolean', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) =>
          text(
            `${value.count} project(s):\n${value.projects.map((p) => `- ${p.title}${p.archived ? ' (archived)' : ''}`).join('\n')}`,
          ),
      },
      execute() {
        const projects = service
          .listProjects()
          .map((p) => ({ id: p.id, title: p.title, archived: p.isArchived }));
        return Promise.resolve({ count: projects.length, projects });
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_list_tags',
      description: "List the user's tags.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            tags: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) =>
          text(`${value.count} tag(s): ${value.tags.map((t) => t.title).join(', ')}`),
      },
      execute() {
        const tags = service.listTags().map((t) => ({ id: t.id, title: t.title }));
        return Promise.resolve({ count: tags.length, tags });
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_upsert_task',
      description:
        'Create a task, or update an existing one when an id is given. ' +
        'A task without a due day does not appear in 今日. dueDay is a local calendar day (YYYY-MM-DD).',
      parameters: {
        id: { type: 'string', description: 'Task id; omit to create a new task.' },
        title: { type: 'string', required: true, description: 'What the task is.' },
        projectId: {
          type: 'string',
          description: 'Project the task belongs to; omit for the inbox.',
        },
        tagIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags carried by the task.',
        },
        dueDay: { type: 'string', description: 'Due day (YYYY-MM-DD).' },
        isImportant: {
          type: 'boolean',
          description: "Mark the task important (the quadrant's vertical axis).",
        },
        notes: { type: 'string', description: 'Markdown notes.' },
        timeEstimate: { type: 'integer', description: 'Estimated effort in minutes.' },
        parentTaskId: { type: 'string', description: 'Parent task id, making this a subtask.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
            created: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) =>
          text(`${value.created ? 'Created' : 'Updated'} task ${value.id}: ${value.title}`),
      },
      async execute(args) {
        const created = args.id === undefined;
        const task = await service.upsertTask({
          ...(args.id !== undefined ? { id: args.id } : {}),
          title: args.title,
          ...(args.projectId !== undefined ? { projectId: args.projectId } : {}),
          ...(args.tagIds !== undefined ? { tagIds: args.tagIds } : {}),
          ...(args.dueDay !== undefined ? { dueDay: args.dueDay } : {}),
          ...(args.isImportant !== undefined ? { isImportant: args.isImportant } : {}),
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          ...(args.timeEstimate !== undefined ? { timeEstimate: args.timeEstimate * 60_000 } : {}),
          ...(args.parentTaskId !== undefined ? { parentTaskId: args.parentTaskId } : {}),
        });
        return { id: task.id, title: task.title, created };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_complete_task',
      description:
        'Mark a task done. If that task currently holds the running timer, the timer is settled first.',
      parameters: { id: { type: 'string', required: true, description: 'Task id.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Completed: ${value.title}`),
      },
      async execute(args) {
        const task = await service.setTaskDone(args.id, true);
        return { id: task.id, title: task.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_uncomplete_task',
      description: 'Reopen a completed task.',
      parameters: { id: { type: 'string', required: true, description: 'Task id.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Reopened: ${value.title}`),
      },
      async execute(args) {
        const task = await service.setTaskDone(args.id, false);
        return { id: task.id, title: task.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_delete_task',
      description: 'Delete a task and the time recorded against it.',
      parameters: { id: { type: 'string', required: true, description: 'Task id.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            deleted: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) =>
          text(value.deleted ? `Deleted task ${value.id}` : `No task ${value.id}`),
      },
      async execute(args) {
        await service.deleteTask(args.id);
        return { id: args.id, deleted: true };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_set_task_order',
      description:
        'Store the manual drag order of one view (for example "today" or "quadrant:notImportant-urgent").',
      parameters: {
        viewKey: { type: 'string', required: true, description: 'View key the order belongs to.' },
        ids: {
          type: 'array',
          required: true,
          items: { type: 'string' },
          description: 'Task ids in display order.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            viewKey: { type: 'string', required: true },
            count: { type: 'integer', required: true },
          },
        },
        render: (_args, value) =>
          text(`Stored order for ${value.viewKey} (${value.count} task(s)).`),
      },
      async execute(args) {
        await service.setOrder(args.viewKey, args.ids);
        return { viewKey: args.viewKey, count: args.ids.length };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_log_time',
      description:
        'Record time spent on a task without running the timer — for work the user already finished, or for a correction.',
      parameters: {
        taskId: { type: 'string', required: true, description: 'Task the time belongs to.' },
        minutes: { type: 'integer', required: true, description: 'Minutes to record.' },
        date: { type: 'string', description: 'Local day (YYYY-MM-DD); defaults to today.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            ms: { type: 'integer', required: true },
            date: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          text(`Recorded ${formatMs(value.ms)} on ${value.date} for task ${value.taskId}.`),
      },
      async execute(args) {
        const entry = await service.logTime({
          taskId: args.taskId,
          minutes: args.minutes,
          ...(args.date !== undefined ? { date: args.date } : {}),
        });
        return { taskId: entry.taskId, ms: entry.ms, date: entry.date };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_start_timer',
      description:
        'Start the timer on a task. Only one timer runs at a time. dsh has no sleep detection, so the timer does not pause itself.',
      parameters: { taskId: { type: 'string', required: true, description: 'Task to time.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            startedAt: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => text(`Timer started on task ${value.taskId}.`),
      },
      async execute(args) {
        const timer = await service.startTimer(args.taskId);
        return { taskId: timer.taskId, startedAt: timer.startedAt };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_pause_timer',
      description: 'Pause the running timer.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            paused: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => text(`Timer on ${value.taskId} paused.`),
      },
      async execute() {
        const timer = await service.pauseTimer();
        return { taskId: timer.taskId, paused: true };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_resume_timer',
      description: 'Resume a paused timer.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            resumed: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => text(`Timer on ${value.taskId} resumed.`),
      },
      async execute() {
        const timer = await service.resumeTimer();
        return { taskId: timer.taskId, resumed: true };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_stop_timer',
      description: 'Stop the running timer and store the measured interval against its task.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            taskId: { type: 'string', required: true },
            ms: { type: 'integer', required: true },
          },
        },
        render: (_args, value) =>
          text(`Timer stopped on ${value.taskId} after ${formatMs(value.ms)}.`),
      },
      async execute() {
        const { ms, entry } = await service.stopTimer();
        return { taskId: entry.taskId, ms };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_finish_day',
      description: 'End the day: work that was due today and is still open moves to tomorrow.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            moved: { type: 'integer', required: true },
            titles: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
        render: (_args, value) =>
          text(
            value.moved === 0
              ? 'Nothing to roll over.'
              : `Rolled over ${value.moved} task(s): ${value.titles.join(', ')}`,
          ),
      },
      async execute() {
        const rolled = await service.finishDay();
        return { moved: rolled.length, titles: rolled.map((t) => t.title) };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_idea_create',
      description:
        'Capture an idea. Ideas are a separate domain from tasks: they never enter 今日 and never take time. ' +
        'An idea can later become a task, be completed, be discarded, or be upgraded to a project for validation.',
      parameters: {
        title: { type: 'string', required: true, description: 'The idea in one line.' },
        notes: { type: 'string', description: 'Markdown notes.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Captured idea ${value.id}: ${value.title}`),
      },
      async execute(args) {
        const idea = await service.upsertIdea({
          title: args.title,
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
        });
        return { id: idea.id, title: idea.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_idea_complete',
      description: 'Complete an idea directly (it stays an idea, it does not become a task).',
      parameters: { id: { type: 'string', required: true, description: 'Idea id.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Idea completed: ${value.title}`),
      },
      async execute(args) {
        const idea = await service.completeIdea(args.id);
        return { id: idea.id, title: idea.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_idea_discard',
      description: 'Discard an idea (it can be reopened later).',
      parameters: { id: { type: 'string', required: true, description: 'Idea id.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Idea discarded: ${value.title}`),
      },
      async execute(args) {
        const idea = await service.discardIdea(args.id);
        return { id: idea.id, title: idea.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_idea_close',
      description:
        'Give a validation verdict on an incubating idea: validated | invalidated | partial.',
      parameters: {
        id: { type: 'string', required: true, description: 'Idea id.' },
        result: {
          type: 'string',
          required: true,
          enum: ['validated', 'invalidated', 'partial'],
          description: 'The verdict.',
        },
        text: { type: 'string', description: 'What the verdict is based on.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            result: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Idea ${value.id} closed: ${value.result}.`),
      },
      async execute(args) {
        const idea = await service.closeIdea(args.id, args.result, args.text);
        return { id: idea.id, result: idea.verdict?.result ?? args.result };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_idea_upgrade_project',
      description:
        'Upgrade an idea to a dedicated project so it can be validated; the idea then sits in 验证中.',
      parameters: {
        id: { type: 'string', required: true, description: 'Idea id.' },
        projectId: { type: 'string', required: true, description: 'The dedicated project id.' },
        validationGoal: { type: 'string', description: 'What "validated" means for this idea.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            projectId: { type: 'string', required: true },
          },
        },
        render: (_args, value) =>
          text(`Idea ${value.id} is now incubating in project ${value.projectId}.`),
      },
      async execute(args) {
        const idea = await service.upgradeIdeaToProject(
          args.id,
          args.projectId,
          args.validationGoal,
        );
        return { id: idea.id, projectId: idea.projectId ?? args.projectId };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_list_ideas',
      description:
        "List the user's ideas in their three groups: 收集箱 (open), 验证中 (incubating), 已了结 (resolved).",
      parameters: {
        group: {
          type: 'string',
          enum: ['open', 'incubating', 'resolved'],
          description: 'Which group to list; omit for all three.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            open: { type: 'array', required: true, items: ideaShape },
            incubating: { type: 'array', required: true, items: ideaShape },
            resolved: { type: 'array', required: true, items: ideaShape },
          },
        },
        render: (_args, value) =>
          text(
            `收集箱 ${value.open.length} · 验证中 ${value.incubating.length} · 已了结 ${value.resolved.length}`,
          ),
      },
      execute(args) {
        const ideas = service.listIdeas();
        const projects = Object.fromEntries(service.listProjects().map((p) => [p.id, p]));
        const pick = (group: string | undefined): IdeaSummary[] => {
          if (group === 'open') return openIdeas(ideas).map(summarizeIdea);
          if (group === 'incubating') return incubatingIdeas(ideas, projects).map(summarizeIdea);
          if (group === 'resolved') return resolvedIdeas(ideas).map(summarizeIdea);
          return [];
        };
        if (typeof args.group === 'string') {
          const picked = pick(args.group);
          return Promise.resolve({
            open: [],
            incubating: [],
            resolved: picked,
            ...(args.group === 'open' ? { open: picked } : {}),
            ...(args.group === 'incubating' ? { incubating: picked } : {}),
          });
        }
        return Promise.resolve({
          open: openIdeas(ideas).map(summarizeIdea),
          incubating: incubatingIdeas(ideas, projects).map(summarizeIdea),
          resolved: resolvedIdeas(ideas).map(summarizeIdea),
        });
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_upsert_followup',
      description:
        'Create or update a follow-up — work that is waiting on somebody else. Follow-ups never enter 今日.',
      parameters: {
        id: { type: 'string', description: 'Follow-up id; omit to create.' },
        title: { type: 'string', required: true, description: 'What is being waited on.' },
        notes: { type: 'string', description: 'Who / background.' },
        nextFollowUpDay: { type: 'string', description: 'Next check-in day (YYYY-MM-DD).' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Follow-up ${value.id}: ${value.title}`),
      },
      async execute(args) {
        const row = await service.upsertFollowUp({
          ...(args.id !== undefined ? { id: args.id } : {}),
          title: args.title,
          ...(args.notes !== undefined ? { notes: args.notes } : {}),
          ...(args.nextFollowUpDay !== undefined ? { nextFollowUpDay: args.nextFollowUpDay } : {}),
        });
        return { id: row.id, title: row.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_resolve_followup',
      description: 'Close a follow-up: the wait is over.',
      parameters: { id: { type: 'string', required: true, description: 'Follow-up id.' } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            title: { type: 'string', required: true },
          },
        },
        render: (_args, value) => text(`Follow-up resolved: ${value.title}`),
      },
      async execute(args) {
        const row = await service.resolveFollowUp(args.id);
        return { id: row.id, title: row.title };
      },
    }),
  );

  register(
    defineTool({
      name: 'ts_list_followups',
      description: "List the user's follow-ups, flagging the ones whose check-in day has arrived.",
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            followUps: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  title: { type: 'string', required: true },
                  due: { type: 'boolean', required: true },
                  nextFollowUpDay: { type: 'string' },
                },
              },
            },
          },
        },
        render: (_args, value) =>
          text(`${value.count} follow-up(s); ${value.followUps.filter((f) => f.due).length} due.`),
      },
      execute() {
        const followUps = service.listFollowUps().map((f) => ({
          id: f.id,
          title: f.title,
          due: isFollowUpDue(f),
          ...(f.nextFollowUpDay !== undefined ? { nextFollowUpDay: f.nextFollowUpDay } : {}),
        }));
        return Promise.resolve({ count: followUps.length, followUps });
      },
    }),
  );

  return {
    names,
    dispose: () => {
      for (const dispose of disposers.reverse()) dispose();
    },
  };
}

const ideaShape = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    title: { type: 'string', required: true },
    status: { type: 'string', required: true },
    verdict: { type: 'string' },
  },
} as const;

interface IdeaSummary {
  id: string;
  title: string;
  status: string;
  verdict?: string;
}

function summarizeIdea(idea: {
  id: string;
  title: string;
  status: string;
  verdict?: { result: string };
}): IdeaSummary {
  return {
    id: idea.id,
    title: idea.title,
    status: idea.status,
    ...(idea.verdict !== undefined ? { verdict: idea.verdict.result } : {}),
  };
}

function shiftDay(day: string, delta: number): string {
  const [y = 1970, m = 1, d = 1] = day.split('-').map(Number);
  return localDate(new Date(y, m - 1, d + delta).getTime());
}
