import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {ListToolsRequestSchema,CallToolRequestSchema,ListResourcesRequestSchema,ListResourceTemplatesRequestSchema,ReadResourceRequestSchema,ListPromptsRequestSchema,GetPromptRequestSchema} from '@modelcontextprotocol/sdk/types.js';
export function configure(server) {
  let cancellations=0;
  server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'},delay:{type:'number'}},required:['text']},annotations:{readOnlyHint:true}}]}));
  server.setRequestHandler(CallToolRequestSchema,async(request,extra)=>{
    if(request.params._meta?.progressToken!==undefined)await extra.sendNotification({method:'notifications/progress',params:{progressToken:request.params._meta.progressToken,progress:1,total:2}});
    await new Promise(resolve=>setTimeout(resolve,5));
    if(request.params.arguments.delay)await new Promise((resolve,reject)=>{const timer=setTimeout(resolve,request.params.arguments.delay);extra.signal.addEventListener('abort',()=>{cancellations++;clearTimeout(timer);reject(new Error('cancelled'));},{once:true});});
    if(request.params.arguments.text==='tool-error')return {isError:true,content:[{type:'text',text:'synthetic tool failure'}]};
    if(request.params.arguments.text==='process-context')return {content:[{type:'text',text:JSON.stringify({cwd:process.cwd(),inherited:process.env.MCP_FIXTURE_INHERITED,override:process.env.MCP_FIXTURE_OVERRIDE})}]};
    return {content:[{type:'text',text:request.params.arguments.text==='process-id'?String(process.pid):request.params.arguments.text==='cancellation-count'?String(cancellations):request.params.arguments.text}]};
  });
  server.setRequestHandler(ListResourcesRequestSchema,async()=>({resources:[{uri:'fixture://hello',name:'hello'}]}));
  server.setRequestHandler(ListResourceTemplatesRequestSchema,async(request)=>request.params?.cursor === 'next' ? {resourceTemplates:[{name:'second',uriTemplate:'fixture://second/{id}'}]} : {resourceTemplates:[{name:'item',uriTemplate:'fixture://items/{id}'}],nextCursor:'next'});
  server.setRequestHandler(ReadResourceRequestSchema,async()=>({contents:[{uri:'fixture://hello',text:'resource text'}]}));
  server.setRequestHandler(ListPromptsRequestSchema,async()=>({prompts:[{name:'greeting'}]}));
  server.setRequestHandler(GetPromptRequestSchema,async()=>({messages:[{role:'user',content:{type:'text',text:'prompt text'}}]}));
  return server;
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href)await configure(new Server({name:'fixture',version:'1.0'},{capabilities:{tools:{},resources:{},prompts:{}}})).connect(new StdioServerTransport());
