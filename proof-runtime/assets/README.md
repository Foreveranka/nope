# Approved public SRS assets

These are public universal ceremony points, not keys or customer data. They were
obtained with the pinned official Barretenberg6.0.0 SDK and verified against the
frozen hashes in `../artifacts/approved-manifest.json` before copying here.

| File | Bytes | SHA-256 |
|---|---:|---|
| bn254_g1.dat | 33554432 | ea7b37bb4e1840b5632675fb2d79873ac0a1598374d3087344ba0e980736b8ac |
| bn254_g2.dat | 128 | 01797bfc4de5a96f0e516a9ea4537d18786dc30cb991aca4274c95822b69c32f |
| grumpkin_g1_v2.flat.dat | 4194304 | 64236c9455e75aeea77a94587ea607eed2e978d2609a421d66bf10bb9698b8fd |

Total37748864bytes (36MiB +128bytes). Node and browser use exactly these bytes.
`node proof-runtime/prepare-crs.mjs` checks them offline. There is no download or
cache fallback. Deployment must include all three files in the Node function
filesystem; the browser package copies them under its same-origin`assets/` path.
The32MiB largest file is below GitHub's100MiB individual-file limit.
Do not replace or regenerate approval metadata as a deployment step.
