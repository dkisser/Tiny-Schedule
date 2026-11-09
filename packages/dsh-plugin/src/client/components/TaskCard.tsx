/**
 * One task, as a card.
 *
 * The retired app drew the same shape: a grip to drag it with, a star for
 * importance, a circle to complete it, and the chips that carry its state.
 * The card is presentational — every action is a callback, so the board and
 * the flat lists drive it the same way.
 */
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { TaskView } from '../../domain/types.ts';

export interface TaskCardProps {
  task: TaskView;
  /** Whether the task is urgent right now (derived by the host's rules). */
  urgent: boolean;
  /** Whether the task is past its due day. */
  overdue: boolean;
  /** The project name, already resolved. */
  projectTitle: string;
  /** Tag names, already resolved. */
  tagLabels: string[];
  /** How many subtasks are done; `undefined` when the task has none. */
  subTasksDone?: number;
  /** A timer is running on this task. */
  active: boolean;
  /** The task is the one open in the detail drawer. */
  selected?: boolean;
  /** Present on the quadrant board: the grip hands the pointer over to it. */
  onGripDown?: (event: ReactPointerEvent<HTMLElement>) => void;
  onToggleDone: (task: TaskView) => void;
  onToggleImportant: (task: TaskView) => void;
  onOpen?: (task: TaskView) => void;
  onStartTimer?: (task: TaskView) => void;
  onStopTimer?: (task: TaskView) => void;
  onDelete?: (task: TaskView) => void;
}

export function TaskCard(props: TaskCardProps) {
  const { task } = props;
  const done = task.isDone;
  const classes = [
    'ts-card',
    done ? 'is-done' : '',
    props.selected ? 'is-selected' : '',
    props.active ? 'is-active' : '',
    props.overdue ? 'is-overdue' : '',
  ]
    .filter((c) => c !== '')
    .join(' ');

  return (
    <div
      className={classes}
      role="button"
      tabIndex={0}
      onClick={() => props.onOpen?.(task)}
      onKeyDown={(event) => {
        if (event.key === 'Enter') props.onOpen?.(task);
      }}
    >
      {props.onGripDown !== undefined && !done && (
        <button
          type="button"
          className="ts-icon is-grip"
          aria-label="拖动排序"
          title="拖动排序"
          onPointerDown={(event) => props.onGripDown?.(event)}
          onClick={(event) => event.stopPropagation()}
        >
          ⠿
        </button>
      )}
      <button
        type="button"
        className="ts-icon is-star"
        aria-label={task.isImportant ? '取消重要' : '标为重要'}
        aria-pressed={task.isImportant}
        title={task.isImportant ? '取消重要' : '标为重要'}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggleImportant(task);
        }}
      >
        {task.isImportant ? '★' : '☆'}
      </button>
      <button
        type="button"
        className="ts-check"
        aria-label={done ? '取消完成' : '完成'}
        aria-pressed={done}
        onClick={(event) => {
          event.stopPropagation();
          props.onToggleDone(task);
        }}
      >
        {done ? '✓' : ''}
      </button>
      <div className="ts-card-main">
        <div className="ts-card-title">{task.title}</div>
        {(props.projectTitle !== '' ||
          props.tagLabels.length > 0 ||
          props.subTasksDone !== undefined ||
          props.overdue ||
          (done && task.doneAt !== undefined)) && (
          <div className="ts-card-chips">
            {done && task.doneAt !== undefined && (
              <span className="ts-chip is-done">做完于 {formatClock(task.doneAt)}</span>
            )}
            {props.overdue && <span className="ts-chip is-overdue">逾期</span>}
            {props.urgent && !done && <span className="ts-chip is-urgent">紧急</span>}
            {props.subTasksDone !== undefined && (
              <span className="ts-chip">
                子任务 {props.subTasksDone}/{task.subTaskIds.length}
              </span>
            )}
            {props.projectTitle !== '' && <span className="ts-chip">{props.projectTitle}</span>}
            {props.tagLabels.map((label) => (
              <span className="ts-chip" key={label}>
                {label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="ts-card-time">
        {task.timeSpent > 0 && task.timeEstimate > 0
          ? `${formatMs(task.timeSpent)} / ${formatMs(task.timeEstimate)}`
          : task.timeSpent > 0
            ? formatMs(task.timeSpent)
            : task.timeEstimate > 0
              ? formatMs(task.timeEstimate)
              : ''}
      </div>
      <div className="ts-card-actions">
        {props.onStartTimer !== undefined &&
          (props.active ? (
            <button
              type="button"
              className="ts-icon"
              aria-label="停止计时"
              title="停止计时"
              onClick={(event) => {
                event.stopPropagation();
                props.onStopTimer?.(task);
              }}
            >
              ⏹
            </button>
          ) : (
            <button
              type="button"
              className="ts-icon"
              aria-label="开始计时"
              title="开始计时"
              onClick={(event) => {
                event.stopPropagation();
                props.onStartTimer?.(task);
              }}
            >
              ▶
            </button>
          ))}
        {props.onDelete !== undefined && !props.active && (
          <button
            type="button"
            className="ts-icon is-danger"
            aria-label="删除"
            title="删除"
            onClick={(event) => {
              event.stopPropagation();
              props.onDelete?.(task);
            }}
          >
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  return sameDay ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function formatMs(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
