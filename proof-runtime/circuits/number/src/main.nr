mod common;
fn main(pre_context: pub [u128;2],final_context: pub [u128;2],column:pub u8,row:pub u8,step_count:pub u8,ops:pub [u8;4],params:pub [[u8;3];4],
    input_pair_root:pub Field,output_pair_root:pub Field,input_selected_root:pub Field,output_selected_root:pub Field,statement:pub Field,
    input_salt:[u128;2],output_salt:[u128;2],input_pairs:[[u128;2];10],output_pairs:[[u128;2];8],input_bits:[bool;10],output_bits:[bool;8]) {
    let h=common::header(1,pre_context,column,row,step_count,ops,params);
    assert(!input_bits[8]);assert(input_bits[9]);
    let mut x:u8=0;
    for j in 0..8 {if input_bits[j] {x=x+((1 as u8)<<(j as u8));} }
    for i in 0..4 {
        if i<step_count as u32 {
            if ops[i]==1 {if x==255 {x=params[i][0];}}
            else {if x!=255 {if x<params[i][0] {x=params[i][0];} if x>params[i][1] {x=params[i][1];}}}
        }
    }
    for j in 0..8 {assert(output_bits[j]==(((x>>(j as u8))&1)==1));}
    common::check_roots(h,final_context,[input_pair_root,output_pair_root,input_selected_root,output_selected_root],statement,
        input_salt,output_salt,input_pairs,output_pairs,input_bits,output_bits);
}
