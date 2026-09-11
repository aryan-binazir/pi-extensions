import assert from 'node:assert/strict';
import test from 'node:test';
import { parseResults, publicAddress, readSearchResponse } from './search.ts';
import { Readable } from 'node:stream';
const fixture=`<div class="result"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.org%2Fa%3Fx%3D1%26y%3D2">A &amp; B</a><a class="result__snippet">A &#x1f680; &quot;snippet&quot;</a></div><div class="result"><a class="result__a" href="https://example.org/a?x=1&amp;y=2">Duplicate</a></div><div class="result"><a class="result__a" href="https://example.net">Next</a></div>`;
test('search decodes wrappers/entities, pairs snippets, deduplicates and limits',()=>{
 assert.deepEqual(parseResults(fixture,1),[{title:'A & B',url:'https://example.org/a?x=1&y=2',snippet:'A 🚀 "snippet"'}]);
 assert.equal(parseResults(fixture,10).length,2);
 assert.throws(()=>parseResults('<form id="challenge-form">captcha</form>',5),/challenge/);
 assert.throws(()=>parseResults('<html>Changed markup</html>',5),/recognized/);
 assert.deepEqual(parseResults('<div class="no-results">No results</div>',5),[]);
});
test('network boundaries reject nonpublic DNS and excessive response bytes',async()=>{
 for(const ip of ['127.0.0.1','10.1.2.3','169.254.169.254','::1','::ffff:127.0.0.1','fe80::1','100.64.1.2'])assert.equal(publicAddress(ip),false,ip);
 assert.equal(publicAddress('1.1.1.1'),true);
 await assert.rejects(readSearchResponse(Readable.from(['abcdef']),5),/exceeds/);
});

import { EventEmitter } from 'node:events';
import { search } from './search.ts';
function transport(status:number,body:string,location?:string){
 const calls:any[]=[];
 const request:any=(url:URL,options:any,callback:any)=>{
  calls.push({url,options});const req=new EventEmitter() as any;
  req.end=()=>queueMicrotask(()=>{
   const response=Readable.from([body]) as any;
   response.statusCode=status;response.headers={'content-type':'text/html',location};callback(response);
  });return req;
 };
 return {calls,request};
}
test('search request is fixed HTTPS and never follows redirects or hides status failures',async()=>{
 const fixtureTransport=transport(200,fixture);
 assert.equal((await search('A & B',2,undefined,fixtureTransport)).length,2);
 assert.equal(fixtureTransport.calls[0].url.origin,'https://html.duckduckgo.com');
 assert.equal(fixtureTransport.calls[0].url.searchParams.get('q'),'A & B');
 assert.equal(fixtureTransport.calls[0].options.agent,false);
 for(const [status,pattern] of [[302,/redirect/],[429,/rate limited/],[503,/503/]] as const){
  const fixtureTransport=transport(status,'','http://127.0.0.1/secrets');
  await assert.rejects(search('test',5,undefined,fixtureTransport),pattern);assert.equal(fixtureTransport.calls.length,1);
 }
});
test('request deadline cancels a server that never responds',async()=>{
 let aborted=false;
 const request:any=(_url:any,options:any)=>{
  const req=new EventEmitter() as any;req.end=()=>{};
  options.signal.addEventListener('abort',()=>{aborted=true;req.emit('error',new Error('aborted'));});return req;
 };
 const keepAlive=setTimeout(()=>{},1000);
 try{await assert.rejects(search('test',5,undefined,{request,timeoutMs:10}),/timed out/);assert.equal(aborted,true);}
 finally{clearTimeout(keepAlive);}
});
test('DNS used by the request rejects private addresses before connecting',async()=>{
 const fixtureTransport=transport(200,fixture);
 const lookup:any=(_host:any,_options:any,callback:any)=>callback(null,[{address:'127.0.0.1',family:4}]);
 await search('test',5,undefined,{...fixtureTransport,lookup});
 await new Promise<void>(resolve=>fixtureTransport.calls[0].options.lookup('html.duckduckgo.com',{all:true},(error:Error)=>{assert.match(error.message,/nonpublic/);resolve();}));
});
test('legitimate captcha search results are not treated as a challenge',()=>{
 assert.equal(parseResults(fixture.replace('A &amp; B','How CAPTCHA works'),1)[0].title,'How CAPTCHA works');
});

test('anchors without href never become fabricated search results',()=>{
 assert.deepEqual(parseResults('<div class="result"><a class="result__a">Missing link</a></div><div class="no-results"></div>',5),[]);
});
