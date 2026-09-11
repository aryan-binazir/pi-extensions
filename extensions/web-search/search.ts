import { lookup } from 'node:dns';
import { request } from 'node:https';
import type { Readable } from 'node:stream';
import { DomUtils, parseDocument } from 'htmlparser2';
import ipaddr from 'ipaddr.js';
export interface SearchResult {title:string;url:string;snippet:string}
export function publicAddress(address:string):boolean {
 try {return ipaddr.process(address).range()==='unicast';}catch{return false;}
}
export function parseResults(html:string,limit:number):SearchResult[] {
 if(/id=["\'](?:challenge-form|anomaly-modal)|action=["\'][^"\']*anomaly\.js/i.test(html))throw new Error('Search challenge/captcha; no results retrieved');
 const doc=parseDocument(html);
 const hasClass=(node:Parameters<typeof DomUtils.textContent>[0],name:string)=>String('attribs' in node ? node.attribs.class??'' : '').split(/\s+/).includes(name);
 const links=DomUtils.findAll(node=>node.name==='a'&&hasClass(node,'result__a'),doc.children);
 const results:SearchResult[]=[];const seen=new Set<string>();
 for(const link of links){
  try {
   let url=new URL(link.attribs.href,'https://html.duckduckgo.com');
   if(['duckduckgo.com','html.duckduckgo.com'].includes(url.hostname)&&url.pathname==='/l/')url=new URL(url.searchParams.get('uddg')??'');
   if(!['http:','https:'].includes(url.protocol)||url.username||url.password)continue;
   url.hash='';if(seen.has(url.href))continue;
   let parent=link.parent;
   while(parent && !hasClass(parent,'result'))parent=parent.parent;
   const snippet=parent&&'children' in parent?DomUtils.findOne(node=>hasClass(node,'result__snippet'),parent.children,true):null;
   const text=(node:Parameters<typeof DomUtils.textContent>[0])=>DomUtils.textContent(node).replace(/\s+/g,' ').trim();
   const title=text(link).slice(0,512);if(!title)continue;
   results.push({title,url:url.href,snippet:snippet?text(snippet).slice(0,2000):''});seen.add(url.href);
   if(results.length>=limit)break;
  }catch{/* Invalid links are never followed. */}
 }
 if(!results.length&&!/no-results|No results found/i.test(html))throw new Error('Search markup not recognized or yielded no valid results');
 return results;
}
export async function readSearchResponse(stream:Readable,maxBytes=1_000_000):Promise<string> {
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of stream){const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk);size+=bytes.length;if(size>maxBytes){stream.destroy();throw new Error('Search response exceeds byte limit');}chunks.push(bytes);}
 return Buffer.concat(chunks).toString('utf8');
}
export async function search(query:string,limit=5,signal?:AbortSignal,network:{request?:typeof request;lookup?:typeof lookup;timeoutMs?:number}={}):Promise<SearchResult[]> {
 if(typeof query!=='string'||!query.trim()||query.length>1000)throw new Error('Query must contain 1–1000 characters');
 if(!Number.isInteger(limit)||limit<1||limit>10)throw new Error('Result limit must be 1–10');
 const deadline=AbortSignal.any([AbortSignal.timeout(network.timeoutMs??10_000),...(signal?[signal]:[])]);
 deadline.throwIfAborted();
 const url=new URL('https://html.duckduckgo.com/html/');url.searchParams.set('q',query);
 const html=await new Promise<string>((resolve,reject)=>{
  const req=(network.request??request)(url,{
   signal:deadline,agent:false,headers:{'User-Agent':'Pi-Web-Search/1.0','Accept':'text/html','Accept-Encoding':'identity'},
   lookup(hostname,options,callback){
    (network.lookup??lookup)(hostname,{all:true},(error,addresses)=>{
     if(error){callback(error,'',4);return;}
     if(!addresses.length||addresses.some(value=>!publicAddress(value.address))){callback(new Error('Search DNS returned a nonpublic address'),'',4);return;}
     if(options.all)callback(null,addresses);else callback(null,addresses[0].address,addresses[0].family);
    });
   },
  },response=>{
   const status=response.statusCode??0;
   if(status!==200){response.destroy();reject(new Error(status===429?'Search rate limited (HTTP 429)':status>=300&&status<400?'Search redirect refused':`Search unavailable (HTTP ${status})`));return;}
   if(!String(response.headers['content-type']).includes('text/html')){response.destroy();reject(new Error('Search returned non-HTML content'));return;}
   void readSearchResponse(response).then(resolve,reject);
  });
  req.on('error',()=>reject(new Error(deadline.aborted?'Search cancelled or timed out':'Search network request failed')));
  req.end();
 });
 return parseResults(html,limit);
}
