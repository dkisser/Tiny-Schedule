import { type AppData, addDays, type Task } from '@tiny-schedule/shared';
import { LayoutGroup, motion, type PanInfo, useDragControls } from 'motion/react';
import { useRef, useState } from 'react';
import { completedInCell, type QuadrantKey, quadrantOf, quadrantTasks } from '../lib/tasks';
import { type ManualOrder, useManualOrder } from '../lib/useManualOrder';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { TaskCard } from './TaskCard';

/** Rows are importance, columns are urgency: the vertical axis moves the
 *  stored `isImportant`, the horizontal axis moves the derived `dueDay`. */
const CELLS: { key: QuadrantKey; title: string }[] = [
  { key: 'important-urgent', title: '重要 · 紧急' },
  { key: 'important-notUrgent', title: '重要 · 不紧急' },
  { key: 'notImportant-urgent', title: '不重要 · 紧急' },
  { key: 'notImportant-notUrgent', title: '不重要 · 不紧急' },
];

function isUrgentCell(key: QuadrantKey): boolean {
  return key.endsWith('-urgent');
}

function isImportantCell(key: QuadrantKey): boolean {
  return key.startsWith('important-');
}

export function QuadrantBoard({
  data,
  today,
  thresholdDays,
  activeTaskId,
}: {
  data: AppData;
  today: string;
  thresholdDays: number;
  activeTaskId?: string | null;
}) {
  const upsertTask = useDataStore((s) => s.upsertTask);
  const allTasks = Object.values(data.tasks);
  const cells = quadrantTasks(allTasks, today, thresholdDays);
  const cellRefs = useRef(new Map<QuadrantKey, HTMLElement | null>());
  const cardRefs = useRef(new Map<string, HTMLElement | null>());
  const [hoverKey, setHoverKey] = useState<QuadrantKey | null>(null);

  // The four cells are fixed, so one hook call per cell stays unconditional.
  // Reorder.Group is deliberately not used here: it locks dragging to a single
  // axis, while a quadrant drag must follow the pointer in both directions.
  const importantUrgent = useManualOrder(cells['important-urgent'], 'quadrant:important-urgent');
  const importantNotUrgent = useManualOrder(
    cells['important-notUrgent'],
    'quadrant:important-notUrgent',
  );
  const notImportantUrgent = useManualOrder(
    cells['notImportant-urgent'],
    'quadrant:notImportant-urgent',
  );
  const notImportantNotUrgent = useManualOrder(
    cells['notImportant-notUrgent'],
    'quadrant:notImportant-notUrgent',
  );
  const orders: Record<QuadrantKey, ManualOrder> = {
    'important-urgent': importantUrgent,
    'important-notUrgent': importantNotUrgent,
    'notImportant-urgent': notImportantUrgent,
    'notImportant-notUrgent': notImportantNotUrgent,
  };

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

  // PanInfo.point is in page coordinates; the cell rects are viewport ones.
  const clientPoint = (info: PanInfo): { x: number; y: number } => ({
    x: info.point.x - window.scrollX,
    y: info.point.y - window.scrollY,
  });

  /** Live in-cell reorder: the dragged card slides past whichever sibling
   *  midpoints the pointer has crossed; siblings animate via their `layout`. */
  const maybeReorder = (cellKey: QuadrantKey, taskId: string, pointerY: number) => {
    const { ordered, onReorder } = orders[cellKey];
    const ids = ordered.map((t) => t.id);
    const others = ids.filter((id) => id !== taskId);
    let insertAt = others.length;
    for (const [i, otherId] of others.entries()) {
      const rect = cardRefs.current.get(otherId)?.getBoundingClientRect();
      if (rect && pointerY < rect.top + rect.height / 2) {
        insertAt = i;
        break;
      }
    }
    const next = [...others];
    next.splice(insertAt, 0, taskId);
    if (next.some((id, i) => id !== ids[i])) onReorder(next);
  };

  const handleDrag = (task: Task, info: PanInfo) => {
    const { x, y } = clientPoint(info);
    const hover = cellAt(x, y);
    setHoverKey(hover);
    if (hover !== null && hover === quadrantOf(task, today, thresholdDays)) {
      maybeReorder(hover, task.id, y);
    }
  };

  /**
   * A board is a view, not a container (ADR-0007): there is no "place a task
   * in this cell" to honour, so a drop is translated into the field changes
   * that put the task where the user pointed.
   */
  const handleDrop = (task: Task, info: PanInfo) => {
    const { x, y } = clientPoint(info);
    const target = cellAt(x, y);
    setHoverKey(null);
    if (!target) return;

    const current = quadrantOf(task, today, thresholdDays);
    if (current === target) return;

    const patch: Partial<Task> = {};
    if (isUrgentCell(current) !== isUrgentCell(target)) {
      // Urgency has no stored field, so dragging across the axis is a rewrite
      // of dueDay: today to become urgent, the first day outside the threshold
      // to leave it.
      patch.dueDay = isUrgentCell(target) ? today : addDays(today, thresholdDays + 1);
    }
    const important = isImportantCell(target);
    if (important !== task.isImportant) patch.isImportant = important;
    if (Object.keys(patch).length === 0) return;
    void upsertTask({ ...task, ...patch });
  };

  return (
    <LayoutGroup>
      <div className="grid grid-cols-2 gap-3">
        {CELLS.map(({ key, title }) => {
          const ordered = orders[key].ordered;
          return (
            <section
              key={key}
              ref={(el) => {
                cellRefs.current.set(key, el);
              }}
              className={cn(
                'flex min-h-40 flex-col rounded-lg border border-border bg-card/40 p-2 transition-colors',
                hoverKey === key && 'border-ring bg-accent/40',
              )}
            >
              <header className="mb-2 flex items-baseline justify-between gap-2 px-1">
                <span className="text-xs font-medium text-muted-foreground">{title}</span>
                <span className="text-xs text-muted-foreground/70">
                  本周完成 {completedInCell(allTasks, key, today, thresholdDays)} 个
                </span>
              </header>
              {ordered.length === 0 ? (
                <p className="px-1 py-3 text-xs text-muted-foreground/60">拖动任务到此格</p>
              ) : (
                <div className="flex flex-col gap-2">
                  {ordered.map((task) => (
                    <QuadrantCard
                      key={task.id}
                      task={task}
                      data={data}
                      active={task.id === activeTaskId}
                      registerEl={(el) => {
                        if (el) cardRefs.current.set(task.id, el);
                        else cardRefs.current.delete(task.id);
                      }}
                      onDrag={handleDrag}
                      onDrop={handleDrop}
                    />
                  ))}
                </div>
              )}
            </section>
          );
        })}
      </div>
    </LayoutGroup>
  );
}

function QuadrantCard({
  task,
  data,
  active,
  registerEl,
  onDrag,
  onDrop,
}: {
  task: Task;
  data: AppData;
  active: boolean;
  registerEl: (el: HTMLDivElement | null) => void;
  onDrag: (task: Task, info: PanInfo) => void;
  onDrop: (task: Task, info: PanInfo) => void;
}) {
  const controls = useDragControls();
  // Layout animation on the dragged card itself would fight the drag
  // transform; only siblings need it. layoutId carries the card across cells:
  // a drop that changes the quadrant remounts it in the target cell, and the
  // shared layout transition glides it there instead of teleporting.
  const [dragging, setDragging] = useState(false);
  return (
    <motion.div
      ref={registerEl}
      layout={!dragging}
      layoutId={task.id}
      drag
      dragListener={false}
      dragControls={controls}
      dragMomentum={false}
      dragSnapToOrigin
      onDragStart={() => setDragging(true)}
      onDrag={(_, info) => onDrag(task, info)}
      onDragEnd={(_, info) => {
        setDragging(false);
        onDrop(task, info);
      }}
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      whileDrag={{ scale: 1.02, zIndex: 20, boxShadow: '0 8px 24px rgba(0,0,0,0.12)' }}
      className="relative"
    >
      <TaskCard task={task} data={data} active={active} dragControls={controls} />
    </motion.div>
  );
}
