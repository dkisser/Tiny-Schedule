export interface MetaResult {
  projects: { id: string; title: string; isArchived: boolean }[];
  tags: { id: string; title: string }[];
}

export function listMeta(data: {
  projects: Record<string, { id: string; title: string; isArchived: boolean }>;
  tags: Record<string, { id: string; title: string }>;
}): MetaResult {
  return {
    projects: Object.values(data.projects).map((p) => ({
      id: p.id,
      title: p.title,
      isArchived: p.isArchived,
    })),
    tags: Object.values(data.tags).map((t) => ({ id: t.id, title: t.title })),
  };
}
