export type ConnectorGrants = Record<string, 'read' | 'write'>;
export interface SelectionProvenance { config: string; profile: string; model: string; thinking: string }
export interface TaskSpec {
  task: string;
  cwd: string;
  profile?: string;
  configProvenance?: SelectionProvenance;
  model?: string;
  thinking?: string;
  tools?: string[];
  preset?: 'reader' | 'writer';
  extensions?: string[];
  timeout?: number;
}

export interface ValidTask extends TaskSpec { tools: string[]; extensions: string[]; hooks: string; timeout: number }
export const READ_TOOLS = ['read', 'grep', 'find', 'ls'];
export const ALL_TOOLS = [...READ_TOOLS, 'write', 'edit', 'bash'];
export const TIMEOUT_BOUNDS = {minimum: 10, maximum: 3600000};
export function validateTimeout(timeout: number | undefined, what: string): number {
  const value = timeout ?? TIMEOUT_BOUNDS.maximum;
  if (!Number.isInteger(value) || value < TIMEOUT_BOUNDS.minimum || value > TIMEOUT_BOUNDS.maximum)
    throw new Error(`${what} must be ${TIMEOUT_BOUNDS.minimum}–${TIMEOUT_BOUNDS.maximum} milliseconds`);
  return value;
}
