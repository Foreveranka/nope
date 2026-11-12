/** Browser-only CSV handling. Neither filenames nor unselected cells belong in API payloads. */
export const MAX_BYTES = 64 * 1024;
export const EXAMPLE_CSV = 'kayit,bolge,puan\r\nS01,Kadikoy,42\r\nS02,"Besiktas, Istanbul",\r\nS03,Ankara,154\r\nS04,Izmir,100\r\n';
const fail = message => { throw new Error(message); };

function readRows(text, delimiter) {
  const rows = []; let row = [], cell = '', quoted = false, closed = false;
  function field() { row.push(cell); cell = ''; closed = false; if (row.length > 16) fail('En fazla 16 sütun kullanılabilir.'); }
  function record() { field(); rows.push(row); row = []; if (rows.length > 33) fail('Başlıktan sonra 1–32 veri satırı gerekli.'); }
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else { quoted = false; closed = true; } }
      else cell += c;
    } else if (c === delimiter) field();
    else if (c === '\n' || c === '\r') { record(); if (c === '\r' && text[i + 1] === '\n') i++; }
    else if (closed) fail('Kapanan tırnaktan sonra yalnızca ayraç veya satır sonu gelebilir.');
    else if (c === '"') { if (cell) fail('Tırnak yalnızca hücrenin başında açılabilir.'); quoted = true; }
    else cell += c;
  }
  if (quoted) fail('Kapanmamış çift tırnak var.');
  if (cell || row.length || closed) record();
  return rows;
}

export function parseCSV(source) {
  if (typeof source !== 'string') fail('CSV metni gerekli.');
  if (new TextEncoder().encode(source).length > MAX_BYTES) fail('Dosya en fazla 64 KiB olabilir.');
  const text = source.replace(/^\uFEFF/, '');
  if (!text || /\u0000|\uFFFD/.test(text)) fail('Geçerli UTF-8 CSV dosyası seçin.');
  // The first separator outside header quotes selects the dialect; quoted separators are data.
  let inQuotes = false, delimiter = ',';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') { if (inQuotes && text[i + 1] === '"') i++; else inQuotes = !inQuotes; }
    else if (!inQuotes && (text[i] === ',' || text[i] === ';')) { delimiter = text[i]; break; }
    else if (!inQuotes && /[\r\n]/.test(text[i])) break;
  }
  const [headers, ...rows] = readRows(text, delimiter);
  if (!headers?.length || !rows.length) fail('Başlık ve 1–32 veri satırı gerekli.');
  if (headers.some(h => !h.trim()) || new Set(headers.map(h => h.trim())).size !== headers.length) fail('Sütun başlıkları boş olamaz ve benzersiz olmalıdır.');
  for (const [i, row] of [headers, ...rows].entries()) {
    if (row.length !== headers.length) fail(`${i + 1}. CSV satırında sütun sayısı başlıkla eşleşmiyor.`);
    if (row.some(c => /^[\s\uFEFF]*[=+\-@]/u.test(c))) fail(`${i + 1}. CSV satırında =, +, - veya @ ile başlayan hücre var. Formül güvenliği için bu prototip negatif değerler dahil bu hücreleri reddeder; hücreler sessizce değiştirilmez.`);
  }
  return { headers, rows, delimiter };
}

export function columnValues(dataset, column) {
  if (!Number.isInteger(column) || column < 0 || column >= dataset.headers.length) fail('Bir sütun seçin.');
  return dataset.rows.map((row, i) => {
    const raw = row[column];
    if (raw === '') return 255;
    if (!/^(?:0|[1-9]\d{0,2})$/.test(raw) || Number(raw) > 254) fail(`${i + 1}. veri satırı: seçilen sütun boş veya 0–254 arasında kanonik tam sayı olmalı (01 ve boşluk kabul edilmez). 255 boş hücre için ayrılmıştır.`);
    return Number(raw);
  });
}

export function verifyValues(input, output) {
  return Array.isArray(output) && output.length === input.length && output.every((v, i) => Number.isInteger(v) && v === (input[i] === 255 ? 0 : Math.min(input[i], 100)));
}

export function exportCSV(dataset, column, values) {
  if (!verifyValues(columnValues(dataset, column), values)) fail('Sonuç, beklenen boş→0 / üst sınır 100 profiliyle eşleşmiyor.');
  const escape = cell => /["\r\n,;]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell;
  const rows = [dataset.headers, ...dataset.rows.map((row, i) => row.map((cell, j) => j === column ? String(values[i]) : cell))];
  return '\uFEFF' + rows.map(row => row.map(escape).join(dataset.delimiter)).join('\r\n') + '\r\n';
}

export function validateEvidence(evidence, rowCount) {
  return Number.isInteger(rowCount) && rowCount >= 1 && rowCount <= 32 && evidence?.schema === 'nope-csv-evidence-v1' && evidence.profile === 'clean-column-batch4-v1' && evidence.rowCount === rowCount &&
    Array.isArray(evidence.batches) && evidence.batches.length === Math.ceil(rowCount / 4) &&
    evidence.batches.every((b, i) => b?.index === i && b.artifactHashes && typeof b.artifactHashes === 'object' && !Array.isArray(b.artifactHashes) && Object.keys(b.artifactHashes).length > 0 && Object.values(b.artifactHashes).every(v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v))) &&
    new Set(evidence.batches.map(b => b.index)).size === evidence.batches.length;
}

export async function verifyEvidenceBundle(bundle, rowCount, expected = undefined) {
  if (bundle?.scope !== 'ciphertext-manifest-commitment' || bundle.privacyProof !== false || typeof bundle.manifestJson !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.manifestSha256)) fail('Kanıt paketi biçimi doğrulanamadı.');
  const manifest = JSON.parse(bundle.manifestJson);
  if (!validateEvidence(manifest, rowCount) || manifest.verified !== true || manifest.realFhe !== true) fail('Kanıt manifesti tamamlanan gerçek hesaplama profiliyle eşleşmiyor.');
  if (expected && (!validateEvidence(expected, rowCount) || manifest.batches.some((batch, i) => {
    const other = expected.batches[i].artifactHashes, hashes = batch.artifactHashes;
    return Object.keys(hashes).length !== Object.keys(other).length || Object.entries(hashes).some(([key, value]) => other[key] !== value);
  }))) fail('Manifest, tamamlanan işin artefaktlarıyla eşleşmiyor.');
  // Hash only the backend's ciphertext-artifact manifest, never browser CSV or plaintext values.
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(bundle.manifestJson));
  if (Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('') !== bundle.manifestSha256) fail('Kanıt manifestinin SHA-256 özeti eşleşmiyor.');
  if (bundle.anchor != null && (bundle.anchor.network !== 'testnet' || bundle.anchor.manifestSha256 !== bundle.manifestSha256)) fail('Zincir kayıt bağı manifestle eşleşmiyor.');
  return manifest;
}
