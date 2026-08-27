import { hasProjectColor, INBOX_PROJECT_ID, SYSTEM_TAG_IDS } from '@tiny-schedule/shared';
import {
  Archive,
  ArchiveRestore,
  Bot,
  CalendarDays,
  ChevronRight,
  Download,
  Inbox,
  Pencil,
  Plus,
  Settings,
  Sun,
  Tag,
  Trash2,
} from 'lucide-react';
import { type KeyboardEvent, type ReactNode, useState } from 'react';
import { cn } from '../lib/utils';
import { useDataStore } from '../stores/data';
import { type SidebarGroup, useUiStore, type View } from '../stores/ui';
import { ProjectColorPicker } from './ProjectColorPicker';
import { Button } from './ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui/collapsible';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog';
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
  // Rendered as a div with role="button" (instead of <button>) so it can host
  // nested interactive content such as the project's color picker trigger.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onClick();
    }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm',
        active ? 'bg-accent text-accent-foreground font-medium' : 'hover:bg-accent/50',
      )}
    >
      {children}
    </div>
  );
}

type EntityRef = { group: SidebarGroup; id: string; title: string };

export function Sidebar() {
  const data = useDataStore((s) => s.data);
  const createProject = useDataStore((s) => s.createProject);
  const updateProject = useDataStore((s) => s.updateProject);
  const deleteProject = useDataStore((s) => s.deleteProject);
  const createTag = useDataStore((s) => s.createTag);
  const updateTag = useDataStore((s) => s.updateTag);
  const deleteTag = useDataStore((s) => s.deleteTag);
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const collapsedGroups = useUiStore((s) => s.collapsedGroups);
  const toggleSidebarGroup = useUiStore((s) => s.toggleSidebarGroup);
  const [creating, setCreating] = useState<SidebarGroup | null>(null);
  const [draft, setDraft] = useState('');
  const [renaming, setRenaming] = useState<EntityRef | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<EntityRef | null>(null);
  if (!data) return null;

  const openCountByProject = new Map<string, number>();
  const taskCountByProject = new Map<string, number>();
  for (const t of Object.values(data.tasks)) {
    if (t.parentTaskId) continue;
    taskCountByProject.set(t.projectId, (taskCountByProject.get(t.projectId) ?? 0) + 1);
    if (!t.isDone) {
      openCountByProject.set(t.projectId, (openCountByProject.get(t.projectId) ?? 0) + 1);
    }
  }
  const isActive = (v: View) =>
    v.type === view.type && ('id' in v ? v.id === (view as { id?: string }).id : true);
  const systemTagIds = Object.values(SYSTEM_TAG_IDS);
  const projects = Object.values(data.projects).filter((p) => !p.isArchived);
  const archivedProjects = Object.values(data.projects).filter((p) => p.isArchived);
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

  const beginRename = (e: EntityRef) => {
    setRenaming(e);
    setRenameDraft(e.title);
  };

  const submitRename = async () => {
    const title = renameDraft.trim();
    const target = renaming;
    setRenaming(null);
    setRenameDraft('');
    if (!target || !title || title === target.title) return;
    if (target.group === 'projects') await updateProject(target.id, { title });
    else await updateTag(target.id, title);
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    setDeleteTarget(null);
    if (!target) return;
    if ('id' in view && view.id === target.id) setView({ type: 'today' });
    if (target.group === 'projects') await deleteProject(target.id);
    else await deleteTag(target.id);
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

  const renameInput = (
    <Input
      autoFocus
      value={renameDraft}
      placeholder="名称，回车确认"
      onChange={(e) => setRenameDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') void submitRename();
        if (e.key === 'Escape') {
          setRenaming(null);
          setRenameDraft('');
        }
      }}
      onBlur={() => void submitRename()}
    />
  );

  const rowActions = (e: EntityRef, deletable: boolean) => (
    <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-accent group-hover/row:flex">
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label="改名"
        className="text-muted-foreground hover:text-foreground"
        onClick={(ev) => {
          ev.stopPropagation();
          beginRename(e);
        }}
      >
        <Pencil />
      </Button>
      {deletable && (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="删除"
          className="text-muted-foreground hover:text-destructive"
          onClick={(ev) => {
            ev.stopPropagation();
            setDeleteTarget(e);
          }}
        >
          <Trash2 />
        </Button>
      )}
    </div>
  );

  // Projects get an Archive button (hides from sidebar but keeps stats).
  // Inbox is a system project and is never archivable.
  const projectRowActions = (e: EntityRef, archivable: boolean) => {
    const project = data?.projects[e.id];
    const archived = !!project?.isArchived;
    const onArchiveToggle = (ev: { stopPropagation: () => void }) => {
      ev.stopPropagation();
      void updateProject(e.id, { isArchived: !archived });
    };
    return (
      <div className="absolute right-1 top-1/2 hidden -translate-y-1/2 items-center gap-0.5 rounded-md bg-accent group-hover/row:flex">
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="改名"
          className="text-muted-foreground hover:text-foreground"
          onClick={(ev) => {
            ev.stopPropagation();
            beginRename(e);
          }}
        >
          <Pencil />
        </Button>
        {archivable && (
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={archived ? '恢复项目' : '归档项目'}
            className="text-muted-foreground hover:text-foreground"
            onClick={onArchiveToggle}
          >
            {archived ? <ArchiveRestore /> : <Archive />}
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label="删除"
          className="text-muted-foreground hover:text-destructive"
          onClick={(ev) => {
            ev.stopPropagation();
            setDeleteTarget(e);
          }}
        >
          <Trash2 />
        </Button>
      </div>
    );
  };

  const header = (group: SidebarGroup, title: string, addLabel: string) => (
    <div className="group mt-3 flex items-center">
      <CollapsibleTrigger className="group/trig flex flex-1 items-center gap-1 px-2 text-xs font-medium text-muted-foreground hover:text-foreground">
        <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]/trig:rotate-90" />
        {title}
      </CollapsibleTrigger>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={addLabel}
        onClick={() => beginCreate(group)}
        className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"
      >
        <Plus />
      </Button>
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
              <div key={p.id} className="group/row relative">
                {renaming?.group === 'projects' && renaming.id === p.id ? (
                  renameInput
                ) : (
                  <NavItem
                    active={isActive({ type: 'project', id: p.id })}
                    onClick={() => setView({ type: 'project', id: p.id })}
                  >
                    {p.id === INBOX_PROJECT_ID ? (
                      <Inbox className="h-4 w-4" />
                    ) : (
                      <ProjectColorPicker projectId={p.id} currentColor={p.primaryColor}>
                        <button
                          type="button"
                          aria-label={
                            hasProjectColor(p.primaryColor) ? '更改项目颜色' : '设置项目颜色'
                          }
                          // Prevent the picker click from also triggering the
                          // parent NavItem's onClick (route change).
                          onClick={(e) => e.stopPropagation()}
                          className={cn(
                            'h-4 w-4 shrink-0 rounded-[3px] border transition-opacity focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background',
                            hasProjectColor(p.primaryColor)
                              ? 'border-foreground/25'
                              : 'border-dashed border-muted-foreground/40 opacity-0 group-hover/row:opacity-100',
                          )}
                          style={
                            hasProjectColor(p.primaryColor)
                              ? { backgroundColor: p.primaryColor }
                              : undefined
                          }
                        />
                      </ProjectColorPicker>
                    )}
                    <span className="flex-1 truncate text-left">{p.title}</span>
                    {(openCountByProject.get(p.id) ?? 0) > 0 && (
                      <span className="rounded-full bg-secondary px-1.5 text-xs text-muted-foreground">
                        {openCountByProject.get(p.id)}
                      </span>
                    )}
                  </NavItem>
                )}
                {projectRowActions(
                  { group: 'projects', id: p.id, title: p.title },
                  p.id !== INBOX_PROJECT_ID,
                )}
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>

      {archivedProjects.length > 0 && (
        <Collapsible
          open={!collapsedGroups.archived}
          onOpenChange={() => toggleSidebarGroup('archived')}
        >
          {header('archived', `已归档 (${archivedProjects.length})`, '')}
          <CollapsibleContent>
            <div className="flex flex-col gap-1 pt-1">
              {archivedProjects.map((p) => (
                <div key={p.id} className="group/row relative">
                  {renaming?.group === 'projects' && renaming.id === p.id ? (
                    renameInput
                  ) : (
                    <NavItem
                      active={isActive({ type: 'project', id: p.id })}
                      onClick={() => setView({ type: 'project', id: p.id })}
                    >
                      <Archive className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="flex-1 truncate text-left text-muted-foreground">
                        {p.title}
                      </span>
                    </NavItem>
                  )}
                  {projectRowActions({ group: 'projects', id: p.id, title: p.title }, true)}
                </div>
              ))}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}

      <Collapsible open={!collapsedGroups.tags} onOpenChange={() => toggleSidebarGroup('tags')}>
        {header('tags', '标签', '新建标签')}
        <CollapsibleContent>
          <div className="flex flex-col gap-1 pt-1">
            {creating === 'tags' && createInput}
            {customTags.map((t) => (
              <div key={t.id} className="group/row relative">
                {renaming?.group === 'tags' && renaming.id === t.id ? (
                  renameInput
                ) : (
                  <NavItem
                    active={isActive({ type: 'tag', id: t.id })}
                    onClick={() => setView({ type: 'tag', id: t.id })}
                  >
                    <Tag className="h-4 w-4" style={t.color ? { color: t.color } : undefined} />
                    <span className="truncate">{t.title}</span>
                  </NavItem>
                )}
                {rowActions({ group: 'tags', id: t.id, title: t.title }, true)}
              </div>
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

      <Dialog open={deleteTarget !== null} onOpenChange={(o) => !o && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              删除{deleteTarget?.group === 'projects' ? '项目' : '标签'}「{deleteTarget?.title}」？
            </DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            {deleteTarget?.group === 'projects'
              ? `该项目下 ${taskCountByProject.get(deleteTarget.id) ?? 0} 个任务将移入 Inbox，任务上显示的项目名保持不变。`
              : '任务上已显示的历史标签名会保留，仅从侧栏移除该标签。'}
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </nav>
  );
}
