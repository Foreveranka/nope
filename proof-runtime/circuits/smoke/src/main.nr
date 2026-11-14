fn h4(x: [Field;4]) -> Field {
 let s = std::hash::poseidon2_permutation([x[0],x[1],x[2], 4 * 18446744073709551616]);
 std::hash::poseidon2_permutation([s[0]+x[3],s[1],s[2],s[3]])[0]
}
fn main(x: Field, y: pub Field) { assert(h4([x,0,0,0]) == y); }
