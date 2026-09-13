import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { McpConfigError, resolveEnvironment, resolveHeaders, type ServerConfig } from './config.ts';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}

/** Bind approval and credentials to the config authority, not just its display name. */
export function serverIdentity(name: string, config: ServerConfig, scope: string, cwd: string): string {
  const effective = config.command
    ? { cwd: resolve(cwd, config.cwd ?? '.'), env: resolveEnvironment(config) }
    : { headers: Object.fromEntries(resolveHeaders(config)) };
  return createHash('sha256').update(JSON.stringify(canonical({ version: 1, name, config, scope, effective }))).digest('hex');
}

export class ConsentStore {
  constructor(private agentDir: string) {}

  private async path(key: string): Promise<string> {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new McpConfigError('Invalid MCP saved consent identity');
    const root = join(this.agentDir, 'harbor-mcp');
    const dir = join(root, 'approvals');
    try {
      for (const path of [root, dir]) {
        await mkdir(path, { mode: 0o700, recursive: true });
        const stat = await lstat(path);
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077)) throw new Error();
      }
      return join(dir, `${key}.consent`);
    } catch { throw new McpConfigError('MCP saved consent directory must be private, owned by you, and not a symlink'); }
  }

  async approved(key: string): Promise<boolean> {
    const path = await this.path(key);
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) || stat.nlink !== 1 || stat.size !== 9) throw new Error();
        const buffer = Buffer.alloc(10);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead !== 9 || buffer.subarray(0, bytesRead).toString() !== 'approved\n') throw new Error();
        return true;
      } finally { await file.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw new McpConfigError('MCP saved consent is unreadable or unsafe; remove the affected approval file before reconnecting');
    }
  }

  async remember(key: string): Promise<void> {
    if (await this.approved(key)) return;
    const path = await this.path(key);
    const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile('approved\n'); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, path);
    } catch { throw new McpConfigError('MCP could not remember connection consent; check private approval directory permissions'); }
    finally { await unlink(temporary).catch(() => {}); }
    if (!await this.approved(key)) throw new McpConfigError('MCP connection approval was concurrently revoked; reconnect');
  }

  async forget(key: string): Promise<void> {
    const path = await this.path(key);
    try { await unlink(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new McpConfigError('MCP could not remove saved connection consent'); }
  }
}
