// Ar's absolute boundary: destructive operations against Railway-hosted databases and storage are always
// blocked. This lives in code rather than in a `.rules` file, because a data file under a writable checkout
// could be edited, deleted or left unparsed, and the boundary must not depend on that. It is never verified
// by running a Railway command.
import type { Shell } from './shell.ts';

export const RAILWAY_FORBIDDEN_REASON = 'destructive Railway operations are permanently blocked; this boundary cannot be approved or configured away. Report the blocker to the user or use a read-only alternative.';
export const RAILWAY_REVIEW_REASON = 'Railway commands that can reach databases or storage are reviewed before they run';

/** Codex's own policy text, used when the bundled policy file cannot be read. */
export const RAILWAY_EXTRA_POLICY = `### Railway Databases (absolute deny)
- Never allow destructive operations against Railway-hosted databases or their persistent storage, in any environment. This includes deleting database services, volumes, buckets, or environments and projects that contain databases; destructive schema or data changes; and wipes or resets.
- The rule applies through the Railway CLI or API, database clients, migrations, scripts, and delegated agents.
- Outcome rule: deny these actions with \`risk_level = "critical"\`. User authorization cannot override this rule, including approval given after a denial.
- Destructive Railway operations are never acceptable as tests, probes, or dry runs.
- If Railway database ownership or the destructive effect is uncertain, deny and require read-only inspection first. Read-only inspection and genuinely non-destructive operations are assessed normally.`;

const RAILWAY_PROGRAMS = new Set(['railway', 'railwayapp']);
/** Package runners that fetch and run the Railway CLI without it being installed. */
const PACKAGE_RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'dlx', 'pnpm', 'yarn', 'bun', 'npm']);
const RAILWAY_PACKAGES = new Set(['@railway/cli', 'railway', '@railway/cli@latest']);
/** Wrappers that run another command, beyond the `sudo`, `env` and shell forms the shell walk already unwraps. */
const WRAPPERS = new Set(['command', 'exec', 'nohup', 'time', 'timeout', 'nice', 'ionice', 'stdbuf', 'setsid', 'xargs', 'watch', 'script', 'caffeinate']);
const DESTRUCTIVE = new Set(['delete', 'down', 'destroy', 'teardown', 'remove', 'rm', 'reset', 'wipe', 'prune', 'restore', 'drop', 'truncate']);
/** Railway subcommands that read or reach data, or run commands with its credentials. */
const REACHES_DATA = new Set(['connect', 'run', 'shell', 'ssh', 'variables', 'volume', 'volumes', 'database', 'db', 'storage', 'bucket',
  'buckets', 'environment', 'env', 'service', 'project', 'link', 'unlink', 'redeploy', 'up', 'deploy', 'add', 'init']);

const basename = (word: string) => word.replace(/^\\/, '').split('/').pop() ?? word;
const isFlag = (word: string) => word.startsWith('-');

/** Drops wrapper programs and their options so the wrapped command is judged. */
function unwrap(command: readonly string[]): string[] {
  let words = [...command];
  for (let depth = 0; depth < 8; depth++) {
    const program = basename(words[0] ?? '');
    if (!WRAPPERS.has(program)) return words;
    let index = 1;
    // Wrapper options and their values cannot be told apart reliably, so skip flags and any numeric argument.
    while (index < words.length && (isFlag(words[index]) || /^\d+(\.\d+)?$/.test(words[index]))) index++;
    words = words.slice(index);
  }
  return words;
}

/** The Railway operands of a command, or undefined when it does not invoke the Railway CLI. */
function railwayOperands(command: readonly string[]): string[] | undefined {
  const words = unwrap(command);
  const program = basename(words[0] ?? '');
  if (RAILWAY_PROGRAMS.has(program)) return words.slice(1).filter(word => !isFlag(word));
  if (!PACKAGE_RUNNERS.has(program)) return undefined;
  const operands = words.slice(1).filter(word => !isFlag(word));
  // `npm`, `pnpm`, `yarn` and `bun` reach the CLI through a runner subcommand such as `dlx` or `exec`.
  const runnerIndex = operands.findIndex(word => RAILWAY_PACKAGES.has(word));
  return runnerIndex === -1 ? undefined : operands.slice(runnerIndex + 1);
}

/** Whether a program word invokes the Railway CLI, directly or through a package runner. */
export function isRailwayProgram(word: string): boolean {
  const program = basename(word);
  return RAILWAY_PROGRAMS.has(program) || PACKAGE_RUNNERS.has(program) || RAILWAY_PACKAGES.has(word);
}

export type RailwayDecision = 'forbidden' | 'prompt' | undefined;

const RAILWAY_TOKEN = /(^|[^A-Za-z0-9_@/-])(railway|railwayapp)([^A-Za-z0-9_-]|$)/i;
const DESTRUCTIVE_TOKEN = new RegExp(`(^|[^A-Za-z0-9_-])(${[...DESTRUCTIVE].join('|')})([^A-Za-z0-9_-]|$)`, 'i');

/**
 * Whether a command must be blocked or reviewed for Railway. Two layers, because static parsing cannot
 * resolve every form: the argv layer judges commands the shell walk can extract, and the text layer
 * catches dynamic or unparsable scripts that still name Railway. The text layer is deliberately blunt: a
 * script that mentions Railway alongside a destructive word is refused even if the mention is only data.
 */
export function railwayDecision(shell: Shell, command: readonly string[]): RailwayDecision {
  let reachesData = false;
  for (const candidate of shell.expandLiteralCommands(command)) {
    const operands = railwayOperands(candidate);
    if (!operands) continue;
    if (operands.some(word => DESTRUCTIVE.has(word.toLowerCase()))) return 'forbidden';
    // A bare `railway` prints help; only a data-reaching subcommand needs review.
    if (operands.length && REACHES_DATA.has(operands[0].toLowerCase())) reachesData = true;
  }
  const script = shell.extractBashCommand(command)?.[1];
  const text = script ?? command.join(' ');
  if (RAILWAY_TOKEN.test(text)) {
    if (DESTRUCTIVE_TOKEN.test(text)) return 'forbidden';
    // A Railway invocation that parsing could not resolve still gets a review.
    if (!reachesData && script !== undefined && !shell.parseShellLcPlainCommands(command)) reachesData = true;
  }
  return reachesData ? 'prompt' : undefined;
}
