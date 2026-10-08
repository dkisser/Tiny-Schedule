/**
 * 想法命令被主进程拒绝时的提示文案。
 *
 * 领域拒绝不是异常：主进程把"这次转移不合法"作为 { ok:false, error } 正常返回
 * （ADR-0003），所以这里只负责把它翻译成人话，调用方统一 toast.error。
 */
const MESSAGES: Record<string, string> = {
  IDEA_NOT_FOUND: '这个想法已不存在',
  IDEA_NOT_IN_OPEN: '只有收集箱里的想法才能这样处理',
  IDEA_NOT_REOPENABLE: '已转任务或已闭环的想法不能重新打开',
  IDEA_NOT_CLOSABLE: '只有验证中的想法才能给出结论',
};

export function ideaRejectionMessage(error: string): string {
  return MESSAGES[error] ?? '操作未生效，请重试';
}

/**
 * 跟进命令被主进程拒绝时的提示文案。同上：拒绝是正常返回值（ADR-0003），
 * 不是异常，所以只负责翻译，调用方统一 toast.error。
 */
const FOLLOW_UP_MESSAGES: Record<string, string> = {
  FOLLOW_UP_NOT_FOUND: '这个跟进已不存在',
};

export function followUpRejectionMessage(error: string): string {
  return FOLLOW_UP_MESSAGES[error] ?? '操作未生效，请重试';
}
