// Ar's database boundary: destructive database operations run only against a provably local target. Evaluated
// as text; no database is contacted.
import assert from 'node:assert/strict';
import test from 'node:test';
import { databaseDecision, isLocalHost } from './database.ts';
import { loadShell } from './shell.ts';

const shell = await loadShell();
const decide = (script: string, env: NodeJS.ProcessEnv = {}) => databaseDecision(shell, ['bash', '-lc', script], env);

test('destructive statements against an unresolved or remote target are refused', () => {
  for (const script of [
    `psql "$DATABASE_URL" -c 'DROP TABLE customers'`,
    "echo 'TRUNCATE orders;' | psql $DATABASE_URL",
    'psql -h db.example.com -c "DROP TABLE users" app',
    "psql postgresql://u:p@roundhouse.proxy.rlwy.net:5432/railway -c 'DROP TABLE users'",
    `psql "host=10.0.0.5 dbname=app" -c 'DELETE FROM users'`,
    'PGHOST=db.example.com psql -c "DROP TABLE x"',
    `export DATABASE_URL=postgres://x@localhost/db && psql "$DATABASE_URL" -c 'DROP TABLE t'`,
    'mysql -e "DELETE FROM users" app',
    `mongosh "mongodb+srv://cluster0.example.net/app" --eval 'db.dropDatabase()'`,
    'redis-cli -u redis://cache.example.com:6379 FLUSHALL',
    "psql -c \"DROP TABLE $(cat table.txt)\"",
    "ssh prod psql -c 'DROP TABLE users'",
    "kubectl exec db-0 -- psql -c 'DROP TABLE users'",
    'npx prisma migrate reset --force',
    'bin/rails db:drop',
    'if true; then mysql -e "DROP DATABASE app"; fi',
  ]) {
    assert.equal(decide(script), 'forbidden', script);
  }
});

test('Pi\'s environment resolves the target a command or tool reads', () => {
  assert.equal(decide(`psql "$DATABASE_URL" -c 'DROP TABLE t'`, { DATABASE_URL: 'postgres://me@localhost:5432/app' }), undefined);
  assert.equal(decide(`psql "$DATABASE_URL" -c 'DROP TABLE t'`, { DATABASE_URL: 'postgres://me@prod.example.com/app' }), 'forbidden');
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
    'mysql -h 127.0.0.1 -e "DROP DATABASE app_test"',
    'mysql --socket=/tmp/mysql.sock -e "DELETE FROM jobs"',
    'redis-cli FLUSHALL',
    `mongosh --eval 'db.dropDatabase()'`,
    'sqlite3 app.db "DROP TABLE cache"',
    'dropdb app_test',
    'docker compose exec db psql -U postgres -c "DROP TABLE t"',
  ]) {
    assert.equal(decide(script), undefined, script);
  }
});

test('commands that are not destructive database operations are untouched', () => {
  for (const script of [`psql "$DATABASE_URL" -c 'select count(*) from users'`, 'git commit -m "drop table support"', 'grep -r "DROP TABLE" migrations/',
    'psql -h db.example.com -c "CREATE TABLE t (id int)"', 'npx prisma migrate deploy', 'echo $HOME']) {
    assert.equal(decide(script), undefined, script);
  }
});

test('local hosts are loopback names and addresses or socket paths', () => {
  for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]', '/var/run/postgresql', '']) assert.ok(isLocalHost(host), host);
  for (const host of ['db.example.com', '10.0.0.5', '0.0.0.0', 'localhost.example.com', 'roundhouse.proxy.rlwy.net']) assert.ok(!isLocalHost(host), host);
});
