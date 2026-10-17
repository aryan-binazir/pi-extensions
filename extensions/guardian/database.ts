// Ar's boundary for destructive database operations. A command rarely names a Railway database: its target
// usually comes from credentials such as `$DATABASE_URL`. So a destructive statement through a database client,
// or a database wipe tool, runs only when every target Guardian can find is local; anything it cannot prove local
// is refused outright, like the Railway boundary, because it might be a Railway database. Never verified against a
// real database.
import type { Shell } from './shell.ts';

export const DATABASE_FORBIDDEN_REASON = 'destructive database operations are refused unless their target is provably local (localhost, 127.0.0.1, ::1, '
  + 'a Unix socket or a SQLite file), because an unresolved target may be a Railway database; this cannot be approved. Name a local host explicitly, '
  + 'or run it yourself outside Pi.';

/** Clients whose destructive statements are judged, and where each finds its server when the command names none. */
const CLIENT_DEFAULTS: Record<string, { env: string[]; defaultLocal: boolean }> = {
  psql: { env: ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'], defaultLocal: true },
  pgcli: { env: ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'], defaultLocal: true },
  // Option files such as ~/.my.cnf can set the host, so these are local only when the command says so.
  mysql: { env: ['MYSQL_HOST'], defaultLocal: false },
  mariadb: { env: ['MYSQL_HOST'], defaultLocal: false },
  mycli: { env: ['MYSQL_HOST'], defaultLocal: false },
  mongosh: { env: [], defaultLocal: true },
  mongo: { env: [], defaultLocal: true },
  'redis-cli': { env: [], defaultLocal: true },
  sqlcmd: { env: ['SQLCMDSERVER'], defaultLocal: true },
  'clickhouse-client': { env: ['CLICKHOUSE_HOST'], defaultLocal: false },
  cockroach: { env: ['COCKROACH_HOST', 'COCKROACH_URL'], defaultLocal: true },
  usql: { env: [], defaultLocal: false },
  sqlite3: { env: [], defaultLocal: true },
  litecli: { env: [], defaultLocal: true },
};

/** Tools that wipe a database by themselves, and where each finds it. */
const WIPE_TOOLS: { pattern: RegExp; env: string[]; defaultLocal: boolean }[] = [
  { pattern: /(^|[^A-Za-z0-9_-])(dropdb|dropuser)([^A-Za-z0-9_-]|$)/, env: ['PGHOST', 'PGHOSTADDR', 'PGSERVICE'], defaultLocal: true },
  // Prisma and Rails read their URL from `.env` or `config/database.yml`, which Guardian does not interpret.
  { pattern: /\bprisma\s+(migrate\s+reset|db\s+push\b[^;&|]*--(force-reset|accept-data-loss))/i, env: ['DATABASE_URL'], defaultLocal: false },
  { pattern: /\b(rails|rake)\s+db:(drop|reset|purge)\b/i, env: ['DATABASE_URL'], defaultLocal: false },
];

const DESTRUCTIVE_STATEMENT = /\b(?:drop\s+(?:table|database|schema|view|materialized\s+view|index|sequence|function|type|extension|collection|user|role|owned)\b|truncate\b|delete\s+from\b|alter\s+table\b[^;]*\bdrop\b|flushall\b|flushdb\b|dropdatabase\b)|\.drop(?:Database)?\s*\(/i;
const CLIENT_TOKEN = new RegExp(`(^|[^A-Za-z0-9_-])(${Object.keys(CLIENT_DEFAULTS).join('|')})([^A-Za-z0-9_-]|$)`, 'g');
/** Commands that run the client on another machine, where "localhost" is that machine. */
const REMOTE_EXEC = /(^|[^A-Za-z0-9_-])(ssh|kubectl|oc|heroku|fly|flyctl|gcloud|az|aws|doctl|render|railway)([^A-Za-z0-9_-]|$)/;
const VARIABLE = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|([A-Za-z_][A-Za-z0-9_]*))/g;
const URI = /\b[a-z][a-z0-9+.-]*:\/\/(?:[^\s'"@/]*@)?(\[[^\]]*\]|[^\s'"/:?,]*)/gi;
const HOST_OPTION = /(?:^|\s)(?:-h|--host|-S|--server|--socket)(?:\s+|=)(['"]?)([^\s'"]+)\1/g;
const CONNINFO_HOST = /\bhost(?:addr)?\s*=\s*(['"]?)([^\s'"]+)\1/gi;
const ENV_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s;&|)]*))/g;

/** Local hosts: loopback names and addresses, Unix socket directories, and libpq's empty host. */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return bare === '' || bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare) || bare.startsWith('/');
}

/** A connection target from an environment value: a URI's host, a conninfo host, or the value as a host name. */
function hostsInValue(value: string): string[] {
  const uris = [...value.matchAll(URI)].map(match => match[1]);
  if (uris.length) return uris;
  const conninfo = [...value.matchAll(CONNINFO_HOST)].map(match => match[2]);
  return conninfo.length ? conninfo : [value];
}

export type DatabaseDecision = 'forbidden' | undefined;

/**
 * Whether a destructive database command must be refused because its target is not provably local. Commands
 * that are not destructive database operations, and those whose every target is local, are left to the normal flow.
 */
export function databaseDecision(shell: Shell, command: readonly string[], env: NodeJS.ProcessEnv = process.env): DatabaseDecision {
  const text = shell.extractBashCommand(command)?.[1] ?? command.join(' ');
  const wipes = WIPE_TOOLS.filter(tool => tool.pattern.test(text));
  const clientNames = DESTRUCTIVE_STATEMENT.test(text) ? [...new Set([...text.matchAll(CLIENT_TOKEN)].map(match => match[2]))] : [];
  if (!wipes.length && !clientNames.length) return undefined;

  // What Guardian cannot see through: substitutions, remote shells, and variables set by the script itself.
  if (/\$\(|`/.test(text) || REMOTE_EXEC.test(text)) return 'forbidden';
  const assigned = new Map<string, string>();
  for (const match of text.matchAll(ENV_ASSIGNMENT)) assigned.set(match[1], match[2] ?? match[3] ?? match[4] ?? '');

  const hosts: string[] = [];
  for (const match of text.matchAll(VARIABLE)) {
    const name = match[1] ?? match[2];
    const value = assigned.has(name) ? undefined : env[name];
    if (value === undefined) return 'forbidden';
    if (/:\/\/|host(addr)?\s*=/i.test(value)) hosts.push(...hostsInValue(value));
  }
  const resolved = text.replace(VARIABLE, (_, braced, plain) => env[braced ?? plain] ?? '');
  hosts.push(...[...resolved.matchAll(URI)].map(match => match[1]));
  hosts.push(...[...resolved.matchAll(HOST_OPTION)].map(match => match[2]));
  hosts.push(...[...resolved.matchAll(CONNINFO_HOST)].map(match => match[2]));

  // Where each tool looks when the command names no server: an assignment in the script, then Pi's environment.
  const implicit = [...wipes, ...clientNames.map(name => CLIENT_DEFAULTS[name])];
  for (const tool of implicit) {
    const names = tool.env.filter(name => assigned.has(name) || env[name] !== undefined);
    if (names.includes('PGSERVICE')) return 'forbidden';
    for (const name of names) hosts.push(...hostsInValue(assigned.get(name) ?? env[name]!));
    if (!names.length && !hosts.length && !tool.defaultLocal) return 'forbidden';
  }
  return hosts.every(isLocalHost) ? undefined : 'forbidden';
}
