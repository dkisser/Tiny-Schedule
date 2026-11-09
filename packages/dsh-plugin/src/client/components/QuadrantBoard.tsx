/**
 * The quadrant board.
 *
 * Rows are importance, columns are urgency. The retired app's rule is kept
 * verbatim: a drop is not "put the task in this cell" — a cell holds no
 * state — it is a rewrite of the fields that put the task where the pointer
 * left it (`domain/projections.ts` owns that translation).
 *
 * The drag is plain pointer events: the board owns the geometry, the host
 * owns the write. Nothing is persisted until the pointer is released.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  completedInCell,
  isOverdue,
  isUrgent,
  quadrantMovePatch,
  quadrantOf,
  quadrantTasks,
} from '../../domain/projections.ts';
import type { QuadrantKey, TaskView } from '../../domain/types.ts';
import { QUADRANT_KEYS, QUADRANT_LABELS } from '../../domain/types.ts';
import { TaskCard } from './TaskCard.tsx';

export interface QuadrantBoardProps {
  tasks: TaskView[];
  today: string;
  thresholdDays: number;
  /** Manual drag order, keyed by view. */
  orders: Record<string, string[]>;
  /** Project name by id. */
  projects: Record<string, string>;
  /** Tag name by id. */
  tags: Record<string, string>;
  /** The task the running timer belongs to, if any. */
  activeTimerTaskId: string | null;
  /** The task open in the detail drawer. */
  selectedTaskId: string | null;
  onReorder: (viewKey: string, ids: string[]) => void;
  onMove: (task: TaskView, patch: { dueDay?: string; isImportant?: boolean }) => void;
  onToggleDone: (task: TaskView) => void;
  onToggleImportant: (task: TaskView) => void;
  onOpen: (task: TaskView) => void;
  onStartTimer: (task: TaskView) => void;
  onStopTimer: (task: TaskView) => void;
  onDelete: (task: TaskView) => void;
}

export function QuadrantBoard(props: QuadrantBoardProps) {
  const { tasks, today, thresholdDays } = props;
  const cells = useMemo(
    () => quadrantTasks(tasks, today, thresholdDays),
    [tasks, today, thresholdDays],
  );
  const cellRefs = useRef(new Map<QuadrantKey, HTMLElement>());
  const cardRefs = useRef(new Map<string, HTMLElement>());
  const [hoverKey, setHoverKey] = useState<QuadrantKey | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const drag = useRef<{
    taskId: string;
    rectLeft: number;
    rectTop: number;
    offsetX: number;
    offsetY: number;
    moved: boolean;
  } | null>(null);

  // The four cells are fixed, so one hook call per cell stays unconditional.
  const importantUrgent = useCellOrder(
    cells['important-urgent'],
    props.orders['quadrant:important-urgent'],
  );
  const importantNotUrgent = useCellOrder(
    cells['important-notUrgent'],
    props.orders['quadrant:important-notUrgent'],
  );
  const notImportantUrgent = useCellOrder(
    cells['notImportant-urgent'],
    props.orders['quadrant:notImportant-urgent'],
  );
  const notImportantNotUrgent = useCellOrder(
    cells['notImportant-notUrgent'],
    props.orders['quadrant:notImportant-notUrgent'],
  );
  const orders: Record<QuadrantKey, CellOrder> = {
    'important-urgent': importantUrgent,
    'important-notUrgent': importantNotUrgent,
    'notImportant-urgent': notImportantUrgent,
    'notImportant-notUrgent': notImportantNotUrgent,
  };
  // The drag listeners are registered once, when the grip is pressed, so they
  // close over the order of that render. The live order has to be read
  // through a ref: the reorder it performs updates the state, and the drop
  // must persist what the drag actually produced, not the order it started
  // from.
  const ordersRef = useRef(orders);
  ordersRef.current = orders;

  const cellAt = (x: number, y: number): QuadrantKey | null => {
    // Rect-based hit test: a pointer released in the gutter between two cells
    // matches neither, so it counts as "dropped nowhere".
    for (const [key, el] of cellRefs.current) {
      const rect = el?.getBoundingClientRect();
      if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
        return key;
      }
    }
    return null;
  };

  /**
   * Live in-cell reorder: the dragged card slides past whichever sibling
   * midpoints the pointer has crossed.
   */
  const maybeReorder = (cellKey: QuadrantKey, taskId: string, pointerY: number) => {
    const order = ordersRef.current[cellKey];
    const ids = order.ids;
    const others = ids.filter((id) => id !== taskId);
    let insertAt = others.length;
    for (const [index, otherId] of others.entries()) {
      const rect = cardRefs.current.get(otherId)?.getBoundingClientRect();
      if (rect && pointerY < rect.top + rect.height / 2) {
        insertAt = index;
        break;
      }
    }
    const next = [...others];
    next.splice(insertAt, 0, taskId);
    if (next.some((id, index) => id !== ids[index])) order.set(next);
  };

  const startDrag = (task: TaskView, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const element = cardRefs.current.get(task.id);
    if (element === undefined) return;
    const rect = element.getBoundingClientRect();
    drag.current = {
      taskId: task.id,
      rectLeft: rect.left,
      rectTop: rect.top,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      moved: false,
    };
    setDraggingId(task.id);
    element.classList.add('is-dragging');
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
  };

  const onPointerMove = (event: PointerEvent) => {
    const state = drag.current;
    if (state === null) return;
    const element = cardRefs.current.get(state.taskId);
    if (element === undefined) return;
    state.moved = true;
    // The card follows the pointer, keeping the grab offset.
    element.style.transform = `translate3d(${
      event.clientX - state.offsetX - state.rectLeft
    }px, ${event.clientY - state.offsetY - state.rectTop}px, 0)`;
    const hover = cellAt(event.clientX, event.clientY);
    setHoverKey(hover);
    const task = tasks.find((candidate) => candidate.id === state.taskId);
    if (hover !== null && task !== undefined && hover === quadrantOf(task, today, thresholdDays)) {
      maybeReorder(hover, state.taskId, event.clientY);
    }
  };

  const onPointerUp = (event: PointerEvent) => {
    const state = drag.current;
    drag.current = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    const element = state === null ? undefined : cardRefs.current.get(state.taskId);
    if (element !== undefined) {
      element.style.transform = '';
      element.classList.remove('is-dragging');
    }
    setDraggingId(null);
    setHoverKey(null);
    if (state === null || !state.moved) return;

    const task = tasks.find((candidate) => candidate.id === state.taskId);
    if (task === undefined) return;
    const target = cellAt(event.clientX, event.clientY);
    if (target === null) return;

    const current = quadrantOf(task, today, thresholdDays);
    if (current === target) {
      // Dropped back into its own cell: keep the order the drag established,
      // but only write it when the drag actually moved something.
      const order = ordersRef.current[target];
      const fallback = cells[target].map((candidate) => candidate.id);
      if (order.ids.some((id, index) => id !== fallback[index])) {
        props.onReorder(`quadrant:${target}`, order.ids);
      }
      return;
    }
    const patch = quadrantMovePatch(task, target, today, thresholdDays);
    if (Object.keys(patch).length === 0) return;
    props.onMove(task, patch);
  };

  // A drag that outlives the component must not leave listeners behind.
  useEffect(
    () => () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
    },
    [],
  );

  return (
    <div className="ts-quadrants">
      {QUADRANT_KEYS.map((cell) => {
        const order = orders[cell];
        const cellTasks = order.ids
          .map((id) => cells[cell].find((task) => task.id === id))
          .filter((task): task is TaskView => task !== undefined);
        return (
          <section
            key={cell}
            ref={(el) => {
              if (el) cellRefs.current.set(cell, el);
              else cellRefs.current.delete(cell);
            }}
            className={hoverKey === cell ? 'ts-quadrant is-hover' : 'ts-quadrant'}
          >
            <div className="ts-quadrant-head">
              <span className="ts-section-title">{QUADRANT_LABELS[cell]}</span>
              <span className="ts-meta">
                {cellTasks.length} · 本周完成 {completedInCell(tasks, cell, today, thresholdDays)}
              </span>
            </div>
            {cellTasks.length === 0 ? (
              <div className="ts-empty">拖动任务到此格</div>
            ) : (
              <div className="ts-list">
                {cellTasks.map((task) => (
                  <div
                    key={task.id}
                    className={draggingId === task.id ? 'ts-drag-card is-dragging' : 'ts-drag-card'}
                    ref={(el) => {
                      if (el) cardRefs.current.set(task.id, el);
                      else cardRefs.current.delete(task.id);
                    }}
                  >
                    <TaskCard
                      task={task}
                      urgent={isUrgent(task, today, thresholdDays)}
                      overdue={isOverdue(task)}
                      projectTitle={props.projects[task.projectId] ?? task.projectTitle ?? ''}
                      tagLabels={task.tagIds
                        .map((id) => props.tags[id] ?? '')
                        .filter((label) => label !== '')}
                      subTasksDone={
                        task.subTaskIds.length > 0
                          ? task.subTaskIds.filter(
                              (id) => props.tasks.find((candidate) => candidate.id === id)?.isDone,
                            ).length
                          : undefined
                      }
                      active={props.activeTimerTaskId === task.id}
                      selected={props.selectedTaskId === task.id}
                      onToggleDone={props.onToggleDone}
                      onToggleImportant={props.onToggleImportant}
                      onOpen={props.onOpen}
                      onStartTimer={props.onStartTimer}
                      onStopTimer={props.onStopTimer}
                      onDelete={props.onDelete}
                      onGripDown={(event) => startDrag(task, event)}
                    />
                  </div>
                ))}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

interface CellOrder {
  ids: string[];
  set: (ids: string[]) => void;
}

/**
 * The manual order of one cell.
 *
 * Kept locally while a drag is in flight and reconciled with the persisted
 * order whenever the cell's membership or the stored order changes: tasks
 * that left the cell are dropped, new ones are appended.
 */
function useCellOrder(tasks: TaskView[], saved: string[] | undefined): CellOrder {
  const [ids, setIds] = useState<string[]>(() => tasks.map((task) => task.id));
  const membership = tasks
    .map((task) => task.id)
    .sort()
    .join(',');
  const savedKey = (saved ?? []).join(',');

  useEffect(() => {
    setIds((previous) => {
      const current = tasks.map((task) => task.id);
      const currentSet = new Set(current);
      const base =
        saved !== undefined && saved.length > 0
          ? saved.filter((id) => currentSet.has(id))
          : previous.filter((id) => currentSet.has(id));
      const baseSet = new Set(base);
      return [...base, ...current.filter((id) => !baseSet.has(id))];
    });
    // The ids are the real dependency; `tasks` is only read for its membership.
  }, [membership, savedKey]);

  return { ids, set: setIds };
}
