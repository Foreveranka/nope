/** Isolated prompt candidates. No task matching, repair, external calls or execution. */
import {buildPlannerMessages as frozenMessages} from '../../web/agent-model-worker.mjs';
const examples=[
 ['Trim C4 and translate it to French.',{status:'unsupported',reason:'Translation is not available'}],
 ['C6 harflerini küçült ve duygusunu yorumla.',{status:'unsupported',reason:'Semantic analysis is not available'}],
 ['Remove spaces at both ends of C1, then make its letters uppercase. Fill absent C2 numbers with 9; then keep C2 in the interval 2 to 90.',{operations:[['C1','trim'],['C1','uppercase'],['C2','fill',9],['C2','clamp',2,90]]}],
 ['C3 rakamlarını maskele ve küçük harf yap. C4 eksiklerini 8 ile doldur, sonra 1-99 aralığına sınırla.',{operations:[['C3','redactDigits'],['C3','lowercase'],['C4','fill',8],['C4','clamp',1,99]]}],
];
const schema=`You translate public instructions into a small tool language. Return ONE JSON object and nothing else.
Success object: {"operations":[...]}.
Each operation is ONE array with EXACTLY one of these signatures:
[column,"trim"]
[column,"lowercase"]
[column,"uppercase"]
[column,"redactDigits"]
[column,"fill",integer]
[column,"clamp",integer_min,integer_max]
column must be an ID from the current column list. The first four operations are text-only and have EXACTLY TWO elements. Never append words like leading, trailing, spaces, letters or digits as arguments. trim already removes BOTH leading and trailing ASCII spaces. lowercase and uppercase use ASCII only. redactDigits replaces each ASCII digit with *.
fill and clamp are number-only. fill replaces missing/empty values. clamp bounds nonmissing numbers. Constants must be integers 0..254 and min<=max. Use constants explicitly requested by the user. Never add fill/clamp/trim unless asked. Preserve operation order within each column. Include ALL requested transformations.
If ANY part of the request requires an unavailable operation, return {"status":"unsupported","reason":"Unavailable operation"} INSTEAD of all operations. Never return only the supported subset. Translation between languages, sentiment, summarization, sorting, deduplication, arithmetic, dates and Unicode language-specific case rules are unavailable.
Interpret English or Turkish. Do not copy example IDs or constants. No markdown, prose or code.`;
function shots(){return examples.flatMap(([input,output])=>[{role:'user',content:input},{role:'assistant',content:JSON.stringify(output)}]);}
export const prompts={
 'frozen-baseline':{description:'Current frozen worker, unchanged.',messages:frozenMessages},
 'exact-arity-v1':{description:'Explicit tuple signatures and whole-request unsupported policy; same adapter.',messages:task=>[{role:'system',content:schema+'\nCurrent column types: '+JSON.stringify(task.columns)},...shots(),{role:'user',content:task.goal}]},
 'typed-task-v2':{description:'Same signatures; structured public task and interleaved examples, no repair.',messages:task=>[{role:'system',content:schema},...shots().slice(0,4),...shots().slice(4),{role:'user',content:JSON.stringify(task)}]},
};
