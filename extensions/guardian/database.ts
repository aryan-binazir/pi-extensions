// Ar's boundary for destructive database operations. A command rarely names a Railway database: its target
// usually comes from credentials such as `$DATABASE_URL`. A database command runs against a target Guardian cannot
// prove local only when all of its SQL is visible and none of it is destructive; anything else that could reach
// such a target is refused outright, like the Railway boundary.
//
// Guardian evaluates the script with the bash grammar: each command's arguments as bash would pass them, with Pi's
// environment substituted only where bash expands, nested shells and `eval` parsed again, and each client's options
// read the way the client reads them. What it cannot evaluate exactly counts as unproven. Never verified against a
// real database.
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
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);
/** Commands whose operands Guardian cannot follow, so a client they run may get arguments from elsewhere. */
const OPAQUE = new Set(['xargs', 'find', 'parallel', 'watch']);
/** Prefixes that run the client on another machine or in a container, where "localhost" is not this machine. */
const REMOTE = new Set(['ssh', 'kubectl', 'oc', 'heroku', 'fly', 'flyctl', 'gcloud', 'az', 'aws', 'doctl', 'render', 'railway', 'docker',
  'podman', 'nerdctl', 'docker-compose']);

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
/** Text that may destroy data or hide statements, for scripts Guardian cannot evaluate exactly. */
const RISK_MARKERS = /<|\||(^|\s)(-f|--file|-i|--eval|-x)(\s|=|$)|\\i\b|\b(migrate\s+reset|db:(drop|reset|purge)|force-reset|accept-data-loss|dropdb|dropuser|pg_restore)\b|[$`]/;

const programOf = (word: string) => word.replace(/^\\/, '').split('/').pop() ?? word;
/** Commands and redirections that write files, which could create a client's startup file before it runs. */
const WRITERS = new Set(['tee', 'cp', 'mv', 'ln', 'install', 'rsync', 'dd', 'curl', 'wget', 'git', 'tar', 'unzip', 'sed', 'perl', 'python', 'python3',
  'node', 'ruby']);
const OUTPUT_REDIRECT = /(^|[^<>&])>/;
const mentionsClient = (text: string) => MENTION.test(text);
const risky = (text: string) => DESTRUCTIVE_STATEMENT.test(text) || RISK_MARKERS.test(text);

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

/**
 * The script a shell runs with `-c`, as `bash -euc SCRIPT`, and the arguments that follow it, which become `$0`,
 * `$1`…; undefined when the shell reads a file or standard input.
 */
function shellScript(args: readonly string[]): { script: string; positional: string[] } | undefined {
  let command = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index];
    if (word === '-o' || word === '+o') { index++; continue; }
    if (/^[-+][A-Za-z]+$/.test(word)) { if (word.slice(1).includes('c')) command = true; continue; }
    return command ? { script: word, positional: args.slice(index + 1) } : undefined;
  }
  return undefined;
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
  // `env -S` re-splits a string with its own quoting rules; it is not in the grammar, so it refuses beside a client.
  env: { valued: ['-u', '--unset', '-C', '--chdir'], flags: ['-i', '--ignore-environment', '-0', '--null', '-v', '--debug', '-'], assignments: true },
  timeout: { valued: ['-s', '--signal', '-k', '--kill-after'], flags: ['--preserve-status', '--foreground', '-v', '--verbose'], fixed: 1 },
  nice: { valued: ['-n', '--adjustment'] },
  ionice: { valued: ['-c', '--class', '-n', '--classdata'], flags: ['-t', '--ignore'] },
  stdbuf: { valued: ['-i', '--input', '-o', '--output', '-e', '--error'] },
  nohup: {},
  setsid: { flags: ['-c', '--ctty', '-f', '--fork', '-w', '--wait'] },
  command: { flags: ['-p'], inert: ['-v', '-V'] },
  exec: { valued: ['-a'], flags: ['-c', '-l'] },
  builtin: {},
  time: { valued: ['-f', '--format', '-o', '--output'], flags: ['-p', '-a', '--append', '-v', '--verbose', '-q', '--quiet'] },
};
/**
 * Runners that start a command they are given, often with secrets in its environment (`doppler run`, `op run`,
 * `aws-vault exec`), so a client they start has an unproven target.
 */
/** Commands that read or show their arguments and input and never run them, so a client name there is only text. */
const READERS = new Set(['grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'cat', 'bat', 'head', 'tail', 'which', 'whereis', 'type', 'echo', 'printf', 'wc',
  'sort', 'uniq', 'cut', 'diff', 'ls', 'file', 'stat', 'tldr', 'jq']);
/**
 * Commands that change what later commands see: variables (`source`, `read`, `set -a`, `printf -v`), positional
 * parameters (`set --`), command lookup (`alias`, `hash`) or standard input (`exec <file`). After one, a client's
 * target and statements are unproven.
 */
function changesLaterCommands(argv: readonly string[]): boolean {
  const [program, ...args] = argv.map((word, index) => index === 0 ? programOf(word) : word);
  switch (program) {
    case 'source': case '.': case 'read': case 'mapfile': case 'readarray': case 'getopts': case 'let': case 'alias': case 'shopt': case 'hash':
    case 'enable': case 'trap':
      return true;
    case 'set': {
      // `-o NAME` names an option; `-a`/allexport exports later assignments, and `--` or other words set `$1`….
      for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        if (arg === '--' || !/^[-+]/.test(arg)) return true;
        if (/^-[A-Za-z]*a/.test(arg)) return true;
        if (/^[-+][A-Za-z]*o$/.test(arg) && args[++index] === 'allexport' && arg.startsWith('-')) return true;
      }
      return false;
    }
    case 'printf': return args.includes('-v');
    case 'exec': return args.every(arg => /^\d*[<>]/.test(arg));
    default: return false;
  }
}
const RUNNERS_WITH_ENV = new Set(['doppler', 'op', 'infisical', 'aws-vault', 'dotenv', 'dotenvx', 'direnv', 'envdir', 'envconsul', 'chamber', 'teller',
  'sops', 'with-env', 'flock', 'chronic', 'unbuffer', 'caffeinate', 'doas', 'pkexec', 'chroot', 'strace', 'ltrace', 'valgrind', 'firejail',
  'nix-shell', 'systemd-run', 'scl', 'conda', 'poetry', 'uv', 'pipenv', 'mise', 'asdf', 'rtx', 'devbox']);

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
    const equals = word.startsWith('--') ? word.indexOf('=') : -1;
    const name = equals === -1 ? word : word.slice(0, equals);
    const attached = !word.startsWith('--') && word.length > 2 ? word.slice(2) : undefined;
    const short = attached === undefined ? name : word.slice(0, 2);
    if (has(spec.inert, name)) return { argv: [] };
    // `sudo -s` escapes each argument for the shell, so the command keeps its arguments.
    if (has(spec.shell, name)) return { argv: argv.slice(index + 1) };
    if (has(spec.valued, name) && equals === -1) {
      const value = argv[++index] ?? '';
      if (name === '-u' || name === '--unset') env.set(value, '');
      continue;
    }
    if (has(spec.valued, name) || has(spec.valued, short)) {
      if ((short === '-u' || name === '--unset')) env.set(equals !== -1 ? word.slice(equals + 1) : attached ?? '', '');
      continue;
    }
    if (has(spec.flags, name)) {
      // A cleared environment drops what the command line assigned before it, too.
      if (name === '-i' || name === '--ignore-environment' || name === '-') { env.clear(); env.set('\0cleared', '1'); }
      continue;
    }
    if (programOf(argv[0]) === 'nice' && /^-\d+$/.test(word)) continue;
    return 'unknown';
  }
  return { argv: argv.slice(index + (spec.fixed ?? 0)) };
}

const MAX_DEPTH = 8;

/** Whether any command in an evaluated script must be refused. `remote` means "localhost" is another machine. */
function refuse(shell: Shell, commands: readonly Evaluated[], outer: Lookup, positional: Positional, remote: boolean, depth: number, script: string, root: Lookup): boolean {
  if (depth > MAX_DEPTH) return true;
  const context: StartupContext = { root, writes: OUTPUT_REDIRECT.test(script) || commands.some(command => WRITERS.has(programOf(command.argv[0] ?? ''))) };
  // A client named in one command's arguments can be run by another reading it, as `echo "psql …" | at now`.
  const named = commands.some(command => command.argv.slice(1).some(mentionsClient));
  if (named && commands.some(command => command.fed && !READERS.has(programOf(command.argv[0] ?? '')) && !CLIENTS[programOf(command.argv[0] ?? '')])) return true;
  let changed = false;
  for (const command of commands) {
    // What runs after a command that changes variables, parameters or input is judged as if on another machine.
    const unproven = remote || changed;
    if (changesLaterCommands(command.argv)) { changed = true; continue; }
    const env = new Map(command.env);
    let argv = command.argv;
    // Assignments reach the command they prefix, and a nested shell inherits them; `env -i` drops the rest.
    const lookup: Lookup = name => env.has(name) ? env.get(name) || undefined : env.has('\0cleared') ? undefined : outer(name);
    let wrapped: Unwrapped | undefined = unwrap(argv, env);
    for (; wrapped && wrapped !== 'unknown'; wrapped = unwrap(argv, env)) argv = wrapped.argv;
    // A wrapper option Guardian does not know could hide which command runs.
    if (wrapped === 'unknown') { if (argv.some(mentionsClient)) return true; continue; }
    const program = programOf(argv[0] ?? '');
    const args = argv.slice(1);

    if (SHELLS.has(program) || program === 'eval') {
      const nested = program === 'eval' ? { script: args.join(' '), positional } : shellScript(args);
      // A shell reading a file or standard input runs something Guardian cannot see.
      if (nested === undefined) { if (mentionsClient(script)) return true; continue; }
      if (judge(shell, nested.script, unproven ? () => undefined : lookup, nested.positional, unproven, depth + 1, root)) return true;
      continue;
    }
    // A client named inside another program's arguments, as in `sqlite3 db ".shell psql …"` or
    // `python -c "os.system('psql …')"`, cannot be followed.
    if (args.some(word => mentionsClient(word) && risky(word))) return true;
    if (OPAQUE.has(program)) { if (args.some(mentionsClient)) return true; continue; }
    // A client such a runner starts gets an environment Guardian cannot see; one in an unknown command's arguments
    // counts when options of that client follow it, as `mywrapper psql -h … -c …`.
    const carried = READERS.has(program) ? -1 : args.findIndex((word, index) => {
      const carriedSpec = CLIENTS[programOf(word)];
      return !!carriedSpec && (RUNNERS_WITH_ENV.has(program) || (!CLIENTS[program] && !REMOTE.has(program) && (command.fed
        || args.slice(index + 1).some(next => carriedSpec.options[next.split('=')[0]] !== undefined || carriedSpec.options[next.slice(0, 2)] !== undefined))));
    });
    if (carried !== -1 && !CLIENTS[program] && !REMOTE.has(program)) {
      const invocation = analyzeClient(CLIENTS[programOf(args[carried])], args.slice(carried + 1), () => undefined, context);
      if (invocation.destructive || invocation.hidden || command.fed) return true;
      continue;
    }
    if (RUNNERS_WITH_ENV.has(program) && args.some(word => mentionsClient(word))) {
      if (args.some(word => mentionsClient(word) && judge(shell, word, () => undefined, [], true, depth + 1, root))) return true;
      continue;
    }
    if (REMOTE.has(program)) {
      const at = args.findIndex(word => CLIENTS[programOf(word)] !== undefined);
      if (at !== -1) {
        const invocation = analyzeClient(CLIENTS[programOf(args[at])], args.slice(at + 1), () => undefined, context);
        if (invocation.destructive || invocation.hidden) return true;
      } else if (args.some(word => mentionsClient(word) && judge(shell, word, () => undefined, [], true, depth + 1, root))) {
        return true;
      }
      continue;
    }

    const frameworkAt = argv.findIndex(word => FRAMEWORK_WIPES[programOf(word)] !== undefined);
    if (frameworkAt !== -1 && argv.slice(0, frameworkAt).every(word => RUNNERS.has(programOf(word)) || word.startsWith('-'))) {
      if (!FRAMEWORK_WIPES[programOf(argv[frameworkAt])](argv.slice(frameworkAt + 1))) continue;
      const url = lookup('DATABASE_URL');
      const targets = url === undefined ? undefined : connectionTargets(url);
      const local = !!targets && !targets.service && effectiveHosts(targets).length > 0 && effectiveHosts(targets).every(isLocalHost);
      if (!local || unproven) return true;
      continue;
    }

    const spec = CLIENTS[program];
    if (!spec) continue;
    const invocation = analyzeClient(spec, args, lookup, context);
    if ((!invocation.local || unproven) && (invocation.destructive || invocation.hidden)) return true;
  }
  return false;
}

function judge(shell: Shell, script: string, lookup: Lookup, positional: Positional, remote: boolean, depth: number, root: Lookup): boolean {
  if (!mentionsClient(script)) return false;
  const commands = evaluateScript(shell, script, lookup, positional);
  // A script Guardian cannot evaluate exactly is refused when it could destroy data or hide what it runs.
  if (!commands) return remote || risky(script);
  return refuse(shell, commands, lookup, positional, remote, depth, script, root);
}

export type DatabaseDecision = 'forbidden' | undefined;

/**
 * Whether a database command must be refused: one that may run destructive or unseen SQL against a target Guardian
 * cannot prove local. Everything else, including any command against a local target, is left to the normal flow.
 */
export function databaseDecision(shell: Shell, command: readonly string[], env: NodeJS.ProcessEnv = process.env): DatabaseDecision {
  const script = shell.extractBashCommand(command)?.[1] ?? command.join(' ');
  const root: Lookup = name => env[name];
  return judge(shell, script, root, [], false, 0, root) ? 'forbidden' : undefined;
}
