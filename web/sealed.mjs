/** Existing MPC v2 commitment codec. Amount/salt never leave this module implicitly. */
const enc = new TextEncoder();
const hex = bytes => [...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
const unhex = s => {if(typeof s!=='string'||! /^[0-9a-f]{64}$/.test(s))throw new Error('Geçersiz bağlam özeti.');return Uint8Array.from(s.match(/../g),v=>parseInt(v,16));};
export function parseAmount(value,{budget=false}={}) {
 if(typeof value!=='string'||! /^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/.test(value))throw new Error('Tutar en fazla altı ondalık basamak içermeli.');
 const [whole,fraction='']=value.split('.');const amount=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
 if(amount<(budget?0n:1n)||amount>1000000000000n)throw new Error('Tutar desteklenen aralığın dışında.');
 return amount;
}
export async function sealAmount(contextHash,slot,amount,salt) {
 if(!Number.isInteger(slot)||slot<0||slot>3||typeof amount!=='bigint'||amount<(slot===0?0n:1n)||amount>1000000000000n)throw new Error('Geçersiz teklif.');
 const secret=salt??crypto.getRandomValues(new Uint8Array(32));
 if(!(secret instanceof Uint8Array)||secret.length!==32)throw new Error('Geçersiz gizleme anahtarı.');
 const tag=enc.encode('VEIL-MPC-v2\0'),context=unhex(contextHash);
 const message=new Uint8Array(tag.length+32+1+8+32);message.set(tag);message.set(context,tag.length);message[tag.length+32]=slot;
 new DataView(message.buffer).setBigUint64(tag.length+33,amount,false);message.set(secret,tag.length+41);
 const commitment=hex(new Uint8Array(await crypto.subtle.digest('SHA-256',message)));
 message.fill(0);
 return {commitment,witness:{codec:'sealed-cheapest-3-spdz2k-v2',contextHash,slot,amount:amount.toString(),salt:hex(secret)}};
}
