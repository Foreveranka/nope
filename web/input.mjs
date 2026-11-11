/** Fixed-profile input validation. No evaluation or cryptographic work happens here. */
export const EXAMPLE_RECORDS = Object.freeze([
  Object.freeze({ id: 11, value: 36 }), Object.freeze({ id: 22, value: 255 }),
  Object.freeze({ id: 11, value: 128 }), Object.freeze({ id: 44, value: 72 }),
]);
export const DEFAULT_TITLE = 'Sentetik kayıt kontrolü';
export function validateRecords(rows) {
  const errors = [];
  if (!Array.isArray(rows) || rows.length !== 4) {
    return { valid: false, errors: [{ message: 'Tam 4 kayıt gerekli.' }], records: [] };
  }
  const records = rows.map((row, index) => {
    const record = {};
    for (const field of ['id', 'value']) {
      const raw = row?.[field];
      const value = typeof raw === 'string' ? raw.trim() : raw;
      if (!((typeof value === 'string' && /^\d+$/.test(value)) || typeof value === 'number') ||
          !Number.isInteger(Number(value)) || Number(value) < 0 || Number(value) > 255) {
        errors.push({ row: index, field, message: `${index + 1}. satır ${field === 'id' ? 'kimlik' : 'değer'}: 0–255 arasında tam sayı girin.` });
      } else record[field] = Number(value);
    }
    return record;
  });
  return { valid: errors.length === 0, records: errors.length ? [] : records, errors };
}
export function parseCSV(source) {
  const lines = String(source).replace(/^\uFEFF/, '').trim().split(/\r?\n/);
  const fail = message => ({ valid: false, records: [], errors: [{ message }] });
  if (lines[0]?.split(',').map(value => value.trim()).join(',') !== 'id,value') {
    return fail('İlk satır id,value olmalı; sütun sırasını değiştirmeyin.');
  }
  if (lines.length !== 5) return fail('Başlıktan sonra tam 4 kayıt satırı gerekli.');
  const rows = [];
  for (let index = 1; index < lines.length; index++) {
    const cells = lines[index].split(',');
    if (cells.length !== 2) return fail(`${index}. kayıtta yalnızca id ve value sütunları olmalı.`);
    rows.push({ id: cells[0], value: cells[1] });
  }
  return validateRecords(rows);
}
export function toCSV(records) {
  return ['id,value', ...records.map(row => `${row.id},${row.value}`)].join('\n');
}
export function capabilityReady(data) {
  return data?.profile?.id === 'clean-4-records-v1' && data.profile.recordCount === 4 &&
    typeof data.csrfToken === 'string' && data.csrfToken.length > 0;
}
export function metricText(key, value) {
  if (typeof value === 'boolean') return value ? 'Evet' : 'Hayır';
  if (typeof value === 'number' && Number.isFinite(value)) {
    const number = new Intl.NumberFormat('tr-TR', { maximumFractionDigits: 3 }).format(value);
    if (/(?:_seconds|Seconds|_s)$/.test(key)) return `${number} sn`;
    if (/(?:_ms|Ms)$/.test(key)) return `${number} ms`;
    return number;
  }
  if (typeof value === 'string') return value;
  return JSON.stringify(value) ?? '—';
}
