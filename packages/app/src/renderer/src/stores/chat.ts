import type { ChatSession } from '@tiny-schedule/shared';
import { Ipc } from '@tiny-schedule/shared';
import { create } from 'zustand';
import { api } from '../api';

export type ChatRunStatus = 'idle' | 'running' | 'retrying' | 'failed';

export interface ToolCard {
  toolCallId: string;
  name: string;
  status: 'running' | 'done' | 'error';
  args?: unknown;
  resultSummary?: string;
}

interface ChatState {
  sessions: ChatSession[];
  activeSessionId: string | null;
  streamText: string;
  toolCards: ToolCard[];
  status: ChatRunStatus;
  statusDetail: string; // retrying: "重试中 1/2"；failed: 错误原因
  requestId: string | null;
  load: () => Promise<void>;
  create: () => Promise<string>;
  remove: (id: string) => Promise<void>;
  select: (id: string) => void;
  send: (text: string) => Promise<void>;
  retry: () => Promise<void>;
  stop: () => Promise<void>;
}

export const useChatStore = create<ChatState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  streamText: '',
  toolCards: [],
  status: 'idle',
  statusDetail: '',
  requestId: null,

  load: async () => {
    const sessions = await api().chatSessionsList();
    set((s) => ({
      sessions,
      activeSessionId: s.activeSessionId ?? sessions[0]?.id ?? null,
    }));
  },

  create: async () => {
    const session = await api().chatSessionCreate({});
    set((s) => ({ sessions: [session, ...s.sessions], activeSessionId: session.id }));
    return session.id;
  },

  remove: async (id) => {
    const sessions = await api().chatSessionDelete({ sessionId: id });
    set((s) => ({
      sessions,
      activeSessionId: s.activeSessionId === id ? (sessions[0]?.id ?? null) : s.activeSessionId,
    }));
  },

  select: (id) =>
    set({ activeSessionId: id, streamText: '', toolCards: [], status: 'idle', statusDetail: '' }),

  send: async (text) => {
    // 防重复发送：manager 拒绝并发 run，run 进行中直接忽略新的 send
    if (get().status === 'running') return;
    let { activeSessionId } = get();
    if (!activeSessionId) activeSessionId = await get().create();
    set({ streamText: '', toolCards: [], status: 'running', statusDetail: '' });
    const res = await api().chatSend({ sessionId: activeSessionId, text });
    if ('error' in res) {
      set({
        status: 'failed',
        statusDetail: res.error === 'NO_PROVIDER_CONFIGURED' ? '尚未配置 AI Provider' : res.error,
      });
      return;
    }
    set({ requestId: res.requestId });
  },

  // 失败后重试：走 chat:continue，不新增 user 消息（真正的 continue，而非再次 send）
  retry: async () => {
    if (get().status === 'running') return;
    const { activeSessionId } = get();
    if (!activeSessionId) return;
    set({ streamText: '', toolCards: [], status: 'running', statusDetail: '' });
    const res = await api().chatContinue({ sessionId: activeSessionId });
    if ('error' in res) {
      set({
        status: 'failed',
        statusDetail: res.error === 'NO_PROVIDER_CONFIGURED' ? '尚未配置 AI Provider' : res.error,
      });
      return;
    }
    set({ requestId: res.requestId });
  },

  stop: async () => {
    const id = get().activeSessionId;
    if (id) await api().chatStop({ sessionId: id });
    set({ status: 'idle' });
  },
}));

/** 订阅 chat 事件；返回取消函数。在 ChatView 挂载时调用一次。 */
export function subscribeChatEvents(): () => void {
  return api().onChatEvent((ev) => {
    const st = useChatStore.getState();
    const sessionId = st.activeSessionId;
    const p = ev.payload as { sessionId?: string };
    if (!sessionId || p.sessionId !== sessionId) return;
    switch (ev.channel) {
      case Ipc.chatChunk:
        useChatStore.setState((s) => ({
          streamText: s.streamText + (ev.payload as { delta: string }).delta,
        }));
        break;
      case Ipc.chatToolEvent: {
        const t = ev.payload as ToolCard & { sessionId: string };
        useChatStore.setState((s) => ({
          toolCards: s.toolCards.some((c) => c.toolCallId === t.toolCallId)
            ? s.toolCards.map((c) =>
                c.toolCallId === t.toolCallId
                  ? { ...c, status: t.status, resultSummary: t.resultSummary ?? c.resultSummary }
                  : c,
              )
            : [
                ...s.toolCards,
                { toolCallId: t.toolCallId, name: t.name, status: t.status, args: t.args },
              ],
        }));
        break;
      }
      case Ipc.chatStatus: {
        const s = ev.payload as {
          status: 'running' | 'retrying' | 'failed';
          attempt?: number;
          error?: string;
        };
        useChatStore.setState({
          status: s.status,
          statusDetail:
            s.status === 'retrying' ? `连接中断，重试中 ${s.attempt ?? 1}/2…` : (s.error ?? ''),
        });
        break;
      }
      case Ipc.chatDone:
        useChatStore.setState({ streamText: '', toolCards: [], status: 'idle', statusDetail: '' });
        void st.load(); // 刷新会话（含持久化后的消息与标题）
        break;
      case Ipc.chatError:
        useChatStore.setState({
          streamText: '',
          toolCards: [],
          status: 'failed',
          statusDetail: (ev.payload as { error: string }).error,
        });
        break;
    }
  });
}
