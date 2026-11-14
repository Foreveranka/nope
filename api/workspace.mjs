import {createWorkspace} from '../workspace/core.mjs';
import {blobWorkspaceStore} from '../workspace/blob.mjs';
import {createEscrowService} from '../workspace/escrow.mjs';
const MAX=1024*1024;
const reject=(status,code)=>{throw Object.assign(Error(code),{status,code});};
function parsedBody(value,MAX=1024*1024){
 let budget=MAX;const seen=new WeakSet();
 const consume=n=>{budget-=n;if(budget<0)reject(413,'BODY_TOO_LARGE');};
 function visit(v,d){
  if(d>16)reject(400,'INVALID_JSON');
  if(v===null||typeof v==='boolean'||typeof v==='number'&&Number.isFinite(v)){consume(JSON.stringify(v).length);return;}
  if(typeof v==='string'){if(v.length>MAX)reject(413,'BODY_TOO_LARGE');consume(Buffer.byteLength(JSON.stringify(v)));return;}
  if(!v||typeof v!=='object'||seen.has(v))reject(400,'INVALID_JSON');
  const array=Array.isArray(v);if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype)&&!(Object.getPrototypeOf(v)===null&&!array))reject(400,'INVALID_JSON');
  seen.add(v);consume(2);const keys=Reflect.ownKeys(v);if(keys.length>MAX/2)reject(413,'BODY_TOO_LARGE');let count=0;
  for(const key of keys){if(array&&key==='length')continue;if(typeof key!=='string'||array&&key!==String(count))reject(400,'INVALID_JSON');const desc=Object.getOwnPropertyDescriptor(v,key);if(!desc.enumerable||!Object.hasOwn(desc,'value'))reject(400,'INVALID_JSON');if(count++)consume(1);if(!array)consume(Buffer.byteLength(JSON.stringify(key))+1);visit(desc.value,d+1);}
  if(array&&count!==v.length)reject(400,'INVALID_JSON');seen.delete(v);
 }
 visit(value,0);return Buffer.from(JSON.stringify(value));
}
/** Injectable adapter for local preview/tests; production always uses private Blob. */
export function createWorkspaceHandler({env=process.env,store,handle}={}){
 let core=handle;
 return async function handler(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json; charset=utf-8');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  try{
   const base=env.NOPE_WORKSPACE_ORIGIN||'https://veil-procurement.vercel.app',url=new URL(req.url,base);
   if(url.pathname==='/api/workspace'){
    const routes=url.searchParams.getAll('route');if(routes.length!==1||!/^(?:session|jobs(?:\/[a-f0-9]{32}(?:\/(?:offers|close|award|task|execute|decision|proof(?:\/evidence)?|payment\/(?:verify|fund|record|release|refund|refresh)))?)?)$/.test(routes[0]))reject(404,'ROUTE_NOT_FOUND');url.pathname='/api/workspace/'+routes[0];url.searchParams.delete('route');
   }
   const MAX=url.pathname==='/api/workspace/jobs'?3*1024*1024:1024*1024;
   if(req.headers?.['content-encoding']&&req.headers['content-encoding']!=='identity')reject(415,'INVALID_ENCODING');
   const len=req.headers?.['content-length'];if(len!==undefined&&(typeof len!=='string'||!/^(0|[1-9][0-9]*)$/.test(len)))reject(400,'INVALID_LENGTH');if(len!==undefined&&Number(len)>MAX)reject(413,'BODY_TOO_LARGE');
   let bytes;
   const parsed=req.body!==undefined&&!Buffer.isBuffer(req.body)&&typeof req.body!=='string';
   if(req.body!==undefined){if((typeof req.body==='string'&&Buffer.byteLength(req.body)>MAX)||(Buffer.isBuffer(req.body)&&req.body.length>MAX))reject(413,'BODY_TOO_LARGE');bytes=parsed?parsedBody(req.body,MAX):Buffer.from(req.body);if(bytes.length>MAX)reject(413,'BODY_TOO_LARGE');}
   else{const chunks=[];let size=0;for await(const c of req){const b=Buffer.from(c);size+=b.length;if(size>MAX)reject(413,'BODY_TOO_LARGE');chunks.push(b);}bytes=Buffer.concat(chunks);}
   if(!parsed&&len!==undefined&&Number(len)!==bytes.length)reject(400,'INVALID_LENGTH');
   const headers=new Headers();for(const [k,v]of Object.entries(req.headers||{}))if(v!==undefined){if(Array.isArray(v))reject(400,'INVALID_HEADERS');headers.set(k,v);}if(parsed)headers.delete('content-length');
   const method=req.method||'GET';if(['GET','HEAD'].includes(method)&&bytes.length)reject(400,'UNEXPECTED_BODY');
   if(!core){const durableStore=store||blobWorkspaceStore(env);core=createWorkspace({store:durableStore,env,escrow:createEscrowService({store:durableStore,env})});}
   const result=await core(new Request(url,{method,headers,...(!['GET','HEAD'].includes(method)?{body:bytes}:{})}));
   res.statusCode=result.status;for(const [k,v]of result.headers)res.setHeader(k,v);res.end(Buffer.from(await result.arrayBuffer()));
  }catch(e){res.statusCode=e.status||503;res.end(JSON.stringify({error:res.statusCode===503?'Service temporarily unavailable.':'Request rejected.',code:e.code||'SERVICE_UNAVAILABLE'}));}
 };
}
export default createWorkspaceHandler();
