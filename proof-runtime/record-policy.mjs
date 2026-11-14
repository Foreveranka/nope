const freeze=x=>{if(x&&typeof x==='object'){Object.values(x).forEach(freeze);Object.freeze(x);}return x;};
export const proofPolicy=freeze({
  "id": "nope-record-noir-poseidon2-v1",
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
    "record": {
      "circuitSha256": "c5f73f34e4afd6fae679e1273790e9c2f3ed5a24cde01c06ea5ac29d79d1eff3",
      "verificationKeySha256": "813e6a232dca75a880fa0b501c48bd901f1683486ce4d8cc665cedd35ea24f7f"
    }
  }
});
export const policyHash="ba19dcc612c2d5cb9418730d75eb3654172b1baa7c8cc2e544ddce2796251459";
export const proofPolicyHash=policyHash;
