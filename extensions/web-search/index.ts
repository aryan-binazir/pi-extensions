import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { search } from './search.ts';
export default function webSearch(pi:ExtensionAPI):void {
 pi.registerTool({
  name:'web_search',label:'Web search',description:'Search DuckDuckGo lightweight HTML. Returns untrusted result titles, links and snippets only. No pages are visited and no secondary agent is used.',
  parameters:Type.Object({query:Type.String({minLength:1,maxLength:1000}),limit:Type.Optional(Type.Integer({minimum:1,maximum:10}))}),
  async execute(_id,params,signal){const results=await search(params.query,params.limit,signal);return {content:[{type:'text',text:JSON.stringify({untrustedSearchResults:results})}],details:{results}};},
 });
}
