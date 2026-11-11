import test from 'node:test';
import assert from 'node:assert/strict';
import { EXAMPLE_RECORDS, DEFAULT_TITLE, validateRecords, parseCSV, toCSV, capabilityReady, metricText } from './input.mjs';

test('four synthetic records, including duplicate ids and sentinel 255, are valid', () => {
  assert.equal(validateRecords(EXAMPLE_RECORDS).valid, true);
  assert.equal(DEFAULT_TITLE.trim().length > 0, true);
});
test('record count is exactly four', () => {
  for (const input of [null, {}, [], EXAMPLE_RECORDS.slice(1), [...EXAMPLE_RECORDS, { id: 1, value: 2 }]]) assert.equal(validateRecords(input).valid, false);
});
test('all byte boundaries accepted and fields converted to numbers', () => {
  const rows = [{ id: '0', value: '255' }, { id: ' 255 ', value: '0' }, { id: '1', value: '100' }, { id: '11', value: '101' }];
  assert.deepEqual(validateRecords(rows).records[0], { id: 0, value: 255 });
  assert.equal(validateRecords(rows).valid, true);
});
test('reject invalid, blank, noninteger and nonnumeric fields with row and field errors', () => {
  for (const value of [-1, 256, 1.1, NaN, Infinity, true, false, null, '', ' ', '1e2', '1.0', '+1', '0xff', '1,2', '<img src=x>', {}, []]) {
    const rows = EXAMPLE_RECORDS.map(row => ({ ...row })); rows[2].value = value;
    const result = validateRecords(rows);
    assert.equal(result.valid, false, String(value));
    assert.equal(result.errors[0].row, 2); assert.equal(result.errors[0].field, 'value');
  }
});
test('CSV round trip; BOM, CRLF and whitespace supported', () => {
  assert.deepEqual(parseCSV(toCSV(EXAMPLE_RECORDS)).records, EXAMPLE_RECORDS);
  assert.equal(parseCSV('\uFEFFid,value\r\n 11,36\r\n22,255\r\n11,128\r\n44,72\r\n').valid, true);
});
test('CSV rejects wrong header, missing/extra columns, rows, quotes and blank body rows', () => {
  for (const csv of ['', 'value,id\n1,2\n1,2\n1,2\n1,2', 'id,value\n1,2', 'id,value\n1,2,3\n1,2\n1,2\n1,2', 'id,value\n"1",2\n1,2\n1,2\n1,2', 'id,value\n1,2\n\n1,2\n1,2', 'id,value\n1,2\n1,2\n1,2\n1,2\n1,2']) assert.equal(parseCSV(csv).valid, false, csv);
});
test('pending FHE capability does not block first job; token and exact profile required', () => {
  const data = { profile: { id: 'clean-4-records-v1', recordCount: 4 }, csrfToken: 'test-only-token', capabilities: [{ id: 'fhe', status: 'pending' }] };
  assert.equal(capabilityReady(data), true);
  assert.equal(capabilityReady({ ...data, csrfToken: '' }), false);
  assert.equal(capabilityReady({ ...data, profile: { id: 'other', recordCount: 4 } }), false);
  assert.equal(capabilityReady({ ...data, profile: { id: 'clean-4-records-v1', recordCount: 3 } }), false);
  assert.equal(capabilityReady(null), false);
});
test('metrics retain string/bool semantics; only numeric time keys receive units', () => {
  assert.equal(metricText('verified_seconds', false), 'Hayır');
  assert.equal(metricText('verified', true), 'Evet');
  assert.equal(metricText('duration_seconds', 'pending'), 'pending');
  assert.equal(metricText('duration_seconds', 1.5), '1,5 sn');
  assert.equal(metricText('elapsed_ms', 42), '42 ms');
  assert.equal(metricText('count', 4), '4');
  assert.equal(metricText('details', { local: true }), '{"local":true}');
});
