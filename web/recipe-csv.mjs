/** Local CSV adapter. Never include this dataset or its metadata in a remote request. */
import { parseCSV, columnValues } from './csv-input.mjs';
import { compileRecipe, estimateRecipe, referenceApply } from './recipe-core.mjs';

const fail = message => { throw new Error(message); };
const quote = (cell, delimiter, firstHeader) => /["\r\n]/.test(cell) || cell.includes(delimiter) || (firstHeader && /[,;]/.test(cell)) ? `"${cell.replaceAll('"', '""')}"` : cell;

function serialize(dataset, compact = false) {
  if (!dataset || !Array.isArray(dataset.headers) || !Array.isArray(dataset.rows) || ![',', ';'].includes(dataset.delimiter)) fail('Geçerli bir CSV veri kümesi gerekli.');
  const records = [dataset.headers, ...dataset.rows];
  for (const row of records) {
    if (!Array.isArray(row) || row.length !== dataset.headers.length || Array.from(row).some(cell => typeof cell !== 'string')) fail('CSV hücreleri metin olmalı ve sütun sayısı korunmalı.');
  }
  const text = records.map((row, i) => row.map((cell, j) => quote(cell, dataset.delimiter, i === 0 && j === 0)).join(dataset.delimiter)).join(compact ? '\n' : '\r\n');
  // Minimal input reconstruction prevents BOM/CRLF normalization from rejecting
  // a valid source at the 64 KiB input boundary. A final single empty field
  // needs a record terminator, otherwise the original parser skips that row.
  return compact ? text + (dataset.headers.length === 1 && dataset.rows.at(-1)?.[0] === '' ? '\n' : '') : '\uFEFF' + text + '\r\n';
}

/** Extract only the selected column, with no coercion or truncation. Empty numeric cells use 255. */
export function parseRecipeColumn(dataset, column, recipe) {
  // Reuse the original parser for dimensions, UTF-8 size, headers and formula safety,
  // including when this adapter is passed a caller-created dataset.
  const checked = parseCSV(serialize(dataset, true));
  if (!Number.isInteger(column) || column < 0 || column >= checked.headers.length) fail('Bir sütun seçin.');
  if (recipe?.type !== 'number' && recipe?.type !== 'text') fail('Tarif türü number veya text olmalı.');
  if (recipe.type === 'text' && checked.rows.length > 8) fail('Metin tarifi en fazla 8 veri satırı destekler; satırlar kesilmez.');
  compileRecipe(recipe);
  estimateRecipe(recipe, checked.rows.length);
  if (recipe.type === 'number') return columnValues(checked, column);
  return checked.rows.map((row, i) => {
    const value = row[column];
    if (value.length > 16 || /[^\x20-\x7e]/.test(value)) fail(`${i + 1}. veri satırı: metin en fazla 16 bayt yazdırılabilir ASCII olmalı. Türkçe karakter, sekme ve satır sonu desteklenmez; veri kesilmez.`);
    return value;
  });
}

/** Verify decoded values against the public recipe and rebuild the complete CSV locally. */
export function applyRecipeOutput(dataset, column, values, recipe) {
  const input = parseRecipeColumn(dataset, column, recipe);
  const expected = referenceApply(input, recipe);
  if (!Array.isArray(values) || values.length !== input.length || Array.from(values).some((value, i) => value !== expected[i])) fail('Sonuç, seçili tarif ve tüm satırlarla eşleşmiyor; CSV oluşturulmadı.');
  const rows = dataset.rows.map((row, i) => row.map((cell, j) => j === column ? (recipe.type === 'number' && values[i] === 255 ? '' : String(values[i])) : cell));
  const output = { headers: [...dataset.headers], rows, delimiter: dataset.delimiter };
  const csv = serialize(output);
  // The source, not the BOM/CRLF-normalized export, has the 64 KiB input cap.
  // Recheck formula safety without rejecting exports enlarged by filled cells.
  if ([output.headers, ...output.rows].some(row => row.some(cell => /^[\s\uFEFF]*[=+\-@]/u.test(cell)))) fail('Sonuçta formül benzeri hücre var; CSV oluşturulmadı.');
  return { ...output, csv };
}
