/** Recompile only the v5 source. Never overwrite v4 sources or artifact pins. */
import {compile_program,createFileManager} from '@noir-lang/noir_wasm';
import fs from 'node:fs/promises';
const {program}=await compile_program(createFileManager(new URL('./circuits/record/',import.meta.url).pathname));
await fs.writeFile(new URL('./artifacts/record.json',import.meta.url),JSON.stringify(program));
console.log(JSON.stringify({type:'record',bytecodeBase64Bytes:program.bytecode.length,publicParameters:program.abi.parameters.filter(p=>p.visibility==='public').map(p=>p.name)}));
