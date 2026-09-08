import type { App } from '@modelcontextprotocol/ext-apps';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ApprovalError, APPROVAL_ERROR_CODES, REVIEW_APPROVAL_TOOL, DECIDE_APPROVAL_TOOL } from '../approval-protocol.js';
import type { ApprovalCardBridge } from './approval-card.js';
import { decodeToolResult } from './tool-result.js';

export interface ChatGptApprovalBridge {
  callTool?: (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;
  sendFollowUpMessage?: (input: { prompt: string; scrollToBottom?: boolean }) => Promise<unknown>;
  theme?: 'light' | 'dark';
}
type StandardBridge = Pick<App, 'getHostCapabilities' | 'callServerTool' | 'sendMessage'>;

export function createApprovalBridge(standard: () => StandardBridge | null, legacy: () => ChatGptApprovalBridge | undefined): ApprovalCardBridge {
  return {
    review: async (name, args) => {
      if (![REVIEW_APPROVAL_TOOL, DECIDE_APPROVAL_TOOL].includes(name)) throw new ApprovalError('CHAT_BRIDGE_UNAVAILABLE');
      const app = standard(), compatibility = legacy();
      // Choose once from advertised capability. Never retry a failed decision
      // through another bridge: the first call may already have been delivered.
      const result = app?.getHostCapabilities()?.serverTools ? await app.callServerTool({ name, arguments: args }) :
        typeof compatibility?.callTool === 'function' ? await compatibility.callTool(name, args) : undefined;
      if (!result) throw new ApprovalError('CHAT_BRIDGE_UNAVAILABLE');
      if (result.isError) {
        let code: typeof APPROVAL_ERROR_CODES[number] = 'APPROVAL_UNAVAILABLE';
        try {
          const text = result.content.find(item => item.type === 'text');
          const failure = JSON.parse(text?.type === 'text' ? text.text : '{}');
          if (APPROVAL_ERROR_CODES.includes(failure.code)) code = failure.code;
        } catch { /* Unstructured host/provider errors must not enter approval UI. */ }
        throw new ApprovalError(code);
      }
      const decoded = decodeToolResult(result);
      if (decoded.kind !== 'approval' || decoded.approval.id !== args.approvalId) throw new ApprovalError('APPROVAL_RESPONSE_MISMATCH');
      return decoded.approval;
    },
    notify: async message => {
      const app = standard(), compatibility = legacy();
      if (app?.getHostCapabilities()?.message) {
        const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text: message }] });
        if (result.isError) throw new ApprovalError('CHAT_BRIDGE_UNAVAILABLE');
      } else if (typeof compatibility?.sendFollowUpMessage === 'function') {
        await compatibility.sendFollowUpMessage({ prompt: message, scrollToBottom: false });
      } else throw new ApprovalError('CHAT_BRIDGE_UNAVAILABLE');
    },
  };
}
