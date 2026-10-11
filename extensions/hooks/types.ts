export type Awaitable<T> = T | Promise<T>;

export interface ToolCall {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
}

export interface GateContext {
  cwd: string;
  signal?: AbortSignal;
}

/** Runs before a tool; a returned reason stops the call. */
export interface BlockHook {
  id: string;
  type: 'block';
  check(call: ToolCall): Awaitable<string | undefined>;
}

/** Runs after a tool; a returned note is appended to the result the model sees. */
export interface AdviseHook {
  id: string;
  type: 'advise';
  check(call: ToolCall): Awaitable<string | undefined>;
}

/** Runs when the agent is about to finish; a returned reason sends it back to work. */
export interface GateHook {
  id: string;
  type: 'gate';
  check(context: GateContext): Awaitable<string | undefined>;
}

export type Hook = BlockHook | AdviseHook | GateHook;
