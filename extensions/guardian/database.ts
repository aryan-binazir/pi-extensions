// Ar's boundary for destructive database operations. A command rarely names a Railway database: its target
// usually comes from credentials such as `$DATABASE_URL`. A database command runs against a target Guardian cannot
// prove local only when all of its SQL is visible and none of it is destructive; anything else that could reach
// such a target is refused outright, like the Railway boundary.
//
// Guardian evaluates the script with the bash grammar: each command's arguments as bash passes them, with Pi's
// environment substituted only where bash expands, and each client's options read the way the client reads them.
// Once a script involves a database client, every command in it must be one Guardian can judge completely: a client
// invocation, a read-only tool with options from its allowlist, a neutral builtin, or an exactly parsed wrapper
// around one of those. Anything else in such a script, including a script it cannot evaluate, is refused. Never
// verified against a real database.
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { Node } from 'web-tree-sitter';
import type { Shell } from './shell.ts';

export const DATABASE_FORBIDDEN_REASON = 'destructive database operations are refused unless their target is provably local (localhost, 127.0.0.1, ::1, '
  + 'a Unix socket or a SQLite file), because an unresolved target may be a Railway database; this cannot be approved. SQL Guardian cannot see, '
  + 'from a file or standard input, counts as destructive. Name a local host explicitly, or run it yourself outside Pi.';

/** How a client reads one option: a host or socket, a network address, a connection string, a statement, a script file, another value, or none. */
type OptionKind = 'host' | 'address' | 'connection' | 'sql' | 'file' | 'value' | 'optional' | 'flag';

interface ClientSpec {
  /** Every option the client accepts, short (`-h`) and long (`--host`); anything else counts as hidden SQL. */
  options: Record<string, OptionKind>;
  /** What operands are: connection strings, the statement itself (`redis-cli FLUSHALL`), or nothing Guardian needs. */
  operands: 'connection' | 'command' | 'ignore';
  /** Environment variables naming the server when the command names none, addresses that always apply, and a service. */
  env?: string[];
  addressEnv?: string[];
  serviceEnv?: string[];
  /** Whether the client reaches a local server when nothing names one. */
  defaultLocal: boolean;
  /** Every invocation destroys data (`dropdb`), or runs statements Guardian cannot read (`pg_restore`). */
  destructive?: boolean;
  hidden?: boolean;
  /** Every target is a local file. */
  local?: boolean;
  /** Only this subcommand runs statements, as `cockroach sql`. */
  subcommand?: string;
  /** A startup file that can connect elsewhere before the statements run, and the flag that skips it. */
  startup?: { skip: string[]; files: (home: string) => boolean; env?: string };
}

const hasFile = (home: string, matches: (name: string) => boolean) => {
  try { return readdirSync(home).some(matches); } catch { return false; }
};

const options = (kind: OptionKind, ...names: string[]) => Object.fromEntries(names.map(name => [name, kind]));
const PG = { env: ['PGHOST'], addressEnv: ['PGHOSTADDR'], serviceEnv: ['PGSERVICE'] };
const PG_CONNECTION = { ...options('host', '-h', '--host'), ...options('value', '-p', '--port', '-U', '--username'), ...options('flag', '-w', '--no-password', '-W', '--password') };

const CLIENTS: Record<string, ClientSpec> = {
  psql: { ...PG, defaultLocal: true, operands: 'connection',
    startup: { skip: ['-X', '--no-psqlrc'], files: home => hasFile(home, name => name === '.psqlrc' || name.startsWith('.psqlrc-')), env: 'PSQLRC' },
    options: {
    ...PG_CONNECTION, ...options('connection', '-d', '--dbname'), ...options('sql', '-c', '--command'), ...options('file', '-f', '--file'),
    ...options('value', '-v', '--set', '--variable', '-o', '--output', '-L', '--log-file', '-P', '--pset', '-T', '--table-attr', '-F',
      '--field-separator', '-R', '--record-separator'),
    ...options('flag', '-a', '--echo-all', '-A', '--no-align', '-b', '--echo-errors', '-e', '--echo-queries', '-E', '--echo-hidden', '-n',
      '--no-readline', '-q', '--quiet', '-s', '--single-step', '-S', '--single-line', '-t', '--tuples-only', '-x', '--expanded', '-X', '--no-psqlrc',
      '-1', '--single-transaction', '-H', '--html', '-z', '--field-separator-zero', '-0', '--record-separator-zero', '--csv', '-l', '--list',
      '-V', '--version', '-?', '--help'),
  } },
  pgcli: { ...PG, defaultLocal: true, operands: 'connection', options: { ...PG_CONNECTION, ...options('connection', '-d', '--dbname', '-D', '--dsn') } },
  pg_restore: { ...PG, defaultLocal: true, operands: 'ignore', hidden: true, options: {
    ...PG_CONNECTION, ...options('connection', '-d', '--dbname'),
    ...options('value', '-f', '--file', '-F', '--format', '-j', '--jobs', '-n', '--schema', '-t', '--table', '-L', '--use-list', '-S', '--superuser'),
    ...options('flag', '-c', '--clean', '-C', '--create', '-1', '--single-transaction', '-e', '--exit-on-error', '-O', '--no-owner', '-x',
      '--no-privileges', '-v', '--verbose', '-a', '--data-only', '-s', '--schema-only', '--if-exists'),
  } },
  dropdb: { ...PG, defaultLocal: true, operands: 'ignore', destructive: true, options: {
    ...PG_CONNECTION, ...options('connection', '--maintenance-db'), ...options('flag', '-i', '--interactive', '-e', '--echo', '-f', '--force', '--if-exists'),
  } },
  dropuser: { ...PG, defaultLocal: true, operands: 'ignore', destructive: true, options: {
    ...PG_CONNECTION, ...options('flag', '-i', '--interactive', '-e', '--echo', '--if-exists'),
  } },
  // Option files such as ~/.my.cnf can name the host, so these are local only when the command names one.
  mysql: { env: ['MYSQL_HOST'], defaultLocal: false, operands: 'ignore', options: {
    ...options('host', '-h', '--host', '-S', '--socket'), ...options('sql', '-e', '--execute'), ...options('optional', '-p', '--password'),
    ...options('value', '-u', '--user', '-P', '--port', '-D', '--database', '--defaults-file', '--defaults-extra-file', '--login-path', '--protocol'),
    ...options('flag', '-B', '--batch', '-N', '--skip-column-names', '-s', '--silent', '-t', '--table', '-E', '--vertical', '-r', '--raw', '-v', '--verbose'),
  } },
  mongosh: { defaultLocal: true, operands: 'connection', startup: { skip: ['--norc', '--nodb'], files: home => existsSync(join(home, '.mongoshrc.js')) },
    options: {
    ...options('host', '--host'), ...options('sql', '--eval'), ...options('file', '-f', '--file'),
    ...options('value', '--port', '-u', '--username', '-p', '--password', '--authenticationDatabase'),
    ...options('flag', '--quiet', '--norc', '--nodb', '--shell', '--json', '--tls'),
  } },
  'redis-cli': { defaultLocal: true, operands: 'command', options: {
    ...options('host', '-h', '-s'), ...options('connection', '-u', '--uri'), ...options('file', '--eval', '-x'),
    ...options('value', '-p', '-a', '--user', '--pass', '-n', '-r', '-i'), ...options('flag', '--raw', '--no-raw', '--no-auth-warning', '--tls', '-c', '-e'),
  } },
  sqlcmd: { env: ['SQLCMDSERVER'], defaultLocal: true, operands: 'ignore', options: {
    ...options('host', '-S'), ...options('sql', '-Q', '-q'), ...options('file', '-i'), ...options('value', '-U', '-P', '-d'), ...options('flag', '-b', '-E', '-C'),
  } },
  'clickhouse-client': { env: ['CLICKHOUSE_HOST'], defaultLocal: false, operands: 'ignore', options: {
    ...options('host', '-h', '--host'), ...options('sql', '-q', '--query'), ...options('file', '--queries-file'),
    ...options('value', '--port', '-u', '--user', '--password', '-d', '--database'), ...options('flag', '-m', '--multiline', '-n', '--multiquery'),
  } },
  cockroach: { env: ['COCKROACH_HOST'], defaultLocal: true, operands: 'ignore', subcommand: 'sql', options: {
    ...options('host', '--host'), ...options('connection', '--url'), ...options('sql', '-e', '--execute'), ...options('file', '-f', '--file'),
    ...options('value', '--port', '-u', '--user', '-d', '--database', '--certs-dir'), ...options('flag', '--insecure'),
  } },
  usql: { defaultLocal: false, operands: 'connection', options: { ...options('sql', '-c', '--command'), ...options('file', '-f', '--file') } },
  sqlite3: { defaultLocal: true, operands: 'ignore', local: true, options: {} },
  litecli: { defaultLocal: true, operands: 'ignore', local: true, options: {} },
};
CLIENTS.mariadb = CLIENTS.mysql;
CLIENTS.mycli = { ...CLIENTS.mysql, operands: 'connection' };
CLIENTS.mongo = CLIENTS.mongosh;
CLIENTS.cockroach.env = ['COCKROACH_HOST', 'COCKROACH_URL'];

/** Frameworks that wipe a database configured in `.env` or `config/database.yml`, which Guardian does not read. */
const FRAMEWORK_WIPES: Record<string, (words: string[]) => boolean> = {
  prisma: words => (words[0] === 'migrate' && words[1] === 'reset')
    || (words[0] === 'db' && words[1] === 'push' && words.some(word => word === '--force-reset' || word === '--accept-data-loss')),
  rails: words => words.some(word => /^db:(drop|reset|purge)\b/.test(word)),
  rake: words => words.some(word => /^db:(drop|reset|purge)\b/.test(word)),
};
/** Words that run a package's binary, so `npx prisma` and `bundle exec rails` reach the framework. */
const RUNNERS = new Set(['npx', 'pnpx', 'bunx', 'yarn', 'pnpm', 'bun', 'npm', 'exec', 'x', 'dlx', 'bundle']);
const DESTRUCTIVE_STATEMENT = /\b(?:drop\s+(?:table|database|schema|view|materialized\s+view|index|sequence|function|type|extension|collection|user|role|owned)\b|truncate\b|delete\s+from\b|alter\s+table\b[^;]*\bdrop\b|flushall\b|flushdb\b|dropdatabase\b)|\.drop(?:Database)?\s*\(|\bdelete(?:Many|One)\s*\(|\.remove\s*\(/i;
const DESTRUCTIVE_REDIS = new Set(['flushall', 'flushdb', 'del', 'unlink', 'swapdb', 'migrate']);
/**
 * Statements that run other statements Guardian cannot read: psql's `\i` and `\gexec`, mysql's `source` and `\.`,
 * MongoDB's `load()`, and Redis's stored scripts and functions.
 */
const HIDDEN_META = /\\(?:i|ir|include|include_relative|gexec)\b|(?:^|;|\n)\s*(?:source|\\\.)\s|\bload\s*\(|^\s*(?:evalsha|evalsha_ro|fcall|fcall_ro)\b/i;
/**
 * Statements that move the session to another server or run a program: psql's `\connect`, shell escapes and
 * program pipes, mysql's `connect` and `system`, MongoDB's `connect()` and `new Mongo()`, and Redis's `MIGRATE`.
 * After one, the target is unproven.
 */
const RETARGET = /\\(?:c|connect|r)\b|\\!|\\copy\b[^\n]*\bprogram\b|\\o\s*\||\b(?:connect|Mongo)\s*\(|^\s*migrate\b|(?:^|;|\n)\s*(?:connect|system)\s/i;
const MENTION = new RegExp(`(^|[^A-Za-z0-9_-])(${[...Object.keys(CLIENTS), ...Object.keys(FRAMEWORK_WIPES)].join('|')})([^A-Za-z0-9_-]|$)`);
const programOf = (word: string) => word.replace(/^\\/, '').split('/').pop() ?? word;
/** Commands and redirections that write files, which could create a client's startup file before it runs. */
const WRITERS = new Set(['tee', 'cp', 'mv', 'ln', 'install', 'rsync', 'dd', 'curl', 'wget', 'git', 'tar', 'unzip', 'sed', 'perl', 'python', 'python3',
  'node', 'ruby']);
const OUTPUT_REDIRECT = /(^|[^<>&])>/;
const mentionsClient = (text: string) => MENTION.test(text);
/** A client name standing as a command inside text, as in `.shell psql -h …` or `\\! /usr/bin/psql`, not in `mysql.sock`. */
const COMMAND_MENTION = new RegExp(`(^|[\\s;|&!('"\`/])(${[...Object.keys(CLIENTS), ...Object.keys(FRAMEWORK_WIPES)].join('|')})(\\s|$)`);

/** Local hosts: loopback names and addresses, Unix socket directories, and libpq's empty host. */
export function isLocalHost(host: string): boolean {
  const bare = host.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  return bare === '' || bare === 'localhost' || bare.endsWith('.localhost') || bare === '::1' || /^127(\.\d{1,3}){3}$/.test(bare) || bare.startsWith('/');
}

const decode = (text: string) => { try { return decodeURIComponent(text); } catch { return text; } };
const withoutPort = (host: string) => host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:[^:]*$/, '');

interface Targets {
  /** Host names named explicitly; none means the client's environment or default decides. */
  hosts: string[];
  /** Network addresses (`hostaddr`), which libpq connects to whatever the host is called. */
  addresses: string[];
  /** A service, whose host lives in a file Guardian does not read. */
  service: boolean;
}

/** Where libpq connects: each entry's address when it has a non-empty one, otherwise its host. */
function effectiveHosts(targets: Pick<Targets, 'hosts' | 'addresses'>): string[] {
  const count = Math.max(targets.hosts.length, targets.addresses.length);
  return Array.from({ length: count }, (_, index) => targets.addresses[index] || (targets.hosts[index] ?? targets.addresses[index] ?? ''));
}

/**
 * The servers a connection value names, as libpq reads it: a URI's hosts are split on commas, percent-decoded, and
 * split again, so an encoded comma adds a host; query parameters are decoded before they are matched; a keyword
 * string's `host` and `hostaddr` lists count, and a `service` cannot be followed. Other clients' URIs read the same
 * way, and a MongoDB-style `host/db` address names its host. A plain database name names no server.
 */
export function connectionTargets(value: string): Targets {
  const targets: Targets = { hosts: [], addresses: [], service: false };
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
      if (key === 'host') targets.hosts.push(...parameter.split(','));
      if (key === 'hostaddr') targets.addresses.push(...parameter.split(','));
      if (key === 'service') targets.service = true;
    }
    return targets;
  }
  if (!value.includes('=')) {
    const address = /^([^\s/=]+)\/[^\s]*$/.exec(value);
    if (address) targets.hosts.push(withoutPort(address[1]));
    return targets;
  }
  for (const match of value.matchAll(/([A-Za-z_]+)\s*=\s*(?:'((?:\\.|[^'\\])*)'|(\S*))/g)) {
    const key = match[1].toLowerCase(), parameter = (match[2] ?? match[3] ?? '').replace(/\\(.)/g, '$1');
    if (key === 'host') targets.hosts.push(...parameter.split(','));
    if (key === 'hostaddr') targets.addresses.push(...parameter.split(','));
    if (key === 'service') targets.service = true;
  }
  return targets;
}

/** A script Guardian cannot evaluate exactly: control flow, substitutions, unset or unusual variables. */
class Unreadable extends Error {}

type Lookup = (name: string) => string | undefined;
/** `$0`, `$1`… of the script being evaluated: none for `bash -lc`, the trailing arguments for `sh -c SCRIPT ARG0 ARG1`. */
type Positional = readonly string[];

interface Evaluated {
  argv: string[];
  /** Assignments before the command name, exported to it. */
  env: Map<string, string>;
  /** Standard input comes from a pipe, file, heredoc or here-string rather than the terminal. */
  fed: boolean;
}

function unquotedWord(text: string): string {
  // Globs, brace expansion and tilde expansion would change the argument.
  if (/[*?[]|^~|\{[^}]*(,|\.\.)[^}]*\}/.test(text) || /\\$/.test(text)) throw new Unreadable();
  return text.replace(/\\(.)/gs, '$1');
}

function expansionValue(node: Node, lookup: Lookup, positional: Positional): string {
  const named = node.namedChildren.filter((child): child is Node => !!child);
  if (node.type === 'expansion' && (named.length !== 1 || named[0].type !== 'variable_name' || node.text !== `\${${named[0].text}}`)) throw new Unreadable();
  const name = named[0];
  if (!name) throw new Unreadable();
  if (/^\d+$/.test(name.text)) return positional[Number(name.text)] ?? '';
  if (name.type === 'special_variable_name') {
    // `$@` and `$*` would become several arguments; joined they could misplace a target.
    if (name.text === '@' || name.text === '*') { if (positional.length > 1) throw new Unreadable(); return ''; }
    return name.text === '#' ? String(Math.max(0, positional.length - 1)) : name.text === '$' ? '1' : name.text === '?' ? '0' : '';
  }
  const value = lookup(name.text);
  if (value === undefined) throw new Unreadable();
  return value;
}

function stringValue(node: Node, lookup: Lookup, positional: Positional): string {
  let value = '';
  for (const part of node.children) {
    if (!part || part.type === '"') continue;
    if (part.type === 'string_content') value += part.text.replace(/\\\n/g, '').replace(/\\([$`"\\])/g, '$1');
    else if (part.type === 'simple_expansion' || part.type === 'expansion') value += expansionValue(part, lookup, positional);
    else throw new Unreadable();
  }
  return value;
}

/** The arguments one syntax node becomes: unquoted expansions split on whitespace, quoted text kept whole. */
function argumentValues(node: Node, lookup: Lookup, positional: Positional): string[] {
  switch (node.type) {
    case 'word': case 'number': return [unquotedWord(node.text)];
    case 'raw_string': return [node.text.slice(1, -1)];
    case 'string': return [stringValue(node, lookup, positional)];
    case 'simple_expansion': case 'expansion': {
      const value = expansionValue(node, lookup, positional);
      if (/[*?[]/.test(value)) throw new Unreadable();
      return value.split(/[ \t\n]+/).filter(Boolean);
    }
    case 'concatenation': {
      let value = '';
      for (const part of node.namedChildren) {
        if (!part) continue;
        const values = part.type === 'simple_expansion' || part.type === 'expansion' ? [expansionValue(part, lookup, positional)] : argumentValues(part, lookup, positional);
        if (values.length !== 1 || ((part.type === 'simple_expansion' || part.type === 'expansion') && /[\s*?[]/.test(values[0]))) throw new Unreadable();
        value += values[0];
      }
      return [value];
    }
    default: throw new Unreadable();
  }
}

/** Every command of a script with its arguments as bash passes them, or undefined when the script cannot be evaluated exactly. */
function evaluateScript(shell: Shell, script: string, lookup: Lookup, positional: Positional): Evaluated[] | undefined {
  return shell.parseTree(script, root => {
    const commands: Evaluated[] = [];
    // A redirection target is evaluated like an argument, so a substitution there is as unreadable as anywhere.
    const feeds = (redirect: Node): boolean => {
      switch (redirect.type) {
        case 'file_redirect': {
          for (const target of redirect.namedChildren) if (target && target.type !== 'file_descriptor') argumentValues(target, lookup, positional);
          return redirect.children.some(token => !!token && !token.isNamed && token.type.startsWith('<'));
        }
        case 'heredoc_redirect':
          if (redirect.descendantsOfType(['command_substitution', 'process_substitution', 'simple_expansion', 'expansion', 'arithmetic_expansion']).length) {
            throw new Unreadable();
          }
          return true;
        case 'herestring_redirect':
          for (const target of redirect.namedChildren) if (target) argumentValues(target, lookup, positional);
          return true;
        default: throw new Unreadable();
      }
    };
    const visit = (node: Node, fed: boolean) => {
      switch (node.type) {
        case 'program': case 'list':
          for (const child of node.namedChildren) if (child) visit(child, fed);
          return;
        case 'pipeline':
          node.namedChildren.forEach((child, index) => { if (child) visit(child, fed || index > 0); });
          return;
        case 'redirected_statement': {
          const [body, ...redirects] = node.namedChildren;
          let input = fed;
          for (const redirect of redirects) if (redirect && feeds(redirect)) input = true;
          if (body) visit(body, input);
          return;
        }
        case 'comment': return;
        case 'command': {
          const env = new Map<string, string>(), argv: string[] = [];
          let input = fed;
          for (const child of node.namedChildren) {
            if (!child || child.type === 'comment') continue;
            if (child.type.endsWith('_redirect')) { if (feeds(child)) input = true; continue; }
            if (child.type === 'variable_assignment') {
              const [name, value] = child.namedChildren;
              if (!name) throw new Unreadable();
              const values = value ? argumentValues(value, lookup, positional) : [''];
              env.set(name.text, values.join(' '));
            } else if (child.type === 'command_name') {
              const name = child.namedChildren[0];
              if (!name) throw new Unreadable();
              argv.push(...argumentValues(name, lookup, positional));
            } else {
              argv.push(...argumentValues(child, lookup, positional));
            }
          }
          commands.push({ argv, env, fed: input });
          return;
        }
        default: throw new Unreadable();
      }
    };
    try {
      visit(root, false);
    } catch (error) {
      if (error instanceof Unreadable) return undefined;
      throw error;
    }
    return commands;
  });
}

interface Invocation {
  local: boolean;
  /** Visible statements include a destructive one, or the tool always destroys data. */
  destructive: boolean;
  /** Some statements come from a file, standard input, a meta-command or an option Guardian does not know. */
  hidden: boolean;
}

/**
 * What decides whether a client's startup file is trustworthy: Pi's own `HOME` and startup variables, and whether
 * the script writes files, since it could create the startup file before the client starts.
 */
interface StartupContext {
  root: Lookup;
  writes: boolean;
}

/** Reads a client's arguments as getopt does, including clustered short options such as `-qc`. */
function analyzeClient(spec: ClientSpec, args: readonly string[], lookup: Lookup, context: StartupContext): Invocation {
  if (spec.local) return { local: true, destructive: false, hidden: false };
  if (spec.subcommand) {
    if (args[0] !== spec.subcommand) return { local: true, destructive: false, hidden: false };
    args = args.slice(1);
  }
  const hosts: string[] = [], addresses: string[] = [], statements: string[] = [];
  let service = false, hidden = !!spec.hidden, sawSql = false, operandsOnly = false, skipsStartup = false;
  const apply = (kind: OptionKind, value: string) => {
    if (kind === 'host') hosts.push(...value.split(','));
    else if (kind === 'connection') {
      const targets = connectionTargets(value);
      hosts.push(...targets.hosts);
      addresses.push(...targets.addresses);
      service ||= targets.service;
    }
    else if (kind === 'sql') { statements.push(value); sawSql = true; }
    else if (kind === 'file') hidden = true;
  };
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (!operandsOnly && word === '--') { operandsOnly = true; continue; }
    if (!operandsOnly && word.startsWith('--')) {
      const equals = word.indexOf('=');
      const name = equals === -1 ? word : word.slice(0, equals);
      const kind = spec.options[name];
      if (spec.startup?.skip.includes(name)) skipsStartup = true;
      if (kind === undefined) { hidden = true; continue; }
      if (kind === 'flag' || kind === 'optional') continue;
      apply(kind, equals === -1 ? args[++index] ?? '' : word.slice(equals + 1));
      continue;
    }
    if (!operandsOnly && word.startsWith('-') && word.length > 1) {
      for (let position = 1; position < word.length; position++) {
        const kind = spec.options[`-${word[position]}`];
        if (spec.startup?.skip.includes(`-${word[position]}`)) skipsStartup = true;
        if (kind === undefined) { hidden = true; break; }
        if (kind === 'flag') continue;
        const attached = word.slice(position + 1);
        if (kind === 'optional') break;
        apply(kind, attached || (args[++index] ?? ''));
        break;
      }
      continue;
    }
    if (spec.operands === 'command') { statements.push(word); sawSql = true; }
    else if (/\.js$/.test(word)) hidden = true;
    else if (spec.operands === 'connection') apply('connection', word);
  }
  for (const name of spec.serviceEnv ?? []) if (lookup(name) !== undefined) service = true;
  const fromEnv = (names: string[] | undefined) => (names ?? []).flatMap(name => {
    const value = lookup(name);
    if (value === undefined) return [];
    if (value.includes('://') || value.includes('=')) { const targets = connectionTargets(value); service ||= targets.service; return effectiveHosts(targets); }
    return value.split(',');
  });
  // Each setting falls back to its own environment variable, as libpq resolves `host` and `hostaddr`.
  if (!hosts.length) hosts.push(...fromEnv(spec.env));
  if (!addresses.length) addresses.push(...fromEnv(spec.addressEnv));
  const targets = effectiveHosts({ hosts, addresses });
  if (!sawSql && !spec.destructive) hidden = true;
  if (statements.some(statement => HIDDEN_META.test(statement))) hidden = true;
  const destructive = !!spec.destructive || statements.some(statement => DESTRUCTIVE_STATEMENT.test(statement))
    || (spec.operands === 'command' && DESTRUCTIVE_REDIS.has((statements[0] ?? '').toLowerCase()));
  const retargets = statements.some(statement => RETARGET.test(statement));
  // A startup file runs before the statements and can connect elsewhere; one the command points at is the agent's.
  // Without HOME, as under `env -i`, the client falls back to the account's home directory.
  const chosenHome = lookup('HOME');
  const startup = !!spec.startup && !skipsStartup && ((spec.startup.env !== undefined && lookup(spec.startup.env) !== undefined)
    || (chosenHome !== undefined && chosenHome !== context.root('HOME')) || context.writes || spec.startup.files(chosenHome ?? homedir()));
  const local = !service && !retargets && !startup && (targets.length ? targets.every(isLocalHost) : spec.defaultLocal);
  return { local, destructive, hidden: hidden || retargets };
}

/** A wrapper's options, as its manual lists them; anything else makes the wrapped command unreadable. */
interface WrapperSpec {
  valued?: string[];
  flags?: string[];
  /** Words after the options that are not the command, as `timeout`'s duration. */
  fixed?: number;
  /** Options after which the rest runs through a shell that escapes each argument, as `sudo -s`. */
  shell?: string[];
  /** Options after which nothing runs, as `command -v`. */
  inert?: string[];
  /** `NAME=VALUE` words set the command's environment, as for `env`. */
  assignments?: boolean;
}

const WRAPPERS: Record<string, WrapperSpec> = {
  sudo: {
    valued: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type',
      '-U', '--other-user', '-T', '--command-timeout'],
    flags: ['-A', '--askpass', '-b', '--background', '-E', '--preserve-env', '-H', '--set-home', '-k', '--reset-timestamp', '-n', '--non-interactive',
      '-P', '--preserve-groups', '-S', '--stdin', '-B', '--bell', '-N', '--no-update'],
    shell: ['-s', '--shell', '-i', '--login'], inert: ['-l', '--list', '-v', '--validate', '-V', '--version', '-e', '--edit'],
  },
  // `env -S` re-splits a string with its own quoting rules, so it is outside the grammar.
  env: { valued: ['-u', '--unset', '-C', '--chdir'], flags: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '-'], assignments: true },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], flags: ['--preserve-status', '--foreground', '-v', '--verbose'], fixed: 1 },
  nice: { valued: ['-n', '--adjustment'] },
  nohup: {},
  command: { flags: ['-p'], inert: ['-v', '-V'] },
  time: { flags: ['-p'] },
};

type Unwrapped = { argv: string[] } | 'unknown';

/** The command a wrapper runs, with the environment it sets; undefined when the word is not a wrapper. */
function unwrap(argv: readonly string[], env: Map<string, string>): Unwrapped | undefined {
  const spec = WRAPPERS[programOf(argv[0] ?? '')];
  if (!spec) return undefined;
  const has = (list: string[] | undefined, name: string) => list?.includes(name) ?? false;
  let index = 1;
  for (; index < argv.length; index++) {
    const word = argv[index];
    if (word === '--') { index++; break; }
    if (spec.assignments && /^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) { env.set(word.slice(0, word.indexOf('=')), word.slice(word.indexOf('=') + 1)); continue; }
    if (!word.startsWith('-') || (word === '-' && !has(spec.flags, '-'))) break;
    if (has(spec.inert, word)) return { argv: [] };
    // `sudo -s` escapes each argument for the shell, so the command keeps its arguments.
    if (has(spec.shell, word)) return { argv: argv.slice(index + 1) };
    if (has(spec.valued, word)) {
      const value = argv[++index] ?? '';
      if (word === '-u' || word === '--unset') env.set(value, '');
      continue;
    }
    const equals = word.indexOf('=');
    if (word.startsWith('--') && equals !== -1 && has(spec.valued, word.slice(0, equals))) {
      if (word.startsWith('--unset=')) env.set(word.slice(equals + 1), '');
      continue;
    }
    if (has(spec.flags, word)) {
      // A cleared environment drops what the command line assigned before it, too.
      if (word === '-i' || word === '--ignore-environment' || word === '-') { env.clear(); env.set('\0cleared', '1'); }
      continue;
    }
    if (programOf(argv[0]) === 'nice' && /^-\d+$/.test(word)) continue;
    return 'unknown';
  }
  return { argv: argv.slice(index + (spec.fixed ?? 0)) };
}

/** Builtins that never run or read their arguments as commands; `set` forms that do are caught first. */
const NEUTRAL = new Set(['cd', 'pwd', 'true', 'false', ':', 'sleep', 'test', '[', 'set', 'unset']);

/** A read-only tool's options: every option is allowed, or only these flags and options with a value. */
interface ReaderSpec {
  any?: boolean;
  flags?: string[];
  valued?: string[];
}

const flags = (short: string, ...long: string[]) => [...short].map(letter => `-${letter}`).concat(long);
/**
 * Read-only tools a script involving a client may also run, with the options that keep them read-only. Options that
 * start programs, such as ripgrep's `--pre` or `--search-zip`, and anything unlisted make the command unknown.
 */
const READERS: Record<string, ReaderSpec> = {
  rg: {
    flags: flags('nilwxFcvohHsSuLNqaU0', '--line-number', '--ignore-case', '--smart-case', '--case-sensitive', '--word-regexp', '--line-regexp',
      '--fixed-strings', '--count', '--count-matches', '--invert-match', '--only-matching', '--no-filename', '--with-filename', '--quiet', '--text',
      '--files', '--files-with-matches', '--files-without-match', '--hidden', '--no-ignore', '--follow', '--no-heading', '--heading', '--vimgrep',
      '--json', '--column', '--null', '--trim', '--multiline', '--pcre2', '--unrestricted', '--no-messages', '--stats', '--sort-files', '--no-line-number'),
    valued: flags('egtTABCmdMfrj', '--regexp', '--glob', '--iglob', '--type', '--type-not', '--after-context', '--before-context', '--context',
      '--max-count', '--max-depth', '--sort', '--sortr', '--max-columns', '--color', '--colors', '--file', '--replace', '--threads', '--max-filesize',
      '--context-separator', '--field-match-separator', '--path-separator'),
  },
  grep: {
    flags: flags('nirRlLwxFEGPcvohHqsIaUZz', '--line-number', '--ignore-case', '--recursive', '--dereference-recursive', '--files-with-matches',
      '--files-without-match', '--word-regexp', '--line-regexp', '--fixed-strings', '--extended-regexp', '--basic-regexp', '--perl-regexp', '--count',
      '--invert-match', '--only-matching', '--no-filename', '--with-filename', '--quiet', '--silent', '--no-messages', '--text', '--null', '--null-data'),
    valued: flags('eABCmfdD', '--regexp', '--after-context', '--before-context', '--context', '--max-count', '--file', '--include', '--exclude',
      '--exclude-dir', '--color', '--colour', '--directories', '--devices', '--label'),
  },
  cat: { flags: flags('nbAeEstTvu') },
  head: { flags: flags('qv'), valued: flags('nc', '--lines', '--bytes') },
  tail: { flags: flags('qvfF'), valued: flags('nc', '--lines', '--bytes') },
  wc: { flags: flags('lwcmL') },
  sort: { flags: flags('nrufbdghiMRV'), valued: flags('kt', '--key', '--field-separator') },
  uniq: { flags: flags('cdui'), valued: flags('fsw') },
  cut: { flags: flags('s'), valued: flags('dfcb', '--delimiter', '--fields', '--characters', '--bytes') },
  echo: { flags: flags('neE') },
  printf: {},
  ls: { any: true }, which: { any: true }, type: { any: true }, whereis: { any: true }, file: { any: true }, stat: { any: true },
  diff: { any: true }, jq: { any: true },
  // `man -P` names a pager to run, so only the page names are allowed.
  man: {},
};
READERS.egrep = READERS.grep;
READERS.fgrep = READERS.grep;
/**
 * `git` subcommands that do not run commands they are given; `rebase --exec`, `bisect run`, `submodule foreach`,
 * `difftool`, `config` and the like are not among them. Options that start programs are refused wherever they appear.
 */
const GIT_READS = new Set(['log', 'show', 'diff', 'status', 'grep', 'blame', 'ls-files', 'rev-parse', 'branch', 'shortlog', 'commit', 'add', 'restore',
  'switch', 'checkout', 'stash', 'fetch', 'pull', 'push', 'tag', 'remote', 'reset', 'rm', 'mv', 'init', 'clone', 'describe', 'revert', 'cherry-pick']);
const GIT_RUNS = new Set(['--ext-diff', '--textconv', '-O', '--open-files-in-pager', '--exec', '-x', '--upload-pack', '--receive-pack', '-u',
  '--config', '--template']);
/** Package managers, and the subcommands that only install, remove or describe packages by name. */
const PACKAGE_MANAGERS: Record<string, Set<string>> = {
  brew: new Set(['install', 'uninstall', 'remove', 'upgrade', 'info', 'search', 'list', 'reinstall']),
  apt: new Set(['install', 'remove', 'purge', 'search', 'show', 'list']),
  'apt-get': new Set(['install', 'remove', 'purge']),
  pip: new Set(['install', 'uninstall', 'show', 'list', 'download']),
  pip3: new Set(['install', 'uninstall', 'show', 'list', 'download']),
  pipx: new Set(['install', 'uninstall', 'list']),
  npm: new Set(['install', 'i', 'ci', 'uninstall', 'remove', 'view', 'info', 'ls', 'list', 'outdated']),
  pnpm: new Set(['add', 'install', 'i', 'remove', 'list', 'ls', 'outdated']),
  yarn: new Set(['add', 'install', 'remove', 'list', 'info']),
  bun: new Set(['add', 'install', 'i', 'remove']),
  cargo: new Set(['install', 'uninstall', 'add', 'remove']),
  gem: new Set(['install', 'uninstall', 'list']),
};

/** Whether a command is a read-only tool used only with options that keep it read-only. */
function readsOnly(argv: readonly string[]): boolean {
  const program = programOf(argv[0] ?? '');
  const args = argv.slice(1);
  if (program === 'git') {
    // `git -c …` sets configuration that can start programs, so the subcommand must come first.
    return GIT_READS.has(args[0] ?? '') && !args.some(arg => GIT_RUNS.has(arg.split('=')[0]));
  }
  if (PACKAGE_MANAGERS[program]) {
    const subcommand = args.find(arg => !arg.startsWith('-'));
    return !!subcommand && PACKAGE_MANAGERS[program].has(subcommand);
  }
  if (program === 'pacman' || program === 'yay') return args.every(arg => !arg.startsWith('-') || /^-[SRQsiyu]+$/.test(arg));
  if (program === 'sed') {
    // Only printing, deleting and quitting by line number, as `sed -n '1,10p'`; `e` and `w` run or write.
    const script = args.filter(arg => !/^-[nEr]+$/.test(arg));
    return script.length <= 2 && /^[\d,$;\s]*[pdq=]?(;[\d,$\s]*[pdq=])*$/.test(script[0] ?? '') && script.slice(1).every(arg => !arg.startsWith('-'));
  }
  const spec = READERS[program];
  if (!spec) return false;
  if (spec.any) return true;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--') break;
    if (!arg.startsWith('-') || arg === '-') continue;
    if (program === 'printf' || program === 'man') return false;
    const equals = arg.indexOf('=');
    const name = arg.startsWith('--') && equals !== -1 ? arg.slice(0, equals) : arg;
    if (spec.flags?.includes(name)) continue;
    if (spec.valued?.includes(name)) { if (equals === -1) index++; continue; }
    if (!arg.startsWith('--')) {
      // A short cluster: flags, then at most one option whose value is attached or follows.
      let ok = true;
      for (let position = 1; position < arg.length; position++) {
        const option = `-${arg[position]}`;
        if (spec.flags?.includes(option)) continue;
        if (spec.valued?.includes(option)) { if (position === arg.length - 1) index++; break; }
        ok = false;
        break;
      }
      if (ok) continue;
    }
    return false;
  }
  return true;
}

/**
 * Commands that change what later commands see: variables (`source`, `read`, `set -a`, `printf -v`), positional
 * parameters (`set --`), command lookup (`alias`, `hash`) or standard input (`exec <file`).
 */
function changesLaterCommands(argv: readonly string[]): boolean {
  const program = programOf(argv[0] ?? '');
  const args = argv.slice(1);
  switch (program) {
    case 'source': case '.': case 'read': case 'mapfile': case 'readarray': case 'getopts': case 'let': case 'alias': case 'shopt': case 'hash':
    case 'enable': case 'trap': case 'exec': case 'eval':
      return true;
    case 'set':
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--' || !/^[-+]/.test(arg) || /^-[A-Za-z]*a/.test(arg)) return true;
        if (/^[-+][A-Za-z]*o$/.test(arg) && args[++index] === 'allexport' && arg.startsWith('-')) return true;
      }
      return false;
    default: return false;
  }
}

const CLIENT_NAME = new RegExp(`(${[...Object.keys(CLIENTS), ...Object.keys(FRAMEWORK_WIPES)].join('|')})`);
/**
 * Whether an evaluated script involves a database client or framework wipe anywhere in its words, including one
 * glued to an option, as in `env -S"psql …"`.
 */
const involvesClient = (commands: readonly Evaluated[]) => commands.some(command =>
  command.argv.some(word => mentionsClient(word) || (word.startsWith('-') && CLIENT_NAME.test(word))) || [...command.env.values()].some(mentionsClient));

/** Whether a script that involves a client must be refused. */
function refuse(commands: readonly Evaluated[], root: Lookup, script: string): boolean {
  const context: StartupContext = { root, writes: OUTPUT_REDIRECT.test(script) || commands.some(command => WRITERS.has(programOf(command.argv[0] ?? ''))) };
  for (const command of commands) {
    if (changesLaterCommands(command.argv)) return true;
    const env = new Map(command.env);
    let argv = command.argv;
    let wrapped: Unwrapped | undefined = unwrap(argv, env);
    for (; wrapped && wrapped !== 'unknown'; wrapped = unwrap(argv, env)) argv = wrapped.argv;
    if (wrapped === 'unknown') return true;
    if (!argv.length) continue;
    // Assignments reach the command they prefix; `env -i` drops the rest.
    const lookup: Lookup = name => env.has(name) ? env.get(name) || undefined : env.has('\0cleared') ? undefined : root(name);
    const program = programOf(argv[0]);

    const frameworkAt = argv.findIndex(word => FRAMEWORK_WIPES[programOf(word)] !== undefined);
    if (frameworkAt !== -1 && argv.slice(0, frameworkAt).every(word => RUNNERS.has(programOf(word)) || word.startsWith('-'))) {
      if (!FRAMEWORK_WIPES[programOf(argv[frameworkAt])](argv.slice(frameworkAt + 1))) continue;
      const url = lookup('DATABASE_URL');
      const targets = url === undefined ? undefined : connectionTargets(url);
      if (!targets || targets.service || !effectiveHosts(targets).length || !effectiveHosts(targets).every(isLocalHost)) return true;
      continue;
    }
    const spec = CLIENTS[program];
    if (spec) {
      // A client can run another one it names, as `sqlite3 db ".shell psql …"` or mysql's `system psql …`.
      if (argv.slice(1).some(arg => COMMAND_MENTION.test(arg))) return true;
      const invocation = analyzeClient(spec, argv.slice(1), lookup, context);
      if (!invocation.local && (invocation.destructive || invocation.hidden)) return true;
      continue;
    }
    if (NEUTRAL.has(program) || readsOnly(argv)) continue;
    // Any other program could run a client Guardian cannot see, so it does not share a script with one.
    return true;
  }
  return false;
}

export type DatabaseDecision = 'forbidden' | undefined;

/**
 * Whether a database command must be refused: one that may run destructive or unseen SQL against a target Guardian
 * cannot prove local, or one sharing its script with a command Guardian cannot judge. Scripts that involve no
 * database client are left alone.
 */
export function databaseDecision(shell: Shell, command: readonly string[], env: NodeJS.ProcessEnv = process.env): DatabaseDecision {
  const script = shell.extractBashCommand(command)?.[1] ?? command.join(' ');
  const root: Lookup = name => env[name];
  const commands = evaluateScript(shell, script, root, []);
  if (!commands) return mentionsClient(script) ? 'forbidden' : undefined;
  if (!involvesClient(commands)) return undefined;
  return refuse(commands, root, script) ? 'forbidden' : undefined;
}
