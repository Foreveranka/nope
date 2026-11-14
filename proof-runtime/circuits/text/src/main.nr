mod common;
fn canonical(bytes:[u8;16]) {
    let mut absent=false;
    for i in 0..16 {
        if bytes[i]<128 {assert(bytes[i]==0);absent=true;}
        else {assert(!absent);}
    }
}
fn trim(bytes:[u8;16]) -> [u8;16] {
    let mut len:u32=0;
    for i in 0..16 {if bytes[i]>=128 {len=len+1;}}
    let mut leading:u32=0;let mut edge=true;
    for i in 0..16 {if edge & (i<len) & (bytes[i]==160) {leading=leading+1;} else {edge=false;} }
    let mut end=leading;
    for i in 0..16 {if (i>=leading) & (i<len) & (bytes[i]!=160) {end=i+1;} }
    let mut out=[0;16];
    for d in 0..16 {for s in 0..16 {if (s==d+leading) & (s<end) {out[d]=bytes[s];}}}
    out
}
fn main(pre_context:pub [u128;2],final_context:pub [u128;2],column:pub u8,row:pub u8,step_count:pub u8,ops:pub [u8;4],params:pub [[u8;3];4],
    input_pair_root:pub Field,output_pair_root:pub Field,input_selected_root:pub Field,output_selected_root:pub Field,statement:pub Field,
    input_salt:[u128;2],output_salt:[u128;2],input_pairs:[[u128;2];130],output_pairs:[[u128;2];128],input_bits:[bool;130],output_bits:[bool;128]) {
    let h=common::header(2,pre_context,column,row,step_count,ops,params);
    assert(!input_bits[128]);assert(input_bits[129]);
    let mut bytes=[0 as u8;16];
    for i in 0..16 {for j in 0..8 {if input_bits[i*8+j] {bytes[i]=bytes[i]+((1 as u8)<<(j as u8));}}}
    canonical(bytes);
    for k in 0..4 {
        if k<step_count as u32 {
            if ops[k]==3 {bytes=trim(bytes);}
            else {
                for i in 0..16 {
                    if bytes[i]>=128 {
                        let c=bytes[i]&127;
                        if (ops[k]==4) & (c>=65) & (c<=90) {bytes[i]=bytes[i]+32;}
                        if (ops[k]==5) & (c>=97) & (c<=122) {bytes[i]=bytes[i]-32;}
                        if (ops[k]==6) & (c>=48) & (c<=57) {bytes[i]=170;}
                    }
                }
            }
        }
    }
    canonical(bytes);
    for i in 0..16 {for j in 0..8 {assert(output_bits[i*8+j]==(((bytes[i]>>(j as u8))&1)==1));}}
    common::check_roots(h,final_context,[input_pair_root,output_pair_root,input_selected_root,output_selected_root],statement,
        input_salt,output_salt,input_pairs,output_pairs,input_bits,output_bits);
}
