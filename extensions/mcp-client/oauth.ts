import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { UnauthorizedError, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthState, OAuthStore } from './credential-store.ts';

/** The SDK owns discovery, registration, PKCE and refresh; only durable credentials enter the store. */
export class SessionOAuth implements OAuthClientProvider {
  private information?: OAuthClientInformationMixed;
  private savedTokens?: OAuthTokens;
  private verifier?: string;
  private nonce = randomBytes(32).toString('hex');
  private server?: Server;
  private closed = true;
  private disposed = false;
  private persistenceEnabled = true;
  private pending: Promise<void> = Promise.resolve();
  private timer?: ReturnType<typeof setTimeout>;
  private receive!: (code: string) => void;
  private reject!: (error: Error) => void;
  authorizationStarted = false;
  redirectUrl = '';
  readonly code = new Promise<string>((resolve, reject) => { this.receive = resolve; this.reject = reject; });

  constructor(private config: { clientId?: string; scope?: string }, private show: (url: string) => void, private store?: OAuthStore) {
    this.code.catch(() => {});
    if (config.clientId) this.information = { client_id: config.clientId };
  }

  static restore(config: { clientId?: string; scope?: string }, state: OAuthState, store: OAuthStore) {
    const provider = new SessionOAuth(config, () => {}, store);
    provider.adopt(state);
    return provider;
  }

  adopt(state: OAuthState) {
    this.redirectUrl = state.redirectUrl;
    this.information = state.clientInformation ?? (this.config.clientId ? { client_id: this.config.clientId } : undefined);
    this.savedTokens = state.tokens;
  }

  async commit() {
    this.persistenceEnabled = true;
    if (this.savedTokens) await this.persist();
  }

  static async start(config: { clientId?: string; scope?: string }, show: (url: string) => void, store?: OAuthStore) {
    // A new interactive login uses a new callback and, for DCR, a new registration.
    // Restored registrations are used only for passive refresh, never with a different callback URI.
    const provider = new SessionOAuth(config, show, store);
    provider.persistenceEnabled = false;
    const server = createServer((req, res) => {
      const u = new URL(req.url ?? '/', provider.redirectUrl);
      const state = u.searchParams.get('state') ?? '';
      if (u.pathname !== '/callback' || !/^[0-9a-f]{64}$/.test(state) || !timingSafeEqual(Buffer.from(state), Buffer.from(provider.nonce))) { res.writeHead(400); res.end('Invalid OAuth state'); return; }
      const code = u.searchParams.get('code');
      if (!code || u.searchParams.has('error')) { res.writeHead(400); res.end('Authorization declined'); provider.reject(new Error('Authorization declined')); return; }
      provider.receive(code); res.end('Authorized. Return to Pi.');
    });
    provider.server = server;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    provider.closed = false;
    provider.redirectUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/callback`;
    provider.timer = setTimeout(() => provider.reject(new Error('OAuth timed out')), 120000); provider.timer.unref();
    return provider;
  }

  private persist(): Promise<void> {
    if (!this.store || this.disposed || !this.persistenceEnabled) return Promise.resolve();
    const state: OAuthState = structuredClone({ redirectUrl: this.redirectUrl, clientInformation: this.information, tokens: this.savedTokens });
    const store = this.store;
    const operation = this.pending.catch(() => {}).then(async () => {
      await store.save(state);
    });
    this.pending = operation;
    return operation;
  }

  get clientMetadata() { return { client_name: 'Harbor MCP', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', ...(this.config.scope ? { scope: this.config.scope } : {}) }; }
  state() { return this.nonce; }
  clientInformation() { return this.information; }
  saveClientInformation(value: OAuthClientInformationMixed) { this.information = value; return this.persist(); }
  tokens() { return this.savedTokens; }
  saveTokens(value: OAuthTokens) { this.savedTokens = value; return this.persist(); }
  redirectToAuthorization(url: URL) {
    if (this.closed || this.disposed) throw new UnauthorizedError();
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('OAuth requires HTTPS');
    this.authorizationStarted = true; this.show(url.href);
  }
  saveCodeVerifier(value: string) { if (this.closed || this.disposed) throw new UnauthorizedError(); this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error('OAuth verifier unavailable'); return this.verifier; }
  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'all' || scope === 'client') this.information = undefined;
    if (scope === 'all' || scope === 'tokens') this.savedTokens = undefined;
    if (scope === 'all' || scope === 'verifier') this.verifier = undefined;
    return ['all', 'client', 'tokens'].includes(scope) ? this.persist() : Promise.resolve();
  }
  async close() {
    this.closed = true; clearTimeout(this.timer); this.reject(new Error('OAuth session closed'));
    const server = this.server; this.server = undefined;
    if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }
  async dispose() {
    this.disposed = true;
    await this.close();
    await this.pending.catch(() => {});
    this.information = undefined; this.savedTokens = undefined; this.verifier = undefined;
  }
}
