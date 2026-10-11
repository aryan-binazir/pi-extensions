import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withHooks } from '../test-support.ts';
import { catalog } from './index.ts';

const both = 'hooks:\n  draft-prs: true\n  no-admin-merge: true\n';

async function withGh(body: (call: (command: string) => Promise<any>) => Promise<void>, yaml = both) {
  await withHooks([...catalog], yaml, ({ call }) => body(command => call('bash', { command })));
}

test('draft creation and unrelated commands remain available', async () => {
  await withGh(async call => {
    for (const command of ['gh pr create --draft', 'gh pr create -d', 'gh pr ready', 'git status']) {
      assert.equal(await call(command), undefined, command);
    }
  });
});

test('shell quoting and command boundaries distinguish execution from literal text', async () => {
  await withGh(async call => {
    for (const command of [
      'cd repo && gh pr create', 'echo ok; gh pr merge --admin',
      'gh pr create --title "a --draft title"', 'gh pr create --title --draft',
      'gh pr create --draft; gh pr create', 'gh pr create # --draft',
      'gh pr create\n# --draft', 'gh pr create --body "first\n--draft"',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'echo "gh pr merge --admin"', 'echo gh pr create', '# gh pr create',
      'gh pr create --title "semi;colon" --draft',
      'gh pr create --title "a \\"quoted\\" title" --draft',
      'gh pr merge --body "--admin"', 'gh pr merge --subject=--admin',
      'gh pr merge --body-file -', 'gh pr create --draft \\\n --body-file -',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('ANSI-C and locale quoting reveal gh flags, and undecoded ANSI-C escapes block gh commands', async () => {
  await withGh(async call => {
    for (const command of [
      "gh pr merge $'--admin'", 'gh pr merge $"--admin"', "gh pr merge --ad'min'", "gh pr merge $'--'admin",
      "gh pr merge $'--admin=true'", 'gh $\'pr\' $"merge" 42 --admin', "$'gh' pr merge --admin",
      String.raw`gh pr merge --body $'it\'s' --admin`, String.raw`gh pr merge --body $'x\\' --admin`,
      "gh pr create --draft $'--draft=false'", "gh pr create $'--web' --draft", 'gh pr merge --ad\0min',
      String.raw`gh pr merge 1 $$'\' --admin #'`,
      'gh pr merge $1 --admin', 'gh pr create --title "$(git log -1 --format=%s)"',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      String.raw`gh pr merge $'--ad\x6din'`, String.raw`gh pr merge $'--ad\155in'`,
      String.raw`gh pr merge $'--ad\u006din'`, String.raw`gh pr merge $'--ad\0'min`,
      String.raw`gh pr create --draft --body $'\cA'`, String.raw`gh pr create --draft --title $'\z'`,
      String.raw`$'\x67h' pr merge --admin`, String.raw`/usr/bin/$'\x67'h pr merge --admin`,
    ]) assert.deepEqual(await call(command), {
      block: true, reason: "[hooks: draft-prs] Hooks cannot check numeric, Unicode, control, or unknown $'...' escapes in gh commands. Use plain quotes.",
    }, command);
    for (const command of [
      "gh pr create $'--draft' --title t --body b", 'gh pr create $"--draft"', "gh pr create -$'d'",
      String.raw`gh pr create --draft --body $'Line 1\nLine 2\t\\ \'q\' \"x\" \? \a\b\e\E\f\r\v'`,
      "gh pr merge $'--admin=false'", "gh pr merge --admin=$'false'", "gh pr merge --body $'--admin'",
      String.raw`gh pr merge "$'\x6d'" --squash`, String.raw`gh pr merge \$'--admin'`, "gh pr merge $$'--admin'",
      String.raw`printf $'\x41\033[0m' && IFS=$'\x1f' read -r a b; gh pr merge 1 --squash`,
      'gh pr merge $PR --squash', 'gh pr create --draft --title "$TITLE" --body "$(cat body.md)"',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('boolean values, repeated flags, and short clusters follow gh option semantics', async () => {
  await withGh(async call => {
    for (const command of [
      'gh pr create --draft --draft=false', 'gh pr create -d=false',
      'gh pr create -ft--draft', 'gh pr create --web', 'gh pr create --dry-run',
      'gh pr merge --admin=true', 'gh pr merge --admin=1',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'gh pr create --draft=true', 'gh pr create --draft=1', 'gh pr create -fd',
      'gh pr create --draft=false -d', 'gh pr create -dtTitle',
      'gh pr merge --admin=false', 'gh pr merge --admin --admin=false',
      'gh pr merge -- --admin', 'gh pr create --draft --body-file -',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('flags before command words still enforce draft creation and administrator merge rules', async () => {
  await withGh(async call => {
    for (const command of [
      'gh pr --title Fix create --body Details',
      'gh --title=Fix pr create --body Details',
      'gh pr --draft=false create --title Fix --body Details',
      'gh pr --body Note merge 42 --admin --squash',
      'gh pr --admin=true merge 42 --squash',
      'gh --admin=true pr merge 42 --squash',
    ]) assert.equal((await call(command))?.block, true, command);
  });
});

test('reordered options retain values, boolean precedence, and command selection', async () => {
  await withGh(async call => {
    for (const command of [
      'gh --title pr pr create',
      'gh pr --body merge create',
      'gh pr --body create merge 42 --admin',
      'gh pr --body merge merge 42 --admin',
      'gh pr --body -- merge 42 --admin',
      'gh pr --admin merge merge --squash',
      'gh pr -tcreate create', 'gh pr -t Fix new',
      'gh pr -ftFix create', 'gh pr -d=false create',
      'gh --draft=true pr create --draft=false',
      'gh pr --admin=false merge 42 --admin',
      'gh --help pr --title Fix create --help=false',
      'gh pr --web=false create --web --draft',
      'gh pr --title --draft create',
      'gh pr --body --help merge 42 --admin',
      'gh pr create -- --draft',
      '"gh" "pr" --title "Fix" "create"',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'gh pr --title Fix create --draft',
      'gh --draft=false pr --draft=true create',
      'gh pr --body Note merge 42 --admin=false',
      'gh pr --body --admin merge 42',
      'gh --admin=true pr merge 42 --admin=false',
      'gh pr --help=false create --help',
      'gh pr --web=true create --web=false --draft',
      'gh --repo pr pr --title merge create --draft',
      'gh pr -Rcreate --body merge merge 42 --admin=false',
      'gh pr -fd create', 'gh pr -tmerge create -d',
      'gh pr --body create view',
      'gh pr --body merge view',
      'gh -- pr create', 'gh pr -- create',
      'gh pr --body Note merge -- --admin',
      'echo "gh pr --admin=true merge"',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('repository selection, assignments, absolute gh paths and the new alias stay covered', async () => {
  await withGh(async call => {
    for (const command of ['gh -R org/repo pr create', 'gh pr --repo=org/repo create', 'GH_HOST=github.com /usr/bin/gh pr merge --admin', 'gh pr new', 'gh pr create --help=false']) {
      assert.equal((await call(command))?.block, true, command);
    }
    for (const command of ['gh -Rorg/repo pr create -d', 'gh pr create --help', 'gh pr merge --admin --help']) {
      assert.equal(await call(command), undefined, command);
    }
  });
});

test('inherited help flags, mixed web aliases, and literal Bash whitespace keep their semantics', async () => {
  await withGh(async call => {
    for (const command of [
      'gh --help=false pr merge --admin', 'gh pr --help=false merge --admin',
      'gh --help=false pr create', 'gh pr --help=false create',
      'gh --help pr create --help=false',
      'gh pr create --title=Fix\u00a0--draft --body=Details',
    ]) assert.equal((await call(command))?.block, true, command);
    for (const command of [
      'gh --help pr create', 'gh pr -h merge --admin',
      'gh pr create -w --web=false --draft', 'gh pr create --web -w=false --draft',
    ]) assert.equal(await call(command), undefined, command);
  });
});

test('administrator merges are blocked without blocking normal merges', async () => {
  await withGh(async call => {
    assert.deepEqual(await call('gh pr merge 42 --admin'), {
      block: true, reason: '[hooks: no-admin-merge] Merge without --admin. Satisfy the repository review and check requirements instead of bypassing them.',
    });
    assert.equal(await call('gh pr merge 42 --squash -d'), undefined);
  });
});

test('non-draft PR creation is blocked with a corrective instruction', async () => {
  await withGh(async call => {
    assert.deepEqual(await call('gh pr create --title "Fix" --body "Details"'), {
      block: true, reason: '[hooks: draft-prs] Create PRs as drafts. Add --draft; mark ready with gh pr ready after review.',
    });
  });
});

test('each gh rule switches independently and ignores other tools', async () => {
  await withGh(async call => {
    assert.equal(await call('gh pr create'), undefined);
    assert.equal((await call('gh pr merge --admin'))?.block, true);
  }, 'hooks:\n  no-admin-merge: true\n');
  await withGh(async call => {
    assert.equal((await call('gh pr create'))?.block, true);
    assert.equal(await call('gh pr merge --admin'), undefined);
  }, 'hooks:\n  draft-prs: true\n');
  await withHooks([...catalog], both, async ({ call }) => assert.equal(await call('read', { path: 'gh pr create' }), undefined));
});

test('short help works and browser creation gives a usable correction', async () => {
  await withGh(async call => {
    assert.equal(await call('gh pr create -h'), undefined);
    assert.equal(await call('gh pr merge --admin -h'), undefined);
    for (const command of ['gh pr create --web', 'gh pr create -w --draft']) {
      assert.deepEqual(await call(command), { block: true, reason: '[hooks: draft-prs] gh cannot create drafts with --web. Drop --web/-w and pass --draft.' });
    }
  });
});
