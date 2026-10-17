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
const URI_AUTHORITY = /\b[a-z][a-z0-9+.-]*:\/\/([^\s'"/?#]*)/gi;
const HOST_OPTION = /(?:^|\s)(?:--(?:host|server|socket)(?:\s+|=)|-[hS](?:\s+|=)?)(['"]?)([^\s'"]+)\1/g;
const CONNINFO_HOST = /\bhost(?:addr)?\s*=\s*(['"]?)([^\s'"&]+)\1/gi;
/** A libpq service file names its own host, which Guardian does not read. */
const SERVICE = /\bservice\s*=/i;
const ENV_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s;&|)]*))/g;

/** Local hosts: loopback names and addresses, Unix socket directories, and libpq's empty host. */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return bare === '' || bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare) || bare.startsWith('/');
}

const decode = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
const withoutPort = (host: string) => host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:[^:]*$/, '');

/** Every host the text names: each host of a multi-host URI, and each entry of a `host=` or `hostaddr=` list. */
function hostsIn(text: string): string[] {
  const hosts: string[] = [];
  for (const match of text.matchAll(URI_AUTHORITY)) {
    const authority = match[1].slice(match[1].lastIndexOf('@') + 1);
    hosts.push(...authority.split(',').map(part => decode(withoutPort(part))));
  }
  for (const match of text.matchAll(CONNINFO_HOST)) hosts.push(...match[2].split(','));
  return hosts;
}

/** The hosts in an environment value: those of a URI or connection string, or the value as a host list. */
function hostsInValue(value: string): string[] {
  const hosts = hostsIn(value);
  return hosts.length ? hosts : value.split(',');
}

/**
 * Expands variables where the shell would: not inside single quotes, so SQL dollar quoting stays text, and `$$`
 * is the process ID. Returns the names expanded and the text with their values.
 */
function expandVariables(text: string, lookup: (name: string) => string | undefined): { names: string[]; expanded: string } {
  const names: string[] = [];
  let expanded = '', single = false, double = false;
  for (let index = 0; index < text.length;) {
    const char = text[index];
    if (single) {
      if (char === "'") single = false;
      expanded += char;
      index++;
    } else if (char === '\\') {
      expanded += text.slice(index, index + 2);
      index += 2;
    } else if (char === "'" && !double) {
      single = true;
      expanded += char;
      index++;
    } else if (char === '"') {
      double = !double;
      expanded += char;
      index++;
    } else if (char === '$' && text[index + 1] === '$') {
      expanded += '$$';
      index += 2;
    } else {
      const variable = char === '$' ? /^\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|^([A-Za-z_][A-Za-z0-9_]*)/.exec(text.slice(index + 1)) : null;
      if (!variable) {
        expanded += char;
        index++;
        continue;
      }
      const name = variable[1] ?? variable[2];
      names.push(name);
      expanded += lookup(name) ?? '';
      index += 1 + variable[0].length;
    }
  }
  return { names, expanded };
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

  const { names: referenced, expanded } = expandVariables(text, name => env[name]);
  // A variable the script sets, or Pi's environment lacks, could name any server.
  if (referenced.some(name => assigned.has(name) || env[name] === undefined)) return 'forbidden';
  if (SERVICE.test(expanded)) return 'forbidden';
  const hosts = [...hostsIn(expanded), ...[...expanded.matchAll(HOST_OPTION)].flatMap(match => match[2].split(','))];

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
