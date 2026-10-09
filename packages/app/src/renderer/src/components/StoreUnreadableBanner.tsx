import { AlertTriangle } from 'lucide-react';
import { useDataStore } from '../stores/data';

/**
 * The store is read-only: nothing typed into this app is being saved (ADR-0004).
 *
 * A banner rather than a toast, deliberately. The condition is a *mode* — it
 * lasts until the user repairs the file, not until the next write — and about
 * ten edit paths (every debounced title/notes commit, the task drag reorder)
 * have no caller that checks a return value. A per-write toast buried the one
 * real signal under a stack of identical ones; a latch could have merged them,
 * but that is a workaround for not having the state.
 *
 * It names the file and the parse error because "save failed, try again" asks
 * the user to retry something that cannot succeed until they repair data.json
 * by hand.
 */
export function StoreUnreadableBanner() {
  const writable = useDataStore((s) => s.storeWritable);
  const reason = useDataStore((s) => s.storeUnreadableReason);
  // Gated on `writable` alone. An earlier version also required a reason,
  // which meant the banner stayed invisible in the one case it exists for —
  // a store that latched at startup, before any write was attempted and so
  // before anything had pushed a reason. The parse error is worth showing but
  // is not a precondition for telling the user nothing is being saved.
  if (writable) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[13px] text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
      <div>
        <span className="font-medium">正在只读——你的修改不会被保存。</span>{' '}
        <span className="opacity-80">
          data.json
          当前无法读取，应用已停止写入以免覆盖你唯一的数据副本。请手动修复或恢复该文件，写入会在恢复后自动继续。
        </span>
        {reason && <div className="mt-0.5 font-mono text-[12px] opacity-70">{reason}</div>}
      </div>
    </div>
  );
}
