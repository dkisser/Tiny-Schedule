import type { ReactNode } from 'react';
import { StoreUnreadableBanner } from './StoreUnreadableBanner';

export function Layout({
  sidebar,
  timerBar,
  children,
}: {
  sidebar: ReactNode;
  timerBar: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-60 shrink-0 border-r border-border bg-muted/30 overflow-y-auto">
        {sidebar}
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="shrink-0 border-b border-border">{timerBar}</div>
        {/* Global, not per-page: the store being unwritable applies to every
            edit path in the app, so it is announced once above the content
            rather than inside whichever view happens to be open. */}
        <StoreUnreadableBanner />
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
