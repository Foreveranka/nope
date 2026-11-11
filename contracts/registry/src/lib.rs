//! Registry of opaque commitments and executor claims. No execution or proof verification.
use near_sdk::borsh::{self, BorshSerialize};
use near_sdk::json_types::U64;
use near_sdk::store::LookupMap;
use near_sdk::{AccountId, PanicOnDefault, env, near};

pub type Hash = [u8; 32];
const MAX_BIDDERS: usize = 10;
const MAX_ATTEMPTS: usize = 16;
const MAX_WINDOW_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JobConfig {
    pub spec_hash: Hash,
    pub circuit_hash: Hash,
    pub key_hash: Hash,
    pub output_policy_hash: Hash,
    pub context_hash: Hash,
    pub input_hash: Hash,
    pub budget_commitment: Hash,
    pub bid_deadline_ns: U64,
    pub result_deadline_ns: U64,
    pub authorized_bidders: Vec<AccountId>,
    pub executor: AccountId,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum JobState {
    Open,
    Closed,
    Executing,
    Reported,
    Rejected,
    Accepted,
    Expired,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BidEntry {
    pub bidder: AccountId,
    pub commitment: Option<Hash>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReceiptStatus {
    ExecutorReported,
    BuyerRejected,
    BuyerAccepted,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptClaim {
    pub job_id: U64,
    pub attempt: U64,
    pub job_binding_hash: Hash,
    pub attempt_binding_hash: Hash,
    pub bidset_root: Hash,
    pub spec_hash: Hash,
    pub circuit_hash: Hash,
    pub key_hash: Hash,
    pub output_policy_hash: Hash,
    pub context_hash: Hash,
    pub input_hash: Hash,
    pub budget_commitment: Hash,
    pub output_hash: Hash,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ReceiptRecord {
    pub claim: ReceiptClaim,
    pub receipt_hash: Hash,
    pub reported_at_ns: U64,
    pub status: ReceiptStatus,
    pub decided_at_ns: Option<U64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Job {
    pub job_id: U64,
    pub buyer: AccountId,
    pub config: JobConfig,
    pub job_binding_hash: Hash,
    pub bids: Vec<BidEntry>,
    pub state: JobState,
    pub bidset_root: Option<Hash>,
    pub closed_at_ns: Option<U64>,
    pub attempt: U64,
    pub attempt_binding_hash: Option<Hash>,
    /// Buyer-selected committed roster member, fixed for all attempts of this job.
    pub selected_executor: Option<AccountId>,
    /// None before execution; 1 = configured executor, 2 = selected executor binding.
    pub attempt_binding_version: Option<u8>,
    pub receipts: Vec<ReceiptRecord>,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Registry {
    owner: AccountId,
    network_domain_hash: Hash,
    next_job_id: u64,
    jobs: LookupMap<u64, Job>,
}

// Versioned Borsh tuples: tag is a String, not an unframed prefix. See README.
fn digest<T: BorshSerialize>(value: &T) -> Hash {
    env::sha256_array(borsh::to_vec(value).expect("hash serialization"))
}

fn nonzero(hash: &Hash) {
    assert_ne!(*hash, [0; 32], "zero hash is not permitted");
}

fn no_money() {
    assert_eq!(
        env::attached_deposit().as_yoctonear(),
        0,
        "no funds accepted"
    );
}

#[near]
impl Registry {
    /// Self-call only: initialize atomically with local deployment. Domain is configured,
    /// not a runtime-verified chain ID; NEAR does not expose a chain ID host function.
    #[init]
    #[private]
    pub fn new(owner: AccountId, network_domain_hash: Hash) -> Self {
        no_money();
        assert_eq!(
            env::predecessor_account_id(),
            env::current_account_id(),
            "self initialization only"
        );
        nonzero(&network_domain_hash);
        Self {
            owner,
            network_domain_hash,
            next_job_id: 1,
            jobs: LookupMap::new(b"j"),
        }
    }

    pub fn owner(&self) -> AccountId {
        self.owner.clone()
    }

    pub fn network_domain_hash(&self) -> Hash {
        self.network_domain_hash
    }

    pub fn get_job(&self, job_id: U64) -> Option<Job> {
        self.jobs.get(&job_id.0).cloned()
    }

    pub fn create_job(&mut self, config: JobConfig) -> Job {
        no_money();
        self.only_owner();
        let mut config = config;
        assert!(
            !config.authorized_bidders.is_empty() && config.authorized_bidders.len() <= MAX_BIDDERS,
            "roster must contain 1..10 bidders"
        );
        config.authorized_bidders.sort();
        assert!(
            config.authorized_bidders.windows(2).all(|w| w[0] != w[1]),
            "duplicate bidder"
        );
        for hash in [
            &config.spec_hash,
            &config.circuit_hash,
            &config.key_hash,
            &config.output_policy_hash,
            &config.context_hash,
            &config.input_hash,
            &config.budget_commitment,
        ] {
            nonzero(hash);
        }
        let now = env::block_timestamp();
        assert!(
            now < config.bid_deadline_ns.0,
            "bid deadline must be future"
        );
        assert!(
            config.bid_deadline_ns.0 < config.result_deadline_ns.0,
            "deadlines must increase"
        );
        assert!(
            config
                .result_deadline_ns
                .0
                .checked_sub(now)
                .is_some_and(|d| d <= MAX_WINDOW_NS),
            "window exceeds 30 days"
        );
        let id = self.next_job_id;
        let next = id.checked_add(1).expect("job id exhausted");
        let binding = digest(&(
            "veil/job/v1".to_string(),
            env::current_account_id(),
            self.network_domain_hash,
            id,
            self.owner.clone(),
            config.clone(),
        ));
        let job = Job {
            job_id: U64(id),
            buyer: self.owner.clone(),
            bids: config
                .authorized_bidders
                .iter()
                .map(|bidder| BidEntry {
                    bidder: bidder.clone(),
                    commitment: None,
                })
                .collect(),
            config,
            job_binding_hash: binding,
            state: JobState::Open,
            bidset_root: None,
            closed_at_ns: None,
            attempt: U64(0),
            attempt_binding_hash: None,
            selected_executor: None,
            attempt_binding_version: None,
            receipts: vec![],
        };
        self.jobs.insert(id, job.clone());
        self.next_job_id = next;
        job
    }

    pub fn submit_bid(&mut self, job_id: U64, expected_job_binding_hash: Hash, commitment: Hash) {
        no_money();
        nonzero(&commitment);
        let caller = env::predecessor_account_id();
        let job = self.jobs.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(
            job.job_binding_hash, expected_job_binding_hash,
            "wrong job binding"
        );
        assert_eq!(job.state, JobState::Open, "bids are closed");
        assert!(
            env::block_timestamp() < job.config.bid_deadline_ns.0,
            "bid deadline passed"
        );
        let slot = job
            .bids
            .iter()
            .position(|b| b.bidder == caller)
            .expect("unauthorized bidder");
        assert!(job.bids[slot].commitment.is_none(), "bid already committed");
        assert!(
            job.bids.iter().all(|b| b.commitment != Some(commitment)),
            "duplicate commitment"
        );
        job.bids[slot].commitment = Some(commitment);
    }

    /// Anyone can trigger deterministic closure; nobody supplies the entries/root.
    pub fn close_bids(&mut self, job_id: U64) -> Hash {
        no_money();
        let job = self.jobs.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(job.state, JobState::Open, "already closed");
        assert!(
            env::block_timestamp() >= job.config.bid_deadline_ns.0,
            "cannot close before deadline"
        );
        let root = digest(&(
            "veil/bidset/v1".to_string(),
            job.job_binding_hash,
            job.bids.clone(),
        ));
        job.bidset_root = Some(root);
        job.closed_at_ns = Some(U64(env::block_timestamp()));
        job.state = JobState::Closed;
        root
    }

    /// Buyer explicitly authorizes each attempt; no concurrent or implicit retries.
    pub fn begin_attempt(&mut self, job_id: U64, expected_bidset_root: Hash) -> Hash {
        self.start_attempt(job_id, expected_bidset_root, None)
    }

    /// Buyer authorization of a roster selection, NOT verification of an MPC winner.
    /// Atomically select/start after closure; selection/mode cannot change on retry.
    pub fn begin_selected_attempt(
        &mut self,
        job_id: U64,
        expected_bidset_root: Hash,
        selected_executor: AccountId,
    ) -> Hash {
        self.start_attempt(job_id, expected_bidset_root, Some(selected_executor))
    }

    /// An authenticated executor claim, NOT attestation or a verified execution proof.
    pub fn report_result(&mut self, claim: ReceiptClaim) -> Hash {
        no_money();
        let job = self.jobs.get_mut(&claim.job_id.0).expect("unknown job");
        assert_eq!(
            &env::predecessor_account_id(),
            job.selected_executor
                .as_ref()
                .unwrap_or(&job.config.executor),
            "executor only"
        );
        self.record_result(claim)
    }
}

impl Registry {
    fn start_attempt(
        &mut self,
        job_id: U64,
        expected_bidset_root: Hash,
        selected: Option<AccountId>,
    ) -> Hash {
        no_money();
        self.only_owner();
        let job = self.jobs.get_mut(&job_id.0).expect("unknown job");
        assert!(
            matches!(job.state, JobState::Closed | JobState::Rejected),
            "wrong state for attempt"
        );
        assert!(
            env::block_timestamp() < job.config.result_deadline_ns.0,
            "result deadline passed"
        );
        assert_eq!(
            job.bidset_root,
            Some(expected_bidset_root),
            "wrong bidset root"
        );
        assert!(
            job.bids.iter().any(|b| b.commitment.is_some()),
            "empty bidset cannot execute"
        );
        assert!(job.attempt.0 < MAX_ATTEMPTS as u64, "attempt limit reached");
        if job.attempt.0 > 0 {
            assert_eq!(
                job.selected_executor, selected,
                "executor selection and binding mode are immutable"
            );
        }
        if let Some(executor) = &selected {
            assert!(
                job.bids
                    .iter()
                    .any(|b| &b.bidder == executor && b.commitment.is_some()),
                "selected executor must be a committed roster bidder"
            );
        }
        let attempt = job.attempt.0 + 1;
        let binding = if let Some(executor) = &selected {
            digest(&(
                "veil/attempt/v2".to_string(),
                job.job_binding_hash,
                expected_bidset_root,
                attempt,
                executor.clone(),
            ))
        } else {
            digest(&(
                "veil/attempt/v1".to_string(),
                job.job_binding_hash,
                expected_bidset_root,
                attempt,
            ))
        };
        job.attempt_binding_version = Some(if selected.is_some() { 2 } else { 1 });
        job.selected_executor = selected;
        job.attempt = U64(attempt);
        job.attempt_binding_hash = Some(binding);
        job.state = JobState::Executing;
        if let Some(executor) = &job.selected_executor {
            env::log_str(&format!(
                "EVENT_JSON:{}",
                near_sdk::serde_json::json!({
                    "standard":"veil_registry", "version":"1.0.0",
                    "event":"buyer_authorized_executor", "data":[{
                        "job_id":job.job_id, "buyer":job.buyer, "selected_executor":executor,
                        "attempt":job.attempt, "attempt_binding_version":2,
                        "attempt_binding_hash":binding, "mpc_proof_verified":false
                    }]
                })
            ));
        }
        binding
    }

    fn record_result(&mut self, claim: ReceiptClaim) -> Hash {
        let job = self.jobs.get_mut(&claim.job_id.0).expect("unknown job");
        assert_eq!(job.state, JobState::Executing, "wrong state for report");
        assert!(
            env::block_timestamp() < job.config.result_deadline_ns.0,
            "result deadline passed"
        );
        assert_eq!(claim.attempt, job.attempt, "wrong attempt");
        assert_eq!(
            claim.job_binding_hash, job.job_binding_hash,
            "wrong job binding"
        );
        assert_eq!(
            Some(claim.attempt_binding_hash),
            job.attempt_binding_hash,
            "wrong attempt binding"
        );
        assert_eq!(
            Some(claim.bidset_root),
            job.bidset_root,
            "wrong bidset root"
        );
        assert_eq!(claim.spec_hash, job.config.spec_hash, "wrong spec");
        assert_eq!(claim.circuit_hash, job.config.circuit_hash, "wrong circuit");
        assert_eq!(claim.key_hash, job.config.key_hash, "wrong key");
        assert_eq!(
            claim.output_policy_hash, job.config.output_policy_hash,
            "wrong output policy"
        );
        assert_eq!(claim.context_hash, job.config.context_hash, "wrong context");
        assert_eq!(claim.input_hash, job.config.input_hash, "wrong input");
        assert_eq!(
            claim.budget_commitment, job.config.budget_commitment,
            "wrong budget commitment"
        );
        nonzero(&claim.output_hash);
        let hash = digest(&("veil/receipt/v1".to_string(), claim.clone()));
        job.receipts.push(ReceiptRecord {
            claim,
            receipt_hash: hash,
            reported_at_ns: U64(env::block_timestamp()),
            status: ReceiptStatus::ExecutorReported,
            decided_at_ns: None,
        });
        job.state = JobState::Reported;
        hash
    }
}

#[near]
impl Registry {
    /// Buyer must select the exact current receipt hash; no automatic acceptance.
    pub fn decide_result(&mut self, job_id: U64, expected_receipt_hash: Hash, accept: bool) {
        no_money();
        self.only_owner();
        let job = self.jobs.get_mut(&job_id.0).expect("unknown job");
        assert_eq!(job.state, JobState::Reported, "wrong state for decision");
        let receipt = job.receipts.last_mut().expect("missing receipt");
        assert_eq!(
            receipt.receipt_hash, expected_receipt_hash,
            "wrong receipt hash"
        );
        receipt.status = if accept {
            ReceiptStatus::BuyerAccepted
        } else {
            ReceiptStatus::BuyerRejected
        };
        receipt.decided_at_ns = Some(U64(env::block_timestamp()));
        job.state = if accept {
            JobState::Accepted
        } else {
            JobState::Rejected
        };
    }

    /// On-time reports stay decidable by the buyer, including after the deadline.
    /// Unreported work (or rejected work without a retry) can be expired by anyone.
    pub fn expire_job(&mut self, job_id: U64) {
        no_money();
        let job = self.jobs.get_mut(&job_id.0).expect("unknown job");
        assert!(
            env::block_timestamp() >= job.config.result_deadline_ns.0,
            "result deadline not reached"
        );
        assert!(
            matches!(
                job.state,
                JobState::Open | JobState::Closed | JobState::Executing | JobState::Rejected
            ),
            "state cannot expire"
        );
        job.state = JobState::Expired;
    }
}

impl Registry {
    fn only_owner(&self) {
        // Predecessor, never signer: a forwarding contract cannot borrow buyer authority.
        assert_eq!(env::predecessor_account_id(), self.owner, "buyer only");
    }
}

#[cfg(test)]
mod tests;
