// Public approved policy identity; no cryptographic SDK/WASM import.
const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export const proofPolicy=freeze({
  "id": "nope-result-noir-poseidon2-v1",
  "relationVersion": 1,
  "noir": "1.0.0",
  "barretenberg": "6.0.0",
  "verifierTarget": "noir-recursive",
  "rootEncoding": "poseidon2-bn254-hash4-fold-v1",
  "srs": {
    "numPoints": 524288,
    "g1": {
      "path": "./assets/bn254_g1.dat",
      "sha256": "ea7b37bb4e1840b5632675fb2d79873ac0a1598374d3087344ba0e980736b8ac",
      "bytes": 33554432
    },
    "g2": {
      "path": "./assets/bn254_g2.dat",
      "sha256": "01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f",
      "bytes": 128
    },
    "grumpkin": {
      "path": "./assets/grumpkin_g1_v2.flat.dat",
      "sha256": "64236c9455e75aeea77a94587ea607eed2e978d2609a421d66bf10bb9698b8fd",
      "bytes": 4194304
    }
  },
  "circuits": {
    "number": {
      "circuitSha256": "621238b1b0c3677ae111cbb4b2cd22bbdc2d9f3a32c8db44c820fee961d1b7e6",
      "verificationKeySha256": "516d848ddeb80503f2a7fe4fd9f5dbce205fd10ab20f8051a086af05688e2f19"
    },
    "text": {
      "circuitSha256": "da5989f1fc84dbcc3dd386a49bcc58aa960a3e654dc3ec5ff1a0e54f2c6e79c9",
      "verificationKeySha256": "8a7addb2df6638e10e1ce5985c3038d7303da3e739e1af34612d02fc12711a1f"
    }
  }
});
export const policyHash='9bf341e80ca4ddb5ecd4fa6c731f9743dfd32ffe9622771ded172533b2d4fa40';
export const proofPolicyHash=policyHash;
