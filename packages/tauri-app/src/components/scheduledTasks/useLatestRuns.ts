import type { ScheduledTaskRun } from '@tiny-schedule/shared';
import { useEffect, useState } from 'react';
import { useDataStore } from '@/stores/data';
import { useUiStore } from '@/stores/ui';

/**
 * 一批定时任务各自**最近一次运行**。
 *
 * 运行记录不进 AppData（它只会一直增长），所以列表页要显示"最近一次运行的状态"，
 * 就得按任务逐个查一次。这里只保留每组的第一条——接口已经按最新在前返回，多拿的
 * 那些只是为了排序，读回来就丢掉。
 *
 * 单个任务查失败不影响其它行：这一行显示"还没有运行记录"，而不是把整页清空。查不到
 * 历史与没有历史在这里被说成同一件事，因为就列表这一列的信息量而言，它们确实没有区别
 * （详情面板里才是要看清区别的地方）。
 */
export function useLatestRuns(taskIds: string[]): Map<string, ScheduledTaskRun | null> {
  const listScheduledTaskRuns = useDataStore((s) => s.listScheduledTaskRuns);
  const runsRevision = useUiStore((s) => s.runsRevision);
  // 任务集合用一个字符串做依赖：数组每次渲染都是新引用，逐个 id 进依赖会让这个 effect
  // 每帧重跑一次，把按任务发起的查询也变成每帧一次。
  const key = taskIds.join(',');
  const [latest, setLatest] = useState<Map<string, ScheduledTaskRun | null>>(new Map());

  useEffect(() => {
    const ids = key === '' ? [] : key.split(',');
    if (ids.length === 0) {
      setLatest(new Map());
      return;
    }
    let cancelled = false;
    void Promise.all(
      ids.map(async (id): Promise<readonly [string, ScheduledTaskRun | null]> => {
        try {
          const runs = await listScheduledTaskRuns(id);
          return [id, runs[0] ?? null];
        } catch {
          return [id, null];
        }
      }),
    ).then((entries) => {
      if (!cancelled) setLatest(new Map(entries));
    });
    return () => {
      cancelled = true;
    };
  }, [key, runsRevision, listScheduledTaskRuns]);

  return latest;
}
