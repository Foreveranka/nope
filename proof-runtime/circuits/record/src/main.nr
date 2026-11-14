mod common;
// Private record VM. Public bounded instructions; private unsigned 32-bit fields.
fn active(r:u8, inputs:u8, constants:u8, step:u32) -> bool {
    (r<inputs) | ((r>=8)&(r<8+constants)) | ((r>=12)&((r as u32)<12+step))
}
fn main(pre_context:pub [u128;2],final_context:pub [u128;2],column:pub u8,row:pub u8,
    input_count:pub u8,constant_count:pub u8,step_count:pub u8,output_count:pub u8,
    constants:pub [u32;4],ops:pub [u8;8],args:pub [[u8;3];8],outputs:pub [u8;4],
    input_pair_root:pub Field,output_pair_root:pub Field,input_selected_root:pub Field,output_selected_root:pub Field,statement:pub Field,
    input_salt:[u128;2],output_salt:[u128;2],input_pairs:[[u128;2];258],output_pairs:[[u128;2];128],input_bits:[bool;258],output_bits:[bool;128]) {
    assert(column==1); assert(row<16); assert(input_count>=1 & input_count<=8);
    assert(constant_count<=4); assert(step_count>=1 & step_count<=8); assert(output_count>=1 & output_count<=4);
    let mut h:[Field;49]=[0;49];
    h[0]=3; h[1]=column as Field; h[2]=row as Field;
    h[3]=pre_context[0] as Field; h[4]=pre_context[1] as Field;
    h[5]=input_count as Field; h[6]=constant_count as Field; h[7]=step_count as Field; h[8]=output_count as Field;
    let mut regs:[u32;20]=[0;20];
    assert(!input_bits[256]); assert(input_bits[257]);
    for i in 0..8 {
        let mut n:u32=0;
        for b in 0..32 {if input_bits[i*32+b] {n=n+((1 as u32)<<(b as u32));}}
        if i>=input_count as u32 {assert(n==0);}
        regs[i]=n;
    }
    for i in 0..4 {
        if i>=constant_count as u32 {assert(constants[i]==0);}
        regs[8+i]=constants[i]; h[9+i]=constants[i] as Field;
        h[45+i]=outputs[i] as Field;
    }
    for i in 0..8 {
        h[13+i]=ops[i] as Field;
        for j in 0..3 {h[21+i*3+j]=args[i][j] as Field;}
        if i<step_count as u32 {
            assert(ops[i]>=1 & ops[i]<=9);
            assert(active(args[i][0],input_count,constant_count,i));
            assert(active(args[i][1],input_count,constant_count,i));
            if ops[i]==8 {assert(active(args[i][2],input_count,constant_count,i));}
            else {assert(args[i][2]==0);}
            let a=regs[args[i][0] as u32]; let b=regs[args[i][1] as u32];
            let mut v:u32=0;
            if ops[i]==1 {let sum=(a as u64)+(b as u64);v=if sum>4294967295 {4294967295} else {sum as u32};}
            else if ops[i]==2 {v=if a>=b {a-b} else {0};}
            else if ops[i]==3 {v=if a<b {a} else {b};}
            else if ops[i]==4 {v=if a>b {a} else {b};}
            else if ops[i]==5 {v=if a==b {1} else {0};}
            else if ops[i]==6 {v=if a<=b {1} else {0};}
            else if ops[i]==7 {v=if (a!=0)&(b!=0) {1} else {0};}
            else if ops[i]==8 {v=if a!=0 {b} else {regs[args[i][2] as u32]};}
            else {assert(a<=65535);assert(b<=65535);v=a*b;}
            regs[12+i]=v;
        } else {
            assert(ops[i]==0); for j in 0..3 {assert(args[i][j]==0);}
        }
    }
    for i in 0..4 {
        let mut n:u32=0;
        if i<output_count as u32 {assert(active(outputs[i],input_count,constant_count,step_count as u32));n=regs[outputs[i] as u32];}
        else {assert(outputs[i]==0);}
        for b in 0..32 {assert(output_bits[i*32+b]==(((n>>(b as u32))&1)==1));}
    }
    common::check_roots(h,final_context,[input_pair_root,output_pair_root,input_selected_root,output_selected_root],statement,
        input_salt,output_salt,input_pairs,output_pairs,input_bits,output_bits);
}
