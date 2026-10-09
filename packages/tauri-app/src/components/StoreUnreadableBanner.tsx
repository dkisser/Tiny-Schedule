import type { StoreWritablePayload } from '@tiny-schedule/shared';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../api';

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
 * It names the file and the parse error because "保存失败，请重试" asks the user
 * to retry something that cannot succeed until they repair data.json by hand.
 *
 * Both halves of the ADR's mode channel are consumed here, and neither alone
 * is sufficient. The push (`onStoreWritable`) covers the transitions that
 * happen while the app is open — the user repairs the file, or deletes the
 * corrupt one. The pull (`storeWritable`) covers the mount case: a store that
 * latched read-only during startup will not change again, so there is no
 * transition for the push to report, and the banner would sit absent for the
 * exact condition it exists to announce.
 */
export function StoreUnreadableBanner() {
  // Null until answered, and treated as writable: rendering the banner before
  // anything is known would flash a read-only warning at every user whose
  // store is fine. The push answers synchronously on subscribe, so the state
  // is settled before the first paint that could show the banner.
  const [mode, setMode] = useState<StoreWritablePayload | null>(null);

  useEffect(() => {
    // StrictMode mounts, unmounts and remounts every effect in development.
    // `onStoreWritable` hands back a teardown, so the surviving mount cleans up
    // exactly what it installed and the listener list does not grow per mount.
    const off = api().onStoreWritable(setMode);
    let cancelled = false;
    void api()
      .storeWritable()
      .then((payload) => {
        if (!cancelled) setMode(payload);
      })
      .catch(() => {
        // The push already carries the current state, so a failed pull costs
        // nothing here — and failing loudly would put an error toast in front
        // of a user who is already being told their saves are not landing.
      });
    return () => {
      cancelled = true;
      off();
    };
  }, []);

  // Gated on `writable` alone. An earlier version also required a reason,
  // which meant the banner stayed invisible in the one case it exists for —
  // a store that latched at startup, before any write was attempted and so
  // before anything had pushed a reason. The parse error is worth showing but
  // is not a precondition for telling the user nothing is being saved.
  if (!mode || mode.writable) return null;

  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-amber-500/40 bg-amber-500/10 px-4 py-2 text-[13px] text-amber-600 dark:text-amber-400"
    >
      <AlertTriangle size={15} className="mt-0.5 shrink-0" aria-hidden />
      <div>
        <span className="font-medium">正在只读——你的修改不会被保存。</span>{' '}
        <span className="opacity-80">
          data.json
          当前无法读取，应用已停止写入以免覆盖你唯一的数据副本。请手动修复或恢复该文件，写入会在恢复后自动继续。
        </span>
        {mode.reason && (
          <div className="mt-0.5 font-mono text-[12px] opacity-70">{mode.reason}</div>
        )}
      </div>
    </div>
  );
}
