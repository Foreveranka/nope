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
pub fn header(kind:u8,pre_context:[u128;2],column:u8,row:u8,step_count:u8,ops:[u8;4],params:[[u8;3];4]) -> [Field;22] {
    assert(column>=1 & column<=16); assert(row<32);
    assert(step_count>=1 & step_count<=4);
    let mut h=[0;22];h[0]=kind as Field;h[1]=column as Field;h[2]=row as Field;
    h[3]=pre_context[0] as Field;h[4]=pre_context[1] as Field;h[5]=step_count as Field;
    for i in 0..4 {
        h[6+i]=ops[i] as Field;
        for j in 0..3 {h[10+i*3+j]=params[i][j] as Field;}
        if i<step_count as u32 {
            if kind==1 {
                assert((ops[i]==1) | (ops[i]==2));
                assert(params[i][0]<=254);assert(params[i][2]==0);
                if ops[i]==1 {assert(params[i][1]==0);}
                else {assert(params[i][1]<=254);assert(params[i][0]<=params[i][1]);}
            } else {assert(ops[i]>=3 & ops[i]<=6); for j in 0..3 {assert(params[i][j]==0);} }
        } else {assert(ops[i]==0);for j in 0..3 {assert(params[i][j]==0);} }
    }
    h
}
fn pair_root<let N:u32>(domain:Field,h:[Field;22],salt:[u128;2],pairs:[[u128;2];N]) -> Field {
    let mut fields=[0;24+N*2];
    for i in 0..22 {fields[i]=h[i];}
    fields[22]=salt[0] as Field;fields[23]=salt[1] as Field;
    for i in 0..N {
        assert(pairs[i][0]!=pairs[i][1]);
        assert((pairs[i][0]&1)!=(pairs[i][1]&1));
        fields[24+i*2]=pairs[i][0] as Field;fields[25+i*2]=pairs[i][1] as Field;
    }
    fold(domain,fields)
}
fn selected_root<let N:u32>(domain:Field,h:[Field;22],pairs:[[u128;2];N],bits:[bool;N]) -> Field {
    let mut fields=[0;22+N];
    for i in 0..22 {fields[i]=h[i];}
    for i in 0..N {fields[22+i]=if bits[i] {pairs[i][1] as Field} else {pairs[i][0] as Field};}
    fold(domain,fields)
}
fn statement_root(h:[Field;22],final_context:[u128;2],roots:[Field;4]) -> Field {
    let mut fields=[0;28];for i in 0..22 {fields[i]=h[i];}
    fields[22]=final_context[0] as Field;fields[23]=final_context[1] as Field;
    for i in 0..4 {fields[24+i]=roots[i];}
    fold(105,fields)
}
pub fn check_roots<let I:u32,let O:u32>(h:[Field;22],final_context:[u128;2],roots:[Field;4],statement:Field,
    input_salt:[u128;2],output_salt:[u128;2],input_pairs:[[u128;2];I],output_pairs:[[u128;2];O],input_bits:[bool;I],output_bits:[bool;O]) {
    assert(pair_root(101,h,input_salt,input_pairs)==roots[0]);
    assert(pair_root(102,h,output_salt,output_pairs)==roots[1]);
    assert(selected_root(103,h,input_pairs,input_bits)==roots[2]);
    assert(selected_root(104,h,output_pairs,output_bits)==roots[3]);
    assert(statement_root(h,final_context,roots)==statement);
}
