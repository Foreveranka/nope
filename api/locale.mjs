/** Country-only locale selection from Vercel's edge-provided header.
 * No IP lookup, request logging, location storage, or external service. */
export function languageForCountry(country) {
 const code=typeof country==='string'?country.trim().toUpperCase():'';
 return ({TR:'tr',DE:'de',ES:'es',FR:'fr'})[code]||'en';
}
export default function handler(req,res) {
 res.setHeader('Cache-Control','private, no-store, max-age=0');
 res.setHeader('Vercel-CDN-Cache-Control','no-store');
 res.setHeader('CDN-Cache-Control','no-store');
 res.setHeader('Content-Type','application/json; charset=utf-8');
 res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET'){res.setHeader('Allow','GET');res.statusCode=405;res.end(JSON.stringify({error:'Method not allowed'}));return;}
 res.statusCode=200;
 res.end(JSON.stringify({language:languageForCountry(req.headers?.['x-vercel-ip-country'])}));
}
