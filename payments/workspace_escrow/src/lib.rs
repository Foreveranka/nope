//! Finite prefunded testnet sponsor pool. Backend-authorized decisions, NOT a
//! computation proof. Separate state/code from the registry's existing escrow.
use near_sdk::json_types::{U64, U128};
use near_sdk::serde_json;
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, env, near};
use std::collections::BTreeMap;

const DOMAIN: &str = "NOPE:WORKSPACE-ESCROW:V1:testnet";
const POOL: u128 = 5 * 10u128.pow(22); // 0.05 test NEAR, immutable
const MAX_HOLD: u128 = 10u128.pow(22); // 0.01
const GAS_RESERVE: u128 = 10u128.pow(23); // 0.1, not sponsor allocation
const STORAGE_HEADROOM: u64 = 65536;
const MAX_HOLDS: usize = 50;
const MAX_HORIZON_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const CALLBACK_TGAS: u64 = 20;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Terms {
    pub job_id: String,
    pub buyer_commitment: String,
    pub provider: AccountId,
    pub amount: U128,
    pub input_hash: String,
    pub program_hash: String,
    pub plan_hash: String,
    pub execution_deadline_ns: U64,
    pub review_deadline_ns: U64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Held,
    Delivered,
    PayoutPending,
    Paid,
    Refunded,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delivery {
    pub version: u32,
    pub output_hash: String,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub terms: Terms,
    pub binding_hash: String,
    pub state: State,
    pub nonce: U64,
    pub delivery: Option<Delivery>,
    pub last_transfer_failure_nonce: Option<U64>,
}

#[near(serializers = [json])]
pub struct Config {
    pub domain: String,
    pub network: String,
    pub contract_id: AccountId,
    pub max_holds: u32,
    pub max_hold_amount: U128,
    pub total_pool: U128,
    pub available: U128,
    /// Includes PayoutPending allocations until their definitive callback.
    pub held: U128,
    pub spent: U128,
    pub pending: U128,
    pub hold_count: u32,
    pub gas_reserve: U128,
    pub storage_headroom_bytes: u64,
    pub min_release_gas_tgas: u64,
    pub callback_gas_tgas: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WorkspaceEscrow {
    holds: BTreeMap<String, Hold>,
    held: u128,
    spent: u128,
    pending: u128,
}

fn hex(value: &str, len: usize) {
    assert!(
        value.len() == len
            && value
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)),
        "invalid lowercase hex"
    );
}
fn owner() {
    assert_eq!(
        env::attached_deposit().as_yoctonear(),
        0,
        "no attached deposit"
    );
    assert_eq!(
        env::predecessor_account_id(),
        env::current_account_id(),
        "self calls only"
    );
    assert!(
        env::current_account_id().as_str().ends_with(".testnet"),
        "testnet contract only"
    );
}
fn provider(account: &AccountId) {
    let value = account.as_str();
    assert!(
        value.ends_with(".testnet")
            || (value.len() == 64
                && value
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))),
        "testnet named or implicit provider only"
    );
    assert_ne!(
        account,
        &env::current_account_id(),
        "provider cannot be escrow"
    );
}
fn binding(terms: &Terms) -> String {
    let bytes = serde_json::to_vec(&[
        DOMAIN.to_string(),
        env::current_account_id().to_string(),
        terms.job_id.clone(),
        terms.buyer_commitment.clone(),
        terms.provider.to_string(),
        terms.amount.0.to_string(),
        terms.input_hash.clone(),
        terms.program_hash.clone(),
        terms.plan_hash.clone(),
        terms.execution_deadline_ns.0.to_string(),
        terms.review_deadline_ns.0.to_string(),
    ])
    .unwrap();
    env::sha256(&bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[near]
impl WorkspaceEscrow {
    #[init]
    pub fn new() -> Self {
        owner();
        let value = Self {
            holds: BTreeMap::new(),
            held: 0,
            spent: 0,
            pending: 0,
        };
        value.solvent();
        value
    }

    pub fn get_config(&self) -> Config {
        Config {
            domain: DOMAIN.into(),
            network: "testnet".into(),
            contract_id: env::current_account_id(),
            max_holds: MAX_HOLDS as u32,
            max_hold_amount: U128(MAX_HOLD),
            total_pool: U128(POOL),
            available: U128(POOL - self.held - self.spent),
            held: U128(self.held),
            spent: U128(self.spent),
            pending: U128(self.pending),
            hold_count: self.holds.len() as u32,
            gas_reserve: U128(GAS_RESERVE),
            storage_headroom_bytes: STORAGE_HEADROOM,
            min_release_gas_tgas: 100,
            callback_gas_tgas: CALLBACK_TGAS,
        }
    }

    pub fn get_hold(&self, job_id: String) -> Option<Hold> {
        hex(&job_id, 32);
        self.holds.get(&job_id).cloned()
    }

    pub fn fund(&mut self, terms: Terms) -> Hold {
        owner();
        Self::validate_terms(&terms);
        if let Some(existing) = self.holds.get(&terms.job_id) {
            assert_eq!(existing.terms, terms, "immutable hold terms");
            return existing.clone(); // no second allocation, even after terminal state
        }
        let now = env::block_timestamp();
        assert!(
            now < terms.execution_deadline_ns.0
                && terms.execution_deadline_ns.0 < terms.review_deadline_ns.0,
            "invalid deadlines"
        );
        assert!(
            terms.review_deadline_ns.0.saturating_sub(now) <= MAX_HORIZON_NS,
            "deadline exceeds 30 days"
        );
        assert!(self.holds.len() < MAX_HOLDS, "hold capacity reached");
        assert!(
            terms.amount.0 <= POOL - self.held - self.spent,
            "sponsor pool exhausted"
        );
        self.solvent();
        let hold = Hold {
            binding_hash: binding(&terms),
            state: State::Held,
            nonce: U64(0),
            delivery: None,
            last_transfer_failure_nonce: None,
            terms,
        };
        self.held += hold.terms.amount.0;
        self.holds.insert(hold.terms.job_id.clone(), hold.clone());
        hold
    }

    pub fn record_delivery(
        &mut self,
        job_id: String,
        binding_hash: String,
        version: u32,
        output_hash: String,
    ) -> Hold {
        owner();
        hex(&output_hash, 64);
        assert!(version > 0, "version starts at one");
        let hold = self.bound(&job_id, &binding_hash);
        assert!(
            matches!(hold.state, State::Held | State::Delivered),
            "not open for delivery"
        );
        assert!(
            env::block_timestamp() <= hold.terms.execution_deadline_ns.0,
            "execution deadline passed"
        );
        let next = Delivery {
            version,
            output_hash,
        };
        if hold.delivery.as_ref() == Some(&next) {
            return hold;
        }
        assert_eq!(
            version,
            hold.delivery
                .as_ref()
                .map_or(Some(1), |d| d.version.checked_add(1))
                .expect("version exhausted"),
            "strict next version required"
        );
        let mut hold = hold;
        hold.delivery = Some(next);
        hold.state = State::Delivered;
        self.holds.insert(job_id, hold.clone());
        hold
    }

    pub fn accept_and_release(
        &mut self,
        job_id: String,
        binding_hash: String,
        version: u32,
        output_hash: String,
    ) -> Promise {
        owner();
        assert!(
            env::prepaid_gas().as_gas() >= Gas::from_tgas(100).as_gas(),
            "attach at least 100 Tgas"
        );
        hex(&output_hash, 64);
        let mut hold = self.bound(&job_id, &binding_hash);
        assert_eq!(
            hold.state,
            State::Delivered,
            "latest delivered state required"
        );
        assert!(
            env::block_timestamp() <= hold.terms.review_deadline_ns.0,
            "review deadline passed"
        );
        assert_eq!(
            hold.delivery,
            Some(Delivery {
                version,
                output_hash
            }),
            "latest delivery mismatch"
        );
        self.solvent();
        hold.nonce.0 = hold.nonce.0.checked_add(1).expect("nonce exhausted");
        hold.state = State::PayoutPending;
        let nonce = hold.nonce;
        self.pending = self
            .pending
            .checked_add(hold.terms.amount.0)
            .expect("pending overflow");
        self.holds.insert(job_id.clone(), hold.clone()); // freeze before scheduling any effect
        Promise::new(hold.terms.provider)
            .transfer(NearToken::from_yoctonear(hold.terms.amount.0))
            .then(Promise::new(env::current_account_id()).function_call(
                "on_transfer", serde_json::to_vec(&near_sdk::serde_json::json!({"job_id":job_id,"binding_hash":binding_hash,"nonce":nonce})).unwrap(),
                NearToken::from_yoctonear(0), Gas::from_tgas(CALLBACK_TGAS)))
    }

    #[private]
    pub fn on_transfer(&mut self, job_id: String, binding_hash: String, nonce: U64) -> bool {
        owner();
        assert_eq!(
            env::promise_results_count(),
            1,
            "exactly one promise result required"
        );
        let mut hold = self.bound(&job_id, &binding_hash);
        assert_eq!(hold.state, State::PayoutPending, "not payout pending");
        assert_eq!(hold.nonce, nonce, "stale callback nonce");
        match env::promise_result_checked(0, 64) {
            Ok(bytes) if bytes.is_empty() => {
                self.pending -= hold.terms.amount.0;
                self.held -= hold.terms.amount.0;
                self.spent += hold.terms.amount.0;
                hold.state = State::Paid;
            }
            Err(near_sdk::PromiseError::Failed) => {
                self.pending -= hold.terms.amount.0;
                hold.state = State::Delivered;
                hold.last_transfer_failure_nonce = Some(nonce);
            }
            _ => return false, // unknown/malformed success stays Pending, never authorizes retry
        }
        let paid = hold.state == State::Paid;
        self.holds.insert(job_id, hold);
        paid
    }

    pub fn refund(&mut self, job_id: String, binding_hash: String) -> Hold {
        owner();
        let mut hold = self.bound(&job_id, &binding_hash);
        assert!(
            matches!(hold.state, State::Held | State::Delivered),
            "only unspent, nonpending hold refundable"
        );
        assert!(
            env::block_timestamp() > hold.terms.review_deadline_ns.0,
            "review deadline not passed"
        );
        self.held -= hold.terms.amount.0;
        hold.state = State::Refunded;
        self.holds.insert(job_id, hold.clone());
        hold // self-sponsored allocation returned internally; no native transfer
    }
}

impl WorkspaceEscrow {
    fn validate_terms(terms: &Terms) {
        hex(&terms.job_id, 32);
        for value in [
            &terms.buyer_commitment,
            &terms.input_hash,
            &terms.program_hash,
            &terms.plan_hash,
        ] {
            hex(value, 64);
        }
        provider(&terms.provider);
        assert!(
            terms.amount.0 > 0 && terms.amount.0 <= MAX_HOLD,
            "amount outside pilot limit"
        );
    }
    fn bound(&self, job_id: &str, binding_hash: &str) -> Hold {
        hex(job_id, 32);
        hex(binding_hash, 64);
        let hold = self.holds.get(job_id).expect("unknown job");
        assert_eq!(hold.binding_hash, binding_hash, "hold binding mismatch");
        hold.clone()
    }
    fn solvent(&self) {
        // Pending native transfers are already scheduled; do not count them as
        // money still available in this account. They remain logically held.
        let remaining = POOL
            .checked_sub(self.spent)
            .unwrap()
            .checked_sub(self.pending)
            .unwrap();
        let storage = u128::from(
            env::storage_usage()
                .checked_add(STORAGE_HEADROOM)
                .expect("storage overflow"),
        )
        .checked_mul(env::storage_byte_cost().as_yoctonear())
        .expect("storage cost overflow");
        let required = storage
            .checked_add(GAS_RESERVE)
            .unwrap()
            .checked_add(remaining)
            .unwrap();
        assert!(
            env::account_balance().as_yoctonear() >= required,
            "prefund storage, gas and sponsor pool separately"
        );
    }
}

#[cfg(test)]
mod tests;
