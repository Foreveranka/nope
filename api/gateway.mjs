import {createGateway} from '../cloud/gateway/core.mjs';
import {blobStore} from '../cloud/gateway/blob.mjs';
const handle = createGateway({store:blobStore()});
export default async function handler(req,res) {
  try {
  const chunks=[];let size=0;
  for await (const chunk of req) {size+=chunk.length;if(size>16384){res.statusCode=413;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end('{"error":"Payload too large."}');return;}chunks.push(chunk);}
  const init={method:req.method,headers:req.headers};
  if (!['GET','HEAD'].includes(req.method)) init.body=Buffer.concat(chunks);
  const routed = new URL(req.url,'https://gateway.invalid');
  if (routed.pathname === '/api/gateway') {
    const routes = routed.searchParams.getAll('route');
    if (routes.length !== 1 || !/^[a-zA-Z0-9/-]{1,100}$/.test(routes[0])) {
      res.statusCode=400;res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.end('{"error":"Invalid route."}');return;
    }
    routed.pathname = '/api/cloud/' + routes[0];routed.search='';
  }
  const response=await handle(new Request(routed,init));
  res.statusCode=response.status;for(const [name,value]of response.headers)res.setHeader(name,value);
  res.end(Buffer.from(await response.arrayBuffer()));
  } catch {
    if (!res.headersSent && !res.writableEnded && !res.destroyed) {
      res.statusCode=503;
      res.setHeader('Content-Type','application/json');
      res.setHeader('Cache-Control','no-store');
      res.setHeader('X-Content-Type-Options','nosniff');
      res.end('{"error":"Service temporarily unavailable."}');
    }
  }
}
