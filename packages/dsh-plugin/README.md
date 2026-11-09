# dsh-plugin-tiny-schedule

Task tracking and idea lifecycle for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Two domains — **任务** and **想法** — plus the agent tools to work with them, and two tabs in the harness web client.

```
dsh web  →  标签行：[对话] [轨迹] [任务] [想法]
                          ├── 今日 · 四象限 · 长期池
                          └── 收集箱 · 验证中 · 已了结
```

## What it is

| Piece | What it does |
|---|---|
| **Domain** | Task, Project, Tag, TimeEntry, Idea, FollowUp — zod schemas, projections, the idea state machine. Pure, no I/O. |
| **Storage** | One dsh storage domain (`task_tracker`), seven tables plus a global slot. json backend → `~/.dsh/storages/task_tracker.json`. |
| **Tools** | 24 agent tools, all prefixed `ts_` (`todo_write` is taken by the harness). |
| **Client** | Two tabs in the conversation's view ring. The browser reads a snapshot the host computes and writes through one same-origin JSON endpoint. |

## Install

```bash
# from a checkout of this package
bun install && bun run build

# into a dsh profile
dsh plugin --profile web add /path/to/packages/dsh-plugin
```

The profile's `bundles` list gains `dsh-plugin-tiny-schedule`; the browser half is discovered automatically through the package's `dsh.client` declaration.

### Migrating from the retired desktop app

One-shot, and it only ever **reads** the old file:

```bash
node lib/migrate/cli.js --from "$HOME/Library/Application Support/@tiny-schedule/app/data.json" \
                        --root "$HOME/.dsh/storages" --force
```

`--dry-run` reports what would move. The legacy Electron blobs (`timeTracking`, `notes`, `planner`, `metric`, `boards`, `scheduledTasks`, `runs` — about 110 KB) are dropped on purpose: they were never modelled.

## The tools

| Tool | Purpose |
|---|---|
| `ts_query_tasks` | Filter tasks by completion, project, tags, due/completion windows, quadrant, long-term pool. |
| `ts_get_summary` | Open/done counts, recorded time, per-quadrant and per-project breakdown, 7-day focus series. |
| `ts_list_projects` / `ts_list_tags` | The project's metadata. |
| `ts_upsert_task` / `ts_complete_task` / `ts_uncomplete_task` / `ts_delete_task` | Task mutations. Completing a task settles its running timer first. |
| `ts_set_task_order` | The manual drag order of one view. |
| `ts_log_time` | Record time without running the timer. |
| `ts_start_timer` / `ts_pause_timer` / `ts_resume_timer` / `ts_stop_timer` | The timer. One at a time. |
| `ts_finish_day` | Roll unfinished work that was due today over to tomorrow. |
| `ts_idea_create` / `ts_idea_complete` / `ts_idea_discard` / `ts_idea_close` / `ts_idea_upgrade_project` / `ts_list_ideas` | The idea lifecycle. |
| `ts_upsert_followup` / `ts_resolve_followup` / `ts_list_followups` | Follow-ups (data and tools; no UI in this version). |

Dates are local calendar days in `YYYY-MM-DD`. "Urgent" is derived (`dueDay` within the urgency threshold); "important" is stored.

## The browser half

The **任务** tab is where work is created, inspected and moved:

- **新建任务** — title, notes, due day, estimate, project, tags, importance.
- **Task detail** — the same fields editable in place (title and estimate commit on a 400 ms debounce), plus subtasks, time entries, notes, the timer and delete.
- **Quadrant board** — drag a card by its grip. Across the importance axis it flips `isImportant`; across the urgency axis it rewrites `dueDay` (today to become urgent, the first day past the threshold to leave it). Inside a cell it reorders, and that order is persisted per cell under `quadrant:<cell>`. The translation lives in `src/domain/projections.ts` (`quadrantMovePatch`), so the browser, the HTTP API and the agent's tools cannot disagree about it.
- The drag is plain pointer events — no animation library in the client bundle, and nothing is written until the pointer is released.

Reads go to `GET /ts/api/state`; writes go to `POST /ts/api/action`, which calls the same service methods the `ts_*` tools call. One write path, one projection path.

## Rules worth knowing

- **今日 / 四象限 / 长期池 are projections of one task set**, not separate kinds of work. The rules live in `src/domain/projections.ts` and are shared by the tools, the HTTP API and the browser.
- **Time has one source of truth**: the `time_entries` table. A task's total and per-day totals are derived on read.
- **The timer never pauses itself.** The harness is pure Node — there is no sleep/idle watcher — so a timer that spans a nap keeps counting. Stop it, or use `ts_log_time` to correct.
- **One writer.** The json backend has no cross-process lock: only one dsh process may hold the `task_tracker` domain at a time.
- **Ideas never take time** and never enter 今日. Their exits are: become a task, done, discarded, or upgraded to a dedicated project and given a verdict.

## Development

```bash
bun test        # domain, service, tools, migration
bun run typecheck
bun run build   # lib/index.js (host) + lib/client.js (browser closure factory)
```

The browser half is a CJS closure factory (`window.__ModuleLoader__.load({ id, factory })`) with `react` and the harness's primitives left external, so it shares the shell's React instance.

## Compatibility

Built against dsh `0.1.0-rc.7`. The harness is a developer preview with frequent breaking changes — the dependency versions here are pinned on purpose.
