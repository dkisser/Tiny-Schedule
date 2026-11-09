import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { emptyAppData, IpcInvokeContract } from '@tiny-schedule/shared';
import { useUiStore } from '@/stores/ui';
import { SHOW_SCHEDULED_TASKS_ENTRY } from './features';

/**
 * 定时任务的入口暂时收起，但功能没删——这三件事各自需要一道闸，因为它们坏掉的
 * 方式完全不同，而且坏掉时都**没有症状**：
 *
 * 1. **入口不再出现在面板上。** 这条是用户看得见的那一件：收起之后侧栏不该再有
 *    「定时任务」这一项。
 * 2. **功能没被删。** 视图类型、页面、IPC 通道、数据模型都还在原处。删掉其中
 *    任何一样，恢复入口的那一刻就会发现点不动了——而那时入口早就被藏了很久，
 *    谁也不会记得是哪儿删的。
 * 3. **运行时没被顺手关掉。** 调度器与界面无关：入口藏起来，已配置的定时任务
 *    照样到点触发、照样落运行记录、照样发系统通知。真正的回归不是"任务不跑了"
 *    （那个有症状），而是"任务还在跑，但界面上再也看不到它的运行记录"。
 *
 * 第 1 条靠读源码判定：仓库里没有 DOM 测试基建（无 testing-library / jsdom，
 * 也没有任何 `.test.tsx`），而"某个视图有没有入口"恰恰是渲染层的事实。为此
 * 引入一套 DOM 测试栈来断言一行文本，是拿一个新工具链换一个本可静态判定的事实。
 * 这里的做法与 `scripts/check-ipc-literals.ts` 同源——扫描源码，判定跨文件的
 * 结构事实。
 */

/** renderer 源码根目录（`src/lib/features.test.ts` → `src/`）。 */
const SRC_DIR = new URL('../', import.meta.url).pathname;

/**
 * 「导航到定时任务视图」的唯一写法。
 *
 * 白名单只认这一种形式：`setView({ type: 'scheduledTasks' })`。侧栏之外没有别
 * 的入口，Rust 侧也没有菜单项或深链接指向它——`setView` 是渲染进程里唯一能换
 * 视图的手段，所以这个匹配覆盖了全部可能的导航路径。
 */
const NAVIGATE_TO_SCHEDULED_TASKS = /setView\(\s*\{\s*type:\s*'scheduledTasks'/;

/** 递归收集 renderer 的全部源码文件。 */
function collectSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...collectSourceFiles(full));
    else if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('定时任务入口暂时收起', () => {
  test('入口当前是收起的', () => {
    // 这个常量就是「收起」这个决定本身。恢复入口 = 把它改回 true（见
    // `features.ts` 的注释）。钉住当前值，是为了让"顺手改成 true"变成一次
    // 需要连带改测试的动作，而不是一次无声的改动。
    expect(SHOW_SCHEDULED_TASKS_ENTRY).toBe(false);
  });

  test('除侧栏外没有别的地方导航到定时任务视图', () => {
    // 侧栏那一处被 `SHOW_SCHEDULED_TASKS_ENTRY` 挡住了，所以它不算一个可见入口。
    // 任何**别的**文件若也开始导航过去，就说明入口被复制了一份——那正是"收起"
    // 失效的方式，而且失效得很安静：多出来的那一份照样能点。
    const offenders = collectSourceFiles(SRC_DIR)
      .filter((file) => !file.endsWith('.test.ts') && !file.endsWith('.test.tsx'))
      .filter((file) => NAVIGATE_TO_SCHEDULED_TASKS.test(readFileSync(file, 'utf8')))
      .filter((file) => !readFileSync(file, 'utf8').includes('SHOW_SCHEDULED_TASKS_ENTRY'));

    expect(offenders).toEqual([]);
  });

  test('视图类型仍然接受定时任务', () => {
    // 视图联合类型里还有这一项，`setView` 仍然接受它——恢复入口的前提。
    //
    // `setView` 顺带清空四个选中项，所以这里存的是整份选中状态而不是只有
    // `view`：只还原 `view` 会把别的用例留下的 `selectedTaskId` 抹掉，而那
    // 属于跨用例的污染——本文件不该改坏别人的状态。
    const before = useUiStore.getState();
    before.setView({ type: 'scheduledTasks' });
    expect(useUiStore.getState().view).toEqual({ type: 'scheduledTasks' });

    useUiStore.setState({
      view: before.view,
      selectedTaskId: before.selectedTaskId,
      selectedFollowUpId: before.selectedFollowUpId,
      selectedIdeaId: before.selectedIdeaId,
      selectedScheduledTaskId: before.selectedScheduledTaskId,
    });
  });

  test('App 仍然把定时任务视图路由到定时任务页', () => {
    // 页面还在、路由还在。这条不许因为"入口收起了"而被顺手删掉：入口收起与
    // 功能删除是两件不同的事，删了页面就再也回不来了。
    const app = readFileSync(join(SRC_DIR, 'App.tsx'), 'utf8');
    expect(app).toMatch(/view\.type === 'scheduledTasks'/);
    expect(app).toMatch(/<ScheduledTasksPage\s*\/>/);
  });

  test('IPC 契约里的定时任务通道一个不少', () => {
    // 六个通道（增删改查、运行记录读写、立即运行）都在。契约是渲染进程与主进程
    // 之间的唯一约定，删掉任何一条，恢复入口之后点「立即运行」就会撞到一个
    // 不存在的通道。
    const scheduledChannels = Object.keys(IpcInvokeContract).filter((key) =>
      key.startsWith('scheduledTask'),
    );
    expect(scheduledChannels.sort()).toEqual([
      'scheduledTaskDelete',
      'scheduledTaskRunAdd',
      'scheduledTaskRunFinish',
      'scheduledTaskRunNow',
      'scheduledTaskRunsList',
      'scheduledTaskUpsert',
    ]);
  });

  test('数据模型仍然带着定时任务', () => {
    // 数据没被顺手清掉：空数据集里这一项仍在，导入导出照旧能带上它们。
    expect(emptyAppData().scheduledTasks).toEqual({});
  });
});
