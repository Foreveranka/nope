import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import * as csv from './csv-input.mjs';
const { parseCSV, columnValues, exportCSV, verifyValues, verifyEvidenceBundle, validateEvidence, EXAMPLE_CSV } = csv;

test('BOM, comma, escaped quotes, quoted CRLF and semicolon inside data', () => {
  const parsed = parseCSV('\uFEFFname,note,value\r\n"A, B","two ""quotes"";\r\nnext line",\r\nZ,plain,254\r\n');
  assert.deepEqual(parsed.headers, ['name', 'note', 'value']);
  assert.deepEqual(parsed.rows, [['A, B', 'two "quotes";\r\nnext line', ''], ['Z', 'plain', '254']]);
  assert.deepEqual(columnValues(parsed, 2), [255, 254]);
});
test('semicolon dialect preserves order and cells after export/parse roundtrip', () => {
  const input = parseCSV('adi;not;puan\r\n"a;b";"x,y";\r\n"say ""hello""";"line\nnext";143\r\n');
  const output = parseCSV(exportCSV(input, 2, [0, 100]));
  assert.equal(output.delimiter, ';');
  assert.deepEqual(output.headers, input.headers);
  assert.deepEqual(output.rows, input.rows.map((r, i) => [r[0], r[1], String([0, 100][i])]));
});
test('single column and final empty value, line endings, no terminal newline', () => {
  for (const sep of ['\r', '\n', '\r\n']) {
    const p = parseCSV(`value${sep}12${sep}""`);
    assert.deepEqual(columnValues(p, 0), [12, 255]);
  }
  assert.deepEqual(parseCSV('name,value\na,\nb,2').rows, [['a', ''], ['b', '2']]);
  assert.deepEqual(columnValues(parseCSV('v\n1\n\n'), 0), [1, 255]);
});
test('bounds: exactly 32 rows, 16 columns, 64 KiB UTF-8 accepted; next unit rejected', () => {
  assert.equal(parseCSV('v\n' + Array(32).fill('1').join('\n')).rows.length, 32);
  assert.throws(() => parseCSV('v\n' + Array(33).fill('1').join('\n')), /1–32/);
  const headers = Array.from({ length: 16 }, (_, i) => `c${i}`);
  assert.equal(parseCSV(headers.join(',') + '\n' + headers.join(',')).headers.length, 16);
  assert.throws(() => parseCSV([...headers, 'c16'].join(',') + '\n1'), /16/);
  assert.equal(parseCSV('v\n' + 'a'.repeat(65534)).rows[0][0].length, 65534);
  assert.throws(() => parseCSV('v\n' + 'a'.repeat(65535)), /64 KiB/);
  assert.throws(() => parseCSV('v\n' + 'ü'.repeat(32768)), /64 KiB/);
});
test('malformed quoting, missing or duplicate headers, inconsistent columns rejected', () => {
  for (const text of ['', 'v', 'a,a\n1,2', 'a, a \n1,2', ',b\n1,2', 'a,b\n1', 'a,b\n1,2,3', 'a,b\n"abc,2', 'a,b\na"b,2', 'a,b\n"ab"c,2', 'v\n\u0000']) {
    assert.throws(() => parseCSV(text), undefined, text);
  }
});
test('canonical 0..254 or exactly empty; sentinel 255 reserved and no whitespace coercion', () => {
  const p = parseCSV('v\n0\n100\n101\n254\n""');
  assert.deepEqual(columnValues(p, 0), [0, 100, 101, 254, 255]);
  for (const raw of ['255', '256', '01', ' 1', '1 ', '1.0', '1e2', 'NaN', 'Infinity', ' ', '0x10']) {
    assert.throws(() => columnValues(parseCSV(`v\n"${raw}"`), 0), /veri satırı/);
  }
  assert.throws(() => columnValues(p, -1), /sütun/);
  assert.throws(() => columnValues(p, null), /sütun/);
});
test('reject formula-like cells everywhere, including negative unrelated data, without mutation', () => {
  for (const value of ['=1+2', '+cmd', '-12', '@SUM(1)', '\t=1', ' \r\n-3']) {
    assert.throws(() => parseCSV(`name,value\n"${value}",12`), /Formül güvenliği/);
    assert.throws(() => parseCSV(`"${value}",value\na,12`), /Formül güvenliği/);
  }
  assert.equal(parseCSV('note,value\n12-34,10').rows[0][0], '12-34');
});
test('HTML-like text remains literal and nonselected values are preserved byte-for-byte as cells', () => {
  const source = parseCSV('id,note,value\n001,"<img src=x onerror=alert(1)>",134\n002," spaced ",');
  const out = parseCSV(exportCSV(source, 2, [100, 0]));
  assert.deepEqual(out.rows, [['001', '<img src=x onerror=alert(1)>', '100'], ['002', ' spaced ', '0']]);
  assert.deepEqual(source.rows[0], ['001', '<img src=x onerror=alert(1)>', '134']);
});
test('export requires fully matching result including count, integer type and empty-to-zero', () => {
  const p = parseCSV(EXAMPLE_CSV), input = columnValues(p, 2);
  assert.deepEqual(input, [42, 255, 154, 100]);
  assert.equal(verifyValues(input, [42, 0, 100, 100]), true);
  for (const values of [[], [42, 0, 100], [42, 0, 100, 100, 0], ['42', 0, 100, 100], [42, 255, 100, 100], [42, 0, 99, 100]]) {
    assert.equal(verifyValues(input, values), false); assert.throws(() => exportCSV(p, 2, values));
  }
  assert.match(exportCSV(p, 2, [42, 0, 100, 100]), /^\uFEFFkayit,bolge,puan\r\n/);
});
const evidence = (rowCount = 4) => ({ schema: 'nope-csv-evidence-v1', profile: 'clean-column-batch4-v1', rowCount, verified: true, realFhe: true, batches: Array.from({ length: Math.ceil(rowCount / 4) }, (_, index) => ({ index, artifactHashes: { outputSha256: 'b'.repeat(64), inputSha256: 'a'.repeat(64) } })) });
async function bundleFor(manifest) {
  const manifestJson = JSON.stringify(manifest);
  const hash = await webcrypto.subtle.digest('SHA-256', new TextEncoder().encode(manifestJson));
  return { manifestJson, manifestSha256: Buffer.from(hash).toString('hex'), anchor: null, scope: 'ciphertext-manifest-commitment', privacyProof: false };
}
test('ciphertext evidence digest verified, artifact key order independent, tampering rejected', async () => {
  const e = evidence(), bundle = await bundleFor(e);
  const expected = structuredClone(e); expected.batches[0].artifactHashes = { inputSha256: 'a'.repeat(64), outputSha256: 'b'.repeat(64) };
  await verifyEvidenceBundle(bundle, 4, expected);
  await assert.rejects(verifyEvidenceBundle({ ...bundle, manifestSha256: '0'.repeat(64) }, 4), /özeti/);
  await assert.rejects(verifyEvidenceBundle({ ...bundle, privacyProof: true }, 4));
  await assert.rejects(verifyEvidenceBundle(bundle, 3));
  expected.batches[0].artifactHashes.inputSha256 = 'c'.repeat(64);
  await assert.rejects(verifyEvidenceBundle(bundle, 4, expected), /artefakt/);
  await assert.rejects(verifyEvidenceBundle({ ...bundle, anchor: { network: 'mainnet', manifestSha256: bundle.manifestSha256 } }, 4));
});
test('evidence requires batch coverage, ordered indexes, correct profile, real verified computation', async () => {
  assert.equal(validateEvidence(evidence(32), 32), true);
  assert.equal(validateEvidence(evidence(0), 0), false);
  for (const update of [{ batches: [] }, { profile: 'sum' }, { rowCount: 0 }, { batches: [{ index: 1, artifactHashes: { a: 'a'.repeat(64) } }] }]) {
    assert.equal(validateEvidence({ ...evidence(), ...update }, 4), false);
  }
  await assert.rejects(verifyEvidenceBundle(await bundleFor({ ...evidence(), realFhe: false }), 4));
});

// A small DOM/fetch harness exercises privacy boundaries and lifecycle without a browser dependency.
const uiSource = (await readFile(new URL('./csv.js', import.meta.url), 'utf8')).replace(/^import .*?;\n/, '');
class Element {
  constructor() { this.listeners = {}; this.children = []; this.dataset = {}; this.value = ''; this.files = []; this.hidden = false; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  removeAttribute(name) { delete this[name]; }
  async fire(name) { return this.listeners[name]?.({}); }
}
async function harness({ hosted = false, invalidResult = false, noEvidence = false, pending = false } = {}) {
  const elements = new Map(), calls = [], blobs = new Map(), revoked = []; let serial = 0;
  const get = id => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id); };
  get('mode').value = 'local';
  const e = evidence(), bundle = await bundleFor(e);
  const job = { id: 'test-job', status: pending ? 'EVALUATING' : 'COMPLETED', events: [{ stage: 'EVALUATING', message: 'Actual batch', batchIndex: 0 }], values: invalidResult ? [42, 255, 100, 100] : [42, 0, 100, 100], evidence: e };
  const context = vm.createContext({ ...csv, console, TextDecoder, TextEncoder, Blob, Uint8Array, AbortController, AbortSignal, crypto: webcrypto,
    location: { hostname: hosted ? 'example.com' : '127.0.0.1' }, document: { getElementById: get, createElement: () => new Element() },
    window: { addEventListener() {} }, Option: function (text, value) { this.textContent = text; this.value = value; },
    setTimeout: pending ? (() => 1) : setTimeout,
    URL: { createObjectURL(blob) { const url = `blob:${++serial}`; blobs.set(url, blob); return url; }, revokeObjectURL(url) { revoked.push(url); } },
    fetch: async (url, options) => {
      calls.push({ url, options });
      if (hosted) return { ok: false, status: 404 };
      let data;
      if (url === '/api/capabilities') data = { csrfToken: 'local-csrf', csvAnchorEnabled: false };
      else if (url.endsWith('/evidence')) { if (noEvidence) return { ok: false, status: 404 }; data = bundle; }
      else data = job;
      return { ok: true, json: async () => data };
    },
  });
  vm.runInContext(uiSource, context);
  await new Promise(resolve => setImmediate(resolve));
  return { get, calls, blobs, revoked, async upload(source = EXAMPLE_CSV, name = 'private-name.csv') {
    get('file').files = [{ name, size: new TextEncoder().encode(source).length, arrayBuffer: async () => new TextEncoder().encode(source).buffer }];
    await get('file').fire('change'); get('column').value = '2'; await get('column').fire('change');
  } };
}
test('hosted preview and synthetic download work; no loopback fetch or run', async () => {
  const h = await harness({ hosted: true }); await h.upload();
  assert.equal(h.get('preview-wrap').hidden, false); assert.equal(h.get('run').disabled, true);
  await h.get('run').fire('click');
  assert.deepEqual(h.calls.map(c => c.url), ['/api/capabilities']);
  assert.equal(h.get('setup').hidden, false);
  assert.match(await h.blobs.get(h.get('example').href).text(), /kayit,bolge,puan/);
});
test('only numeric values and mode POSTed same-origin with CSRF; verified CSV and evidence downloadable', async () => {
  const h = await harness(); await h.upload(); await h.get('run').fire('click');
  const post = h.calls.find(c => c.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), { values: [42, 255, 154, 100], mode: 'local' });
  assert.equal(post.options.headers['X-CSRF-Token'], 'local-csrf'); assert.equal(post.options.credentials, 'same-origin');
  assert.equal(h.get('result').hidden, false); assert.equal(h.get('anchor').hidden, true);
  const clean = parseCSV(await h.blobs.get(h.get('download').href).text());
  assert.deepEqual(clean.rows.map(r => r[2]), ['42', '0', '100', '100']);
  assert.equal(h.get('download').download, 'private-name-temiz.csv');
  assert.equal(JSON.parse(await h.blobs.get(h.get('evidence-download').href).text()).privacyProof, false);
  const csvURL = h.get('download').href, evidenceURL = h.get('evidence-download').href;
  await h.get('reset').fire('click'); assert.equal(h.get('result').hidden, true);
  assert.ok(h.revoked.includes(csvURL)); assert.ok(h.revoked.includes(evidenceURL));
  assert.equal(h.get('download').href, undefined);
});
test('a new invalid dataset clears old downloads and cannot submit prior data', async () => {
  const h = await harness(); await h.upload(); await h.get('run').fire('click'); const url = h.get('download').href;
  await h.upload('name,value\nx,1,2'); assert.ok(h.revoked.includes(url)); assert.equal(h.get('result').hidden, true);
  assert.equal(h.get('run').disabled, true); assert.equal(h.get('download').href, undefined);
});
test('incorrect completed values block download; pending status never invents completion', async () => {
  const h = await harness({ invalidResult: true }); await h.upload(); await h.get('run').fire('click');
  assert.equal(h.get('download').href, undefined); assert.equal(h.get('message').dataset.error, 'true');
  const p = await harness({ pending: true }); await p.upload(); p.get('run').fire('click');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(p.get('download').href, undefined); assert.equal(p.get('message').textContent, 'Şifreli hesaplama');
  assert.equal(p.get('events').children[0].children[0].textContent, 'Parti 1 · Şifreli hesaplama');
  await p.get('reset').fire('click');
});
test('evidence endpoint unavailable does not block verified CSV; offers retry without a fake bundle', async () => {
  const h = await harness({ noEvidence: true }); await h.upload(); await h.get('run').fire('click');
  assert.equal(h.get('result').hidden, false); assert.ok(h.get('download').href);
  assert.equal(h.get('evidence-download').href, undefined); assert.equal(h.get('retry-evidence').hidden, false);
});
