import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {validateDocs, fetchDocs, loadDocsLocale, renderDocs, startDocs, MAX_DOCS_BYTES} from '../web/docs.js';
import {setLanguage, getLanguage} from '../web/i18n.mjs';
import {estimateProofPlan} from '../web/proof-plan-core.mjs';
import {referenceApply} from '../web/recipe-core.mjs';

const source = JSON.parse(await fs.readFile(new URL('../web/docs-locales/tr.json', import.meta.url), 'utf8'));
const catalog = (language, title = `${language} documentation`) => ({...structuredClone(source), locale:language, page:{title,intro:`${language} introduction`}});
const response = value => new Response(JSON.stringify(value), {headers:{'content-type':'application/json'}});

class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.nodeType = 1; this.childNodes = []; this.attrs = {}; this.dataset = {}; this.listeners = {}; this._text = ''; }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  get textContent() { return this._text + this.childNodes.map(n => n.textContent).join(''); }
  set innerHTML(_) { throw Error('HTML parsing is forbidden in documentation'); }
  append(...children) { for (const child of children) { child.parentElement = this; this.childNodes.push(child); } }
  replaceChildren(...children) { this._text = ''; this.childNodes = []; this.append(...children); }
  setAttribute(key, value) { this.attrs[key] = String(value); }
  getAttribute(key) { return this.attrs[key] ?? (key === 'href' ? this.href : null) ?? null; }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  get classList() { return {contains:name => (this.className || '').split(' ').includes(name)}; }
  matches(selector) { return ['script','style','code','pre','textarea'].includes(this.tagName) || this.attrs['data-i18n-ignore'] !== undefined; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector); }
  querySelectorAll(selector) {
    const found = [];
    const walk = element => {
      if (selector === 'a' && element.tagName === 'a' || selector === '[data-docs-ui]' && element.dataset.docsUi || selector === '[data-nope-language]' && element.dataset.nopeLanguage) found.push(element);
      element.childNodes.forEach(walk);
    };
    this.childNodes.forEach(walk); return found;
  }
  scrollIntoView() { this.ownerDocument.scrolledTo = this.id; }
}
function fixture() {
  const doc = {createElement:tag => new Element(tag, doc)};
  doc.documentElement = doc.createElement('html'); doc.head = doc.createElement('head'); doc.body = doc.createElement('body'); doc.documentElement.append(doc.head, doc.body);
  doc.createTextNode = text => { const node = new Element('#text', doc); node.nodeType = 3; node.textContent = text; return node; };
  doc.getElementById = id => { let found; const walk = node => { if (node.id === id) found = node; node.childNodes.forEach(walk); }; walk(doc.documentElement); return found; };
  doc.querySelectorAll = selector => doc.documentElement.querySelectorAll(selector);
  const topbar = doc.createElement('header'); topbar.className = 'topbar'; doc.body.append(topbar);
  for (const id of ['docs-nav','docs-title','docs-intro','docs-root','docs-heading','docs-status','docs-retry','docs-brand','docs-top']) { const node = doc.createElement('div'); node.id = id; doc.body.append(node); }
  const brandLabel = doc.createElement('span'); doc.getElementById('docs-brand').append(brandLabel);
  doc.querySelector = selector => selector === '.topbar' ? topbar : selector === '#docs-brand span' ? brandLabel : doc.querySelectorAll(selector)[0];
  for (const key of Object.keys(source.ui)) { const node = doc.createElement('span'); node.dataset.docsUi = key; doc.body.append(node); }
  const events = new Map(), clipboard = [], stored = new Map([['nope.language','fr']]);
  const win = {
    location:{hash:'#workflow'}, navigator:{clipboard:{writeText:async text => clipboard.push(text)}},
    localStorage:{getItem:key => stored.get(key), setItem:(key,value) => stored.set(key,value)},
    CustomEvent:class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    addEventListener:(name, listener) => events.set(name, listener), dispatchEvent:event => events.get(event.type)?.(event)
  };
  return {doc, win, clipboard, stored};
}
function descendants(node) { return node.childNodes.flatMap(child => [child, ...descendants(child)]); }

test('Turkish documentation is complete, bounded, and explicitly describes the proof and trust boundary', () => {
  assert.equal(validateDocs(source, 'tr'), source);
  const prose = JSON.stringify(source);
  for (const phrase of ['AES yürütme izini','SNARK doğrulaması sözleşmede yapılmaz','bağımsız bir hesaplama düğümü','KYC','site verilerini','40\'ı','sponsor havuzuna','Sessizlik kabul sayılmaz']) assert.ok(prose.includes(phrase), phrase);
  const invalid = structuredClone(source); invalid.sections[0].items[0].href = 'javascript:alert(1)';
  assert.throws(() => validateDocs(invalid,'tr'));
  assert.throws(() => validateDocs(source,'en'));
  assert.ok(Buffer.byteLength(prose) < MAX_DOCS_BYTES);
});

test('the documented mixed example has the stated results and fits actual compiler and proof budgets', () => {
  const text = {type:'text',steps:[{op:'trim'},{op:'uppercase'},{op:'redactDigits'}]};
  const number = {type:'number',steps:[{op:'fill',value:10},{op:'clamp',min:10,max:80}]};
  assert.deepEqual(referenceApply(['  Acme42  ',' beta7 ','Gamma'],text),['ACME**','BETA*','GAMMA']);
  assert.deepEqual(referenceApply([255,200,42],number),[10,80,42]);
  const estimate = estimateProofPlan({version:1,taskHash:'0'.repeat(64),steps:[{column:'C2',recipe:text},{column:'C3',recipe:number}]},3,{jobId:'0'.repeat(32)});
  assert.equal(estimate.rowProofCount,6);
  assert.ok(estimate.gateCount < 10000);
  assert.ok(estimate.estimatedProofBundleBytes < estimate.maxProofBundleBytes);
  assert.equal(source.sections.find(s => s.id === 'templates').items[0].code,'record,supplier,score\nR01,"  Acme42  ",\nR02," beta7 ",200\nR03,Gamma,42\n');
});

test('missing or malformed selected translations fall back to a validated English catalog; failures are never cached', async () => {
  const cache = new Map(), calls = [];
  let available = false;
  const fetcher = async path => {
    calls.push(path);
    if (path.endsWith('/fr.json')) return available ? response(catalog('fr')) : response({...catalog('fr'),sections:[]});
    return response(catalog('en'));
  };
  const first = await loadDocsLocale('fr', {fetcher,cache}); assert.equal(first.language,'en');
  available = true;
  const second = await loadDocsLocale('fr', {fetcher,cache}); assert.equal(second.language,'fr');
  await loadDocsLocale('fr', {fetcher,cache});
  assert.equal(calls.filter(path => path.endsWith('/fr.json')).length,2);
  assert.equal(calls.filter(path => path.endsWith('/en.json')).length,1);
});

test('catalog transport rejects byte-limit violations even when content-length is absent', async () => {
  await assert.rejects(fetchDocs('en', async () => new Response('x'.repeat(MAX_DOCS_BYTES + 1))), /too large/);
  await assert.rejects(fetchDocs('en', async () => new Response('{}',{headers:{'content-length':String(MAX_DOCS_BYTES + 1)}})), /unavailable/);
  await assert.rejects(fetchDocs('xx', async () => { throw Error('must not fetch'); }), /Unsupported/);
});

test('renderer treats documentation as text; copy buttons only write the exact local template to the clipboard', async () => {
  const {doc,win,clipboard} = fixture(), malicious = structuredClone(source);
  malicious.page.title = '<img src=x onerror=alert(1)>';
  malicious.sections[0].items[0].text = '<script>fetch("/api/jobs")</script>';
  renderDocs(malicious,{document:doc,window:win});
  assert.equal(doc.getElementById('docs-title').textContent,malicious.page.title);
  assert.ok(!descendants(doc.documentElement).some(node => ['script','img','form','input','textarea'].includes(node.tagName)));
  assert.equal(doc.getElementById('docs-nav').childNodes.length,10);
  const buttons = descendants(doc.getElementById('docs-root')).filter(node => node.tagName === 'button');
  assert.equal(buttons.length,3);
  for (const button of buttons) await button.listeners.click();
  assert.deepEqual(clipboard,source.sections.find(section => section.id === 'templates').items.map(item => item.code));
  assert.equal(win.location.hash,'#workflow');
});

test('boot aligns shell with English fallback, keeps manual preference, and preserves anchor when switching languages', async () => {
  const {doc,win,stored} = fixture();
  const fetcher = async url => {
    const path = String(url);
    if (path.startsWith('/docs-locales/')) {
      const language = path.match(/([a-z]{2})\.json$/)[1];
      return language === 'fr' ? new Response('',{status:404}) : response(catalog(language));
    }
    const language = path.match(/([a-z]{2})\.json$/)?.[1];
    return response({'Dil':language,'Dil seçimi':language,'PRIVATE WORK':`${language} private work`});
  };
  await startDocs({document:doc,window:win,fetcher});
  assert.equal(getLanguage(),'en'); assert.equal(doc.documentElement.lang,'en'); assert.equal(stored.get('nope.language'),'fr');
  assert.equal(doc.getElementById('docs-title').textContent,'en documentation');
  assert.equal(doc.scrolledTo,'workflow'); assert.equal(win.location.hash,'#workflow');
  assert.equal(doc.querySelector('#docs-brand span').textContent,'en private work');
  setLanguage('de');
  for (let i = 0; i < 10 && doc.getElementById('docs-title').textContent !== 'de documentation'; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(doc.getElementById('docs-title').textContent,'de documentation');
  assert.equal(doc.documentElement.lang,'de'); assert.equal(doc.scrolledTo,'workflow'); assert.equal(win.location.hash,'#workflow');
  assert.equal(doc.getElementById('docs-nav').childNodes[1].getAttribute('aria-current'),'location');
});
