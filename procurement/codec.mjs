import {createHash} from 'node:crypto';

export const PROFILE = 'clean-4-records-v1';
export const MPC_PROFILE = 'sealed-cheapest-3-spdz2k-v2';
export const MPC_UPSTREAM = 'cd4d517a8a37b266d7233ae412717ca181cec6bf';
// Pinned actual repository circuit, checked independently against Python in tests.
export const MPC_PROGRAM_HASH = '2366fe6cd6a01c7d7eacc37053b05109b1ed9363e17cf889941281decdd8760d';
export const MAX_AMOUNT = 10 ** 12;
export const HEX = /^[0-9a-f]{64}$/;
export const ID = /^[0-9a-f]{32}$/;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const exact = (value, fields) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...fields].sort().join('|');
export const hash32 = value => typeof value === 'string' && HEX.test(value) && value !== '0'.repeat(64);
export const account = value => typeof value === 'string' && value.length >= 2 && value.length <= 64 && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
export const isU64 = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) < 2n ** 64n;
export const validRoster = (roster,buyer) => Array.isArray(roster) && roster.length === 3 && roster.every(account) && new Set(roster).size === 3 && [...roster].sort().every((v,n) => v === roster[n]) && !roster.includes(buyer);
export const validDeadlines = (bid,result) => isU64(bid) && isU64(result) && BigInt(bid) < BigInt(result) && BigInt(result) - BigInt(bid) < 30n * 86400n * 1000000000n;
const HASH_FIELDS = ['specHash','circuitHash','keyHash','outputPolicyHash','inputHash'];
const INTENT_FIELDS = ['version','profile','networkDomainHash','registryAccount','buyer','roster','qualified','fixedFee','bidDeadlineNs','resultDeadlineNs','registryExecutor','intentNonce','selectionRound','mpcProgramHash','upstream',...HASH_FIELDS];
export function validateIntent(i) {
  if (!exact(i,INTENT_FIELDS) || i.version !== 2 || i.profile !== MPC_PROFILE || i.upstream !== MPC_UPSTREAM || i.mpcProgramHash !== MPC_PROGRAM_HASH ||
      ![...HASH_FIELDS,'networkDomainHash','intentNonce','selectionRound','mpcProgramHash'].every(k=>hash32(i[k])) ||
      !['registryAccount','buyer','registryExecutor'].every(k=>account(i[k])) || !validRoster(i.roster,i.buyer) ||
      !Array.isArray(i.qualified) || i.qualified.length !== 3 || !i.qualified.every(v=>typeof v === 'boolean') ||
      !Number.isSafeInteger(i.fixedFee) || i.fixedFee < 0 || i.fixedFee > MAX_AMOUNT || !validDeadlines(i.bidDeadlineNs,i.resultDeadlineNs)) throw new Error('Invalid v2 intent');
  return i;
}
const u64 = value => {const b=Buffer.alloc(8);b.writeBigUInt64BE(BigInt(value));return b;};
const text = value => {const b=Buffer.from(value,'ascii');const length=Buffer.alloc(4);length.writeUInt32BE(b.length);return Buffer.concat([length,b]);};
const raw = value => Buffer.from(value,'hex');
export function encodeIntent(value) {
  const i=validateIntent(value);
  return Buffer.concat([Buffer.from('VEIL-INTENT-v2\0'),Buffer.from([2]),text(i.profile),raw(i.networkDomainHash),text(i.registryAccount),text(i.buyer),Buffer.from([3]),
    ...i.roster.map(text),Buffer.from(i.qualified.map(Number)),u64(i.fixedFee),u64(i.bidDeadlineNs),u64(i.resultDeadlineNs),...HASH_FIELDS.map(k=>raw(i[k])),
    text(i.registryExecutor),raw(i.intentNonce),raw(i.selectionRound),raw(i.mpcProgramHash),text(i.upstream)]);
}
export const precommitContext = intent => sha256(encodeIntent(intent));
// This helper is for interoperable clients/tests; HTTP accepts only the resulting hash.
export function commitment(context,slot,amount,salt) {
  if (typeof context !== 'string' || !HEX.test(context) || !Number.isInteger(slot) || slot < 0 || slot > 3 || !Number.isSafeInteger(amount) || amount < (slot===0?0:1) || amount > MAX_AMOUNT || !Buffer.isBuffer(salt) || salt.length !== 32) throw new Error('Invalid commitment witness');
  return sha256(Buffer.concat([Buffer.from('VEIL-MPC-v2\0'),raw(context),Buffer.from([slot]),u64(amount),salt]));
}
// Canonical metadata hashing only; secret commitment and intent codecs above are binary.
export function canonical(value) {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value !== null && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  return JSON.stringify(value);
}
