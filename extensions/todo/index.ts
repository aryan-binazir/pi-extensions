import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
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

const clone = (snapshot: Snapshot): Snapshot => ({ version: 1, todos: snapshot.todos.map(item => ({ content: item.content, status: item.status })), staleTurns: snapshot.staleTurns });
function parse(data: unknown): Snapshot {
  if (!data || typeof data !== 'object') throw new Error('Unsupported todo snapshot');
  const { version, todos, staleTurns } = data as Record<keyof Snapshot, unknown>;
  if (version !== 1 || typeof staleTurns !== 'number' || !Number.isSafeInteger(staleTurns) || staleTurns < 0) throw new Error('Unsupported todo snapshot');
  return { version: 1, todos: normalize(todos), staleTurns };
}

export default function todo(pi: ExtensionAPI): void {
  let state: Snapshot = { version: 1, todos: [], staleTurns: 0 };
  let dirty = false;
  let expanded = false;
  const persist = () => {
    if (!dirty) return;
    pi.appendEntry(entryType, clone(state));
    dirty = false;
  };
  const active = () => state.todos.some(item => item.status !== 'completed');
  const paint = (ctx: ExtensionContext) => {
    if (!ctx.hasUI) return;
    if (!active()) { ctx.ui.setWidget('interactive-tools:todo', undefined); return; }
    ctx.ui.setWidget('interactive-tools:todo', (_tui, theme) => {
      const blue = (text: string) => theme.fg('border', text);
      const current = state.todos.find(item => item.status === 'in_progress') ?? state.todos.find(item => item.status === 'pending');
      const summary = `Todos ${state.todos.filter(item => item.status === 'completed').length}/${state.todos.length} · ${blue('alt+t')} · ${current?.content ?? ''}`;
      const lines = [`Todo — declared progress · ${blue('alt+t')}`, ...state.todos.map(item => `${blue(item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '→' : '○')} ${item.content}`)];
      return {
        invalidate() {},
        render(width: number) {
          if (width < 6) return [];
          if (!expanded) return [truncateToWidth(summary, width)];
          const inner = width - 4;
          return [
            blue(`╭${'─'.repeat(inner + 2)}╮`),
            ...lines.flatMap(line => wrapTextWithAnsi(line, inner)).map(line => `${blue('│')} ${line}${' '.repeat(Math.max(0, inner - visibleWidth(line)))} ${blue('│')}`),
            blue(`╰${'─'.repeat(inner + 2)}╯`),
          ].map(line => truncateToWidth(line, width, ''));
        },
      };
    });
  };
  pi.registerShortcut('alt+t', {
    description: 'Toggle compact/full todo list',
    handler(ctx) {
      expanded = !expanded;
      paint(ctx);
    },
  });
  let tip: object | undefined;
  let tipState: Snapshot | undefined;
  let tipSkipped = 0;
  let tipReason = '';
  const reason = (error: unknown) => error instanceof Error ? error.message : 'Unsupported todo snapshot';
  const failure = new WeakMap<object, string>();
  const parseFailure = (entry: object, data: unknown): string => {
    const cached = failure.get(entry);
    if (cached !== undefined) return cached;
    let error = '';
    try { parse(data); } catch (caught) { error = reason(caught); }
    failure.set(entry, error);
    return error;
  };
  const restore = (ctx: ExtensionContext) => {
    dirty = false;
    const branch = ctx.sessionManager.getBranch();
    let newest = -1;
    let newestData: unknown;
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === 'custom' && entry.customType === entryType) { newest = index; newestData = entry.data; break; }
    }
    if (newest < 0) { tip = tipState = undefined; tipSkipped = 0; tipReason = ''; state = { version: 1, todos: [], staleTurns: 0 }; paint(ctx); return; }
    if (branch[newest] !== tip) {
      let skipped = 0;
      let why = '';
      for (let index = 0; index < newest; index++) {
        const entry = branch[index];
        if (entry.type === 'custom' && entry.customType === entryType) {
          const error = parseFailure(entry, entry.data);
          if (error) { skipped++; why ||= error; }
        }
      }
      let parsed: Snapshot | undefined;
      let tipError = '';
      try { parsed = parse(newestData); } catch (error) { tipError = reason(error); skipped++; why ||= tipError; }
      failure.set(branch[newest], tipError);
      tip = branch[newest]; tipState = parsed; tipSkipped = skipped; tipReason = why;
    }
    state = tipState ?? { version: 1, todos: [], staleTurns: 0 };
    if (ctx.hasUI && tipSkipped) ctx.ui.notify(`Skipped ${tipSkipped} invalid or unsupported todo snapshot${tipSkipped === 1 ? '' : 's'}: ${tipReason}`, 'warning');
    paint(ctx);
  };
  pi.on('session_start', (_event, ctx) => restore(ctx));
  pi.on('session_tree', (_event, ctx) => restore(ctx));
  pi.on('session_shutdown', (_event, ctx) => {
    dirty = false;
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
      const previous = state.todos;
      const changed = todos.length !== previous.length || todos.some((item, index) => item.content !== previous[index].content || item.status !== previous[index].status);
      const next: Snapshot = { version: 1, todos, staleTurns: changed ? 0 : state.staleTurns };
      pi.appendEntry(entryType, clone(next));
      state = next;
      dirty = false;
      paint(ctx);
      return { content: [{ type: 'text', text: todos.length ? `Declared progress saved: ${todos.filter(item => item.status === 'completed').length}/${todos.length} completed.` : 'Todo list cleared.' }], details: clone(state) };
    },
  });
  pi.on('message_start', event => {
    if (event.message.role !== 'user' || !active()) return;
    persist();
    state = { ...state, staleTurns: state.staleTurns + 1 };
    dirty = true;
  });
  pi.on('agent_end', () => persist());
  pi.on('context', event => {
    persist();
    if (!active()) return;
    const warning = state.staleTurns >= 6 ? 'STALE TODO: Before proceeding, reconcile this list with actual work; explain blockers or clear obsolete tasks. Do not mark tasks complete without evidence.' : state.staleTurns >= 3 ? 'This todo list has not changed for several turns. Update actual progress or explain the blocker.' : 'Keep the todo list current as work progresses.';
    return { messages: [...event.messages, { role: 'custom', customType: 'interactive-tools:todo-reminder', display: false, timestamp: Date.now(), content: `${warning}\nPersisted todos are declared progress, not verified completion:\n${state.todos.map(item => `[${item.status}] ${item.content}`).join('\n')}` }] };
  });
}
