import { SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import {
  Bot,
  CalendarDays,
  ChevronRight,
  Download,
  Inbox,
  Plus,
  Settings,
  Sun,
  Tag,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { type SidebarGroup, useUiStore, type View } from '../stores/ui';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Input } from './ui/input';

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
  const createProject = useDataStore((s) => s.createProject);
  const createTag = useDataStore((s) => s.createTag);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const collapsedGroups = useUiStore((s) => s.collapsedGroups);
  const toggleSidebarGroup = useUiStore((s) => s.toggleSidebarGroup);
  const [creating, setCreating] = useState<SidebarGroup | null>(null);
  const [draft, setDraft] = useState('');
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

  const beginCreate = (group: SidebarGroup) => {
    setDraft('');
    setCreating(group);
    if (collapsedGroups[group]) toggleSidebarGroup(group);
  };

  const submitCreate = async () => {
    const title = draft.trim();
    const group = creating;
    setCreating(null);
    setDraft('');
    if (!group || !title) return;
    if (group === 'projects') await createProject(title);
    else await createTag(title);
  };

  const cancelCreate = () => {
    setCreating(null);
    setDraft('');
  };

  const createInput = (
    <Input
      autoFocus
      value={draft}
      placeholder="名称，回车确认"
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submitCreate();
        if (e.key === 'Escape') cancelCreate();
      }}
      onBlur={() => {
        if (draft.trim()) void submitCreate();
        else cancelCreate();
      }}
    />
  );

  const header = (group: SidebarGroup, title: string, addLabel: string) => (
    <div className="group mt-3 flex items-center">
      <CollapsibleTrigger className="group/trig flex flex-1 items-center gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]/trig:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <button
        type="button"
        aria-label={addLabel}
        onClick={() => beginCreate(group)}
        className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
      >
        <Plus className="h-3.5 w-3.5" />
      </button>
    </div>
  );

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

      <Collapsible
        open={!collapsedGroups.projects}
        onOpenChange={() => toggleSidebarGroup('projects')}
      >
        {header('projects', '项目', '新建项目')}
        <CollapsibleContent>
          <div className="flex flex-col gap-1 pt-1">
            {creating === 'projects' && createInput}
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
          </div>
        </CollapsibleContent>
      </Collapsible>

      <Collapsible open={!collapsedGroups.tags} onOpenChange={() => toggleSidebarGroup('tags')}>
        {header('tags', '标签', '新建标签')}
        <CollapsibleContent>
          <div className="flex flex-col gap-1 pt-1">
            {creating === 'tags' && createInput}
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
          </div>
        </CollapsibleContent>
      </Collapsible>

      <div className="mt-3 border-t border-border pt-2">
        <NavItem active={isActive({ type: 'ai' })} onClick={() => setView({ type: 'ai' })}>
          <Bot className="h-4 w-4" /> 分析
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
