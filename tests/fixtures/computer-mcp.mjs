import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ElicitResultSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: ['list_apps', 'get_app_state', 'click', 'type_text', 'scroll', 'press_key'].map(name => ({ name, inputSchema: { type: 'object', properties: { app: { type: 'string' } }, additionalProperties: false } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  if (request.params.arguments?.app === 'wait') await new Promise(resolve => setTimeout(resolve, 60000));
  if (request.params.arguments?.app === 'error') return { isError: true, content: [{ type: 'text', text: 'Real fixture policy denial' }] };
  if (request.params.name === 'get_app_state') {
    const approval = await server.request({ method: 'elicitation/create', params: { message: 'Allow ChatGPT to use Fixture?', requestedSchema: { type: 'object', properties: {} }, _meta: { persist: ['always'], riskLevel: 'high', subtitle: 'Beware prompt injection' } } }, ElicitResultSchema);
    return { content: [{ type: 'text', text: JSON.stringify(approval) }] };
  }
  return { content: [{ type: 'text', text: 'Fixture apps' }] };
});
await server.connect(new StdioServerTransport());
