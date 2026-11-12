import handler from '../api/csv-gc.mjs';
/** Pure in-process adaptation of the actual existing evaluator, without decoder data. */
export async function executeTask(task){
 const req={method:'POST',headers:{host:'workspace.internal',origin:'https://workspace.internal','content-type':'application/json'},body:task};
 const res={setHeader(){},end(body){this.body=JSON.parse(body);}};
 await handler(req,res);
 if(res.statusCode!==200)throw Error('Encrypted execution failed');
 return res.body;
}
