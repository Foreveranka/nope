// Immutable active V2 storage-funded policy; historical policies verify old evidence only.
export const WALLET_ESCROW_POLICY = Object.freeze({
  "network": "testnet",
  "contractId": "nope-wallet-5144c7d4.testnet",
  "codeHash": "349qhEttcFqG3ezvPHBCoFCyM8X1ZpXzYotgfqFXgN13",
  "domain": "NOPE:WALLET-ESCROW:V2:testnet",
  "requireKeyless": true,
  "admissionPublicKey": "268c745898f45bd60ae1ff6947481b985a3836b9e964b9e35d48a06d3dd3c2c9",
  "storageDepositYocto": "40960000000000000000000"
});
export const HISTORICAL_WALLET_ESCROW_POLICIES=Object.freeze([Object.freeze({
  "network": "testnet",
  "contractId": "nope-wallet-66e1273c.testnet",
  "codeHash": "5MAoowxLrnP7KWFFU2hAepMrQwUtgKpDtbgeFr7rcF9v",
  "domain": "NOPE:WALLET-ESCROW:V1:testnet",
  "requireKeyless": true,
  "admissionPublicKey": "268c745898f45bd60ae1ff6947481b985a3836b9e964b9e35d48a06d3dd3c2c9"
}),Object.freeze({
  "network": "testnet",
  "contractId": "nope-wallet-44384e2f.testnet",
  "codeHash": "6qzVqhNyk7KKvjzC6g8iPtJmHffTgb6YBh8Fp9xerXHy",
  "domain": "NOPE:WALLET-ESCROW:V1:testnet",
  "requireKeyless": true
})]);
