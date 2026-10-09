import { lazy, Suspense } from 'react';

/**
 * `MarkdownEditor`, loaded on demand.
 *
 * cherry-markdown is by far the largest dependency in the renderer — about
 * 5.4 MB of its ESM bundle before minification, more than everything else in
 * the app combined — and it is only needed once the user actually clicks
 * "编辑" on a note. Statically importing it put the whole of it in the entry
 * chunk, so every launch parsed several megabytes of editor code for a screen
 * that, in the common case, has no editor on it at all.
 *
 * `React.lazy` splits it into its own chunk, fetched at the moment the editor
 * first mounts. The wrapper keeps the same props, so the call sites change only
 * in which symbol they import.
 *
 * Lifecycle note: `React.lazy` and `Suspense` preserve the component's mount
 * and unmount semantics, which matters here because these callers flush
 * uncommitted edits from `onUnmount`. The editor mounts when the chunk
 * resolves rather than on the click, and unmounts exactly as before when the
 * surrounding panel goes away.
 */
const MarkdownEditor = lazy(() =>
  import('./MarkdownEditor').then((m) => ({ default: m.MarkdownEditor })),
);

type MarkdownEditorProps = React.ComponentProps<typeof MarkdownEditor>;

/**
 * Placeholder shown while the editor chunk is in flight. Deliberately quiet: it
 * occupies roughly the space the editor will, so the panel does not jump when
 * the real thing arrives.
 */
function EditorLoading(): React.JSX.Element {
  return (
    <div className="rounded-md border border-border p-2 text-sm text-muted-foreground">
      加载编辑器…
    </div>
  );
}

export function LazyMarkdownEditor(props: MarkdownEditorProps): React.JSX.Element {
  return (
    <Suspense fallback={<EditorLoading />}>
      <MarkdownEditor {...props} />
    </Suspense>
  );
}
