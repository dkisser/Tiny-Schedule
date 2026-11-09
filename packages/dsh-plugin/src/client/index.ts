/**
 * dsh-plugin-tiny-schedule — browser half.
 *
 * Contributes two tabs to the conversation's view ring: 任务 (today /
 * quadrant / long term) and 想法 (inbox / validating / resolved).
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the ui-conversation SlotMap row ('conversation.view').
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import { en, NS, type TinyScheduleKey, zh } from './locales.ts';
import { injectStyles } from './styles.ts';
import { IdeasView } from './views/IdeasView.tsx';
import { TasksView } from './views/TasksView.tsx';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The plugin's copy. */
    tinySchedule: TinyScheduleKey;
  }
}

/** Required services: the conversation slot and the locale service. */
export const inject = ['slots', 'locale'];

/**
 * Client plugin body: register the two tabs.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  injectStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tiny-schedule: dictionaries');
  const t = ctx.locale.bind(NS);

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'tiny-schedule-tasks',
        order: 20,
        locale: NS,
        label: () => t('view.tasks'),
      },
      TasksView,
    ),
  );

  ctx.slots.inject('conversation.view', () =>
    ctx.slots.register(
      {
        name: 'conversation.view',
        id: 'tiny-schedule-ideas',
        order: 21,
        locale: NS,
        label: () => t('view.ideas'),
      },
      IdeasView,
    ),
  );
}
