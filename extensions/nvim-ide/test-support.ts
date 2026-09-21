import { WebSocketServer, type WebSocket } from 'ws';

export const token = 'a3f1c2d4e5f60718293a4b5c6d7e8f90';

/**
 * Minimal stand-in for claudecode.nvim's server: token check, initialize, and a
 * `tools/call` echo of `name(arguments)`. Two names are special: `boom` answers
 * with an error result and `slow` never answers at all.
 */
export function fakeIde(onClient?: (socket: WebSocket) => void) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: (info: { req: { headers: Record<string, unknown> } }) => info.req.headers['x-claude-code-ide-authorization'] === token });
  const calls: { name: string; arguments: any }[] = [];
  server.on('connection', socket => {
    onClient?.(socket);
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const reply = (result: unknown) => socket.send(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
      if (message.method === 'initialize') reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'claudecode-neovim', version: '0.0.0' } });
      else if (message.method === 'tools/call') {
        calls.push(message.params);
        if (message.params.name === 'boom') reply({ content: [{ type: 'text', text: 'nope' }], isError: true });
        else if (message.params.name === 'slow') return;
        else reply({ content: [{ type: 'text', text: `${message.params.name}(${JSON.stringify(message.params.arguments)})` }] });
      }
    });
  });
  const port = () => (server.address() as { port: number }).port;
  const broadcast = (method: string, params: unknown) => { for (const client of server.clients) client.send(JSON.stringify({ jsonrpc: '2.0', method, params })); };
  return { server, calls, port, broadcast, close: () => new Promise<void>(done => { for (const client of server.clients) client.terminate(); server.close(() => done()); }) };
}

/** Poll `check` until it holds, rather than sleeping for a guessed duration. */
export const until = (check: () => boolean, ms = 3000) => new Promise<void>((resolve, reject) => {
  const start = Date.now();
  const tick = () => check() ? resolve() : Date.now() - start > ms ? reject(new Error('timeout')) : setTimeout(tick, 10);
  tick();
});
