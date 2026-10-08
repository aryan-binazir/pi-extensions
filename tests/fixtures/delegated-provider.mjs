import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';

export default function delegatedProvider(pi) {
  let turn = 0;
  pi.registerProvider('test', {
    baseUrl: 'http://127.0.0.1:1', api: 'openai-responses', apiKey: 'synthetic',
    models: [{id: 'fixture', name: 'Fixture', reasoning: true, input: ['text'], cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}, contextWindow: 100000, maxTokens: 1000}],
    streamSimple(model, context) {
      const request = JSON.parse(process.argv.at(-1));
      const results = context.messages.filter(message => message.role === 'toolResult');
      const attempt = turn++;
      const retry = request.retry && attempt === 0;
      const call = attempt === (request.retry ? 1 : 0);
      const content = retry ? [] : call
        ? [{type: 'toolCall', id: 'real-child-call', name: request.name, arguments: request.args}]
        : [{type: 'text', text: JSON.stringify({tools: pi.getActiveTools(), results})}];
      const message = {role: 'assistant', content, api: model.api, provider: model.provider, model: model.id, stopReason: retry ? 'error' : call ? 'toolUse' : 'stop', ...(retry ? {errorMessage: '429 rate limit'} : {}), usage: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0}}, timestamp: Date.now()};
      const stream = createAssistantMessageEventStream();
      stream.push(retry ? {type: 'error', reason: 'error', error: message} : {type: 'done', reason: message.stopReason, message}); stream.end(message); return stream;
    },
  });
}
