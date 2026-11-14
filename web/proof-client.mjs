import {prepareProofPlan as prepareV4,decodeProofPlan as decodeV4,proveProofPlan as proveV4} from './proof-plan-client.mjs';
import {prepareProofRecord,decodeProofRecord,proveProofRecord} from './record-proof-client.mjs';
import {RECORD_PROFILE} from './proof-protocol.mjs';
export const prepareProofPlan=(values,plan,options)=>Object.hasOwn(plan||{},'inputs')?prepareProofRecord(values,plan,options):prepareV4(values,plan,options);
export const decodeProofPlan=(result,decoder)=>decoder?.profile===RECORD_PROFILE?decodeProofRecord(result,decoder):decodeV4(result,decoder);
export const proveProofPlan=args=>args?.request?.profile===RECORD_PROFILE?proveProofRecord(args):proveV4(args);
