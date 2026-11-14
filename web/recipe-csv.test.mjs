import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { parseCSV, MAX_BYTES } from './csv-input.mjs';
import { parseRecipeColumn, applyRecipeOutput } from './recipe-csv.mjs';
import { referenceApply, compileRecipe, estimateRecipe } from './recipe-core.mjs';
import { prepareRecipe, decodeRecipe } from './recipe-client.mjs';
import { evaluateRecipeRequest } from '../api/recipe-gc.mjs';

const numeric = { type: 'number', steps: [{ op: 'fill', value: 7 }, { op: 'clamp', min: 10, max: 80 }] };
const fill = { type: 'number', steps: [{ op: 'fill', value: 0 }] };
const lower = { type: 'text', steps: [{ op: 'lowercase' }] };
const normalize = { type: 'text', steps: [{ op: 'trim' }, { op: 'lowercase' }, { op: 'redactDigits' }] };
const apply = (dataset, column, recipe) => applyRecipeOutput(dataset, column, referenceApply(parseRecipeColumn(dataset, column, recipe), recipe), recipe);

test('numeric fill and two-sided clamp replace only the selected column', () => {
  const dataset = parseCSV('id,note,value\r\n001,"İstanbul, Türkiye",\r\n002,"İşlem; açıklama",254\r\n003,"Ömer ",42\r\n');
  const original = structuredClone(dataset);
  assert.deepEqual(parseRecipeColumn(dataset, 2, numeric), [255, 254, 42]);
  const result = apply(dataset, 2, numeric);
  assert.deepEqual(result.rows, [['001', 'İstanbul, Türkiye', '10'], ['002', 'İşlem; açıklama', '80'], ['003', 'Ömer ', '42']]);
  assert.deepEqual(parseCSV(result.csv), { headers: result.headers, rows: result.rows, delimiter: ',' });
  assert.deepEqual(dataset, original);
});

test('text trim/lowercase/redaction preserves unselected UTF-8, numeric spelling, headers, order and semicolon dialect', () => {
  const dataset = parseCSV('müşteri;etiket;puan;not\r\nÇağrı;" ACME42 ";001;"iki; parça"\r\nÖzge;" BETA7 ";254;"Türkçe, 日本語 ve 😀\r\nikinci satır"\r\n');
  const result = apply(dataset, 1, normalize);
  assert.equal(result.delimiter, ';');
  assert.deepEqual(result.headers, dataset.headers);
  assert.deepEqual(result.rows, dataset.rows.map((row, i) => [row[0], ['acme**', 'beta*'][i], row[2], row[3]]));
  assert.deepEqual(parseCSV(result.csv), { headers: result.headers, rows: result.rows, delimiter: ';' });
  assert.match(result.csv, /^\uFEFF/);
});

test('missing numeric sentinel stays an empty CSV cell when only clamp is selected', () => {
  const dataset = parseCSV('id,value\nx,\ny,254\nz,0');
  const recipe = { type: 'number', steps: [{ op: 'clamp', min: 5, max: 200 }] };
  assert.deepEqual(parseRecipeColumn(dataset, 1, recipe), [255, 254, 0]);
  assert.deepEqual(apply(dataset, 1, recipe).rows, [['x', ''], ['y', '200'], ['z', '5']]);
});

test('public step order changes fill/clamp outcome; full recipes allow up to four steps', () => {
  const dataset = parseCSV('value\n""\n90');
  const first = { type: 'number', steps: [{ op: 'fill', value: 254 }, { op: 'clamp', min: 0, max: 80 }] };
  const second = { type: 'number', steps: [...first.steps].reverse() };
  assert.deepEqual(apply(dataset, 0, first).rows, [['80'], ['80']]);
  assert.deepEqual(apply(dataset, 0, second).rows, [['254'], ['80']]);
  const four = { type: 'text', steps: [{ op: 'uppercase' }, { op: 'lowercase' }, { op: 'redactDigits' }, { op: 'uppercase' }] };
  assert.deepEqual(apply(parseCSV('v\na9'), 0, four).rows, [['A*']]);
});

test('empty text remains text, ASCII spaces trim at ends without collapsing internal spaces', () => {
  const dataset = parseCSV('label,keep\n"",Ü\n"  A  B9  ",é');
  const recipe = { type: 'text', steps: [{ op: 'trim' }, { op: 'uppercase' }] };
  assert.deepEqual(parseRecipeColumn(dataset, 0, recipe), ['', '  A  B9  ']);
  assert.deepEqual(apply(dataset, 0, recipe).rows, [['', 'Ü'], ['A  B9', 'é']]);
});

test('quoted first header containing the other delimiter does not change CSV dialect', () => {
  for (const source of ['"name;label",v\nAlice,1', '"name,label";v\nAlice;1']) {
    const dataset = parseCSV(source), result = apply(dataset, 1, fill);
    assert.equal(parseCSV(result.csv).delimiter, dataset.delimiter);
    assert.deepEqual(parseCSV(result.csv).headers, dataset.headers);
  }
});

test('numeric 32-row and text 8-row ceilings accept cheap recipes and reject overflow without truncation', () => {
  const n32 = parseCSV('v\n' + Array(32).fill('254').join('\n'));
  assert.equal(parseRecipeColumn(n32, 0, fill).length, 32);
  assert.throws(() => parseCSV('v\n' + Array(33).fill('1').join('\n')), /1–32/);
  const t8 = parseCSV('v\n' + Array(8).fill('A').join('\n'));
  assert.deepEqual(parseRecipeColumn(t8, 0, lower), Array(8).fill('A'));
  assert.throws(() => parseRecipeColumn(parseCSV('v\n' + Array(9).fill('A').join('\n')), 0, lower), /8/);
});

test('gate budget is checked before encryption even below the text row ceiling', () => {
  const dataset = parseCSV('v\n' + Array(8).fill(' ACME42 ').join('\n'));
  assert.throws(() => parseRecipeColumn(dataset, 0, normalize), undefined, 'trim-heavy recipe must not be promised for all eight rows');
});

test('ASCII 16-byte boundary is exact; longer, non-ASCII and control input is never trimmed or coerced', () => {
  assert.deepEqual(parseRecipeColumn(parseCSV('v\nABCDEFGHIJKLMNOP'), 0, lower), ['ABCDEFGHIJKLMNOP']);
  for (const value of ['A'.repeat(17), 'Çağrı', '😀', 'a\tb', 'a\nb', 'a\rb', '\x7f', '\x01']) {
    assert.throws(() => parseRecipeColumn(parseCSV(`v\n"${value}"`), 0, lower), /ASCII/);
  }
});

test('numeric values require canonical 0..254 integers and exact empty cells', () => {
  assert.deepEqual(parseRecipeColumn(parseCSV('v\n0\n254\n""'), 0, fill), [0, 254, 255]);
  for (const value of ['255', '256', '01', ' 1', '1 ', '1.0', '1e2', 'NaN', 'Infinity', ' ']) {
    assert.throws(() => parseRecipeColumn(parseCSV(`v\n"${value}"`), 0, fill), /veri satırı/);
  }
});

test('recipe validation rejects unknown ops, mixed types, excess steps and invalid public parameters', () => {
  const dataset = parseCSV('v\n1');
  for (const recipe of [null, {}, { type: 'date', steps: [] }, { type: 'number', steps: [] },
    { type: 'number', steps: [{ op: 'fill', value: 255 }] },
    { type: 'number', steps: [{ op: 'clamp', min: 20, max: 10 }] },
    { type: 'number', steps: [{ op: 'fill', value: 1.5 }] },
    { type: 'text', steps: [{ op: 'clamp', min: 0, max: 10 }] },
    { type: 'number', steps: [{ op: 'trim' }] },
    { type: 'text', steps: [{ op: 'arbitraryAI' }] },
    { type: 'text', steps: Array.from({ length: 5 }, () => ({ op: 'lowercase' })) },
    { type: 'text', steps: [{ op: 'lowercase', secret: 'not allowed' }] },
  ]) assert.throws(() => parseRecipeColumn(dataset, 0, recipe));
});

test('wrong count, sparse arrays, coercible strings and incorrect remote results fail closed', () => {
  const dataset = parseCSV('v,keep\n,Ö\n100,Ü');
  const before = structuredClone(dataset);
  for (const output of [null, [], [0], [0, 100, 2], ['0', 100], [1, 100], [255, 100], new Array(2), { 0: 0, 1: 100, length: 2 }]) {
    assert.throws(() => applyRecipeOutput(dataset, 0, output, fill), /Sonuç/);
  }
  assert.deepEqual(dataset, before);
  assert.throws(() => applyRecipeOutput(parseCSV('v\nALICE'), 0, ['Alice'], lower), /Sonuç/);
});

test('all columns retain formula safety, including caller-created datasets', () => {
  for (const unsafe of ['=1+2', '+cmd', '-12', '@SUM(1)', ' \t=1']) {
    assert.throws(() => parseCSV(`name,value\n"${unsafe}",12`), /Formül güvenliği/);
    assert.throws(() => parseRecipeColumn({ headers: ['name', 'value'], rows: [[unsafe, '12']], delimiter: ',' }, 1, fill), /Formül güvenliği/);
  }
  const dataset = parseCSV('name,value\n"<img src=x onerror=alert(1)>",12');
  assert.equal(apply(dataset, 1, fill).rows[0][0], '<img src=x onerror=alert(1)>');
});

test('invalid columns and malformed dataset shapes are rejected', () => {
  const dataset = parseCSV('a,b\nx,1');
  for (const column of [-1, 2, null, '1', 0.5, NaN]) assert.throws(() => parseRecipeColumn(dataset, column, fill));
  for (const input of [null, {}, { ...dataset, delimiter: '|' }, { ...dataset, rows: [[1, 2]] }, { ...dataset, rows: [['1']] }]) assert.throws(() => parseRecipeColumn(input, 1, fill));
});

test('original parser keeps the input byte and column ceilings', () => {
  const headers = Array.from({ length: 16 }, (_, i) => `c${i}`);
  const dataset = parseCSV(headers.join(',') + '\n' + headers.map((_, i) => String(i)).join(','));
  assert.equal(apply(dataset, 0, fill).headers.length, 16);
  assert.throws(() => parseCSV([...headers, 'c16'].join(',') + '\n1'), /16/);
  assert.throws(() => parseCSV('v\n' + 'x'.repeat(MAX_BYTES)), /64 KiB/);
  const boundary = parseCSV('keep,v\n' + 'x'.repeat(MAX_BYTES - 9) + ',1');
  assert.deepEqual(parseRecipeColumn(boundary, 1, fill), [1]);
  assert.equal(apply(boundary, 1, fill).rows[0][0], boundary.rows[0][0]);
});

// Test doubles below cover UI lifecycle and local privacy boundaries only.
// Engine cryptography is exercised by its own tests and the real browser smoke.
class Element {
  constructor() { this.listeners = {}; this.children = []; this.dataset = {}; this.value = ''; this.files = []; this.hidden = false; this.checked = false; }
  addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  removeAttribute(name) { delete this[name]; }
  async fire(type) { for (const callback of this.listeners[type] || []) await callback({}); }
}
async function harness() {
  const elements = new Map(), workers = [], blobs = new Map(), revoked = [], calls = [];
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  for (const [id, value] of Object.entries({ 'recipe-type': 'number', 'fill-value': '0', 'clamp-min': '0', 'clamp-max': '100', 'text-case': 'lowercase', preset: 'fill-clamp' })) get(id).value = value;
  for (const id of ['fill-enabled', 'clamp-enabled', 'trim-enabled']) get(id).checked = true;
  class FakeWorker {
    constructor(url) { this.url = String(url); this.listeners = {}; workers.push(this); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    postMessage(data) { this.input = structuredClone(data); }
    terminate() { this.terminated = true; }
    emit(data) { this.listeners.message?.({ data }); }
  }
  class TestURL extends URL {
    static createObjectURL(blob) { const url = `blob:${blobs.size + 1}`; blobs.set(url, blob); return url; }
    static revokeObjectURL(url) { revoked.push(url); }
  }
  const source = (await readFile(new URL('./recipes.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify('http://localhost/recipes.js'));
  const context = vm.createContext({
    MAX_BYTES, parseCSV,
    // Imported modules and application code share a realm in browsers. VM
    // injection crosses realms; clone at this test-only boundary so the core's
    // intentional plain-object prototype check sees ordinary local objects.
    parseRecipeColumn: (...args) => parseRecipeColumn(...structuredClone(args)),
    applyRecipeOutput: (...args) => applyRecipeOutput(...structuredClone(args)),
    referenceApply, compileRecipe, estimateRecipe: (...args) => estimateRecipe(...structuredClone(args)),
    crypto: webcrypto, Worker: FakeWorker, URL: TestURL, Blob, TextDecoder, structuredClone,
    performance: { now: () => 1000 }, console,
    document: { getElementById: get, createElement: () => new Element() }, window: { addEventListener() {} },
    Option: function(text, value) { this.textContent = text; this.value = value; },
    fetch: (...args) => { calls.push(args); throw Error('UI thread must not send plaintext'); },
  });
  vm.runInContext(source, context);
  return { get, workers, blobs, revoked, calls, async upload(source = 'private_id,private_label,amount\nÖmer, ACME42 ,\nÇağrı, BETA7 ,154') {
    get('file').files = [{ name: 'private-filename.csv', size: new TextEncoder().encode(source).length, arrayBuffer: async () => new TextEncoder().encode(source).buffer }];
    await get('file').fire('change');
  }, async select(column) { get('column').value = String(column); await get('column').fire('change'); } };
}

test('UI sends only chosen values and public recipe into worker, shows full result locally and clears stale download', async () => {
  const h = await harness(); await h.upload(); await h.select(2); await h.get('run').fire('click');
  assert.equal(h.workers.length, 1, h.get('message').textContent);
  assert.deepEqual(h.workers[0].input, { values: [255, 154], recipe: { type: 'number', steps: [{ op: 'fill', value: 0 }, { op: 'clamp', min: 0, max: 100 }] } });
  assert.equal(h.workers[0].url, 'http://localhost/recipes.js');
  assert.deepEqual(h.calls, []);
  h.workers[0].emit({ type: 'complete', values: [0, 100] });
  assert.equal(h.get('result').hidden, false);
  const url = h.get('download').href;
  assert.deepEqual(parseCSV(await h.blobs.get(url).text()).rows, [['Ömer', ' ACME42 ', '0'], ['Çağrı', ' BETA7 ', '100']]);
  assert.equal(h.get('comparison').children.length, 3);
  h.get('clamp-max').value = '80'; await h.get('clamp-max').fire('input');
  assert.equal(h.get('result').hidden, true);
  assert.equal(h.get('download').href, undefined);
  assert.ok(h.revoked.includes(url));
});

test('UI abort/reset suppresses late worker responses and wrong results never create downloads', async () => {
  const h = await harness(); await h.upload(); await h.select(2); await h.get('run').fire('click');
  const first = h.workers[0];
  await h.get('reset').fire('click');
  assert.equal(first.terminated, true);
  first.emit({ type: 'complete', values: [0, 100] });
  assert.equal(h.get('result').hidden, true);
  assert.equal(h.get('download').href, undefined);
  await h.upload(); await h.select(2); await h.get('run').fire('click');
  h.workers[1].emit({ type: 'complete', values: [0, 99] });
  assert.equal(h.get('result').hidden, true);
  assert.equal(h.get('download').href, undefined);
  assert.equal(h.get('message').dataset.error, 'true');
});

test('UI rejects unsupported text early and clears old dataset on malformed upload', async () => {
  const h = await harness(); await h.upload();
  h.get('recipe-type').value = 'text'; await h.get('recipe-type').fire('change');
  await h.select(0);
  assert.equal(h.get('run').disabled, true);
  await h.get('run').fire('click'); assert.equal(h.workers.length, 0);
  await h.select(1); assert.equal(h.get('run').disabled, false);
  await h.upload('a,b\nx,1,2');
  assert.equal(h.get('run').disabled, true);
  assert.equal(h.get('preview-wrap').hidden, true);
  await h.get('run').fire('click'); assert.equal(h.workers.length, 0);
});

test('UI explains the total circuit budget and enables a cheaper recipe without dropping rows', async () => {
  const h = await harness();
  await h.upload('id,label\n' + Array.from({ length: 8 }, (_, i) => `S${i}, ACME42 `).join('\n'));
  h.get('recipe-type').value = 'text'; await h.get('recipe-type').fire('change');
  await h.select(1);
  assert.equal(h.get('run').disabled, true);
  assert.match(h.get('validation').textContent, /10\.000 kapı.*3 MiB/);
  await h.get('run').fire('click'); assert.equal(h.workers.length, 0);
  h.get('trim-enabled').checked = false; await h.get('trim-enabled').fire('change');
  assert.equal(h.get('run').disabled, false);
  assert.match(h.get('validation').textContent, /8 satır hazır.*10\.000 devre kapısı/);
  await h.get('run').fire('click');
  assert.equal(h.workers[0].input.values.length, 8);
});

test('actual recipe worker branch encrypts, remotely evaluates and decodes numeric and text recipes', async () => {
  const source = (await readFile(new URL('./recipes.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify('http://localhost/recipes.js'));
  for (const [values, recipe] of [[[255, 154], numeric], [[' ACME42 ', ' BETA7 '], normalize]]) {
    let handle;
    const messages = [], requests = [];
    const context = vm.createContext({
      prepareRecipe, decodeRecipe: (result, decoder) => decodeRecipe(structuredClone(result), decoder), referenceApply, AbortSignal,
      self: { addEventListener(type, callback) { assert.equal(type, 'message'); handle = callback; }, postMessage(data) { messages.push(structuredClone(data)); } },
      fetch: async (url, options) => {
        assert.equal(url, '/api/recipe-gc'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
        const request = JSON.parse(options.body); requests.push(request);
        assert.deepEqual(Object.keys(request).sort(), ['profile', 'recipe', 'programSha256', 'nonce', 'rowCount', 'rows'].sort());
        assert.equal(options.body.includes('ACME42'), false); assert.equal(options.body.includes('BETA7'), false);
        const reply = await evaluateRecipeRequest(request);
        return { ok: true, text: async () => JSON.stringify(reply) };
      },
    });
    vm.runInContext(source, context);
    await handle({ data: { values, recipe } });
    assert.equal(requests.length, 1);
    assert.deepEqual(messages.filter(message => message.type === 'complete'), [{ type: 'complete', values: referenceApply(values, recipe) }], JSON.stringify(messages));
    assert.deepEqual(messages.filter(message => message.type === 'error'), []);
  }
});

test('actual worker decoding rejects a mismatched remote program before announcing completion', async () => {
  const source = (await readFile(new URL('./recipes.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '').replaceAll('import.meta.url', JSON.stringify('http://localhost/recipes.js'));
  let handle;
  const messages = [];
  vm.runInContext(source, vm.createContext({
    prepareRecipe, decodeRecipe: (result, decoder) => decodeRecipe(structuredClone(result), decoder), referenceApply, AbortSignal,
    self: { addEventListener(_type, callback) { handle = callback; }, postMessage(data) { messages.push(structuredClone(data)); } },
    fetch: async (_url, options) => {
      const reply = await evaluateRecipeRequest(JSON.parse(options.body));
      return { ok: true, text: async () => JSON.stringify({ ...reply, programSha256: '0'.repeat(64) }) };
    },
  }));
  await handle({ data: { values: [255], recipe: fill } });
  assert.equal(messages.some(message => message.type === 'complete'), false);
  assert.equal(messages.filter(message => message.type === 'error').length, 1);
});
