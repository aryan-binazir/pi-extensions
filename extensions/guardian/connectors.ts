import type { ExtensionAPI, ExtensionContext, ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent';
import { type Approvals, formatActionPretty, MAX_REVIEWED_ACTION_BYTES } from './approvals.ts';
import type { GuardianConfig } from './config.ts';
import { truncateText } from './review/context.ts';

export function createConnectorGate(deps: { config(): GuardianConfig; tools: ExtensionAPI['getAllTools']; approvals: Pick<Approvals, 'request'> }) {
  return async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
    try {
      const settings = deps.config();
      if (!settings.enabled) return;
      const tool = deps.tools().find(tool => tool.name === event.toolName);
      if (!tool) return { block: true, reason: 'Guardian could not resolve the registered tool identity.' };
      const source = tool.sourceInfo.path;
      if (['bash', 'write', 'edit'].includes(tool.name) || source.startsWith('builtin:') && source !== 'builtin:mcp') return;
      const parentForwardingProxy = process.env.PI_SUBAGENT_TOOL_BRIDGE === '1' && /(^|[/\\])subagents[/\\]connector-bridge\.ts$/.test(source);
      if (parentForwardingProxy) return;
      const force = settings.connectors.alwaysReview.includes(tool.name);
      if (source !== 'builtin:mcp' && !force && !settings.connectors.readOnly.includes(tool.name)) return;
      if (!force && (settings.connectors.readOnly.includes(tool.name) || tool.annotations?.readOnlyHint === true && tool.annotations.destructiveHint !== true)) return;
      if (settings.approvalPolicy === 'never') return { block: true, reason: 'Guardian approvalPolicy never forbids review-required connector calls.' };
      const signal = ctx.signal;
      if (signal?.aborted) return { block: true, reason: 'Connector approval cancelled.' };
      const action = {
        tool: 'connector', name: tool.name, source, namespace: tool.namespace?.name, cwd: ctx.cwd,
        description: truncateText(tool.description, 128), annotations: tool.annotations, arguments: event.input,
      };
      const bytes = Buffer.byteLength(formatActionPretty(action));
      if (bytes > MAX_REVIEWED_ACTION_BYTES) return { block: true, reason: `Connector action is too large to review completely (${bytes} bytes, limit ${MAX_REVIEWED_ACTION_BYTES}). Split it into smaller calls.` };
      const summary = `Connector call: ${tool.name}`;
      const decision = await deps.approvals.request({
        action, summary,
        audit: { action: { tool: 'connector', name: tool.name, toolCallId: event.toolCallId,
          ...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
          argumentBytes: Buffer.byteLength(JSON.stringify(event.input)) }, summary },
      }, ctx, signal);
      if (signal?.aborted) return { block: true, reason: 'Connector approval cancelled.' };
      if (decision.type !== 'approved') return { block: true, reason: decision.message };
    } catch (error) {
      return { block: true, reason: `Guardian connector approval failed: ${error instanceof Error ? error.message : String(error)}` };
    }
  };
}
