//! Exact wallet deposits, buyer-namespaced liabilities. No sponsor allocation,
//! admin withdrawal, automatic dispute ruling or on-chain SNARK verifier.
use near_sdk::json_types::{U64, U128};
use near_sdk::{AccountId, Gas, NearToken, PanicOnDefault, Promise, env, near, serde_json};
use near_sdk::store::LookupMap;

const DOMAIN: &str = "NOPE:WALLET-ESCROW:V2:testnet";
const ADMISSION_DOMAIN: &str = "NOPE:WALLET-ADMISSION:V1\0";
const MAX_HOLD: u128 = 10u128.pow(24);
// Every permanent record, including its largest later lifecycle state, is prepaid.
const STORAGE_BYTES_PER_HOLD: u64 = 4096;
const MAX_HORIZON_NS: u64 = 30 * 24 * 60 * 60 * 1_000_000_000;
const STORAGE_HEADROOM: u64 = 131072;
const GAS_BUFFER: u128 = 10u128.pow(23);
const CALLBACK_TGAS: u64 = 20;
const TRANSFER_TGAS: u64 = 100;

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Terms {
    pub job_id: String,
    pub buyer_commitment: String,
    pub buyer_account: AccountId,
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
pub enum State { Held, Delivered, PayoutPending, RefundPending, Paid, Refunded }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Action { Payout, Refund }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Delivery { pub version: u32, pub output_hash: String }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PendingTransfer { pub action: Action, pub previous_state: State }

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Hold {
    pub terms: Terms,
    pub binding_hash: String,
    pub storage_deposit_yocto: U128,
    pub state: State,
    pub nonce: U64,
    pub delivery: Option<Delivery>,
    pub last_transfer_failure_nonce: Option<U64>,
    pub pending: Option<PendingTransfer>,
}

#[near(serializers = [json])]
pub struct Config {
    pub admission_public_key: String,
    pub domain: String,
    pub network: String,
    pub contract_id: AccountId,
    pub storage_bytes_per_hold: U64,
    pub storage_deposit_yocto: U128,
    pub storage_deposits: U128,
    pub storage_deposit_refundable: bool,
    pub max_hold_amount: U128,
    pub min_hold_amount: U128,
    pub max_horizon_ns: U64,
    pub hold_count: U64,
    pub total_deposited: U128,
    pub liabilities: U128,
    pub total_paid: U128,
    pub total_refunded: U128,
    pub pending_outgoing: U128,
    pub on_account_liabilities: U128,
    pub account_balance: U128,
    pub storage_reserve: U128,
    pub gas_buffer: U128,
    pub storage_headroom_bytes: u64,
    pub min_transfer_gas_tgas: u64,
    pub callback_gas_tgas: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct WalletEscrow {
    admission_public_key: [u8; 32],
    holds: LookupMap<String, Hold>,
    hold_count: u64,
    initial_storage_usage: u64,
    storage_deposits: u128,
    total_deposited: u128,
    liabilities: u128,
    total_paid: u128,
    total_refunded: u128,
    pending_outgoing: u128,
}

fn hex(value: &str, len: usize) {
    assert!(value.len() == len && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "invalid lowercase hex");
}
fn decode_hex<const N: usize>(value: &str) -> [u8;N] {
    hex(value,N*2);
    let mut out=[0;N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte=u8::from_str_radix(&value[i*2..i*2+2],16).expect("hex byte");
    }
    out
}
fn encode_hex(value: &[u8]) -> String { value.iter().map(|b|format!("{b:02x}")).collect() }
fn account(value: &AccountId) {
    let s = value.as_str();
    assert!(s.ends_with(".testnet") || s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)), "testnet named or implicit account required");
    assert_ne!(value, &env::current_account_id(), "escrow cannot be a payment party");
}
fn key(buyer: &AccountId, job: &str) -> String {
    // AccountId never contains ':', so the namespace encoding is unambiguous.
    hex(job, 32);
    format!("{buyer}:{job}")
}
fn no_deposit() { assert_eq!(env::attached_deposit().as_yoctonear(), 0, "no attached deposit"); }
fn binding(t: &Terms) -> String {
    let bytes = serde_json::to_vec(&[DOMAIN.to_string(),env::current_account_id().to_string(),t.job_id.clone(),t.buyer_commitment.clone(),t.buyer_account.to_string(),t.provider.to_string(),t.amount.0.to_string(),t.input_hash.clone(),t.program_hash.clone(),t.plan_hash.clone(),t.execution_deadline_ns.0.to_string(),t.review_deadline_ns.0.to_string()]).unwrap();
    env::sha256(&bytes).iter().map(|b| format!("{b:02x}")).collect()
}

#[near]
impl WalletEscrow {
    #[init]
    pub fn new(admission_public_key: String) -> Self {
        no_deposit();
        assert_eq!(env::predecessor_account_id(), env::current_account_id(), "self initialization only");
        assert!(env::current_account_id().as_str().ends_with(".testnet"), "testnet deployment account required");
        let admission_public_key = decode_hex::<32>(&admission_public_key);
        assert_ne!(admission_public_key, [0;32], "nonzero admission public key required");
        let value = Self { admission_public_key,holds:LookupMap::new(b"h"),hold_count:0,initial_storage_usage:env::storage_usage(),storage_deposits:0,total_deposited:0,liabilities:0,total_paid:0,total_refunded:0,pending_outgoing:0 };
        value.solvent(0, 0);
        value
    }

    pub fn get_config(&self) -> Config {
        Config { admission_public_key:encode_hex(&self.admission_public_key),domain:DOMAIN.into(),network:"testnet".into(),contract_id:env::current_account_id(),storage_bytes_per_hold:U64(STORAGE_BYTES_PER_HOLD),storage_deposit_yocto:U128(Self::storage_deposit()),storage_deposits:U128(self.storage_deposits),storage_deposit_refundable:false,max_hold_amount:U128(MAX_HOLD),min_hold_amount:U128(1),max_horizon_ns:U64(MAX_HORIZON_NS),hold_count:U64(self.hold_count),total_deposited:U128(self.total_deposited),liabilities:U128(self.liabilities),total_paid:U128(self.total_paid),total_refunded:U128(self.total_refunded),pending_outgoing:U128(self.pending_outgoing),on_account_liabilities:U128(self.liabilities.checked_sub(self.pending_outgoing).expect("liability invariant")),account_balance:U128(env::account_balance().as_yoctonear()),storage_reserve:U128(self.storage_reserve(self.hold_count)),gas_buffer:U128(GAS_BUFFER),storage_headroom_bytes:STORAGE_HEADROOM,min_transfer_gas_tgas:TRANSFER_TGAS,callback_gas_tgas:CALLBACK_TGAS }
    }

    pub fn get_hold(&self, buyer_account: AccountId, job_id: String) -> Option<Hold> {
        self.holds.get(&key(&buyer_account,&job_id)).cloned()
    }

    #[payable]
    pub fn fund(&mut self, terms: Terms, admission_signature: String) -> Hold {
        account(&terms.buyer_account); account(&terms.provider);
        assert_eq!(env::predecessor_account_id(), terms.buyer_account, "buyer wallet must fund");
        hex(&terms.job_id,32);
        for h in [&terms.buyer_commitment,&terms.input_hash,&terms.program_hash,&terms.plan_hash] { hex(h,64); }
        let binding_hash = binding(&terms);
        let signature = decode_hex::<64>(&admission_signature);
        let message = format!("{ADMISSION_DOMAIN}{binding_hash}");
        assert!(env::ed25519_verify(&signature, message.as_bytes(), &self.admission_public_key), "application admission required");
        assert!(terms.amount.0 > 0 && terms.amount.0 <= MAX_HOLD, "amount outside pilot bounds");
        let storage_deposit=Self::storage_deposit();
        assert_eq!(env::attached_deposit().as_yoctonear(), terms.amount.0.checked_add(storage_deposit).expect("funding overflow"), "attach exact price plus nonrefundable storage deposit");
        let namespace = key(&terms.buyer_account,&terms.job_id);
        assert!(!self.holds.contains_key(&namespace), "job already funded in buyer namespace");
        let hold_count=self.hold_count.checked_add(1).expect("hold counter overflow");
        let now = env::block_timestamp();
        assert!(now < terms.execution_deadline_ns.0 && terms.execution_deadline_ns.0 < terms.review_deadline_ns.0, "invalid deadlines");
        assert!(terms.review_deadline_ns.0.checked_sub(now).expect("deadline underflow") <= MAX_HORIZON_NS, "deadline exceeds 30 days");
        let liabilities = self.liabilities.checked_add(terms.amount.0).expect("liability overflow");
        let deposited = self.total_deposited.checked_add(terms.amount.0).expect("deposit overflow");
        let storage_deposits=self.storage_deposits.checked_add(storage_deposit).expect("storage deposit overflow");
        self.solvent_for_count(liabilities,self.pending_outgoing,hold_count);
        let hold = Hold { binding_hash,storage_deposit_yocto:U128(storage_deposit),terms,state:State::Held,nonce:U64(0),delivery:None,last_transfer_failure_nonce:None,pending:None };
        self.liabilities=liabilities; self.total_deposited=deposited;
        self.hold_count=hold_count; self.storage_deposits=storage_deposits;
        self.holds.insert(namespace,hold.clone());
        self.holds.flush();
        self.solvent(self.liabilities,self.pending_outgoing);
        self.accounting(); hold
    }

    pub fn record_delivery(&mut self, buyer_account: AccountId, job_id: String, version: u32, output_hash: String) -> Hold {
        no_deposit(); hex(&output_hash,64); assert!(version>0,"version starts at one");
        let mut hold=self.bound(&buyer_account,&job_id);
        let caller=env::predecessor_account_id();
        assert!(caller==hold.terms.provider || caller==hold.terms.buyer_account,"buyer or selected provider only");
        assert!(matches!(hold.state,State::Held|State::Delivered),"not open for delivery");
        assert!(env::block_timestamp()<=hold.terms.execution_deadline_ns.0,"execution deadline passed");
        let delivery=Delivery{version,output_hash};
        if hold.delivery.as_ref()==Some(&delivery) { return hold; }
        assert_eq!(version,hold.delivery.as_ref().map_or(Some(1),|d|d.version.checked_add(1)).expect("version exhausted"),"strict next version required");
        hold.delivery=Some(delivery); hold.state=State::Delivered;
        self.holds.insert(key(&buyer_account,&job_id),hold.clone()); hold
    }

    pub fn accept_and_release(&mut self, buyer_account: AccountId, job_id: String, version: u32, output_hash: String) -> Promise {
        no_deposit(); hex(&output_hash,64);
        let hold=self.bound(&buyer_account,&job_id); Self::buyer(&hold);
        assert_eq!(hold.state,State::Delivered,"latest delivered state required");
        assert!(env::block_timestamp()<=hold.terms.review_deadline_ns.0,"review deadline passed");
        assert_eq!(hold.delivery,Some(Delivery{version,output_hash}),"latest delivery mismatch");
        self.transfer(hold,Action::Payout)
    }

    pub fn refund(&mut self, buyer_account: AccountId, job_id: String) -> Promise {
        no_deposit(); let hold=self.bound(&buyer_account,&job_id); Self::buyer(&hold);
        assert!(matches!(hold.state,State::Held|State::Delivered),"only nonterminal nonpending hold refundable");
        assert!(env::block_timestamp()>hold.terms.review_deadline_ns.0,"review deadline not passed");
        self.transfer(hold,Action::Refund)
    }

    #[private]
    pub fn on_transfer(&mut self, buyer_account: AccountId, job_id: String, nonce: U64, action: Action) -> bool {
        no_deposit(); assert_eq!(env::predecessor_account_id(),env::current_account_id(),"self callback only");
        assert_eq!(env::promise_results_count(),1,"exactly one promise result required");
        let mut hold=self.bound(&buyer_account,&job_id);
        let pending=hold.pending.clone().expect("not transfer pending");
        assert_eq!(hold.nonce,nonce,"stale callback nonce"); assert_eq!(pending.action,action,"callback action mismatch");
        assert_eq!(hold.state,if action==Action::Payout{State::PayoutPending}else{State::RefundPending},"callback state mismatch");
        let amount=hold.terms.amount.0;
        match env::promise_result_checked(0,64) {
            Ok(bytes) if bytes.is_empty()=>{
                let liabilities=self.liabilities.checked_sub(amount).expect("liability underflow");
                let outgoing=self.pending_outgoing.checked_sub(amount).expect("pending underflow");
                match action {
                    Action::Payout=>{self.total_paid=self.total_paid.checked_add(amount).expect("paid overflow");hold.state=State::Paid;},
                    Action::Refund=>{self.total_refunded=self.total_refunded.checked_add(amount).expect("refund overflow");hold.state=State::Refunded;},
                }
                self.liabilities=liabilities; self.pending_outgoing=outgoing;
            },
            Err(near_sdk::PromiseError::Failed)=>{
                self.pending_outgoing=self.pending_outgoing.checked_sub(amount).expect("pending underflow");
                hold.state=pending.previous_state; hold.last_transfer_failure_nonce=Some(nonce);
                // A failed native transfer's refund receipt can arrive later.
                // Restore the logical liability now; subsequent spending still
                // requires the actual-balance solvency guard to pass.
            },
            _=>return false, // uncertain result stays pending, never authorizes resend
        }
        let success=matches!(hold.state,State::Paid|State::Refunded);
        hold.pending=None; self.holds.insert(key(&buyer_account,&job_id),hold);
        self.accounting(); success
    }
}

impl WalletEscrow {
    fn bound(&self,buyer:&AccountId,job:&str)->Hold {
        let hold=self.holds.get(&key(buyer,job)).expect("unknown buyer/job");
        assert_eq!(&hold.terms.buyer_account,buyer,"buyer namespace mismatch"); hold.clone()
    }
    fn buyer(hold:&Hold) { assert_eq!(env::predecessor_account_id(),hold.terms.buyer_account,"buyer wallet only"); }
    fn storage_deposit()->u128 {
        u128::from(STORAGE_BYTES_PER_HOLD).checked_mul(env::storage_byte_cost().as_yoctonear()).expect("storage cost overflow")
    }
    fn storage_reserve(&self,count:u64)->u128 {
        let bytes=self.initial_storage_usage.checked_add(STORAGE_HEADROOM).and_then(|n|count.checked_mul(STORAGE_BYTES_PER_HOLD).and_then(|v|n.checked_add(v))).expect("storage overflow");
        assert!(env::storage_usage()<=bytes,"prepaid storage bound exceeded");
        u128::from(bytes).checked_mul(env::storage_byte_cost().as_yoctonear()).expect("storage cost overflow")
    }
    fn solvent_for_count(&self,liabilities:u128,pending:u128,count:u64) {
        let required=liabilities.checked_sub(pending).expect("pending exceeds liabilities").checked_add(self.storage_reserve(count)).and_then(|v|v.checked_add(GAS_BUFFER)).expect("balance overflow");
        assert!(env::account_balance().as_yoctonear()>=required,"preserve payment liabilities, prepaid storage and gas buffer");
    }
    fn solvent(&self,liabilities:u128,pending:u128) { self.solvent_for_count(liabilities,pending,self.hold_count); }
    fn accounting(&self) {
        assert_eq!(self.total_deposited,self.liabilities.checked_add(self.total_paid).and_then(|v|v.checked_add(self.total_refunded)).expect("accounting overflow"),"deposit accounting invariant");
        assert!(self.pending_outgoing<=self.liabilities,"pending liability invariant");
    }
    fn transfer(&mut self,mut hold:Hold,action:Action)->Promise {
        assert!(env::prepaid_gas().as_gas()>=Gas::from_tgas(TRANSFER_TGAS).as_gas(),"attach at least 100 Tgas");
        assert!(hold.pending.is_none(),"transfer already pending"); self.solvent(self.liabilities,self.pending_outgoing);
        let previous_state=hold.state.clone();
        hold.nonce=U64(hold.nonce.0.checked_add(1).expect("nonce exhausted"));
        hold.state=if action==Action::Payout{State::PayoutPending}else{State::RefundPending};
        hold.pending=Some(PendingTransfer{action:action.clone(),previous_state});
        let outgoing=self.pending_outgoing.checked_add(hold.terms.amount.0).expect("pending overflow");
        assert!(outgoing<=self.liabilities,"pending exceeds liabilities");
        let receiver=if action==Action::Payout{hold.terms.provider.clone()}else{hold.terms.buyer_account.clone()};
        let args=serde_json::to_vec(&serde_json::json!({"buyer_account":hold.terms.buyer_account,"job_id":hold.terms.job_id,"nonce":hold.nonce,"action":action})).unwrap();
        self.pending_outgoing=outgoing;
        self.holds.insert(key(&hold.terms.buyer_account,&hold.terms.job_id),hold.clone()); self.accounting();
        Promise::new(receiver).transfer(NearToken::from_yoctonear(hold.terms.amount.0)).then(
            Promise::new(env::current_account_id()).function_call("on_transfer",args,NearToken::from_yoctonear(0),Gas::from_tgas(CALLBACK_TGAS)))
    }
}

#[cfg(test)]
mod tests;
