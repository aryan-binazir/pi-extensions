import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

/** Session-only credentials; the SDK owns discovery, registration, PKCE and refresh. */
export class SessionOAuth implements OAuthClientProvider {
  private information?:OAuthClientInformationMixed;
  private savedTokens?:OAuthTokens;
  private verifier?:string;
  private nonce=randomBytes(32).toString('hex');
  private server?:Server;
  private timer?:ReturnType<typeof setTimeout>;
  private receive!:(code:string)=>void;
  private reject!:(error:Error)=>void;
  authorizationStarted=false;
  redirectUrl='';
  readonly code=new Promise<string>((resolve,reject)=>{this.receive=resolve;this.reject=reject;});
  constructor(private config:{clientId?:string;scope?:string},private show:(url:string)=>void) {this.code.catch(()=>{});if(config.clientId)this.information={client_id:config.clientId};}
  static async start(config:{clientId?:string;scope?:string},show:(url:string)=>void) {
    const provider=new SessionOAuth(config,show);
    const server=createServer((req,res)=>{
      const u=new URL(req.url??'/',provider.redirectUrl);
      const state=u.searchParams.get('state')??'';
      if(u.pathname!=='/callback' || !/^[0-9a-f]{64}$/.test(state) || !timingSafeEqual(Buffer.from(state),Buffer.from(provider.nonce))) {res.writeHead(400);res.end('Invalid OAuth state');return;}
      const code=u.searchParams.get('code');
      if(!code || u.searchParams.has('error')){res.writeHead(400);res.end('Authorization declined');provider.reject(new Error('Authorization declined'));return;}
      provider.receive(code);res.end('Authorized. Return to Pi.');
    });
    provider.server=server;
    await new Promise<void>((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
    provider.redirectUrl=`http://127.0.0.1:${(server.address() as {port:number}).port}/callback`;
    provider.timer=setTimeout(()=>provider.reject(new Error('OAuth timed out')),120000);provider.timer.unref();
    return provider;
  }
  get clientMetadata(){return {client_name:'Pi MCP client',redirect_uris:[this.redirectUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none',...(this.config.scope?{scope:this.config.scope}:{})};}
  state(){return this.nonce;}
  clientInformation(){return this.information;}
  saveClientInformation(value:OAuthClientInformationMixed){this.information=value;}
  tokens(){return this.savedTokens;}
  saveTokens(value:OAuthTokens){this.savedTokens=value;}
  redirectToAuthorization(url:URL){if(url.protocol!=='https:' && !['127.0.0.1','localhost','[::1]'].includes(url.hostname))throw new Error('OAuth requires HTTPS');this.authorizationStarted=true;this.show(url.href);}
  saveCodeVerifier(value:string){this.verifier=value;}
  codeVerifier(){if(!this.verifier)throw new Error('OAuth verifier unavailable');return this.verifier;}
  invalidateCredentials(scope:'all'|'client'|'tokens'|'verifier'|'discovery'){if(scope==='all'||scope==='client')this.information=undefined;if(scope==='all'||scope==='tokens')this.savedTokens=undefined;if(scope==='all'||scope==='verifier')this.verifier=undefined;}
  async close(){clearTimeout(this.timer);this.reject(new Error('OAuth session closed'));const server=this.server;this.server=undefined;if(server){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}}
}
