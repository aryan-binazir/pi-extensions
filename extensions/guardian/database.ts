// Ar's boundary for destructive database operations. A command rarely names a Railway database: its target
// usually comes from credentials such as `$DATABASE_URL`. A database command runs against a target Guardian
// cannot prove local only when all of its SQL is visible and none of it is destructive; anything else that could
// reach such a target is refused outright, like the Railway boundary. Guardian reads each client's options the
// way the client does, and fails closed on what it cannot follow. Never verified against a real database.
import type { Shell } from './shell.ts';

export const DATABASE_FORBIDDEN_REASON = 'destructive database operations are refused unless their target is provably local (localhost, 127.0.0.1, ::1, '
  + 'a Unix socket or a SQLite file), because an unresolved target may be a Railway database; this cannot be approved. SQL Guardian cannot see, '
  + 'from a file or standard input, counts as destructive. Name a local host explicitly, or run it yourself outside Pi.';

/** How a client takes its server and its statements on the command line. */
interface ClientSpec {
  /** Options whose value is a host or socket path. */
  host?: string[];
  /** Options whose value is a connection string or URI. */
  connection?: string[];
  /** Options whose value is a statement Guardian can read. */
  sql?: string[];
  /** Options whose value names a script file Guardian does not read. */
  file?: string[];
  /** Other options that take a value, skipped so it is not mistaken for an operand. */
  value?: string[];
  /** The first operand may be a connection string, URI or `host/db` address. */
  connectionOperand?: boolean;
  /** Operands after the options are the statement, as for `redis-cli FLUSHALL`. */
  commandOperands?: boolean;
  /** Environment variables that name the server; a service names a file Guardian does not read. */
  env?: string[];
  serviceEnv?: string[];
  /** Whether the client reaches a local server when nothing names one. */
  defaultLocal: boolean;
  /** Every invocation destroys data, as `dropdb` does. */
  destructive?: boolean;
  /** Every target is a local file. */
  local?: boolean;
}

const PG_ENV = { env: ['PGHOST', 'PGHOSTADDR'], serviceEnv: ['PGSERVICE'] };
const CLIENTS: Record<string, ClientSpec> = {
  psql: { ...PG_ENV, host: ['-h', '--host'], connection: ['-d', '--dbname'], sql: ['-c', '--command'], file: ['-f', '--file'],
    value: ['-p', '--port', '-U', '--username', '-v', '--set', '--variable', '-o', '--output', '-L', '--log-file', '-P', '--pset', '-T',
      '--table-attr', '-F', '--field-separator', '-R', '--record-separator'], connectionOperand: true, defaultLocal: true },
  pgcli: { ...PG_ENV, host: ['-h', '--host'], connection: ['-d', '--dbname'], value: ['-p', '--port', '-U', '--username', '-D', '--dsn'],
    connectionOperand: true, defaultLocal: true },
  pg_restore: { ...PG_ENV, host: ['-h', '--host'], connection: ['-d', '--dbname'], value: ['-p', '--port', '-U', '--username', '-f', '--file',
    '-F', '--format', '-j', '--jobs', '-n', '--schema', '-t', '--table', '-L', '--use-list', '-S', '--superuser'], defaultLocal: true },
  dropdb: { ...PG_ENV, host: ['-h', '--host'], connection: ['--maintenance-db'], value: ['-p', '--port', '-U', '--username'], defaultLocal: true, destructive: true },
  dropuser: { ...PG_ENV, host: ['-h', '--host'], value: ['-p', '--port', '-U', '--username'], defaultLocal: true, destructive: true },
  // Option files such as ~/.my.cnf can name the host, so these are local only when the command says so.
  mysql: { host: ['-h', '--host', '-S', '--socket'], sql: ['-e', '--execute'], value: ['-u', '--user', '-P', '--port', '-D', '--database',
    '--defaults-file', '--defaults-extra-file', '--login-path', '--protocol'], env: ['MYSQL_HOST'], defaultLocal: false },
  mariadb: { host: ['-h', '--host', '-S', '--socket'], sql: ['-e', '--execute'], value: ['-u', '--user', '-P', '--port', '-D', '--database',
    '--defaults-file', '--defaults-extra-file', '--protocol'], env: ['MYSQL_HOST'], defaultLocal: false },
  mycli: { host: ['-h', '--host', '-S', '--socket'], sql: ['-e', '--execute'], value: ['-u', '--user', '-P', '--port', '-D', '--database'],
    connectionOperand: true, env: ['MYSQL_HOST'], defaultLocal: false },
  mongosh: { host: ['--host'], sql: ['--eval'], file: ['-f', '--file'], value: ['--port', '-u', '--username', '-p', '--password',
    '--authenticationDatabase'], connectionOperand: true, defaultLocal: true },
  mongo: { host: ['--host'], sql: ['--eval'], value: ['--port', '-u', '--username', '-p', '--password', '--authenticationDatabase'],
    connectionOperand: true, defaultLocal: true },
  'redis-cli': { host: ['-h', '-s'], connection: ['-u', '--uri'], file: ['--eval'], value: ['-p', '-a', '--user', '--pass', '-n', '-r', '-i'],
    commandOperands: true, defaultLocal: true },
  sqlcmd: { host: ['-S'], sql: ['-Q', '-q'], file: ['-i'], value: ['-U', '-P', '-d'], env: ['SQLCMDSERVER'], defaultLocal: true },
  'clickhouse-client': { host: ['-h', '--host'], sql: ['-q', '--query'], file: ['--queries-file'], value: ['--port', '-u', '--user',
    '--password', '-d', '--database'], env: ['CLICKHOUSE_HOST'], defaultLocal: false },
  cockroach: { host: ['--host'], connection: ['--url'], sql: ['-e', '--execute'], file: ['-f', '--file'], value: ['--port', '-u', '--user',
    '-d', '--database', '--certs-dir'], env: ['COCKROACH_HOST', 'COCKROACH_URL'], defaultLocal: true },
  usql: { sql: ['-c', '--command'], file: ['-f', '--file'], connectionOperand: true, defaultLocal: false },
  sqlite3: { defaultLocal: true, local: true },
  litecli: { defaultLocal: true, local: true },
};

/** Tools that wipe a database configured elsewhere, by the words that select the operation. */
const FRAMEWORK_WIPES: { program: RegExp; operation: (words: string[]) => boolean }[] = [
  { program: /^prisma$/, operation: words => (words[0] === 'migrate' && words[1] === 'reset')
    || (words[0] === 'db' && words[1] === 'push' && words.some(word => word === '--force-reset' || word === '--accept-data-loss')) },
  { program: /^(rails|rake)$/, operation: words => words.some(word => /^db:(drop|reset|purge)\b/.test(word)) },
];

const DESTRUCTIVE_STATEMENT = /\b(?:drop\s+(?:table|database|schema|view|materialized\s+view|index|sequence|function|type|extension|collection|user|role|owned)\b|truncate\b|delete\s+from\b|alter\s+table\b[^;]*\bdrop\b|flushall\b|flushdb\b|dropdatabase\b)|\.drop(?:Database)?\s*\(|\bdelete(?:Many|One)\s*\(|\.remove\s*\(/i;
const DESTRUCTIVE_REDIS = new Set(['flushall', 'flushdb', 'del', 'unlink', 'swapdb']);
/** psql meta-commands that read a file or run a shell, hiding the statements they run. */
const HIDDEN_META = /\\(?:i|ir|include|include_relative|gexec)\b|\\!/;
const MENTION = new RegExp(`(^|[^A-Za-z0-9_-])(${[...Object.keys(CLIENTS), 'prisma', 'rails', 'rake'].join('|')})([^A-Za-z0-9_-]|$)`, 'g');
/** Prefixes whose operands Guardian cannot follow, so the client's arguments or target may come from elsewhere. */
const OPAQUE_PREFIX = new Set(['xargs', 'find', 'parallel', 'watch', 'eval']);
/**
 * Prefixes that run the client on another machine, where "localhost" is that machine. A container counts: its
 * engine may be remote through a Docker context, and its database is not one of the local targets.
 */
const REMOTE_PREFIX = new Set(['ssh', 'kubectl', 'oc', 'heroku', 'fly', 'flyctl', 'gcloud', 'az', 'aws', 'doctl', 'render', 'railway', 'docker',
  'podman', 'nerdctl', 'docker-compose']);
const ENV_ASSIGNMENT = /(?:^|[\s;&|(])(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'([^']*)'|"([^"]*)"|([^\s;&|)]*))/g;
/** Values that read the same in every quoting context, so they can be substituted into the script safely. */
const SAFE_VALUE = /^[A-Za-z0-9_@%+=:,./~?!*#[\]{}^-]*$/;

const programOf = (word: string) => word.replace(/^\\/, '').split('/').pop() ?? word;

/** Local hosts: loopback names and addresses, Unix socket directories, and libpq's empty host. */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return bare === '' || bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare) || bare.startsWith('/');
}

const decode = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
const withoutPort = (host: string) => host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:[^:]*$/, '');

interface Targets {
  /** Hosts named explicitly; none means the client's environment or default decides. */
  hosts: string[];
  /** A service, whose host lives in a file Guardian does not read. */
  service: boolean;
}

/**
 * The servers a connection value names, as libpq reads it: a URI's hosts are split on commas, percent-decoded, and
 * split again, so an encoded comma adds a host; query parameters are decoded before they are matched; a keyword
 * string's `host` and `hostaddr` lists count, and a `service` cannot be followed. Other clients' URIs read the same
 * way. A plain database name names no server.
 */
export function connectionTargets(value: string): Targets {
  const targets: Targets = { hosts: [], service: false };
  const uri = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(value);
  if (uri) {
    const rest = uri[2];
    const authorityEnd = rest.search(/[/?#]/);
    const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
    const hostList = authority.slice(authority.lastIndexOf('@') + 1);
    if (hostList) targets.hosts.push(...hostList.split(',').flatMap(entry => decode(withoutPort(entry)).split(',')));
    const queryStart = rest.indexOf('?');
    const query = queryStart === -1 ? '' : rest.slice(queryStart + 1).split('#')[0];
    for (const pair of query.split('&').filter(Boolean)) {
      const separator = pair.indexOf('=');
      const key = decode(separator === -1 ? pair : pair.slice(0, separator)).trim().toLowerCase();
      const parameter = separator === -1 ? '' : decode(pair.slice(separator + 1));
      if (key === 'host' || key === 'hostaddr') targets.hosts.push(...parameter.split(','));
      if (key === 'service') targets.service = true;
    }
    return targets;
  }
  if (!value.includes('=')) {
    // A MongoDB-style `host[:port]/db` address names its host before the slash.
    const address = /^([^\s/=]+)\/[^\s]*$/.exec(value);
    if (address) targets.hosts.push(withoutPort(address[1]));
    return targets;
  }
  for (const match of value.matchAll(/([A-Za-z_]+)\s*=\s*(?:'((?:\\.|[^'\\])*)'|(\S*))/g)) {
    const key = match[1].toLowerCase(), parameter = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    if (key === 'host' || key === 'hostaddr') targets.hosts.push(...parameter.split(','));
    if (key === 'service') targets.service = true;
  }
  return targets;
}

/**
 * Expands `$NAME` and `${NAME}` everywhere, including inside single quotes, because a nested shell expands what the
 * outer one quoted. `$$` is the process ID or an SQL dollar quote, and stays as written.
 */
function expandVariables(text: string, lookup: (name: string) => string | undefined): { names: string[]; expanded: string } {
  const names: string[] = [];
  const expanded = text.replace(/\$\$|\$\{([A-Za-z_][A-Za-z0-9_]*)[^}]*\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    if (match === '$$') return match;
    const name = braced ?? plain;
    names.push(name);
    return lookup(name) ?? '';
  });
  return { names, expanded };
}

interface Invocation {
  local: boolean;
  /** Visible statements include a destructive one, or the tool always destroys data. */
  destructive: boolean;
  /** Some statements come from a file, standard input or a meta-command Guardian does not read. */
  hidden: boolean;
}

function analyzeClient(spec: ClientSpec, args: readonly string[], envFor: (name: string) => string | undefined): Invocation {
  if (spec.local) return { local: true, destructive: false, hidden: false };
  const hosts: string[] = [];
  let service = false, hidden = false, sawSql = false;
  const statements: string[] = [];
  const addConnection = (value: string) => {
    const targets = connectionTargets(value);
    hosts.push(...targets.hosts);
    service ||= targets.service;
  };
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    const option = (names: string[] | undefined) => {
      for (const name of names ?? []) {
        if (word === name) return args[++index] ?? '';
        if (name.startsWith('--') && word.startsWith(`${name}=`)) return word.slice(name.length + 1);
        if (!name.startsWith('--') && word.startsWith(name) && word.length > name.length) return word.slice(name.length);
      }
      return undefined;
    };
    let value: string | undefined;
    if ((value = option(spec.host)) !== undefined) hosts.push(...value.split(','));
    else if ((value = option(spec.connection)) !== undefined) addConnection(value);
    else if ((value = option(spec.sql)) !== undefined) { statements.push(value); sawSql = true; }
    else if ((value = option(spec.file)) !== undefined) hidden = true;
    else if (option(spec.value) !== undefined) continue;
    else if (word.startsWith('-')) continue;
    else if (spec.commandOperands) { statements.push(word); sawSql = true; }
    // Any operand may be the connection string: an option Guardian does not know could have taken the one before.
    else if (/\.js$/.test(word)) hidden = true;
    else if (spec.connectionOperand) addConnection(word);
  }
  for (const name of spec.serviceEnv ?? []) if (envFor(name) !== undefined) service = true;
  if (!hosts.length) for (const name of spec.env ?? []) {
    const value = envFor(name);
    if (value !== undefined) hosts.push(...(value.includes('://') || value.includes('=') ? connectionTargets(value).hosts : value.split(',')));
  }
  if (!sawSql && !spec.destructive) hidden = true;
  if (statements.some(statement => HIDDEN_META.test(statement))) hidden = true;
  const destructive = !!spec.destructive || statements.some(statement => DESTRUCTIVE_STATEMENT.test(statement))
    || (spec.commandOperands === true && DESTRUCTIVE_REDIS.has((statements[0] ?? '').toLowerCase()));
  const local = !service && (hosts.length ? hosts.every(isLocalHost) : spec.defaultLocal);
  return { local, destructive, hidden };
}

export type DatabaseDecision = 'forbidden' | undefined;

/**
 * Whether a database command must be refused: one that may run destructive or unseen SQL against a target Guardian
 * cannot prove local. Everything else, including any command against a local target, is left to the normal flow.
 */
export function databaseDecision(shell: Shell, command: readonly string[], env: NodeJS.ProcessEnv = process.env): DatabaseDecision {
  const text = shell.extractBashCommand(command)?.[1] ?? command.join(' ');
  if (!text.match(MENTION)) return undefined;

  const assigned = new Map<string, string>();
  for (const match of text.matchAll(ENV_ASSIGNMENT)) assigned.set(match[1], match[2] ?? match[3] ?? match[4] ?? '');
  const { names, expanded } = expandVariables(text, name => env[name]);
  // A variable the script sets, Pi's environment lacks, or whose value would change how the script parses could
  // hold any target, and so could a command substitution.
  const unresolved = /\$\(|`/.test(text) || names.some(name => assigned.has(name) || env[name] === undefined || !SAFE_VALUE.test(env[name]!));

  const covered = new Set<string>();
  for (const argv of shell.expandLiteralCommands(['bash', '-lc', expanded])) {
    const index = argv.findIndex(word => CLIENTS[programOf(word)] !== undefined || FRAMEWORK_WIPES.some(wipe => wipe.program.test(programOf(word))));
    if (index === -1 || (argv[0] === 'bash' && argv[1] === '-lc' && argv[2] === expanded)) continue;
    const program = programOf(argv[index]);
    covered.add(program);
    const prefix = argv.slice(0, index).map(programOf);
    const prefixEnv = new Map(argv.slice(0, index).flatMap(word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word) ? [[word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)] as const] : []));
    const envFor = (name: string) => prefixEnv.get(name) ?? assigned.get(name) ?? env[name];
    if (prefix.some(word => OPAQUE_PREFIX.has(word))) return 'forbidden';
    const remote = prefix.some(word => REMOTE_PREFIX.has(word));

    const wipe = FRAMEWORK_WIPES.find(candidate => candidate.program.test(program));
    let invocation: Invocation;
    if (wipe) {
      if (!wipe.operation(argv.slice(index + 1))) continue;
      const url = envFor('DATABASE_URL');
      invocation = { local: url !== undefined && connectionTargets(url).hosts.length > 0 && connectionTargets(url).hosts.every(isLocalHost)
        && !connectionTargets(url).service, destructive: true, hidden: false };
    } else {
      invocation = analyzeClient(CLIENTS[program], argv.slice(index + 1), envFor);
    }
    // What an unresolved variable or substitution holds could be a statement as well as a target.
    const local = invocation.local && !remote && !unresolved;
    if (!local && (invocation.destructive || invocation.hidden || unresolved)) return 'forbidden';
  }

  // A client the parser could not place in a command, as inside `sh -c` with escaped quotes, cannot be judged.
  const mentioned = [...expanded.matchAll(MENTION)].map(match => match[2]);
  const unplaced = mentioned.some(name => !covered.has(name));
  if (unplaced && (DESTRUCTIVE_STATEMENT.test(expanded) || /(^|\s)(-f|--file|-i|--eval)(\s|=|$)|<|\||\\i\b/.test(expanded)
    || /\b(migrate\s+reset|db:(drop|reset|purge)|--force-reset|--accept-data-loss|dropdb|dropuser|pg_restore)\b/.test(expanded))) {
    return 'forbidden';
  }
  return undefined;
}
