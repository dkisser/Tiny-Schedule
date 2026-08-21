import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * 受控输入的本地缓冲 + 防抖自动提交。
 *
 * 返回 `[value, setValue, flush]`：
 * - `value` 是当前显示在输入框里的本地状态。
 * - `setValue(next)` 立即更新本地状态，并在 `delay` ms 内没有新改动时把 `next` 提交给 `commit`。
 * - `flush()` 立即把当前待提交的值 commit 出去（组件 unmount 或 input onBlur 时调用）。
 *
 * 适用场景：表单字段被频繁编辑且希望切换上下文（切换任务/页面）时不丢字。
 * 沿用 `SettingsPage.tsx` 中 AI provider 草稿（500 ms setTimeout）的同款防抖节奏，
 * 但额外提供了 `flush()` 兜底 unmount 与 initial 变化时的提交。
 */
export function useDebouncedCommit<T>(
  initial: T,
  commit: (value: T) => void,
  delay = 400,
): readonly [T, (next: T) => void, () => void] {
  const [value, setValue] = useState<T>(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<T | null>(null);
  // 持有最新 commit 回调，避免 setValue 的 useEffect 依赖 commit 而导致不必要的重建。
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const flush = useCallback(() => {
    clearTimer();
    if (pendingRef.current !== null) {
      commitRef.current(pendingRef.current);
      pendingRef.current = null;
    }
  }, []);

  // 当外部 initial 变化（例如切换任务、数据从后端拉回），重置本地缓冲。
  useEffect(() => {
    setValue(initial);
    pendingRef.current = null;
    clearTimer();
    // 仅依赖 initial；value/commit 通过 ref 间接持有。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  // 组件卸载时把还没来得及提交的内容 flush 出去，防止切换上下文时丢字。
  useEffect(
    () => () => {
      clearTimer();
      if (pendingRef.current !== null) {
        commitRef.current(pendingRef.current);
        pendingRef.current = null;
      }
    },
    [],
  );

  const update = useCallback(
    (next: T) => {
      setValue(next);
      pendingRef.current = next;
      clearTimer();
      timerRef.current = setTimeout(() => {
        if (pendingRef.current !== null) {
          commitRef.current(pendingRef.current);
          pendingRef.current = null;
        }
        timerRef.current = null;
      }, delay);
    },
    [delay],
  );

  return [value, update, flush] as const;
}
