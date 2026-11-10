/**
 * The 想法 tab: an idea's own lifecycle, separate from tasks.
 *
 * 收集箱 (open) → 验证中 (incubating) → 已了结 (resolved). An idea never
 * enters the today view and never takes time.
 */

import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import { useMemo, useState } from 'react';
import { incubatingIdeas, openIdeas, resolvedIdeas } from '../../domain/ideas.ts';
import type { IdeaRecord } from '../../domain/schema.ts';
import { useTracker } from '../data/useTracker.ts';

type Group = 'inbox' | 'incubating' | 'resolved';

export interface IdeasViewProps extends PropsLocale<'tinySchedule'> {
  /** How often to re-read the host's snapshot, in milliseconds; omitted means no polling. */
  pollMs?: number;
}

export function IdeasView(props: IdeasViewProps) {
  const { t } = props;
  const { state, error, act } = useTracker({ pollMs: props.pollMs });
  const [group, setGroup] = useState<Group>('inbox');

  const ideas = state?.ideas ?? [];
  const projects = useMemo(
    () => Object.fromEntries((state?.projects ?? []).map((p) => [p.id, p])),
    [state],
  );

  const lists: Record<Group, IdeaRecord[]> = useMemo(
    () => ({
      inbox: openIdeas(ideas),
      incubating: incubatingIdeas(ideas, projects),
      resolved: resolvedIdeas(ideas),
    }),
    [ideas, projects],
  );

  const rows = lists[group];

  return (
    <div className="ts-root">
      <div className="ts-bar">
        <div className="ts-segments" role="tablist">
          <Segment id="inbox" active={group} label={t('panel.inbox')} onSelect={setGroup} />
          <Segment
            id="incubating"
            active={group}
            label={t('panel.incubating')}
            onSelect={setGroup}
          />
          <Segment id="resolved" active={group} label={t('panel.resolved')} onSelect={setGroup} />
        </div>
        {error !== null && <span className="ts-chip is-overdue">{error}</span>}
      </div>

      {state === null && error === null && <div className="ts-empty">…</div>}

      {state !== null && (
        <section className="ts-section">
          <div className="ts-list">
            {rows.map((idea) => (
              <div className="ts-row" key={idea.id}>
                <span className="ts-title" title={idea.notes}>
                  {idea.title}
                </span>
                {idea.status === 'incubating' && !idea.verdict && (
                  <span className="ts-chip">{t('label.pendingVerdict')}</span>
                )}
                {idea.verdict !== undefined && (
                  <span className="ts-chip">{idea.verdict.result}</span>
                )}
                {group !== 'resolved' && (
                  <>
                    <button
                      type="button"
                      className="ts-button"
                      onClick={() => void act({ type: 'idea.complete', id: idea.id })}
                    >
                      {t('action.complete')}
                    </button>
                    <button
                      type="button"
                      className="ts-button"
                      onClick={() => void act({ type: 'idea.discard', id: idea.id })}
                    >
                      {t('action.discard')}
                    </button>
                  </>
                )}
                {group === 'resolved' &&
                  (idea.status === 'done' || idea.status === 'discarded') && (
                    <button
                      type="button"
                      className="ts-button"
                      onClick={() => void act({ type: 'idea.reopen', id: idea.id })}
                    >
                      {t('action.reopen')}
                    </button>
                  )}
              </div>
            ))}
            {rows.length === 0 && <div className="ts-empty">{t('label.empty')}</div>}
          </div>
        </section>
      )}
    </div>
  );
}

function Segment(props: {
  id: Group;
  active: Group;
  label: string;
  onSelect: (group: Group) => void;
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
