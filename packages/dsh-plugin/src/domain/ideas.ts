/**
 * The idea lifecycle.
 *
 * An idea is a separate domain from tasks: it never takes part in timing or
 * in the today view. Its only exits are into a task, into "done", into
 * "discarded", or — when it was upgraded to a dedicated project — into a
 * verdict.
 *
 *   open ──► incubating ──► closed          (a verdict was given)
 *     │           │
 *     │           └──► converted            (became a task)
 *     ├──► done
 *     └──► discarded                        (both reopenable)
 */
import type { IdeaEntry, IdeaRecord, IdeaStatus, IdeaVerdict } from './schema.ts';

/** Resolved states: the idea will not move again on its own. */
export const RESOLVED_STATUSES: readonly IdeaStatus[] = [
  'done',
  'discarded',
  'converted',
  'closed',
];

export function newIdeaId(now = Date.now()): string {
  return `i_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function blankIdea(title: string, now = Date.now()): IdeaRecord {
  return {
    id: newIdeaId(now),
    title,
    notes: '',
    createdAt: now,
    status: 'open',
  };
}

/** The inbox: untouched ideas, newest first. */
export function openIdeas(ideas: IdeaRecord[]): IdeaRecord[] {
  return ideas.filter((i) => i.status === 'open').sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Awaiting a verdict: incubating, without a verdict, and its project has been
 * archived. Restoring the project retires the flag on its own.
 */
export function ideaPendingVerdict(
  idea: IdeaRecord,
  projects: Record<string, { isArchived: boolean }>,
): boolean {
  return (
    idea.status === 'incubating' &&
    !idea.verdict &&
    idea.projectId !== undefined &&
    projects[idea.projectId]?.isArchived === true
  );
}

/** The idea a dedicated project belongs to (one-to-one). */
export function ideaByProjectId(ideas: IdeaRecord[], projectId: string): IdeaRecord | undefined {
  return ideas.find((i) => i.projectId === projectId);
}

/** Open tasks of the idea's dedicated project. */
export function ideaProjectOpenTaskCount(
  tasks: { projectId: string; parentTaskId?: string; isDone: boolean }[],
  projectId: string,
): number {
  return tasks.filter((t) => t.projectId === projectId && !t.parentTaskId && !t.isDone).length;
}

/** The latest activity of an incubating idea: its newest log entry, or when it was upgraded. */
function ideaActivityAt(idea: IdeaRecord): number {
  const latestEntry = idea.timeline?.reduce((m, e) => Math.max(m, e.createdAt), 0) ?? 0;
  return Math.max(latestEntry, idea.incubatedAt ?? 0);
}

/** Incubating ideas: awaiting a verdict first, then by recent activity. */
export function incubatingIdeas(
  ideas: IdeaRecord[],
  projects: Record<string, { isArchived: boolean }>,
): IdeaRecord[] {
  return ideas
    .filter((i) => i.status === 'incubating')
    .sort((a, b) => {
      const pa = ideaPendingVerdict(a, projects);
      const pb = ideaPendingVerdict(b, projects);
      if (pa !== pb) return pa ? -1 : 1;
      return ideaActivityAt(b) - ideaActivityAt(a);
    });
}

/** Resolved ideas, newest resolution first (converted rows fall back to convertedAt). */
export function resolvedIdeas(ideas: IdeaRecord[]): IdeaRecord[] {
  return ideas
    .filter((i) => RESOLVED_STATUSES.includes(i.status))
    .sort((a, b) => (b.resolvedAt ?? b.convertedAt ?? 0) - (a.resolvedAt ?? a.convertedAt ?? 0));
}

/** Directly completed — a note of the day, the weather, anything. */
export function completeIdea(idea: IdeaRecord, now = Date.now()): IdeaRecord {
  return { ...idea, status: 'done', resolvedAt: now };
}

/** Dropped as unnecessary; reopenable. */
export function discardIdea(idea: IdeaRecord, now = Date.now()): IdeaRecord {
  return { ...idea, status: 'discarded', resolvedAt: now };
}

/** Reopened — only done and discarded ideas may return to the inbox. */
export function reopenIdea(idea: IdeaRecord): IdeaRecord {
  if (idea.status !== 'done' && idea.status !== 'discarded') return idea;
  return { ...idea, status: 'open', resolvedAt: undefined };
}

/** Upgraded to a dedicated project and now under validation. */
export function upgradeIdeaToProject(
  idea: IdeaRecord,
  projectId: string,
  validationGoal?: string,
  now = Date.now(),
): IdeaRecord {
  return {
    ...idea,
    status: 'incubating',
    projectId,
    validationGoal: validationGoal || undefined,
    incubatedAt: now,
  };
}

/** Append a note to the evolution log. */
export function appendIdeaEntry(idea: IdeaRecord, text: string, now = Date.now()): IdeaRecord {
  const entry: IdeaEntry = { id: newIdeaId(now), createdAt: now, text };
  return { ...idea, timeline: [...(idea.timeline ?? []), entry] };
}

/** Rewrite one log entry. */
export function updateIdeaEntry(idea: IdeaRecord, entryId: string, text: string): IdeaRecord {
  return {
    ...idea,
    timeline: (idea.timeline ?? []).map((e) => (e.id === entryId ? { ...e, text } : e)),
  };
}

/** Drop one log entry. */
export function deleteIdeaEntry(idea: IdeaRecord, entryId: string): IdeaRecord {
  return { ...idea, timeline: (idea.timeline ?? []).filter((e) => e.id !== entryId) };
}

/**
 * Give a verdict. An incubating idea becomes closed; an already closed idea
 * keeps its state and only its verdict changes.
 */
export function closeIdeaWithVerdict(
  idea: IdeaRecord,
  result: IdeaVerdict['result'],
  text?: string,
  now = Date.now(),
): IdeaRecord {
  const verdict: IdeaVerdict = { result, text: text || undefined, closedAt: now };
  if (idea.status === 'closed') return { ...idea, verdict };
  return { ...idea, status: 'closed', verdict, resolvedAt: now };
}
