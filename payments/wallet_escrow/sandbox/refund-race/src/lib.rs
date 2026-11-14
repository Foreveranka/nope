//! Local sandbox fixture ONLY. It deletes itself while an authorized refund is
//! in flight, forcing the real native-transfer failure callback.
use near_sdk::{near,env,AccountId,Promise,NearToken,Gas,serde_json::{self,Value,json}};
#[near(contract_state)]
#[derive(Default)]
pub struct ClosingBuyer {}
#[near]
impl ClosingBuyer {
 #[init] pub fn new()->Self{Self{}}
 pub fn fund_job(&self,escrow:AccountId,terms:Value,admission_signature:String)->Promise{
  assert_eq!(env::predecessor_account_id(),env::current_account_id());
  Promise::new(escrow).function_call("fund",serde_json::to_vec(&json!({"terms":terms,"admission_signature":admission_signature})).unwrap(),NearToken::from_yoctonear(100_000_000_000_000_000_000_000+40_960_000_000_000_000_000_000),Gas::from_tgas(50))
 }
 pub fn refund_and_delete(&self,escrow:AccountId,job_id:String,beneficiary:AccountId)->Promise{
  assert_eq!(env::predecessor_account_id(),env::current_account_id());
  let refund=Promise::new(escrow).function_call("refund",serde_json::to_vec(&json!({"buyer_account":env::current_account_id(),"job_id":job_id})).unwrap(),NearToken::from_yoctonear(0),Gas::from_tgas(150));
  // Independent sibling receipt, not .then(refund). The account is deleted
  // before the refund's subsequently-created Transfer can be delivered.
  drop(Promise::new(env::current_account_id()).delete_account(beneficiary));
  refund
 }
}
