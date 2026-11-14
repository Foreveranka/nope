// Reviewed record-only artifact pins; historical v4 pins remain separate.
export const APPROVED={
  "scheme": "nope-record-noir-poseidon2-v1",
  "noir": "1.0.0",
  "barretenberg": "6.0.0",
  "verifierTarget": "noir-recursive",
  "circuits": {
    "record": {
      "circuitPath": "./artifacts/record.json",
      "circuitSha256": "c5f73f34e4afd6fae679e1273790e9c2f3ed5a24cde01c06ea5ac29d79d1eff3",
      "vkPath": "./artifacts/record.vk",
      "vkSha256": "813e6a232dca75a880fa0b501c48bd901f1683486ce4d8cc665cedd35ea24f7f",
      "vkBytes": 3680,
      "proofBytes": 14656,
      "gates": 95436,
      "dyadic": 131072
    }
  },
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
  }
};
