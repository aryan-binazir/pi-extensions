import {createAgentSession, DefaultResourceLoader, ModelRegistry, ModelRuntime, SessionManager, SettingsManager} from '@earendil-works/pi-coding-agent';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {join} from 'node:path';
import {Socket} from 'node:net';
import {stat} from 'node:fs/promises';

const args = process.argv.slice(2);
const tools = args[args.indexOf('--tools') + 1].split(',').filter(Boolean);
const extensions = args.flatMap((arg, i) => arg === '-e' ? [args[i + 1]] : []);
const request = JSON.parse(args.at(-1));
if (request.attack || request.protocol) {
  const socket = new Socket({fd: 5, readable: true, writable: true});
  socket.setEncoding('utf8');
  await new Promise((resolve, reject) => {
    let buffer = '';
    socket.on('error', reject);
    socket.on('data', chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const message = JSON.parse(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1);
        if (message.type === 'tools') {
          const calls = request.protocol ?? [{type: 'call', id: 1, name: request.attack, args: {issueKey: 'BBA-42'}}];
          socket.write(calls.map(call => JSON.stringify(call) + '\n').join(''));
          if (request.gate) void (async () => {
            while (!await stat(request.gate).then(() => true, () => false)) await new Promise(resolve => setTimeout(resolve, 10));
            socket.write(request.afterGate.map(call => JSON.stringify(call) + '\n').join(''));
          })().catch(reject);
        }
        if (message.type === 'result' && message.id === (request.finishId ?? 1)) process.stdout.write(JSON.stringify({type: 'message_end', message: {role: 'assistant', stopReason: 'stop', content: [{type: 'text', text: JSON.stringify(message)}]}}) + '\n', () => {socket.destroy(); resolve();});
      }
    });
  });
  process.exit(0);
}
const cwd = process.cwd(), agentDir = process.env.PI_CODING_AGENT_DIR;
const settingsManager = SettingsManager.inMemory({});
const resourceLoader = new DefaultResourceLoader({cwd, agentDir, settingsManager, additionalExtensionPaths: extensions, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true});
await resourceLoader.reload();
if (resourceLoader.getExtensions().errors.length) throw new Error('Child extension loading failed: ' + JSON.stringify(resourceLoader.getExtensions().errors));
const modelRuntime = await ModelRuntime.create({authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json'), refreshOnCreate: false, allowModelNetwork: false});
const registry = new ModelRegistry(modelRuntime);
await registry.refresh({allowNetwork: false});
const {session} = await createAgentSession({cwd, agentDir, settingsManager, modelRuntime, resourceLoader, tools, model: registry.find('test', 'fixture'), sessionManager: SessionManager.inMemory(cwd)});
try {
  await session.bindExtensions({});
  if (request.delay) await new Promise(resolve => setTimeout(resolve, request.delay));
  let turn = 0;
  const executions = [];
  session.agent.streamFunction = () => {
    const results = session.agent.state.messages.filter(message => message.role === 'toolResult');
    const content = turn++ === 0
      ? [{type: 'toolCall', id: 'child-call', name: request.name, arguments: request.args}]
      : [{type: 'text', text: JSON.stringify({tools: session.getActiveToolNames(), results, executions})}];
    const message = {role: 'assistant', content, api: 'openai-responses', provider: 'test', model: 'fixture', stopReason: turn === 1 ? 'toolUse' : 'stop', usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, timestamp: Date.now()};
    const stream = createAssistantMessageEventStream();
    stream.push({type: 'done', reason: message.stopReason, message});
    stream.end(message);
    return stream;
  };
  session.agent.subscribe(event => {
    if (event.type === 'tool_execution_end') executions.push(event);
    if (event.type === 'message_end' && event.message.role === 'assistant') process.stdout.write(JSON.stringify(event) + '\n');
  });
  await session.agent.prompt('Execute the fixture request');
} finally {
  await session.extensionRunner.emit({type: 'session_shutdown', reason: 'quit'});
  session.dispose();
}
