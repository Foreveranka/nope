import test from 'node:test';
import assert from 'node:assert/strict';
import handler,{languageForCountry} from '../api/locale.mjs';

test('country selection follows the four localized countries and English everywhere else',()=>{
 for(const [country,expected]of [['TR','tr'],['DE','de'],['ES','es'],['FR','fr'],['GB','en'],['US','en'],['AT','en'],['CH','en'],['MX','en'],['CA','en'],['JP','en'],['','en'],[undefined,'en'],[['TR'],'en'],[' de ','de']])assert.equal(languageForCountry(country),expected);
});
test('locale endpoint is uncached, country-only, read-only and returns no IP',()=>{
 const headers={};let body;
 const res={setHeader(k,v){headers[k]=v;},end(v){body=JSON.parse(v);}};
 handler({method:'GET',headers:{'x-vercel-ip-country':'FR','x-forwarded-for':'PRIVATE-IP-MARKER','accept-language':'tr'}},res);
 assert.equal(res.statusCode,200);assert.deepEqual(body,{language:'fr'});
 assert.match(headers['Cache-Control'],/private.*no-store/);assert.equal(headers['Vercel-CDN-Cache-Control'],'no-store');
 handler({method:'GET',headers:{'accept-language':'tr','x-forwarded-for':'PRIVATE-IP-MARKER'}},res);assert.deepEqual(body,{language:'en'});
 handler({method:'POST',headers:{'x-vercel-ip-country':'TR'}},res);assert.equal(res.statusCode,405);assert.equal(headers.Allow,'GET');
});
