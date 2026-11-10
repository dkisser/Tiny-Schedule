/**
 * The create-task form.
 *
 * The retired app's dialog, reduced to what a browser page can carry: no
 * portal, no combobox — a plain select for the project and a chip row for
 * the tags. The host owns the write; this only collects the fields.
 */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useEffect, useState } from 'react';
import type { ProjectRecord, TagRecord } from '../../domain/schema.ts';

export interface NewTaskInput {
  title: string;
  notes: string;
  dueDay: string;
  isImportant: boolean;
  timeEstimateMinutes: number;
  projectId: string;
  tagIds: string[];
}

export interface AddTaskDialogProps extends PropsLocale<'tinySchedule'> {
  open: boolean;
  projects: ProjectRecord[];
  tags: TagRecord[];
  defaultProjectId?: string;
  defaultDueDay?: string;
  onCreate: (input: NewTaskInput) => void;
  onClose: () => void;
}

export function AddTaskDialog(props: AddTaskDialogProps) {
  const { open, projects, tags, t } = props;
  const [title, setTitle] = useState('');
  const [notes, setNotes] = useState('');
  const [dueDay, setDueDay] = useState('');
  const [isImportant, setImportant] = useState(false);
  const [estimate, setEstimate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setNotes('');
    setDueDay(props.defaultDueDay ?? '');
    setImportant(false);
    setEstimate('');
    setProjectId(props.defaultProjectId ?? '');
    setTagIds([]);
  }, [open, props.defaultProjectId, props.defaultDueDay]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') props.onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, props]);

  if (!open) return null;

  const canSubmit = title.trim().length > 0;

  const toggleTag = (tagId: string) => {
    setTagIds((ids) => (ids.includes(tagId) ? ids.filter((id) => id !== tagId) : [...ids, tagId]));
  };

  const submit = () => {
    const trimmed = title.trim();
    if (!trimmed) return;
    props.onCreate({
      title: trimmed,
      notes: notes.trim(),
      dueDay,
      isImportant,
      timeEstimateMinutes: Number(estimate) || 0,
      projectId,
      tagIds,
    });
    props.onClose();
  };

  return (
    <div className="ts-modal-backdrop" onClick={props.onClose}>
      <div
        className="ts-modal"
        role="dialog"
        aria-modal="true"
        aria-label={t('action.newTask')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ts-modal-title">{t('action.newTask')}</div>
        <input
          className="ts-input"
          autoFocus
          placeholder={t('field.title')}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && canSubmit) submit();
          }}
        />
        <textarea
          className="ts-input ts-textarea"
          placeholder={t('field.notes')}
          rows={3}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
        />
        <div className="ts-field-grid">
          <label className="ts-field">
            <span className="ts-field-label">{t('field.dueDay')}</span>
            <input
              className="ts-input"
              type="date"
              value={dueDay}
              onChange={(event) => setDueDay(event.target.value)}
            />
          </label>
          <label className="ts-field">
            <span className="ts-field-label">{t('field.estimate')}</span>
            <input
              className="ts-input"
              type="number"
              min="0"
              step="0.5"
              placeholder="0"
              value={estimate}
              onChange={(event) => setEstimate(event.target.value)}
            />
          </label>
        </div>
        <label className="ts-field">
          <span className="ts-field-label">{t('field.project')}</span>
          <select
            className="ts-input"
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            <option value="">{t('field.noProject')}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.title}
              </option>
            ))}
          </select>
        </label>
        <div className="ts-field">
          <span className="ts-field-label">{t('field.tags')}</span>
          <div className="ts-tag-picker">
            {tags.length === 0 && <span className="ts-meta">{t('field.noTags')}</span>}
            {tags.map((tag) => (
              <button
                key={tag.id}
                type="button"
                className={tagIds.includes(tag.id) ? 'ts-tag is-on' : 'ts-tag'}
                onClick={() => toggleTag(tag.id)}
              >
                {tag.title}
              </button>
            ))}
          </div>
        </div>
        <label className="ts-checkline">
          <input
            type="checkbox"
            checked={isImportant}
            onChange={(event) => setImportant(event.target.checked)}
          />
          <span>{t('field.markImportant')}</span>
        </label>
        <div className="ts-modal-footer">
          <button type="button" className="ts-button" onClick={props.onClose}>
            {t('action.cancel')}
          </button>
          <button
            type="button"
            className="ts-button is-primary"
            disabled={!canSubmit}
            onClick={submit}
          >
            {t('action.create')}
          </button>
        </div>
      </div>
    </div>
  );
}
