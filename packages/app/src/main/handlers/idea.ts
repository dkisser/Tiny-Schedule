import type { IdeaCommandResult, IdeaEdit } from '@tiny-schedule/shared';
import type { HandlerDeps } from './deps';
import { asCommand, masked } from './deps';

/**
 * 想法的 handler：写契约是意图命令集，所以这里的方法名就是领域语言。
 * 守卫（终态规则）全在 ideaService 里，handler 不复述任何一条。
 *
 * 每一条返回数据集的通道都要过 written()（它内部做 masked()）：渲染进程是跨 contextBridge 的
 * 不可信边界，service 返回的落库数据里带着每个 provider 的 apiKeyEncrypted
 * 密文。渲染进程会整份采纳命令结果，所以漏掉一次遮罩就是把密文送过去。
 */
export function ideaHandlers({ ideas }: HandlerDeps) {
  return {
    /** 字段编辑：请求只带非状态字段，合并由 service 完成。 */
    ideaUpsert: (patch: IdeaEdit) => masked(ideas.edit(patch)),

    ideaDelete: ({ id }: { id: string }) => masked(ideas.remove(id)),

    ideaComplete: ({ id }: { id: string }) => asCommand(ideas.complete(id)),

    ideaDiscard: ({ id }: { id: string }) => asCommand(ideas.discard(id)),

    ideaReopen: ({ id }: { id: string }) => asCommand(ideas.reopen(id)),

    ideaConvertToTask: ({ id, title }: { id: string; title?: string }) =>
      asCommand(ideas.convertToTask(id, title)),

    /**
     * 升级为项目：建项目与转状态在 service 内一次 store.update 完成，
     * 因此这里不存在"项目建好了但想法没转"的中间态。
     */
    ideaUpgradeToProject: (req: {
      id: string;
      title: string;
      icon?: string;
      primaryColor?: string;
      validationGoal?: string;
    }) => asCommand(ideas.upgradeToProject(req.id, req)),

    /** 追加/删除演进日志：也是命令,改的是主进程存的那条列表。 */
    ideaAddEntry: ({ id, text }: { id: string; text: string }) =>
      asCommand(ideas.addEntry(id, text)),

    ideaDeleteEntry: ({ id, entryId }: { id: string; entryId: string }) =>
      asCommand(ideas.deleteEntry(id, entryId)),

    ideaUpdateEntry: ({ id, entryId, text }: { id: string; entryId: string; text: string }) =>
      asCommand(ideas.updateEntry(id, entryId, text)),

    ideaCloseWithVerdict: ({
      id,
      result,
      text,
    }: {
      id: string;
      result: 'validated' | 'invalidated' | 'partial';
      text?: string;
    }): IdeaCommandResult => asCommand(ideas.closeWithVerdict(id, result, text)),
  };
}
