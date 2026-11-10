/**
 * The plugin's page: the whole surface, behind one left-column entry.
 *
 * The harness's centre column is either the conversation or a global panel.
 * This page is the plugin's global panel: the same two tabs the plugin used
 * to contribute to the conversation's view ring — 任务 and 想法 — each with
 * its own projection row, now inside the page instead of beside the chat.
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import { useState } from 'react';
import { IdeasView } from '../views/IdeasView.tsx';
import { TasksView } from '../views/TasksView.tsx';

/** The two domains the page shows, as before. */
type PageTab = 'tasks' | 'ideas';

/** How often the page re-reads the host's snapshot, in milliseconds. */
const POLL_MS = 30_000;

export type TrackerPageProps = PropsRuntime<'main'> &
  PropsLocale<'tinySchedule'> & {
    /** Hand the centre column back to the conversation. */
    onBack: () => void;
  };

/**
 * Render the plugin's page.
 * @param props - The panel's runtime share, the plugin's translator and the way back.
 * @returns The page tree.
 */
export function TrackerPage(props: TrackerPageProps): React.JSX.Element {
  const [tab, setTab] = useState<PageTab>('tasks');

  return (
    <section className="ts-page" aria-label={props.t('panel.label')}>
      <header className="ts-page-head">
        <div className="ts-segments" role="tablist">
          <button
            type="button"
            role="tab"
            className="ts-segment"
            aria-selected={tab === 'tasks'}
            onClick={() => setTab('tasks')}
          >
            {props.t('view.tasks')}
          </button>
          <button
            type="button"
            role="tab"
            className="ts-segment"
            aria-selected={tab === 'ideas'}
            onClick={() => setTab('ideas')}
          >
            {props.t('view.ideas')}
          </button>
        </div>
        <button type="button" className="ts-button" onClick={props.onBack}>
          {props.t('page.back')}
        </button>
      </header>

      <div className="ts-page-body" role="tabpanel">
        {tab === 'tasks' ? (
          <TasksView t={props.t} pollMs={POLL_MS} />
        ) : (
          <IdeasView t={props.t} pollMs={POLL_MS} />
        )}
      </div>
    </section>
  );
}
