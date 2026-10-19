// Ported from openai/codex codex-rs/shell-command/src/{bash,command_safety/is_dangerous_command}.rs @ ce0323f (Apache-2.0); see docs/licenses/README.md.
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadShell, MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH } from './shell.ts';

const shell = await loadShell();
const parseSeq = (src: string) => shell.parseShellScriptIntoCommands(src);

test('accepts single simple command', () => {
  assert.deepEqual(parseSeq('ls -1'), [['ls', '-1']]);
});

test('accepts multiple commands with allowed operators', () => {
  assert.deepEqual(parseSeq("ls && pwd; echo 'hi there' | wc -l"), [['ls'], ['pwd'], ['echo', 'hi there'], ['wc', '-l']]);
});

test('extracts double and single quoted strings', () => {
  assert.deepEqual(parseSeq('echo "hello world"'), [['echo', 'hello world']]);
  assert.deepEqual(parseSeq("echo 'hi there'"), [['echo', 'hi there']]);
});

test('accepts double quoted strings with newlines', () => {
  assert.deepEqual(parseSeq('git commit -m "line1\nline2"'), [['git', 'commit', '-m', 'line1\nline2']]);
});

test('accepts mixed quote concatenation', () => {
  assert.deepEqual(parseSeq(`echo "/usr"'/'"local"/bin`), [['echo', '/usr/local/bin']]);
  assert.deepEqual(parseSeq(`echo '/usr'"/"'local'/bin`), [['echo', '/usr/local/bin']]);
});

test('rejects double quoted strings with expansions', () => {
  assert.equal(parseSeq('echo "hi ${USER}"'), undefined);
  assert.equal(parseSeq('echo "$HOME"'), undefined);
});

test('accepts numbers as words', () => {
  assert.deepEqual(parseSeq('echo 123 456'), [['echo', '123', '456']]);
});

test('rejects parentheses and subshells', () => {
  assert.equal(parseSeq('(ls)'), undefined);
  assert.equal(parseSeq('ls || (pwd && echo hi)'), undefined);
});

test('rejects redirections and unsupported operators', () => {
  assert.equal(parseSeq('ls > out.txt'), undefined);
  assert.equal(parseSeq('echo hi & echo bye'), undefined);
});

test('rejects command and process substitutions and expansions', () => {
  assert.equal(parseSeq('echo $(pwd)'), undefined);
  assert.equal(parseSeq('echo `pwd`'), undefined);
  assert.equal(parseSeq('echo $HOME'), undefined);
  assert.equal(parseSeq('echo "hi $USER"'), undefined);
});

test('rejects runtime expansion in plain words', () => {
  for (const script of [
    'find . -{delete,print}', 'rg --pre{=,=sh} pattern payload.sh', 'find . -del*', 'find . -delet?', 'find . -delet[e]',
    String.raw`find . -de\lete`, 'echo ~', 'echo ~HOME', 'echo HEAD~1', 'echo HEAD^', 'echo file~', 'echo =sh',
    'echo foo^bar', 'echo foo#bar', 'l* -l',
  ]) {
    for (const name of ['bash', 'zsh']) {
      for (const flag of ['-c', '-lc']) {
        const command = [name, flag, script];
        assert.equal(shell.parseShellLcPlainCommands(command), undefined, JSON.stringify(command));
      }
    }
  }
});

test('preserves quoted literals', () => {
  for (const [script, expected] of [
    [`rg -g"*.py" pattern`, ['rg', '-g*.py', 'pattern']],
    [String.raw`echo "\n"`, ['echo', String.raw`\n`]],
    [`echo "~HOME" 'HEAD~1' "HEAD^" 'foo#bar' "=sh" 'file~'`, ['echo', '~HOME', 'HEAD~1', 'HEAD^', 'foo#bar', '=sh', 'file~']],
    [String.raw`echo -"{a,b}" '*?[]~^#=\\'`, ['echo', '-{a,b}', String.raw`*?[]~^#=\\`]],
  ] as const) {
    assert.deepEqual(shell.parseShellScriptIntoCommands(script), [expected], script);
  }
});

test('rejects double quoted escapes', () => {
  for (const script of [String.raw`echo "\$HOME\`\"\\\n"`, 'find . "-de\\\nlete"', String.raw`echo "\\"`]) {
    assert.equal(parseSeq(script), undefined, script);
    for (const name of ['bash', 'zsh']) {
      assert.equal(shell.parseShellLcPlainCommands([name, '-lc', script]), undefined, `${name} ${script}`);
    }
  }
});

test('rejects variable assignment prefix', () => {
  assert.equal(parseSeq('FOO=bar ls'), undefined);
});

test('rejects trailing operator parse error', () => {
  assert.equal(parseSeq('ls &&'), undefined);
});

test('rejects empty command position with leading operator', () => {
  assert.equal(parseSeq('&& ls'), undefined);
});

test('rejects empty command position with double separator', () => {
  assert.equal(parseSeq('ls ;; pwd'), undefined);
});

test('rejects empty command position with empty pipeline segment', () => {
  assert.equal(parseSeq('ls | | wc'), undefined);
});

test('parse zsh lc plain commands', () => {
  assert.deepEqual(shell.parseShellLcPlainCommands(['zsh', '-lc', 'ls']), [['ls']]);
});

test('accepts concatenated flag and value', () => {
  assert.deepEqual(parseSeq('rg -n "foo" -g"*.py"'), [['rg', '-n', 'foo', '-g*.py']]);
});

test('accepts concatenated flag with single quotes', () => {
  assert.deepEqual(parseSeq("grep -n 'pattern' -g'*.txt'"), [['grep', '-n', 'pattern', '-g*.txt']]);
});

test('rejects concatenation with variable substitution', () => {
  assert.equal(parseSeq('rg -g"$VAR" pattern'), undefined);
  assert.equal(parseSeq('rg -g"${VAR}" pattern'), undefined);
});

test('rejects concatenation with command substitution', () => {
  assert.equal(parseSeq('rg -g"$(pwd)" pattern'), undefined);
  assert.equal(parseSeq(`rg -g"$(echo '*.py')" pattern`), undefined);
});

test('extract bash command recognizes shells by name, path, and stem only with -c or -lc', () => {
  assert.deepEqual(shell.extractBashCommand(['/bin/zsh', '-lc', 'ls']), ['/bin/zsh', 'ls']);
  assert.deepEqual(shell.extractBashCommand(['sh', '-c', 'ls']), ['sh', 'ls']);
  assert.deepEqual(shell.extractBashCommand(['bash.exe', '-c', 'ls']), ['bash.exe', 'ls']);
  assert.equal(shell.extractBashCommand(['bash', '-x', 'ls']), undefined);
  assert.equal(shell.extractBashCommand(['fish', '-c', 'ls']), undefined);
  assert.equal(shell.extractBashCommand(['bash', '-lc']), undefined);
});

test('rm -rf is dangerous', () => {
  assert.equal(shell.dangerousCommandMatch(['rm', '-rf', '/']), 'forced_rm');
});

test('rm -f is dangerous', () => {
  assert.equal(shell.dangerousCommandMatch(['rm', '-f', '/']), 'forced_rm');
});

test('forced rm variants are dangerous', () => {
  for (const command of [
    ['/bin/rm', '-fr', '/tmp/example'], ['rm', '-r', '-f', '/tmp/example'], ['rm', '--force', '/tmp/example'],
    ['rm', '/tmp/example', '-f'], ['sudo', 'rm', '-rf', '/tmp/example'], ['env', 'TARGET=/tmp/example', 'rm', '-rf', '/tmp/example'],
  ]) {
    assert.equal(shell.dangerousCommandMatch(command), 'forced_rm', JSON.stringify(command));
  }
});

test('deeply nested command wrappers fail closed', () => {
  for (const [depth, expected] of [[MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH, 'forced_rm'], [MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH + 1, 'other']] as const) {
    assert.equal(shell.dangerousCommandMatch([...Array<string>(depth).fill('env'), 'rm', '-rf', '/tmp/example']), expected);
  }
});

test('forced rm in complex shell syntax is dangerous', () => {
  for (const script of [
    'printf x | rm -rf /tmp/example',
    'if test -d /tmp/example; then rm --force /tmp/example; fi',
    'rm -rf "$TARGET" >/dev/null',
    'for target in /tmp/a /tmp/b; do rm -r -f "$target"; done',
    'echo "$(rm -rf /tmp/example)"',
    "bash -c 'rm -rf /tmp/example'",
    "trap 'rm -rf /tmp/example' EXIT",
    `for a in '-C5a25KeRr' '--' '--json' '--bogus'; do HOME=$(mktemp -d) MDE_URL=http://127.0.0.1:1 MDE_TOKEN=x node cli/mde.cjs ls "$a" >/tmp/mde-review-out 2>/tmp/mde-review-err; code=$?; printf '%s\\t%s\\t%s\\n' "$a" "$code" "$(tr '\\n' ' ' </tmp/mde-review-err)"; rm -rf "$HOME"; done`,
  ]) {
    assert.equal(shell.dangerousCommandMatch(['bash', '-lc', script]), 'forced_rm', script);
  }
});

test('non forced or non literal rm is not dangerous', () => {
  for (const command of [
    ['rm', '-r', '/tmp/example'], ['rm', '--', '-f'], ['bash', '-lc', "echo 'rm -rf /tmp/example'"],
    ['bash', '-lc', 'cmd=rm; $cmd -rf /tmp/example'], ['bash', '-lc', 'if then rm -rf /tmp/example'],
    ['env', 'TARGET=/tmp/example', 'rm', '-r', '/tmp/example'], ['bash', '-lc', "trap 'echo rm -rf /tmp/example' EXIT"],
  ]) {
    assert.equal(shell.dangerousCommandMatch(command), undefined, JSON.stringify(command));
  }
});

test('expanded literal commands unwrap wrappers and nested shells like the dangerous-command walk', () => {
  const expand = (script: string) => shell.expandLiteralCommands(['bash', '-lc', script]).map(command => command.join(' '));
  assert.deepEqual(expand('railway delete'), ['bash -lc railway delete', 'railway delete']);
  for (const [script, expected] of [
    ['sudo railway down', 'railway down'],
    ['env TOKEN=x railway down', 'railway down'],
    ['env -i -- railway down', 'railway down'],
    ["bash -c 'railway down'", 'railway down'],
    ["sh -lc 'sudo railway down'", 'railway down'],
    ["trap 'railway down' EXIT", 'railway down'],
    ['if true; then railway down; fi', 'railway down'],
    ['echo "$(railway down)"', 'railway down'],
    ['printf x | railway down', 'railway down'],
  ] as const) {
    assert.ok(expand(script).includes(expected), `${script} -> ${JSON.stringify(expand(script))}`);
  }
  assert.ok(!expand("echo 'railway down'").includes('railway down'), 'quoted text is an argument, not a command');
  const nested = Array.from({ length: MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH + 4 }, () => 'env').join(' ');
  assert.ok(shell.expandLiteralCommands(['bash', '-lc', `${nested} railway down`]).length <= MAX_DANGEROUS_COMMAND_WRAPPER_DEPTH + 3, 'bounded depth');
  assert.deepEqual(shell.expandLiteralCommands(['railway', 'delete']), [['railway', 'delete']]);
});
