import type { ChatAgentManager } from '../services/chatService';

/** chat 的 handler：全部转调 chatService，事件推送由 service 的 sink 负责。 */
export function chatHandlers(chatManager: ChatAgentManager) {
  return {
    chatSessionsList: () => chatManager.listSessions(),
    chatSessionCreate: (req: { providerId?: string }) => chatManager.createSession(req.providerId),
    chatSessionDelete: (req: { sessionId: string }) => chatManager.deleteSession(req.sessionId),
    chatSend: (req: { sessionId: string; text: string; providerId?: string }) =>
      chatManager.send(req.sessionId, req.text, req.providerId),
    chatContinue: (req: { sessionId: string }) => chatManager.continue(req.sessionId),
    chatStop: async (req: { sessionId: string }) => {
      chatManager.stop(req.sessionId);
      // 等 run 结算（含 aborted 尾部的 persist），渲染端随后 load() 才能看到中断内容
      await chatManager.waitForIdle(req.sessionId);
    },
  };
}
