import { SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import { Bot, CalendarDays, Download, Inbox, Settings, Sun, Tag } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { useUiStore, type View } from '../stores/ui';

function NavItem({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50',
      )}
    >
      {children}
    </button>
  );
}

export function Sidebar() {
  const data = useDataStore((s) => s.data);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  if (!data) return null;

  const openCountByProject = new Map<string, number>();
  for (const t of Object.values(data.tasks)) {
    if (!t.isDone && !t.parentTaskId) {
      openCountByProject.set(t.projectId, (openCountByProject.get(t.projectId) ?? 0) + 1);
    }
  }
  const isActive = (v: View) =>
    v.type === view.type && ('id' in v ? v.id === (view as { id?: string }).id : true);
  const systemTagIds = Object.values(SYSTEM_TAG_IDS);
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const customTags = Object.values(data.tags).filter((t) => !systemTagIds.includes(t.id as never));

  return (
    <nav className="flex flex-col gap-1 p-2">
      <NavItem active={isActive({ type: 'today' })} onClick={() => setView({ type: 'today' })}>
        <Sun className="h-4 w-4" /> 今日
      </NavItem>
      <NavItem
        active={isActive({ type: 'upcoming' })}
        onClick={() => setView({ type: 'upcoming' })}
      >
        <CalendarDays className="h-4 w-4" /> Upcoming
      </NavItem>

      <div className="mt-3 px-2 text-xs font-medium text-muted-foreground">项目</div>
      {projects.map((p) => (
        <NavItem
          key={p.id}
          active={isActive({ type: 'project', id: p.id })}
          onClick={() => setView({ type: 'project', id: p.id })}
        >
          <Inbox className="h-4 w-4" />
          <span className="flex-1 truncate text-left">{p.title}</span>
          {(openCountByProject.get(p.id) ?? 0) > 0 && (
            <span className="rounded-full bg-secondary px-1.5 text-xs text-muted-foreground">
              {openCountByProject.get(p.id)}
            </span>
          )}
        </NavItem>
      ))}

      <div className="mt-3 px-2 text-xs font-medium text-muted-foreground">标签</div>
      {customTags.map((t) => (
        <NavItem
          key={t.id}
          active={isActive({ type: 'tag', id: t.id })}
          onClick={() => setView({ type: 'tag', id: t.id })}
        >
          <Tag className="h-4 w-4" style={t.color ? { color: t.color } : undefined} />
          <span className="truncate">{t.title}</span>
        </NavItem>
      ))}

      <div className="mt-3 border-t border-border pt-2">
        <NavItem active={isActive({ type: 'ai' })} onClick={() => setView({ type: 'ai' })}>
          <Bot className="h-4 w-4" /> AI 分析
        </NavItem>
        <NavItem active={isActive({ type: 'export' })} onClick={() => setView({ type: 'export' })}>
          <Download className="h-4 w-4" /> 导入 / 导出
        </NavItem>
        <NavItem
          active={isActive({ type: 'settings' })}
          onClick={() => setView({ type: 'settings' })}
        >
          <Settings className="h-4 w-4" /> 设置
        </NavItem>
      </div>
    </nav>
  );
}
