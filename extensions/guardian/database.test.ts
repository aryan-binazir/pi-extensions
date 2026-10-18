// Ar's database boundary: a database command may run destructive or unseen SQL only against a provably local
// target. Evaluated as text; no database is contacted.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after } from 'node:test';
import { connectionTargets, databaseDecision, isLocalHost } from './database.ts';
import { loadShell } from './shell.ts';

const shell = await loadShell();
/** A home without startup files, so the machine running the tests does not decide them. */
const HOME = mkdtempSync(join(tmpdir(), 'guardian-database-home-'));
after(() => rmSync(HOME, { recursive: true, force: true }));
const decide = (script: string, env: NodeJS.ProcessEnv = {}) => databaseDecision(shell, ['bash', '-lc', script], { HOME, ...env });
const REMOTE = { DATABASE_URL: 'postgres://me@prod.example.com:5432/app' };
const LOCAL = { DATABASE_URL: 'postgres://me@localhost:5432/app' };

test('destructive statements against an unresolved or remote target are refused', () => {
  for (const script of [
    `psql "$DATABASE_URL" -c 'DROP TABLE customers'`,
    "echo 'TRUNCATE orders;' | psql $DATABASE_URL",
    'psql -h db.example.com -c "DROP TABLE users" app',
    "psql postgresql://u:p@roundhouse.proxy.rlwy.net:5432/railway -c 'DROP TABLE users'",
    `psql "host=10.0.0.5 dbname=app" -c 'DELETE FROM users'`,
    'PGHOST=db.example.com psql -c "DROP TABLE x"',
    'env PGHOST=db.example.com psql -c "DROP TABLE x"',
    `export DATABASE_URL=postgres://x@localhost/db && psql "$DATABASE_URL" -c 'DROP TABLE t'`,
    'mysql -e "DELETE FROM users" app',
    `mongosh "mongodb+srv://cluster0.example.net/app" --eval 'db.dropDatabase()'`,
    'mongosh db.example.com/app --eval "db.users.deleteMany({})"',
    'redis-cli -u redis://cache.example.com:6379 FLUSHALL',
    'redis-cli -h cache.example.com DEL session:1',
    'psql -c "DROP TABLE $(cat table.txt)"',
    "ssh prod psql -c 'DROP TABLE users'",
    "kubectl exec db-0 -- psql -c 'DROP TABLE users'",
    "docker compose exec db psql -U postgres -c 'DROP TABLE t'",
    'npx prisma migrate reset --force',
    'bin/rails db:drop',
    'if true; then mysql -e "DROP DATABASE app"; fi',
    'pg_restore --clean -d postgres://db.example.com/app dump.sql',
    'dropdb -h db.example.com app',
    `psql -h localhost -c "DELETE FROM cache WHERE key = $KEY"`,
  ]) {
    assert.equal(decide(script), 'forbidden', script);
  }
});

test('every host of a target counts, however libpq would read it', () => {
  for (const env of [
    { DATABASE_URL: 'postgresql://localhost:5432,roundhouse.proxy.rlwy.net:5432/railway' },
    { DATABASE_URL: 'postgresql://%2Ftmp%2Cdb.example.com/app' },
    { DATABASE_URL: 'postgresql://localhost/app?%68ost=db.example.com' },
    { DATABASE_URL: 'postgresql://localhost/app?service=production' },
    { DATABASE_URL: 'postgres://localhost/db?x=1&host=db.example.com' },
  ]) {
    assert.equal(decide(`psql "$DATABASE_URL" -c 'DROP TABLE customers'`, env), 'forbidden', env.DATABASE_URL);
  }
  assert.equal(decide(`psql $DATABASE_URL -c 'DROP TABLE t'`, { DATABASE_URL: 'postgres://localhost/db?x=1&host=remote' }), 'forbidden',
    'a value that would parse differently once substituted is unresolved');
  for (const script of [
    'psql -hprod.example.com -c "DROP TABLE t"',
    'psql -h localhost,db.example.com -c "DROP TABLE t"',
    `psql "service=production" -c 'DROP TABLE t'`,
    `psql "postgresql://localhost/app?host=db.example.com" -c 'DROP TABLE t'`,
    `psql "host=localhost,10.0.0.5 dbname=app" -c 'DROP TABLE t'`,
    'mongosh "mongodb://localhost:27017,mongo2.example.com:27017/app" --eval "db.dropDatabase()"',
  ]) {
    assert.equal(decide(script), 'forbidden', script);
  }
  assert.deepEqual(connectionTargets('postgresql://%2Ftmp%2Cdb.example.com/app').hosts, ['/tmp', 'db.example.com']);
  assert.deepEqual(connectionTargets('postgresql://u:p%40x@[::1]:5432,h2:5433/db?hostaddr=10.0.0.1').hosts, ['[::1]', 'h2', '10.0.0.1']);
  assert.equal(connectionTargets("host='a b' service=prod").service, true);
  assert.deepEqual(connectionTargets('app_dev').hosts, []);
});

test('a nested shell expands what the outer one quoted', () => {
  assert.equal(decide(`bash -c 'psql "$DATABASE_URL" -c "DROP TABLE customers"'`, REMOTE), 'forbidden');
  assert.equal(decide(`bash -c 'psql "$DATABASE_URL" -c "DROP TABLE customers"'`, LOCAL), undefined);
  assert.equal(decide(`sh -c "bash -c 'psql -h db.example.com -c \\"DROP TABLE t\\"'"`), 'forbidden', 'a client the parser cannot place is refused');
});

test('SQL Guardian cannot see counts as destructive against a target it cannot prove local', () => {
  for (const script of [
    `psql "$DATABASE_URL" -f wipe.sql`,
    'cat wipe.sql | psql -h db.example.com',
    'psql -h db.example.com < wipe.sql',
    "psql -h db.example.com <<'SQL'\nDROP TABLE x;\nSQL",
    `psql -h db.example.com -c '\\i wipe.sql'`,
    'mongosh "mongodb://db.example.com/app" wipe.js',
    'redis-cli -h cache.example.com --eval wipe.lua',
  ]) {
    assert.equal(decide(script, REMOTE), 'forbidden', script);
  }
  assert.equal(decide('psql -h localhost -f wipe.sql'), undefined, 'against a local target it runs');
});

test('arguments Guardian cannot follow are refused', () => {
  for (const script of [
    `eval "psql -h db.example.com -c 'DROP TABLE x'"`,
    "echo x | xargs psql -h localhost -c 'DROP TABLE x'",
    "find . -name x -exec psql -h localhost -c 'DROP TABLE x' \\;",
  ]) {
    assert.equal(decide(script), 'forbidden', script);
  }
});

test('Pi\'s environment resolves the target a command or tool reads', () => {
  assert.equal(decide(`psql "$DATABASE_URL" -c 'DROP TABLE t'`, LOCAL), undefined);
  assert.equal(decide(`psql "$DATABASE_URL" -c 'DROP TABLE t'`, REMOTE), 'forbidden');
  assert.equal(decide('psql -c "DROP TABLE t"', { PGHOST: 'db.example.com' }), 'forbidden');
  assert.equal(decide('psql -c "DROP TABLE t"', { PGHOST: '/var/run/postgresql' }), undefined);
  assert.equal(decide('psql -c "DROP TABLE t"', { PGSERVICE: 'prod' }), 'forbidden');
  assert.equal(decide('npx prisma migrate reset --force', { DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/dev' }), undefined);
  assert.equal(decide('bin/rails db:reset', { DATABASE_URL: 'postgres://u@prod-db.internal/app' }), 'forbidden');
});

test('destructive statements against a provably local target run as usual', () => {
  for (const script of [
    'psql -c "DROP TABLE scratch"',
    'psql -h localhost -c "TRUNCATE events" app_dev',
    'psql postgres:///app_dev -c "DROP TABLE t"',
    `psql "postgresql://%2Fvar%2Frun%2Fpostgresql/app" -c 'DROP TABLE t'`,
    'psql -h127.0.0.1 -c "DROP TABLE t"',
    'mysql -h 127.0.0.1 -e "DROP DATABASE app_test"',
    'mysql --socket=/tmp/mysql.sock -e "DELETE FROM jobs"',
    'redis-cli FLUSHALL',
    `mongosh --eval 'db.dropDatabase()'`,
    'sqlite3 app.db "DROP TABLE cache"',
    'dropdb app_test',
    'sudo -u postgres psql -c "DROP TABLE t"',
    "psql -h localhost -c 'DELETE FROM cache WHERE key = $$obsolete$$'",
    'psql -h localhost -c "DELETE FROM cache WHERE pid = $$"',
    `psql -h localhost -c "DELETE FROM cache WHERE key = 'service=worker'"`,
  ]) {
    assert.equal(decide(script), undefined, script);
  }
});

test('visible, non-destructive statements run against any target', () => {
  for (const [script, env] of [
    [`psql "$DATABASE_URL" -c 'select count(*) from users'`, REMOTE],
    ['psql -h db.example.com -c "CREATE TABLE t (id int)"', {}],
    ['redis-cli -h cache.example.com GET session:1', {}],
    [`psql "$DATABASE_URL" -c '\\dt'`, REMOTE],
  ] as const) {
    assert.equal(decide(script, env), undefined, script);
  }
});

test('commands that are not database operations are untouched', () => {
  for (const script of ['git commit -m "drop table support"', 'grep -r "DROP TABLE" migrations/', 'npx prisma migrate deploy', 'echo $HOME',
    'bin/rails server', 'git commit -m "use psql for the import"']) {
    assert.equal(decide(script), undefined, script);
  }
});

test('libpq settings that apply whatever the host is called still count', () => {
  assert.equal(decide("psql -h localhost -c 'DROP TABLE customers'", { PGHOSTADDR: '203.0.113.10' }), 'forbidden', 'hostaddr is the network address');
  assert.equal(decide("psql -h localhost -c 'DROP TABLE customers'", { PGHOST: 'db.example.com' }), undefined, 'an explicit host overrides PGHOST');
  assert.equal(decide('env -u PGHOST psql -c "DROP TABLE t"', { PGHOST: 'db.example.com' }), undefined, 'env -u removes it');
});

test('options are read the way getopt reads them', () => {
  assert.equal(decide("psql -h db.example.com -c 'SELECT 1' -qc 'DROP TABLE customers'"), 'forbidden', '-qc is -q then -c');
  assert.equal(decide("psql --frobnicate -h db.example.com -c 'SELECT 1'"), 'forbidden', 'an unknown option counts as hidden SQL');
  assert.equal(decide("psql -h localhost --frobnicate -c 'DROP TABLE x'"), undefined, 'against a local target it runs');
  assert.equal(decide('mysql -h127.0.0.1 -psecret -e "DROP DATABASE t"'), undefined, "mysql's -p takes only an attached value");
  assert.equal(decide("psql -X -1 -v ON_ERROR_STOP=1 -h db.example.com -c 'SELECT 1'"), undefined);
});

test('every invocation is judged on its own', () => {
  assert.equal(decide(`psql -h localhost -c 'SELECT 1'; bash -euc 'psql -h db.example.com -c "DROP TABLE customers"'`), 'forbidden');
  assert.equal(decide("echo \"psql -h db.example.com -c 'DROP TABLE x'\" | bash"), 'forbidden', 'a shell reading standard input');
  assert.equal(decide(`python3 -c "import os; os.system('psql -h db.example.com -c \\"DROP TABLE x\\"')"`), 'forbidden', 'a client inside another program');
  assert.equal(decide("psql -h localhost -c 'DELETE FROM cache WHERE key = $tag$obsolete$tag$'"), undefined, 'tagged dollar quotes in single quotes are text');
  for (const script of ['rg mysql', 'rg -n psql src/', 'cat docs/psql.md', 'man psql']) assert.equal(decide(script), undefined, script);
});

test('positional parameters of a nested shell are its trailing arguments', () => {
  assert.equal(decide(`sh -c 'psql "$1" -c "DROP TABLE t"' sh postgres://db.example.com/app`), 'forbidden');
  assert.equal(decide(`sh -c 'psql "$1" -c "DROP TABLE t"' sh postgres://localhost/app`), undefined);
  assert.equal(decide(`bash -c 'psql "$@" -c "DROP TABLE t"' bash -h db.example.com`), 'forbidden', '$@ spread over several arguments is unreadable');
});

test('statements that move the session elsewhere make the target unproven', () => {
  for (const script of [
    `psql -h localhost -c '\\c postgres://db.example.com/app' -c 'DROP TABLE x'`,
    `psql -h localhost -c '\\! psql -h db.example.com -c "DROP TABLE x"'`,
    `mongosh --eval "db = connect('mongodb://db.example.com/app'); db.dropDatabase()"`,
    `sqlite3 x.db ".shell psql -h db.example.com -c 'DROP TABLE x'"`,
  ]) {
    assert.equal(decide(script), 'forbidden', script);
  }
});

test('a startup file that can connect elsewhere makes the target unproven unless skipped', () => {
  const home = join(HOME, 'with-rc');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, '.psqlrc'), '\\c postgres://db.example.com/app\n');
  writeFileSync(join(home, '.mongoshrc.js'), "db = connect('mongodb://db.example.com/app');\n");
  assert.equal(decide("psql -h localhost -c 'DROP TABLE t'", { HOME: home }), 'forbidden');
  assert.equal(decide("psql -X -h localhost -c 'DROP TABLE t'", { HOME: home }), undefined, '-X skips ~/.psqlrc');
  assert.equal(decide(`mongosh --eval 'db.dropDatabase()'`, { HOME: home }), 'forbidden');
  assert.equal(decide(`mongosh --norc --eval 'db.dropDatabase()'`, { HOME: home }), undefined);
  assert.equal(decide("psql -h localhost -c 'DROP TABLE t'", { PSQLRC: '/tmp/x' }), 'forbidden');
  assert.equal(decide("PSQLRC=./rc psql -h localhost -c 'DROP TABLE t'"), 'forbidden');
  assert.equal(decide("HOME=./fake psql -h localhost -c 'DROP TABLE t'"), 'forbidden', 'a home the command chooses could hold anything');
  assert.equal(decide(`echo '\\c postgres://db.example.com/app' > ~/.psqlrc && psql -h localhost -c 'DROP TABLE t'`), 'forbidden',
    'a script that writes files could create the startup file first');
  assert.equal(decide(`psql -h localhost -c 'DROP TABLE t' > drop.log`), 'forbidden');
  assert.equal(decide(`psql -X -h localhost -c 'DROP TABLE t' > drop.log`), undefined, '-X makes it safe to log');
});

test('local hosts are loopback names and addresses or socket paths', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '/var/run/postgresql', '']) assert.ok(isLocalHost(host), host);
  for (const host of ['db.example.com', '10.0.0.5', '0.0.0.0', 'localhost.example.com', 'roundhouse.proxy.rlwy.net']) assert.ok(!isLocalHost(host), host);
});
