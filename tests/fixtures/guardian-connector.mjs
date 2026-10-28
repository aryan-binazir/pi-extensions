import { appendFileSync } from 'node:fs';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
const server = new Server({ name: 'guardian-connector-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [
  { name: 'update', description: 'Synthetic update only', inputSchema: { type: 'object', properties: { value: { type: 'number' }, token: { type: 'string' } }, required: ['value'] } },
  { name: 'read', description: 'Synthetic read only', annotations: { readOnlyHint: true }, inputSchema: { type: 'object', properties: {} } },
] }));
server.setRequestHandler(CallToolRequestSchema, request => {
  if (process.argv[2]) appendFileSync(process.argv[2], JSON.stringify(request.params) + '\n');
  return { content: [{ type: 'text', text: JSON.stringify(request.params.arguments) }] };
});
await server.connect(new StdioServerTransport());
