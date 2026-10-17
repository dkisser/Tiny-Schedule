/**
 * 运行记录变了——就这一件事的一个本进程信号。
 *
 * 存在的理由：运行记录**不进 AppData 之外的那条推送链路**，所以「立即运行」跑完之后
 * 没有任何数据集变化可以驱动运行历史重新拉取。界面那边靠 `stores/ui.ts` 的
 * `runsRevision` 计数器，而计数器需要一个东西去 bump 它。
 *
 * 为什么不是一个回调参数层层往下传：手动入口与调度器各自组装了一份 runtime
 * （`runtime.ts` 明说这两个入口必须共用同一份 in-flight 账本，也就是共用同一份接线），
 * 回调会要求两个组装点各自记得传，漏一个就是"定时触发的运行不刷新界面"这种只在无人
 * 时候才暴露的 bug。这里是一个叶子模块上的订阅表：runner 喊一声，界面听见了就重查。
 *
 * 载荷刻意是空的：界面要的不是"发生了什么"，而是"去重查"。谁在什么时候跑了什么，
 * 那是运行记录自己的事，重查一次就全知道了。
 */

export type RunsChangedListener = () => void;

const listeners = new Set<RunsChangedListener>();

/** 订阅运行记录的变化，返回退订。监听器抛错不影响其他监听器。 */
export function onRunsChanged(listener: RunsChangedListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 运行记录变了。快照一份再遍历：监听器可能在回调里退订自己。 */
export function emitRunsChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('scheduledTask: 运行记录变化监听器抛错', error);
    }
  }
}
