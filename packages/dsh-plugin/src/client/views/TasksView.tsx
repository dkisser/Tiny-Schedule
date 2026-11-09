/**
 * The 任务 tab: three projections of the same task set.
 *
 * 今日 / 四象限 / 长期池 are not three kinds of work — they are three views of
 * one list, so they share the rules in `domain/projections.ts` with the
 * agent's tools. The panel is also where work is created, inspected and
 * dragged: every write goes through the host's HTTP action endpoint, so the
 * browser and the agent never disagree about the state.
 */
import type { ConvViewProps } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useMemo, useState } from 'react';
import {
  isOverdue,
  isUrgent,
  longTermPool,
  todayDoneTasks,
  todayTasks,
  workedTodayMs,
} from '../../domain/projections.ts';
import { formatMs, today as todayOf } from '../../domain/time.ts';
import type { TaskView } from '../../domain/types.ts';
import { AddTaskDialog } from '../components/AddTaskDialog.tsx';
import { QuadrantBoard } from '../components/QuadrantBoard.tsx';
import { TaskCard } from '../components/TaskCard.tsx';
import { TaskDetail } from '../components/TaskDetail.tsx';
import { useTracker } from '../data/useTracker.ts';

type Panel = 'today' | 'quadrant' | 'longTerm';

export function TasksView(props: ConvViewProps & PropsLocale<'tinySchedule'>) {
  const { t } = props;
  const { state, error, act } = useTracker();
  const [panel, setPanel] = useState<Panel>('today');
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const day = todayOf();
  const threshold = state?.settings.urgencyThresholdDays ?? 2;
  const horizon = state?.settings.longTermHorizonDays ?? 14;
  const tasks = state?.tasks ?? [];
  const projects = state?.projects ?? [];
  const tags = state?.tags ?? [];

  const projectNames = useMemo(
    () => Object.fromEntries(projects.map((p) => [p.id, p.title])),
    [projects],
  );
  const tagNames = useMemo(
    () => Object.fromEntries(tags.map((tag) => [tag.id, tag.title])),
    [tags],
  );

  const selected = selectedId === null ? undefined : tasks.find((task) => task.id === selectedId);
  const activeTimerTaskId = state?.activeTimer?.taskId ?? null;

  const toggleDone = (task: TaskView): void => {
    void act({ type: task.isDone ? 'task.uncomplete' : 'task.complete', id: task.id });
  };

  const toggleImportant = (task: TaskView): void => {
    void act({ type: 'task.patch', id: task.id, isImportant: !task.isImportant });
  };

  const subTasksDone = (task: TaskView): number | undefined => {
    if (task.subTaskIds.length === 0) return undefined;
    return task.subTaskIds.filter((id) => tasks.find((t) => t.id === id)?.isDone).length;
  };

  const renderCard = (task: TaskView) => (
    <TaskCard
      key={task.id}
      task={task}
      urgent={isUrgent(task, day, threshold)}
      overdue={isOverdue(task)}
      projectTitle={task.projectTitle ?? projectNames[task.projectId] ?? ''}
      tagLabels={task.tagIds.map((id) => tagNames[id] ?? '').filter((label) => label !== '')}
      subTasksDone={subTasksDone(task)}
      active={activeTimerTaskId === task.id}
      selected={selectedId === task.id}
      onToggleDone={toggleDone}
      onToggleImportant={toggleImportant}
      onOpen={(target) => setSelectedId(target.id)}
      onStartTimer={(target) => void act({ type: 'timer.start', taskId: target.id })}
      onStopTimer={() => void act({ type: 'timer.stop' })}
      onDelete={(target) => {
        void act({ type: 'task.delete', id: target.id });
        if (selectedId === target.id) setSelectedId(null);
      }}
    />
  );

  return (
    <div className="ts-root">
      <div className="ts-bar">
        <div className="ts-segments" role="tablist">
          <Segment id="today" active={panel} label={t('panel.today')} onSelect={setPanel} />
          <Segment id="quadrant" active={panel} label={t('panel.quadrant')} onSelect={setPanel} />
          <Segment id="longTerm" active={panel} label={t('panel.longTerm')} onSelect={setPanel} />
        </div>
        <button type="button" className="ts-button is-primary" onClick={() => setCreating(true)}>
          + 新建任务
        </button>
        {state?.activeTimer !== undefined && state.activeTimer !== null && (
          <span className="ts-chip is-urgent">{t('label.timerRunning')}</span>
        )}
        {error !== null && <span className="ts-chip is-overdue">{error}</span>}
      </div>

      {state === null && error === null && <div className="ts-empty">…</div>}

      {state !== null && panel === 'today' && (
        <>
          <div className="ts-meta">
            {t('label.timeToday')} {formatMs(workedTodayMs(tasks, day))}
          </div>
          <section className="ts-section">
            <div className="ts-section-title">{t('label.open')}</div>
            <div className="ts-list">
              {todayTasks(tasks, day).map(renderCard)}
              {todayTasks(tasks, day).length === 0 && (
                <div className="ts-empty">{t('label.empty')}</div>
              )}
            </div>
          </section>
          <section className="ts-section">
            <div className="ts-section-title">{t('label.doneToday')}</div>
            <div className="ts-list">
              {todayDoneTasks(tasks, day).map(renderCard)}
              {todayDoneTasks(tasks, day).length === 0 && (
                <div className="ts-empty">{t('label.empty')}</div>
              )}
            </div>
          </section>
        </>
      )}

      {state !== null && panel === 'quadrant' && (
        <QuadrantBoard
          tasks={tasks}
          today={day}
          thresholdDays={threshold}
          orders={state.orders}
          projects={projectNames}
          tags={tagNames}
          activeTimerTaskId={activeTimerTaskId}
          selectedTaskId={selectedId}
          onReorder={(viewKey, ids) => void act({ type: 'order', viewKey, ids })}
          onMove={(task, patch) =>
            void act({
              type: 'task.patch',
              id: task.id,
              ...(patch.dueDay !== undefined ? { dueDay: patch.dueDay } : {}),
              ...(patch.isImportant !== undefined ? { isImportant: patch.isImportant } : {}),
            })
          }
          onToggleDone={toggleDone}
          onToggleImportant={toggleImportant}
          onOpen={(task) => setSelectedId(task.id)}
          onStartTimer={(task) => void act({ type: 'timer.start', taskId: task.id })}
          onStopTimer={() => void act({ type: 'timer.stop' })}
          onDelete={(task) => {
            void act({ type: 'task.delete', id: task.id });
            if (selectedId === task.id) setSelectedId(null);
          }}
        />
      )}

      {state !== null &&
        panel === 'longTerm' &&
        (() => {
          const pool = longTermPool(tasks, day, horizon);
          return (
            <>
              <section className="ts-section">
                <div className="ts-section-title">{t('label.unscheduled')}</div>
                <div className="ts-list">
                  {pool.unscheduled.map(renderCard)}
                  {pool.unscheduled.length === 0 && (
                    <div className="ts-empty">{t('label.empty')}</div>
                  )}
                </div>
              </section>
              <section className="ts-section">
                <div className="ts-section-title">{t('label.farFuture')}</div>
                <div className="ts-list">
                  {pool.farFuture.map(renderCard)}
                  {pool.farFuture.length === 0 && (
                    <div className="ts-empty">{t('label.empty')}</div>
                  )}
                </div>
              </section>
            </>
          );
        })()}

      <AddTaskDialog
        open={creating}
        projects={projects}
        tags={tags}
        onCreate={(input) => {
          void act({
            type: 'task.create',
            title: input.title,
            notes: input.notes,
            dueDay: input.dueDay,
            isImportant: input.isImportant,
            timeEstimateMinutes: input.timeEstimateMinutes,
            projectId: input.projectId,
            tagIds: input.tagIds,
          });
        }}
        onClose={() => setCreating(false)}
      />

      {selected !== undefined && (
        <TaskDetail
          task={selected}
          tasks={tasks}
          projects={projects}
          tags={tags}
          activeTimerTaskId={activeTimerTaskId}
          onClose={() => setSelectedId(null)}
          onPatch={(id, patch) =>
            void act({
              type: 'task.patch',
              id,
              ...(patch.title !== undefined ? { title: patch.title } : {}),
              ...(patch.projectId !== undefined ? { projectId: patch.projectId } : {}),
              ...(patch.dueDay !== undefined ? { dueDay: patch.dueDay } : {}),
              ...(patch.isImportant !== undefined ? { isImportant: patch.isImportant } : {}),
              ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
              ...(patch.timeEstimateMinutes !== undefined
                ? { timeEstimateMinutes: patch.timeEstimateMinutes }
                : {}),
              ...(patch.tagIds !== undefined ? { tagIds: patch.tagIds } : {}),
            })
          }
          onToggleDone={toggleDone}
          onDelete={(task) => {
            void act({ type: 'task.delete', id: task.id });
            setSelectedId(null);
          }}
          onAddSubTask={(parentId, title) =>
            void act({ type: 'task.create', title, parentTaskId: parentId })
          }
          onAddTime={(taskId, minutes) => void act({ type: 'time.add', taskId, minutes })}
          onDeleteTime={(id) => void act({ type: 'time.delete', id })}
          onStartTimer={(task) => void act({ type: 'timer.start', taskId: task.id })}
          onStopTimer={() => void act({ type: 'timer.stop' })}
        />
      )}
    </div>
  );
}

function Segment(props: {
  id: Panel;
  active: Panel;
  label: string;
  onSelect: (panel: Panel) => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      className="ts-segment"
      aria-selected={props.active === props.id}
      onClick={() => props.onSelect(props.id)}
    >
      {props.label}
    </button>
  );
}
