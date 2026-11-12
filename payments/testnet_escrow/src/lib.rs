//! Explicit NOPE native test-NEAR escrow, independent of NEAR Market.
//! Trusts the configured registry account/code and its buyer acceptance, not FHE
//! correctness. No administrator withdrawal, arbitrary call or automatic release.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json::{self, json};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue, env, near};
use std::collections::BTreeMap;

type Hash = [u8; 32];
const MAX_AMOUNT: u128 = 10u128.pow(24); // <= 1 native test NEAR per job
const STORAGE_TOPUP: u128 = 2 * 10u128.pow(22); // 0.02 test NEAR; retained, not price
const MAX_JOBS: usize = 10; // bounded demo state, no unbounded storage subsidy

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Held,
    Verifying,
    PayoutPending,
    Paid,
    RefundPending,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Terms {
    pub job_id: U64,
    pub buyer: AccountId,
    pub provider: AccountId,
    pub amount: U128,
    pub context_hash: Hash,
    pub job_binding_hash: Hash,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Acceptance {
    pub attempt: U64,
    pub attempt_binding_hash: Hash,
    pub receipt_hash: Hash,
    pub output_hash: Hash,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub terms: Terms,
    pub state: State,
    pub nonce: U64,
    pub acceptance: Option<Acceptance>,
    pub provider_approves_refund: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Escrow {
    registry: AccountId,
    holds: BTreeMap<u64, Hold>,
}

fn test_account(account: &AccountId) {
    assert!(
        account.as_str().ends_with(".testnet"),
        "named testnet accounts only"
    );
}

fn no_deposit() {
    assert_eq!(
        env::attached_deposit().as_yoctonear(),
        0,
        "no deposit on this method"
    );
}

fn private_callback() {
    no_deposit();
    assert_eq!(
        env::predecessor_account_id(),
        env::current_account_id(),
        "private callback"
    );
    assert_eq!(
        env::promise_results_count(),
        1,
        "one promise result required"
    );
}

fn enough_gas() {
    assert!(
        env::prepaid_gas().as_gas() >= Gas::from_tgas(100).as_gas(),
        "attach at least 100 Tgas"
    );
}

fn nonzero(hash: &Hash) {
    assert_ne!(hash, &[0; 32], "zero hash");
}

// Deserialize just the existing registry's public view, with bounded callback
// bytes. Unknown enum/state/version, missing fields or malformed JSON fail closed.
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RegistryJob {
    job_id: U64,
    buyer: AccountId,
    state: String,
    config: RegistryConfig,
    job_binding_hash: Hash,
    attempt: U64,
    attempt_binding_hash: Option<Hash>,
    selected_executor: Option<AccountId>,
    attempt_binding_version: Option<u8>,
    receipts: Vec<RegistryReceipt>,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RegistryConfig {
    context_hash: Hash,
    executor: AccountId,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RegistryReceipt {
    receipt_hash: Hash,
    status: String,
    decided_at_ns: Option<U64>,
    claim: RegistryClaim,
}
#[derive(near_sdk::serde::Deserialize)]
#[serde(crate = "near_sdk::serde")]
struct RegistryClaim {
    job_id: U64,
    attempt: U64,
    job_binding_hash: Hash,
    attempt_binding_hash: Hash,
    context_hash: Hash,
    output_hash: Hash,
}

fn accepted(bytes: &[u8], hold: &Hold) -> bool {
    let Ok(job) = serde_json::from_slice::<RegistryJob>(bytes) else {
        return false;
    };
    let Some(expected) = &hold.acceptance else {
        return false;
    };
    let Some(receipt) = job.receipts.last() else {
        return false;
    };
    let provider = match job.attempt_binding_version {
        Some(1) => Some(&job.config.executor),
        Some(2) => job.selected_executor.as_ref(),
        _ => None,
    };
    let terms = &hold.terms;
    job.state == "Accepted"
        && job.job_id == terms.job_id
        && job.buyer == terms.buyer
        && provider == Some(&terms.provider)
        && job.config.context_hash == terms.context_hash
        && job.job_binding_hash == terms.job_binding_hash
        && job.attempt == expected.attempt
        && job.attempt_binding_hash == Some(expected.attempt_binding_hash)
        && receipt.status == "BuyerAccepted"
        && receipt.decided_at_ns.is_some_and(|time| time.0 > 0)
        && receipt.receipt_hash == expected.receipt_hash
        && receipt.claim.job_id == terms.job_id
        && receipt.claim.attempt == expected.attempt
        && receipt.claim.job_binding_hash == terms.job_binding_hash
        && receipt.claim.attempt_binding_hash == expected.attempt_binding_hash
        && receipt.claim.context_hash == terms.context_hash
        && receipt.claim.output_hash == expected.output_hash
}

#[near]
impl Escrow {
    #[init]
    pub fn new(registry: AccountId) -> Self {
        no_deposit();
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "self initialization only"
        );
        test_account(&env::current_account_id());
        test_account(&registry);
        assert_ne!(
            registry,
            env::current_account_id(),
            "separate registry required"
        );
        Self {
            registry,
            holds: BTreeMap::new(),
        }
    }

    pub fn registry(&self) -> AccountId {
        self.registry.clone()
    }

    pub fn get_hold(&self, job_id: U64) -> Option<Hold> {
        self.holds.get(&job_id.0).cloned()
    }

    pub fn storage_topup(&self) -> U128 {
        U128(STORAGE_TOPUP)
    }

    #[payable]
    pub fn fund(&mut self, terms: Terms) -> Hold {
        test_account(&terms.buyer);
        test_account(&terms.provider);
        assert_eq!(
            env::predecessor_account_id(),
            terms.buyer,
            "buyer must fund directly"
        );
        // Fixed-buyer pilot: the pinned registry is self-owned and creates jobs
        // with buyer == registry. An outsider must not reserve a real job ID by
        // attaching their own money and claiming themselves as its buyer.
        assert_eq!(terms.buyer, self.registry, "configured registry buyer only");
        assert_ne!(
            terms.buyer, terms.provider,
            "distinct buyer/provider required"
        );
        assert_ne!(
            terms.provider,
            env::current_account_id(),
            "provider cannot be escrow"
        );
        assert!(
            terms.job_id.0 > 0 && terms.amount.0 > 0 && terms.amount.0 <= MAX_AMOUNT,
            "invalid job or amount"
        );
        nonzero(&terms.context_hash);
        nonzero(&terms.job_binding_hash);
        assert_eq!(
            env::attached_deposit().as_yoctonear(),
            terms.amount.0 + STORAGE_TOPUP,
            "exact price plus storage topup required"
        );
        assert!(self.holds.len() < MAX_JOBS, "test escrow capacity reached");
        assert!(
            !self.holds.contains_key(&terms.job_id.0),
            "job already funded; no replay"
        );
        let hold = Hold {
            terms,
            state: State::Held,
            nonce: U64(0),
            acceptance: None,
            provider_approves_refund: false,
        };
        self.holds.insert(hold.terms.job_id.0, hold.clone());
        hold
    }

    pub fn release(&mut self, job_id: U64, acceptance: Acceptance) -> Promise {
        no_deposit();
        enough_gas();
        assert!(acceptance.attempt.0 > 0, "invalid attempt");
        nonzero(&acceptance.attempt_binding_hash);
        nonzero(&acceptance.receipt_hash);
        nonzero(&acceptance.output_hash);
        let hold = self.holds.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(
            env::predecessor_account_id(),
            hold.terms.buyer,
            "buyer only"
        );
        assert_eq!(
            hold.state,
            State::Held,
            "held only; pending effects cannot retry"
        );
        hold.nonce.0 = hold.nonce.0.checked_add(1).expect("nonce exhausted");
        hold.acceptance = Some(acceptance);
        hold.state = State::Verifying;
        let nonce = hold.nonce;
        Promise::new(self.registry.clone())
            .function_call(
                "get_job".to_string(),
                serde_json::to_vec(&json!({"job_id":job_id})).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(10),
            )
            .then(Promise::new(env::current_account_id()).function_call(
                "on_registry".to_string(),
                serde_json::to_vec(&json!({"job_id":job_id,"nonce":nonce})).unwrap(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(70),
            ))
    }

    #[private]
    pub fn on_registry(&mut self, job_id: U64, nonce: U64) -> PromiseOrValue<bool> {
        private_callback();
        let hold = self.holds.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(hold.state, State::Verifying, "not verifying");
        assert_eq!(hold.nonce, nonce, "stale callback");
        let valid =
            env::promise_result_checked(0, 64 * 1024).is_ok_and(|data| accepted(&data, hold));
        if !valid {
            hold.state = State::Held; // no transfer was scheduled, safe to re-verify
            return PromiseOrValue::Value(false);
        }
        hold.state = State::PayoutPending; // persist BEFORE transfer: no double payout
        PromiseOrValue::Promise(Self::transfer(hold, false))
    }

    /// Cooperative refund only. No timeout and no buyer unilateral withdrawal.
    pub fn approve_refund(&mut self, job_id: U64) {
        no_deposit();
        let hold = self.holds.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(
            env::predecessor_account_id(),
            hold.terms.provider,
            "provider only"
        );
        assert_eq!(hold.state, State::Held, "held only");
        hold.provider_approves_refund = true;
    }

    pub fn refund(&mut self, job_id: U64) -> Promise {
        no_deposit();
        enough_gas();
        let hold = self.holds.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(
            env::predecessor_account_id(),
            hold.terms.buyer,
            "buyer only"
        );
        assert_eq!(hold.state, State::Held, "held only");
        assert!(
            hold.provider_approves_refund,
            "provider refund approval required"
        );
        hold.nonce.0 = hold.nonce.0.checked_add(1).expect("nonce exhausted");
        hold.state = State::RefundPending;
        Self::transfer(hold, true)
    }

    #[private]
    pub fn on_transfer(&mut self, job_id: U64, nonce: U64, refund: bool) -> bool {
        private_callback();
        let hold = self.holds.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(hold.nonce, nonce, "stale callback");
        assert_eq!(
            hold.state,
            if refund {
                State::RefundPending
            } else {
                State::PayoutPending
            },
            "not matching pending transfer"
        );
        match env::promise_result_checked(0, 64) {
            Ok(data) => {
                // A native Transfer returns empty bytes. Unknown successful data
                // keeps Pending, never enables a second payment.
                if !data.is_empty() {
                    return false;
                }
                hold.state = if refund { State::Refunded } else { State::Paid };
                true
            }
            Err(near_sdk::PromiseError::Failed) => {
                // Actual failed transfer receipt, not missing callback/timeout.
                hold.state = State::Held;
                false
            }
            Err(_) => false,
        }
    }
}

impl Escrow {
    fn transfer(hold: &Hold, refund: bool) -> Promise {
        let receiver = if refund {
            &hold.terms.buyer
        } else {
            &hold.terms.provider
        };
        Promise::new(receiver.clone())
            .transfer(NearToken::from_yoctonear(hold.terms.amount.0))
            .then(
                Promise::new(env::current_account_id()).function_call(
                    "on_transfer".to_string(),
                    serde_json::to_vec(
                        &json!({"job_id":hold.terms.job_id,"nonce":hold.nonce,"refund":refund}),
                    )
                    .unwrap(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(10),
                ),
            )
    }
}

#[cfg(test)]
mod tests;
