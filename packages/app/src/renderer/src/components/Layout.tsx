import type { ReactNode } from 'react';

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
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}
