/**
 * The task detail drawer.
 *
 * The retired app's right-hand panel: everything a task knows about itself,
 * editable in place. Fields commit as they change — title and estimate are
 * debounced, the rest commit on the spot.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useRef, useState } from 'react';
import type { ProjectRecord, TagRecord } from '../../domain/schema.ts';
import type { TaskView } from '../../domain/types.ts';

export interface TaskPatchInput {
  title?: string;
  projectId?: string;
  dueDay?: string | null;
  isImportant?: boolean;
  notes?: string;
  timeEstimateMinutes?: number;
  tagIds?: string[];
}

export interface TaskDetailProps extends PropsLocale<'tinySchedule'> {
  task: TaskView;
  /** Every task, so the subtask list can resolve its rows. */
  tasks: TaskView[];
  projects: ProjectRecord[];
  tags: TagRecord[];
  /** The task the running timer belongs to, if any. */
  activeTimerTaskId: string | null;
  onClose: () => void;
  onPatch: (taskId: string, patch: TaskPatchInput) => void;
  onToggleDone: (task: TaskView) => void;
  onDelete: (task: TaskView) => void;
  onAddSubTask: (parentId: string, title: string) => void;
  onAddTime: (taskId: string, minutes: number) => void;
  onDeleteTime: (entryId: string) => void;
  onStartTimer: (task: TaskView) => void;
  onStopTimer: (task: TaskView) => void;
}

export function TaskDetail(props: TaskDetailProps) {
  const { task, t } = props;
  const title = useDebouncedCommit(task.title, 400, (value) => {
    const trimmed = value.trim();
    if (trimmed !== '' && trimmed !== task.title) props.onPatch(task.id, { title: trimmed });
  });
  const hours = useDebouncedCommit(
    task.timeEstimate > 0 ? String(task.timeEstimate / 3_600_000) : '',
    400,
    (value) => {
      const ms = Math.round((Number(value) || 0) * 3_600_000);
      if (ms !== task.timeEstimate) props.onPatch(task.id, { timeEstimateMinutes: ms / 60_000 });
    },
  );

  const [subTitle, setSubTitle] = useState('');
  const [minutes, setMinutes] = useState('');
  const [notes, setNotes] = useState(task.notes);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    setNotes(task.notes);
    setConfirmDelete(false);
  }, [task.id, task.notes]);

  const byId = new Map(props.tasks.map((t) => [t.id, t]));
  const subTasks = task.subTaskIds
    .map((id) => byId.get(id))
    .filter((t): t is TaskView => t !== undefined);
  const active = props.activeTimerTaskId === task.id;

  const toggleTag = (tagId: string) => {
    const next = task.tagIds.includes(tagId)
      ? task.tagIds.filter((id) => id !== tagId)
      : [...task.tagIds, tagId];
    props.onPatch(task.id, { tagIds: next });
  };

  const addSubTask = () => {
    const trimmed = subTitle.trim();
    if (trimmed === '') return;
    props.onAddSubTask(task.id, trimmed);
    setSubTitle('');
  };

  const addTime = () => {
    const value = Number(minutes);
    if (!Number.isFinite(value) || value <= 0) return;
    props.onAddTime(task.id, value);
    setMinutes('');
  };

  return (
    <>
      <div className="ts-drawer-backdrop" onClick={props.onClose} />
      <aside className="ts-drawer" aria-label={t('field.taskDetail')}>
        <div className="ts-drawer-head">
          <button type="button" className="ts-button" onClick={props.onClose}>
            {t('field.close')}
          </button>
          <button
            type="button"
            className="ts-button is-primary"
            onClick={() => props.onToggleDone(task)}
          >
            {task.isDone ? t('action.uncomplete') : t('action.complete')}
          </button>
        </div>

        <input
          className="ts-input ts-title-input"
          value={title.value}
          onChange={(event) => title.set(event.target.value)}
          onBlur={title.flush}
          onKeyDown={(event) => {
            if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
          }}
        />

        <label className="ts-field">
          <span className="ts-field-label">{t('field.project')}</span>
          <select
            className="ts-input"
            value={task.projectId}
            onChange={(event) => props.onPatch(task.id, { projectId: event.target.value })}
          >
            {props.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>

        <div className="ts-field">
          <span className="ts-field-label">{t('field.tags')}</span>
          <div className="ts-tag-picker">
            {props.tags.length === 0 && <span className="ts-meta">{t('field.noTags')}</span>}
            {props.tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={task.tagIds.includes(tag.id) ? 'ts-tag is-on' : 'ts-tag'}
                onClick={() => toggleTag(tag.id)}
              >
                {tag.title}
              </button>
            ))}
          </div>
        </div>

        <div className="ts-field-grid">
          <label className="ts-field">
            <span className="ts-field-label">{t('field.dueDay')}</span>
            <div className="ts-inline">
              <input
                className="ts-input"
                type="date"
                value={task.dueDay ?? ''}
                onChange={(event) => props.onPatch(task.id, { dueDay: event.target.value || null })}
              />
              <button
                type="button"
                className="ts-icon is-star"
                aria-label={
                  task.isImportant ? t('action.unmarkImportant') : t('action.markImportant')
                }
                aria-pressed={task.isImportant}
                onClick={() => props.onPatch(task.id, { isImportant: !task.isImportant })}
              >
                {task.isImportant ? '★' : '☆'}
              </button>
            </div>
          </label>
          <label className="ts-field">
            <span className="ts-field-label">{t('field.estimate')}</span>
            <input
              className="ts-input"
              type="number"
              min="0"
              step="0.5"
              value={hours.value}
              onChange={(event) => hours.set(event.target.value)}
              onBlur={hours.flush}
            />
          </label>
        </div>

        <div className="ts-field">
          <span className="ts-field-label">{t('field.subtasks')}</span>
          {subTasks.length > 0 && (
            <div className="ts-subtasks">
              {subTasks.map((sub) => (
                <div className="ts-subtask" key={sub.id}>
                  <input
                    type="checkbox"
                    checked={sub.isDone}
                    onChange={() => props.onToggleDone(sub)}
                  />
                  <span className={sub.isDone ? 'is-done' : ''}>{sub.title}</span>
                  <button
                    type="button"
                    className="ts-icon is-danger"
                    aria-label={t('action.deleteSubtask')}
                    onClick={() => props.onDelete(sub)}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="ts-inline">
            <input
              className="ts-input"
              placeholder={t('field.addSubtask')}
              value={subTitle}
              onChange={(event) => setSubTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addSubTask();
              }}
            />
            <button type="button" className="ts-button" onClick={addSubTask}>
              {t('action.add')}
            </button>
          </div>
        </div>

        <div className="ts-field">
          <span className="ts-field-label">{t('field.timeEntries')}</span>
          {task.timeEntries.length === 0 ? (
            <div className="ts-meta">{t('field.noTimeEntries')}</div>
          ) : (
            <div className="ts-entries">
              {[...task.timeEntries]
                .sort((a, b) => b.end - a.end)
                .map((entry) => (
                  <div className="ts-entry" key={entry.id}>
                    <span>
                      {entry.date} {formatClock(entry.start)}–{formatClock(entry.end)}
                    </span>
                    <span className="ts-meta">{formatDuration(entry.ms)}</span>
                    <button
                      type="button"
                      className="ts-icon is-danger"
                      aria-label={t('action.deleteTimeEntry')}
                      onClick={() => props.onDeleteTime(entry.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
            </div>
          )}
          <div className="ts-inline">
            <input
              className="ts-input"
              type="number"
              min="0"
              step="1"
              placeholder={t('field.logMinutes')}
              value={minutes}
              onChange={(event) => setMinutes(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addTime();
              }}
            />
            <button type="button" className="ts-button" onClick={addTime}>
              {t('action.log')}
            </button>
          </div>
        </div>

        <div className="ts-field">
          <span className="ts-field-label">{t('field.notes')}</span>
          <textarea
            className="ts-input ts-textarea"
            rows={4}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            onBlur={() => {
              if (notes !== task.notes) props.onPatch(task.id, { notes });
            }}
          />
        </div>

        <div className="ts-drawer-foot">
          {active ? (
            <button type="button" className="ts-button" onClick={() => props.onStopTimer(task)}>
              {t('action.stopTimer')}
            </button>
          ) : (
            <button type="button" className="ts-button" onClick={() => props.onStartTimer(task)}>
              {t('action.startTimer')}
            </button>
          )}
          <button
            type="button"
            className={confirmDelete ? 'ts-button is-danger' : 'ts-button'}
            onClick={() => {
              if (confirmDelete) props.onDelete(task);
              else setConfirmDelete(true);
            }}
            onBlur={() => setConfirmDelete(false)}
          >
            {confirmDelete ? t('action.confirmDelete') : t('action.delete')}
          </button>
        </div>
      </aside>
    </>
  );
}

/**
 * A controlled value that commits on a delay.
 *
 * The old app used the same shape: the field stays responsive while typing
 * and the write lands once the user pauses.
 */
function useDebouncedCommit(
  initial: string,
  delay: number,
  commit: (value: string) => void,
): { value: string; set: (next: string) => void; flush: () => void } {
  const [value, setValue] = useState(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(initial);
  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    setValue(initial);
    latest.current = initial;
  }, [initial]);

  const clear = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  useEffect(() => clear, []);

  const flush = () => {
    clear();
    commitRef.current(latest.current);
  };

  const set = (next: string) => {
    latest.current = next;
    setValue(next);
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      commitRef.current(latest.current);
    }, delay);
  };

  return { value, set, flush };
}

function formatClock(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms: number): string {
  const m = Math.floor(ms / 60_000);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}
