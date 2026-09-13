import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionOAuth } from './oauth.ts';
import { McpConnection, publicError } from './client.ts';
import { CredentialStoreError, type OAuthState, type OAuthStore } from './credential-store.ts';
import { startFixture } from './fixture.ts';

const state: OAuthState = { redirectUrl: 'http://127.0.0.1:12345/callback', clientInformation: { client_id: 'fixture-client' }, tokens: { access_token: 'synthetic-access', refresh_token: 'synthetic-refresh', token_type: 'Bearer' } };

test('restored OAuth has no interactive listener and persists only durable fields', async () => {
  let saved: OAuthState | undefined;
  const store: OAuthStore = { load: async () => state, save: async value => { saved = value; }, delete: async () => {} };
  const oauth = SessionOAuth.restore({}, state, store);
  try {
    assert.throws(() => oauth.redirectToAuthorization(new URL('https://auth.example/authorize')), /Unauthorized/);
    assert.throws(() => oauth.saveCodeVerifier('never-store-me'), /Unauthorized/);
    await oauth.saveTokens({ ...state.tokens!, access_token: 'rotated' });
    assert.deepEqual(Object.keys(saved!).sort(), ['clientInformation', 'redirectUrl', 'tokens']);
    assert.equal(saved!.tokens!.access_token, 'rotated');
    await oauth.invalidateCredentials('tokens');
    assert.equal(saved!.tokens, undefined);
    assert.equal(saved!.clientInformation!.client_id, 'fixture-client');
  } finally { await oauth.dispose(); }
});

test('dispose drains already-started storage writes and forbids later persistence', async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let writes = 0, deleted = false;
  const store: OAuthStore = { load: async () => state, save: async () => { writes++; entered(); await gate; }, delete: async () => { deleted = true; } };
  const oauth = SessionOAuth.restore({}, state, store);
  const saving = oauth.saveTokens(state.tokens!);
  await started;
  const disposing = oauth.dispose().then(() => store.delete());
  await Promise.resolve(); assert.equal(deleted, false);
  release(); await saving; await disposing;
  await oauth.saveTokens(state.tokens!);
  assert.equal(writes, 1); assert.equal(deleted, true);
});

test('interactive registration is staged until successful login and shutdown drains every accepted save', async () => {
  const snapshots: OAuthState[] = [];
  const store: OAuthStore = { load: async () => state, save: async value => { snapshots.push(value); }, delete: async () => {} };
  const interactive = await SessionOAuth.start({}, () => {}, store);
  try {
    await interactive.saveClientInformation({ client_id: 'new-registration' });
    await interactive.saveTokens(state.tokens!);
    assert.equal(snapshots.length, 0);
    await interactive.commit(); assert.equal(snapshots.length, 1);
  } finally { await interactive.dispose(); }
  snapshots.length = 0;
  const restored = SessionOAuth.restore({}, state, store);
  const first = restored.saveTokens({ ...state.tokens!, access_token: 'first' });
  const second = restored.saveTokens({ ...state.tokens!, access_token: 'second' });
  await restored.dispose(); await first; await second;
  assert.deepEqual(snapshots.map(value => value.tokens!.access_token), ['first', 'second']);
});

test('credential loading has its own budget, separate from the MCP handshake deadline', async () => {
  const fixture = await startFixture('http');
  const store: OAuthStore = { load: async () => { await new Promise(resolve => setTimeout(resolve, 120)); return undefined; }, save: async () => {}, delete: async () => {} };
  const connection = new McpConnection('slow-keychain', { ...fixture.config, oauth: {}, startupTimeoutMs: 80 }, process.cwd(), store);
  try { assert.equal((await connection.connect())[0].name, 'echo'); }
  finally { await connection.close(); await fixture.close(); }
});

test('shutdown cancels waiting for credential loading and prevents late restoration', async () => {
  let release!: (value: OAuthState) => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const store: OAuthStore = { load: () => { entered(); return new Promise(resolve => { release = resolve; }); }, save: async () => {}, delete: async () => {} };
  const connection = new McpConnection('cancel-keychain', { url: 'http://127.0.0.1:1', oauth: {} }, process.cwd(), store);
  const pending = assert.rejects(connection.connect(), /cancelled/);
  await started; await connection.close(); await pending;
  release(state); await new Promise(resolve => setImmediate(resolve));
  assert.equal(connection.status.state, 'closed');
});

test('Keychain failures remain actionable and do not silently fall back to unsigned connections', async () => {
  const error = new CredentialStoreError('denied');
  const store: OAuthStore = { load: async () => { throw error; }, save: async () => { throw error; }, delete: async () => {} };
  const connection = new McpConnection('linear', { url: 'https://mcp.example/mcp', oauth: {} }, process.cwd(), store);
  try {
    await assert.rejects(connection.connect(), candidate => candidate === error);
    assert.equal(connection.status.state, 'failed');
    assert.equal(publicError(error), error);
    const oauth = SessionOAuth.restore({}, state, store);
    try { await assert.rejects(oauth.saveTokens(state.tokens!), candidate => candidate === error); }
    finally { await oauth.dispose(); }
  } finally { await connection.close(); }
});
