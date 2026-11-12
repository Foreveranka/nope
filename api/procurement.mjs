import {createProcurement} from '../procurement/core.mjs';
import {blobProcurementStore} from '../procurement/blob.mjs';
import {createBlobSelectionVerifier} from '../operators/blob-evidence.mjs';
let handle;
function configuredHandler(){
 if(handle)return handle;
 let selectionVerifier;
 const raw=process.env.NOPE_OPERATOR_COMMITTEE;
 if(raw){const committee=JSON.parse(raw);if(committee.operation!=='operator-reported')throw new Error('Live committee required');selectionVerifier=createBlobSelectionVerifier({committee,expectedCommitteeHash:process.env.NOPE_OPERATOR_COMMITTEE_HASH});}
 handle=createProcurement({store:blobProcurementStore(),selectionVerifier});return handle;
}
export default async function handler(req,res){
 try{
  const chunks=[];let size=0;
  for await(const chunk of req){size+=chunk.length;if(size>16384){res.statusCode=413;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Payload too large.',code:'BODY_TOO_LARGE'}));return;}chunks.push(chunk);}
  // Never trust forwarded host for authorization. The configured origin is the deployment boundary.
  const base=process.env.NOPE_PROCUREMENT_ORIGIN||'https://veil-procurement.vercel.app';
  const url=new URL(req.url,base);
  if(url.pathname==='/api/procurement'){
   const routes=url.searchParams.getAll('route');
   if(routes.length!==1||!/^[a-zA-Z0-9/-]{1,120}$/.test(routes[0]))throw new Error('Invalid route');
   url.pathname='/api/procurement/'+routes[0];url.searchParams.delete('route');
  }
  const init={method:req.method,headers:req.headers};if(!['GET','HEAD'].includes(req.method))init.body=Buffer.concat(chunks);
  const response=await configuredHandler()(new Request(url,init));res.statusCode=response.status;for(const [key,value]of response.headers)res.setHeader(key,value);res.end(Buffer.from(await response.arrayBuffer()));
 }catch{
  if(!res.headersSent&&!res.writableEnded&&!res.destroyed){res.statusCode=503;res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({error:'Service temporarily unavailable.',code:'SERVICE_UNAVAILABLE'}));}
 }
}
