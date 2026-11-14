fn h4(x: [Field;4]) -> Field {
    let s = std::hash::poseidon2_permutation([x[0],x[1],x[2],4 * 18446744073709551616]);
    std::hash::poseidon2_permutation([s[0]+x[3],s[1],s[2],s[3]])[0]
}
fn fold<let N:u32>(domain:Field, fields:[Field;N]) -> Field {
    let mut acc = h4([domain,1,N as Field,0]);
    for i in 0..((N+2)/3) {
        let mut block=[0;3];
        for j in 0..3 { if i*3+j<N { block[j]=fields[i*3+j]; } }
        acc=h4([acc,block[0],block[1],block[2]]);
    }
    acc
}
fn pair_root<let N:u32>(domain:Field,h:[Field;49],salt:[u128;2],pairs:[[u128;2];N]) -> Field {
    let mut fields=[0;51+N*2];
    for i in 0..49 {fields[i]=h[i];}
    fields[49]=salt[0] as Field;fields[50]=salt[1] as Field;
    for i in 0..N {
        assert(pairs[i][0]!=pairs[i][1]);
        assert((pairs[i][0]&1)!=(pairs[i][1]&1));
        fields[51+i*2]=pairs[i][0] as Field;fields[52+i*2]=pairs[i][1] as Field;
    }
    fold(domain,fields)
}
fn selected_root<let N:u32>(domain:Field,h:[Field;49],pairs:[[u128;2];N],bits:[bool;N]) -> Field {
    let mut fields=[0;49+N];
    for i in 0..49 {fields[i]=h[i];}
    for i in 0..N {fields[49+i]=if bits[i] {pairs[i][1] as Field} else {pairs[i][0] as Field};}
    fold(domain,fields)
}
fn statement_root(h:[Field;49],final_context:[u128;2],roots:[Field;4]) -> Field {
    let mut fields=[0;55];for i in 0..49 {fields[i]=h[i];}
    fields[49]=final_context[0] as Field;fields[50]=final_context[1] as Field;
    for i in 0..4 {fields[51+i]=roots[i];}
    fold(105,fields)
}
pub fn check_roots<let I:u32,let O:u32>(h:[Field;49],final_context:[u128;2],roots:[Field;4],statement:Field,
    input_salt:[u128;2],output_salt:[u128;2],input_pairs:[[u128;2];I],output_pairs:[[u128;2];O],input_bits:[bool;I],output_bits:[bool;O]) {
    assert(pair_root(101,h,input_salt,input_pairs)==roots[0]);
    assert(pair_root(102,h,output_salt,output_pairs)==roots[1]);
    assert(selected_root(103,h,input_pairs,input_bits)==roots[2]);
    assert(selected_root(104,h,output_pairs,output_bits)==roots[3]);
    assert(statement_root(h,final_context,roots)==statement);
}
