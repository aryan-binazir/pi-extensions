import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { StringEnum } from '@earendil-works/pi-ai';

interface Todo { content: string; status: 'pending' | 'in_progress' | 'completed' }
interface Snapshot { version: 1; todos: Todo[]; staleTurns: number }
const entryType = 'interactive-tools:todo';
function normalize(value: unknown): Todo[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('todos must be a list of at most 100 tasks');
  const seen = new Set<string>();
  const todos = value.map((item: unknown) => {
    if (!item || typeof item !== 'object') throw new Error('Each todo needs content and status');
    const { content, status } = item as Todo;
    if (typeof content !== 'string' || !['pending', 'in_progress', 'completed'].includes(status)) throw new Error('Each todo needs text content and a valid status');
    const text = content.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 500 || /[\x00-\x1f\x7f]/.test(text)) throw new Error('Todo content must be nonempty plain text, at most 500 characters');
    if (seen.has(text)) throw new Error('Todo content must be unique');
    seen.add(text);
    return { content: text, status };
  });
  if (todos.filter(todo => todo.status === 'in_progress').length > 1) throw new Error('At most one todo may be in_progress');
  return todos;
}

export default function todo(pi: ExtensionAPI): void {
  // Only trusted local code declares its own bounded storage/UI effects.
  pi.events?.on('auto-mode:request-declarations', () => {
    pi.events.emit('auto-mode:declare', { version: 1, source: 'local', extension: fileURLToPath(import.meta.url), tool: 'todo_write', effect: 'managed' });
  });
  let state: Snapshot = { version: 1, todos: [], staleTurns: 0 };
  const active = () => state.todos.some(item => item.status !== 'completed');
  const paint = (ctx: ExtensionContext) => {
    if (ctx.hasUI) ctx.ui.setWidget('interactive-tools:todo', active() ? ['Todo — declared progress', ...state.todos.map(item => `${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : '○'} ${item.content}`)] : undefined);
  };
  const restore = (ctx: ExtensionContext) => {
    state = { version: 1, todos: [], staleTurns: 0 };
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== 'custom' || entry.customType !== entryType) continue;
      try {
        const value = entry.data as Snapshot;
        if (value?.version !== 1 || !Number.isSafeInteger(value.staleTurns) || value.staleTurns < 0) throw new Error('Unsupported todo snapshot');
        state = { version: 1, todos: normalize(value.todos), staleTurns: value.staleTurns };
      } catch {
        state = { version: 1, todos: [], staleTurns: 0 };
        if (ctx.hasUI) ctx.ui.notify('Skipped invalid or unsupported todo snapshot', 'warning');
      }
    }
    paint(ctx);
  };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    state = { version: 1, todos: [], staleTurns: 0 };
    paint(ctx);
  });
  pi.registerTool({
    name: 'todo_write', label: 'Todo write',
    description: 'Replace the entire declared task list. Each task has content and pending, in_progress or completed status. At most one task may be in_progress. Record only progress you actually achieved; persisted status is a declaration, not verification. Send [] to clear. All-completed lists hide the widget and reminders.',
    parameters: Type.Object({ todos: Type.Array(Type.Object({ content: Type.String(), status: StringEnum(['pending', 'in_progress', 'completed'] as const) }), { maxItems: 100 }) }),
    async execute(_id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      const todos = normalize(params.todos);
      // Repeating the same declaration does not reset a stale-progress reminder.
      const changed = JSON.stringify(todos) !== JSON.stringify(state.todos);
      const next: Snapshot = { version: 1, todos, staleTurns: changed ? 0 : state.staleTurns };
      pi.appendEntry(entryType, structuredClone(next));
      state = next;
      paint(ctx);
      return { content: [{ type: 'text', text: todos.length ? `Declared progress saved: ${todos.filter(item => item.status === 'completed').length}/${todos.length} completed.` : 'Todo list cleared.' }], details: structuredClone(state) };
    },
  });
  pi.on('before_agent_start', (event, _ctx) => {
    if (!active()) return;
    state = { ...state, staleTurns: Math.min(state.staleTurns + 1, 1_000_000) };
    pi.appendEntry(entryType, structuredClone(state));
    const warning = state.staleTurns >= 6 ? 'STALE TODO: Before proceeding, reconcile this list with actual work; explain blockers or clear obsolete tasks. Do not mark tasks complete without evidence.' : state.staleTurns >= 3 ? 'This todo list has not changed for several turns. Update actual progress or explain the blocker.' : 'Keep the todo list current as work progresses.';
    return { systemPrompt: `${event.systemPrompt}\n\n${warning}\nPersisted todos are declared progress, not verified completion:\n${state.todos.map(item => `[${item.status}] ${item.content}`).join('\n')}` };
  });
}
