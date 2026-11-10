# dsh-plugin-tiny-schedule

Task tracking and idea lifecycle for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

Two domains — **任务** and **想法** — plus the agent tools to work with them, and a page in the harness web client you open from the left column.

```
dsh web  →  左栏（会话历史上方）：[✓ 任务与想法]  ← 总入口
                              └── 点击 → 中栏整页：任务 | 想法
                                                    任务内：今日 · 四象限 · 长期池
                                                    想法内：收集箱 · 验证中 · 已了结
```

## What it is

| Piece | What it does |
|---|---|
| **Domain** | Task, Project, Tag, TimeEntry, Idea, FollowUp — zod schemas, projections, the idea state machine. Pure, no I/O. |
| **Storage** | One dsh storage domain (`task_tracker`), seven tables plus a global slot. json backend → `~/.dsh/storages/task_tracker.json`. |
| **Tools** | 24 agent tools, all prefixed `ts_` (`todo_write` is taken by the harness). |
| **Client** | A left-column entry above the session history. Clicking it swaps the centre column for a page of the plugin's own — the 任务 and 想法 tabs, as they were before. The browser reads a snapshot the host computes and writes through one same-origin JSON endpoint. |

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

The plugin is one entry in the **left column**, above the session history. Clicking it opens a page in the centre column; the page's own top tabs are **任务 | 想法**, and a 「返回对话」 button hands the column back.

### The page (`src/client/page/TrackerPage.tsx`)

- **任务 | 想法** — the two top-level tabs. 任务 holds three projections of one task set (**今日 / 四象限 / 长期池**); 想法 holds the idea lifecycle (**收集箱 / 验证中 / 已了结**).
- **返回对话** — `ctx.layout.selectPanel(null)`; the centre column returns to the conversation.
- A 30 s poll of `/ts/api/state` keeps the page in step with what the agent tools write.

### The task surface (`src/client/views/TasksView.tsx`)

Where work is created, inspected and moved:

- **新建任务** — title, notes, due day, estimate, project, tags, importance.
- **Task detail** — the same fields editable in place (title and estimate commit on a 400 ms debounce), plus subtasks, time entries, notes, the timer and delete.
- **Quadrant board** — drag a card by its grip. Across the importance axis it flips `isImportant`; across the urgency axis it rewrites `dueDay` (today to become urgent, the first day past the threshold to leave it). Inside a cell it reorders, and that order is persisted per cell under `quadrant:<cell>`. The translation lives in `src/domain/projections.ts` (`quadrantMovePatch`), so the browser, the HTTP API and the agent's tools cannot disagree about it.
- The drag is plain pointer events — no animation library in the client bundle, and nothing is written until the pointer is released.

Reads go to `GET /ts/api/state`; writes go to `POST /ts/api/action`, which calls the same service methods the `ts_*` tools call. One write path, one projection path.

### How it gets into the column

The harness ships this seam itself: a `sidebar.panellist` row selects a centre panel. The plugin registers the two halves of that pair —

| Seat | What | Fields |
|---|---|---|
| `sidebar.panellist` | the left-column row | `id: 'tiny-schedule'`, `order: 20` |
| `main` | the keyed centre panel | `key: 'tiny-schedule'` |

Both spell the same id on purpose: `ctx.layout.selectPanel(id)` refuses to select a panel the `main` slot does not hold. `dsh-client-ui-plugin-manager` and `dsh-client-ui-schedule` are built the same way.

The plugin therefore **does not patch the shell's DOM** — no `data-slot` anchor, no portal host, no re-anchoring timer. The only host coupling is the seat names themselves. See [ADR 0010](../../docs/adr/0010-the-plugin-opens-as-a-page-from-the-left-column.md).

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

Built against dsh `0.2.2-rc.1`. The harness is a developer preview with frequent breaking changes — the dependency versions here are pinned on purpose.

Two pins are load-bearing:

- **`zod` is pinned to `4.4.3`,** the exact version `@deepseek-ai/dsh-storage-domain` depends on. `domainTable()` infers its value type from `ZodType<V>`, and a schema built by a *different* zod version makes TypeScript match the two type graphs structurally — which does not fail, it exhausts the heap. A mismatched zod turns `bun run typecheck` into an OOM instead of an error.
- **`@deepseek-ai/dsh-client-ui-renderer` is a peer dependency** for one reason: `ctx.slots` is declared there, not in `dsh-client-ui-slots`. The browser half needs the renderer's Context merge to type `ctx.slots.inject(...)`.

A third peer, **`@deepseek-ai/dsh-client-ui-sidebar`**, declares the `sidebar.panellist` seat the entry registers into; it is type-only (the seat name is a string, not an import), but the version still has to match the host.

A fourth peer, **`@deepseek-ai/dsh-client-ui-layout`**, declares the `main` slot row and the `ctx.layout` service the page uses for panel selection and 「返回对话」. Also type-only, also version-locked.
