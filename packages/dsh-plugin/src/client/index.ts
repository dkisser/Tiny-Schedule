/**
 * dsh-plugin-tiny-schedule — browser half.
 *
 * The plugin's surface is one left-column entry above the session history.
 * Clicking it swaps the centre column for a page of the plugin's own: the
 * 任务 and 想法 tabs, exactly as they were before the surface moved.
 *
 * The harness ships this seam itself — a `sidebar.panellist` row selects a
 * `main` panel — so the plugin neither patches the shell's DOM nor occupies
 * the conversation column. See ADR 0010.
 */
import type { Context } from '@deepseek-ai/cordis';
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client';
// Type-only: pulls the layout plugin's Context merge (ctx.layout) and its
// SlotMap rows ('main').
import type {} from '@deepseek-ai/dsh-client-ui-layout/client';
// Type-only: pulls the renderer's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
// Type-only: pulls the sidebar's SlotMap row ('sidebar.panellist').
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client';
import { en, NS, type TinyScheduleKey, zh } from './locales.ts';
import { TrackerPage } from './page/TrackerPage.tsx';
import { TrackerPanelIcon } from './page/TrackerPanelIcon.tsx';
import { injectStyles } from './styles.ts';

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The plugin's copy. */
    tinySchedule: TinyScheduleKey;
  }
}

/**
 * The key shared by the left-column entry and the page it opens. The sidebar
 * selects a centre panel by this id, and the harness refuses to select a
 * panel the `main` slot does not hold — so both registrations must spell it
 * the same way.
 */
const PANEL_ID = 'tiny-schedule';

/** Required services: the slot registry, the locale service, the panel service. */
export const inject = ['slots', 'locale', 'layout'];

/**
 * Client plugin body: register the left-column entry and the page behind it.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  injectStyles();
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tiny-schedule: dictionaries');
  const t = ctx.locale.bind(NS);

  // The page: a keyed cell of the central panel. The conversation holds the
  // 'conversation' key, so this one sits beside it rather than replacing it.
  ctx.slots.inject('main', () =>
    ctx.slots.register(
      {
        name: 'main',
        key: PANEL_ID,
        locale: NS,
        inject: () => ({
          /** Hand the centre column back to the conversation. */
          onBack: () => ctx.layout.selectPanel(null),
        }),
      },
      TrackerPage,
    ),
  );

  // The entry: a row in the left column's panel list, which the harness draws
  // directly above the session history. Clicking it selects the page above.
  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      {
        name: 'sidebar.panellist',
        id: PANEL_ID,
        order: 20,
        locale: NS,
        label: () => t('panel.label'),
      },
      TrackerPanelIcon,
    ),
  );
}
