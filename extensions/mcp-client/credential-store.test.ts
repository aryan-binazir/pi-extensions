import assert from 'node:assert/strict';
import test from 'node:test';
import { chmod, mkdtemp, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStoreError, createOAuthStore, credentialStoreTest, type OAuthState } from './credential-store.ts';

const key = 'a'.repeat(64);
const state: OAuthState = {
  redirectUrl: 'http://127.0.0.1:43123/callback',
  clientInformation: { client_id: 'synthetic-client', client_secret: 'SYNTHETIC_CLIENT_SECRET' },
  tokens: { access_token: 'SYNTHETIC_ACCESS_TOKEN', token_type: 'Bearer', refresh_token: 'SYNTHETIC_REFRESH_TOKEN' },
};

test('createOAuthStore is unavailable off macOS and validates storage keys on macOS', () => {
  assert.throws(() => createOAuthStore('/tmp', 'not-a-key'), (error: unknown) => error instanceof CredentialStoreError && error.code === 'invalid-key');
  if (process.platform !== 'darwin') assert.equal(createOAuthStore('/tmp', key), undefined);
});

test('store uses the bounded helper protocol for load, save, and delete', async () => {
  const requests: unknown[] = [];
  const responses: unknown[] = [
    { version: 1, ok: true, found: false },
    { version: 1, ok: true },
    { version: 1, ok: true, found: true, payload: state },
    { version: 1, ok: true },
  ];
  const store = credentialStoreTest.createOAuthStore(key, async request => { requests.push(request); return responses.shift(); });
  assert.equal(await store.load(), undefined);
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  await store.delete();
  assert.deepEqual(requests.map(value => (value as { action: string }).action), ['load', 'save', 'load', 'delete']);
  assert.equal((requests[1] as { service: string }).service, 'Harbor MCP OAuth');
  assert.equal((requests[1] as { account: string }).account, key);
  assert.deepEqual((requests[1] as { payload: OAuthState }).payload, state);
  assert.equal(Object.hasOwn(requests[0] as object, 'payload'), false);
});

test('load distinguishes missing credentials from denied and unavailable Keychain access', async () => {
  const result = async (response: unknown) => credentialStoreTest.createOAuthStore(key, async () => response).load();
  assert.equal(await result({ version: 1, ok: true, found: false }), undefined);
  await assert.rejects(result({ version: 1, ok: false, error: 'denied' }), (error: unknown) => error instanceof CredentialStoreError && error.code === 'denied' && /allow access/.test(error.message));
  await assert.rejects(result({ version: 1, ok: false, error: 'unavailable' }), (error: unknown) => error instanceof CredentialStoreError && error.code === 'unavailable' && /unlock Keychain/.test(error.message));
});

test('malformed helper responses and persisted SDK payloads fail closed', async () => {
  const invalid: unknown[] = [
    'not-json',
    { version: 1, ok: true },
    { version: 1, ok: true, found: false, payload: state },
    { version: 1, ok: false, error: 'denied', detail: 'unexpected' },
    { version: 1, ok: true, found: true },
    { version: 1, ok: true, found: true, payload: { redirectUrl: 'https://127.0.0.1:43123/callback' } },
    { version: 1, ok: true, found: true, payload: { redirectUrl: 'http://localhost:43123/callback' } },
    { version: 1, ok: true, found: true, payload: { redirectUrl: 'http://127.0.0.1:43123/callback?code=x' } },
    { version: 1, ok: true, found: true, payload: { redirectUrl: 'http://127.0.0.1:43123/callback', tokens: { token_type: 'Bearer' } } },
    { version: 1, ok: true, found: true, payload: { redirectUrl: 'http://127.0.0.1:43123/callback', clientInformation: { client_secret: 'x' } } },
    { version: 1, ok: true, found: true, payload: { redirectUrl: 'http://127.0.0.1:43123/callback', unexpected: true } },
  ];
  for (const response of invalid) {
    const store = credentialStoreTest.createOAuthStore(key, async () => response);
    await assert.rejects(store.load(), CredentialStoreError);
  }
});

test('state size is bounded before invoking the helper', async () => {
  let calls = 0;
  const store = credentialStoreTest.createOAuthStore(key, async () => { calls++; return { version: 1, ok: true }; });
  await assert.rejects(store.save({ ...state, tokens: { access_token: 'x'.repeat(70 * 1024), token_type: 'Bearer' } }), (error: unknown) => error instanceof CredentialStoreError && error.code === 'invalid-state');
  assert.equal(calls, 0);

  const oversized = { version: 1, ok: true, found: true, payload: { ...state, tokens: { access_token: 'x'.repeat(70 * 1024), token_type: 'Bearer' } } };
  await assert.rejects(credentialStoreTest.createOAuthStore(key, async () => oversized).load(), (error: unknown) => error instanceof CredentialStoreError && error.code === 'invalid-state');
});

test('runner failures and native errors cannot expose secret text', async () => {
  const secret = 'DO_NOT_EXPOSE_THIS_SYNTHETIC_SECRET';
  const cases = [
    credentialStoreTest.createOAuthStore(key, async () => { throw new Error(secret); }).load(),
    credentialStoreTest.createOAuthStore(key, async () => ({ version: 1, ok: false, error: secret })).load(),
    credentialStoreTest.createOAuthStore(key, async () => ({ version: 1, ok: true, found: true, payload: { redirectUrl: secret } })).load(),
  ];
  for (const promise of cases) {
    await assert.rejects(promise, (error: unknown) => {
      assert.ok(error instanceof CredentialStoreError);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    });
  }
});

test('native helper locks the same identity while allowing a different identity', {
  skip: process.platform !== 'darwin' || process.env.HARBOR_NATIVE_CREDENTIAL_TEST !== '1',
}, async () => {
  const agentDir = await realpath(await mkdtemp(join(tmpdir(), 'harbor-oauth-lock-')));
  let releaseFirst!: () => void;
  const firstMayFinish = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstEntered!: () => void;
  const firstDidEnter = new Promise<void>(resolve => { firstEntered = resolve; });
  try {
    const first = createOAuthStore(agentDir, key)!;
    const contender = createOAuthStore(agentDir, key)!;
    const independent = createOAuthStore(agentDir, 'b'.repeat(64))!;
    assert.ok(first.withLock && contender.withLock && independent.withLock);

    const held = first.withLock(async () => { firstEntered(); await firstMayFinish; });
    await firstDidEnter;
    let contenderEntered = false;
    const waiting = contender.withLock(async () => { contenderEntered = true; });
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(contenderEntered, false);
    assert.equal(await independent.withLock(async () => 'independent'), 'independent');
    releaseFirst();
    await Promise.all([held, waiting]);
    assert.equal(contenderEntered, true);

    const callbackFailure = new Error('synthetic callback failure');
    await assert.rejects(first.withLock(async () => { throw callbackFailure; }), error => error === callbackFailure);
    assert.equal(await contender.withLock(async () => 'released'), 'released');

    const originalDeveloperDir = process.env.DEVELOPER_DIR;
    const retryStore = createOAuthStore(agentDir, 'c'.repeat(64))!;
    try {
      process.env.DEVELOPER_DIR = '/does/not/exist';
      await assert.rejects(retryStore.withLock!(async () => assert.fail('callback ran without a lease')), (error: unknown) => error instanceof CredentialStoreError && error.code === 'compiler-unavailable');
    } finally {
      if (originalDeveloperDir === undefined) delete process.env.DEVELOPER_DIR;
      else process.env.DEVELOPER_DIR = originalDeveloperDir;
    }
    assert.equal(await retryStore.withLock!(async () => 'retried'), 'retried');

    const lockPath = join(agentDir, '.harbor-mcp-oauth', `${key}.lock`);
    assert.equal((await stat(lockPath)).isFile(), true);
    await chmod(lockPath, 0o644);
    let callbackRan = false;
    await assert.rejects(first.withLock(async () => { callbackRan = true; }), (error: unknown) => error instanceof CredentialStoreError && error.code === 'lock');
    assert.equal(callbackRan, false);
  } finally {
    releaseFirst();
    await rm(agentDir, { recursive: true, force: true });
  }
});
