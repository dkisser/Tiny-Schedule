import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { AppData } from '@tiny-schedule/shared';
import { Type } from 'typebox';
import { getSummary, listMeta, queryTasks } from './chatTools';

export const CHAT_SYSTEM_PROMPT = `你是 Tiny Schedule 的效率分析助手。你可以用工具查询用户的任务、耗时与项目/标签数据，然后基于真实数据回答问题。
规则：
- 日期格式为 YYYY-MM-DD；用户说"今天""本周"时以当前日期为锚点换算。
- 回答使用简体中文，Markdown 格式，简洁。`;

interface TextToolResult {
  content: { type: 'text'; text: string }[];
  details: undefined;
}

function json(result: unknown): TextToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], details: undefined };
}

const queryTasksParams = Type.Object({
  from: Type.Optional(Type.String({ description: '起始日期 YYYY-MM-DD（按工作/完成时间过滤）' })),
  to: Type.Optional(Type.String({ description: '结束日期 YYYY-MM-DD（按工作/完成时间过滤）' })),
  dueFrom: Type.Optional(Type.String({ description: '截止日起始日 YYYY-MM-DD' })),
  dueTo: Type.Optional(Type.String({ description: '截止日结束日 YYYY-MM-DD' })),
  doneFrom: Type.Optional(Type.String({ description: '完成日起始日 YYYY-MM-DD' })),
  doneTo: Type.Optional(Type.String({ description: '完成日结束日 YYYY-MM-DD' })),
  projectId: Type.Optional(Type.String()),
  isDone: Type.Optional(Type.Boolean()),
});

const summaryParams = Type.Object({
  scope: Type.Union([Type.Literal('today'), Type.Literal('week'), Type.Literal('project')]),
  date: Type.Optional(Type.String({ description: '锚点日期，缺省为今天' })),
  projectId: Type.Optional(Type.String()),
});

const listMetaParams = Type.Object({});

export function buildChatTools(getData: () => AppData, today: () => string): AgentTool[] {
  const query: AgentTool<typeof queryTasksParams> = {
    name: 'queryTasks',
    label: '查询任务',
    description:
      '按条件查询任务列表及耗时。参数：from/to（工作/完成时间范围）、dueFrom/dueTo（截止日范围）、doneFrom/doneTo（完成日范围，查"某天完成了什么"用它）、projectId、isDone。日期均为 YYYY-MM-DD。',
    parameters: queryTasksParams,
    execute: async (_toolCallId, params) => json(queryTasks(getData(), params)),
  };

  const summary: AgentTool<typeof summaryParams> = {
    name: 'getSummary',
    label: '统计汇总',
    description:
      '聚合统计（任务数、完成数、总耗时、按项目/标签分布）。scope：today/week/project；project 范围必须提供 projectId。',
    parameters: summaryParams,
    execute: async (_toolCallId, params) =>
      json(getSummary(getData(), { ...params, date: params.date ?? today() })),
  };

  const meta: AgentTool<typeof listMetaParams> = {
    name: 'listProjects',
    label: '项目与标签',
    description: '列出所有项目与标签。',
    parameters: listMetaParams,
    execute: async () => json(listMeta(getData())),
  };

  return [query, summary, meta];
}
