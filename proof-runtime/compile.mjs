import {compile_program,createFileManager} from '@noir-lang/noir_wasm';
import fs from 'node:fs/promises';
for (const type of process.argv.slice(2).length?process.argv.slice(2):['number','text']) {
 const root=new URL(`./circuits/${type}`,import.meta.url);
 const common=await fs.readFile(new URL('./circuits/common.nr',import.meta.url),'utf8');
 await fs.writeFile(new URL('./src/common.nr',root.href+'/'),common);
 const started=performance.now();
 const {program}=await compile_program(createFileManager(root.pathname));
 await fs.mkdir(new URL('./artifacts/',import.meta.url),{recursive:true});
 await fs.writeFile(new URL(`./artifacts/${type}.json`,import.meta.url),JSON.stringify(program));
 console.log(JSON.stringify({compiled:type,noirVersion:program.noir_version,bytecodeBase64Bytes:program.bytecode.length,publicParameters:program.abi.parameters.filter(p=>p.visibility==='public').map(p=>p.name),ms:Math.round(performance.now()-started)}));
}
