use super::*;
use ed25519_dalek::{Signer,SigningKey};
fn admission_key()->SigningKey{SigningKey::from_bytes(&[7;32])}
fn admit(t:&Terms)->String{encode_hex(&admission_key().sign(format!("{ADMISSION_DOMAIN}{}",binding(t)).as_bytes()).to_bytes())}
fn admitted(e:&mut WalletEscrow,t:Terms)->Hold{let signature=admit(&t);e.fund(t,signature)}
use near_sdk::{PromiseResult, test_utils::{VMContextBuilder,get_created_receipts},testing_env};
use std::panic::{catch_unwind,AssertUnwindSafe};
const CONTRACT:&str="wallet-escrow.testnet";
const BUYER:&str="buyer.testnet";
const OTHER:&str="other.testnet";
const PROVIDER:&str="provider.testnet";
const NOW:u64=1_000_000_000;
const AMOUNT:u128=10u128.pow(21);
fn context(caller:&str,time:u64,balance:u128,deposit:u128,gas:u64,results:Vec<PromiseResult>){
 let mut b=VMContextBuilder::new();
 b.current_account_id(CONTRACT.parse().unwrap()).predecessor_account_id(caller.parse().unwrap()).signer_account_id(caller.parse().unwrap()).account_balance(NearToken::from_yoctonear(balance)).attached_deposit(NearToken::from_yoctonear(deposit)).storage_usage(1024).block_timestamp(time).prepaid_gas(Gas::from_tgas(gas));
 testing_env!(b.build(),near_sdk::test_vm_config(),near_sdk::RuntimeFeesConfig::test(),Default::default(),results);
}
fn ctx(caller:&str,time:u64,deposit:u128){context(caller,time,10u128.pow(25),deposit,300,vec![]);}
fn terms(buyer:&str,id:u128)->Terms{Terms{job_id:format!("{id:032x}"),buyer_commitment:"11".repeat(32),buyer_account:buyer.parse().unwrap(),provider:PROVIDER.parse().unwrap(),amount:U128(AMOUNT),input_hash:"22".repeat(32),program_hash:"33".repeat(32),plan_hash:"44".repeat(32),execution_deadline_ns:U64(NOW+100),review_deadline_ns:U64(NOW+200)}}
fn init()->WalletEscrow{ctx(CONTRACT,NOW,0);WalletEscrow::new(encode_hex(admission_key().verifying_key().as_bytes()))}
fn fund(e:&mut WalletEscrow,buyer:&str,id:u128)->Hold{ctx(buyer,NOW,AMOUNT+WalletEscrow::storage_deposit());admitted(e,terms(buyer,id))}
fn delivered(e:&mut WalletEscrow,buyer:&str,id:u128)->Hold{ctx(PROVIDER,NOW,0);e.record_delivery(buyer.parse().unwrap(),format!("{id:032x}"),1,"55".repeat(32))}
fn release(e:&mut WalletEscrow,buyer:&str,id:u128){ctx(buyer,NOW,0);drop(e.accept_and_release(buyer.parse().unwrap(),format!("{id:032x}"),1,"55".repeat(32)));}
fn callback(e:&mut WalletEscrow,buyer:&str,id:u128,nonce:u64,action:Action,result:PromiseResult)->bool{context(CONTRACT,NOW,10u128.pow(25),0,20,vec![result]);e.on_transfer(buyer.parse().unwrap(),format!("{id:032x}"),U64(nonce),action)}
fn reject(f:impl FnOnce()){assert!(catch_unwind(AssertUnwindSafe(f)).is_err());}
fn invariants(e:&WalletEscrow){
 let holds:Vec<Hold>=[BUYER,OTHER].into_iter().flat_map(|buyer|(1..=2).filter_map(move |id|e.get_hold(buyer.parse().unwrap(),format!("{id:032x}")))).collect();
 let liability:u128=holds.iter().filter(|h|!matches!(h.state,State::Paid|State::Refunded)).map(|h|h.terms.amount.0).sum();
 let pending:u128=holds.iter().filter(|h|h.pending.is_some()).map(|h|h.terms.amount.0).sum();
 let paid:u128=holds.iter().filter(|h|h.state==State::Paid).map(|h|h.terms.amount.0).sum();
 let refunded:u128=holds.iter().filter(|h|h.state==State::Refunded).map(|h|h.terms.amount.0).sum();
 assert_eq!(e.liabilities,liability);assert_eq!(e.pending_outgoing,pending);assert_eq!(e.total_paid,paid);assert_eq!(e.total_refunded,refunded);
 assert_eq!(e.total_deposited,liability+paid+refunded);assert!(pending<=liability);
}

#[test]fn funding_is_exact_wallet_deposit_not_sponsor_credit(){
 let mut e=init();assert_eq!(e.total_deposited,0);assert_eq!(e.liabilities,0);
 ctx(OTHER,NOW,AMOUNT+WalletEscrow::storage_deposit());reject(||{admitted(&mut e,terms(BUYER,1));});
 for n in [0,AMOUNT,AMOUNT+WalletEscrow::storage_deposit()-1,AMOUNT+WalletEscrow::storage_deposit()+1]{ctx(BUYER,NOW,n);reject(||{admitted(&mut e,terms(BUYER,1));});}
 let h=fund(&mut e,BUYER,1);assert_eq!(h.state,State::Held);assert_eq!(e.total_deposited,AMOUNT);assert_eq!(e.liabilities,AMOUNT);
 ctx(BUYER,NOW,AMOUNT+WalletEscrow::storage_deposit());reject(||{admitted(&mut e,terms(BUYER,1));});invariants(&e);
}

#[test]fn public_job_preemption_isolated_by_buyer_namespace(){
 let mut e=init();let attacker=fund(&mut e,OTHER,1);let legitimate=fund(&mut e,BUYER,1);
 assert_ne!(attacker.binding_hash,legitimate.binding_hash);assert_eq!(e.hold_count,2);
 assert_eq!(e.get_hold(BUYER.parse().unwrap(),legitimate.terms.job_id.clone()).unwrap(),legitimate);
 ctx(OTHER,NOW+201,0);reject(||{drop(e.refund(BUYER.parse().unwrap(),legitimate.terms.job_id.clone()));});
 assert_eq!(e.liabilities,2*AMOUNT);invariants(&e);
}

#[test]fn binding_tuple_exact_order_and_wallet_identity(){
 let mut e=init();let h=fund(&mut e,BUYER,1);let t=&h.terms;
 let tuple=serde_json::json!([DOMAIN,CONTRACT,t.job_id,t.buyer_commitment,BUYER,PROVIDER,AMOUNT.to_string(),t.input_hash,t.program_hash,t.plan_hash,(NOW+100).to_string(),(NOW+200).to_string()]);
 let expected:String=env::sha256(serde_json::to_string(&tuple).unwrap().as_bytes()).iter().map(|b|format!("{b:02x}")).collect();assert_eq!(expected,h.binding_hash);
 let mut changed=t.clone();changed.buyer_account=OTHER.parse().unwrap();assert_ne!(binding(&changed),expected);
}

#[test]fn terms_limits_hashes_and_deadlines_fail_closed(){
 let mut e=init();let cases:Vec<Box<dyn Fn(&mut Terms)>>=vec![Box::new(|t|t.amount=U128(0)),Box::new(|t|t.amount=U128(MAX_HOLD+1)),Box::new(|t|t.job_id="A".repeat(32)),Box::new(|t|t.input_hash="0".repeat(63)),Box::new(|t|t.buyer_commitment="g".repeat(64)),Box::new(|t|t.execution_deadline_ns=U64(NOW)),Box::new(|t|t.review_deadline_ns=t.execution_deadline_ns),Box::new(|t|t.review_deadline_ns=U64(NOW+MAX_HORIZON_NS+1)),Box::new(|t|t.provider="provider.near".parse().unwrap()),Box::new(|t|t.provider=CONTRACT.parse().unwrap())];
 for change in cases{let mut t=terms(BUYER,1);change(&mut t);ctx(BUYER,NOW,t.amount.0+WalletEscrow::storage_deposit());reject(||{admitted(&mut e,t);});assert!(e.hold_count==0);}
 invariants(&e);
}

#[test]fn customer_deposit_cannot_pay_storage_or_cover_another_hold(){
 let mut e=init();let reserve=e.storage_reserve(e.hold_count)+GAS_BUFFER;
 context(BUYER,NOW,reserve-1,AMOUNT+WalletEscrow::storage_deposit(),300,vec![]);
 // VM account_balance includes the attached deposit: it still cannot cover
 // both the separately required buffer and the new full payment liability.
 assert!(env::account_balance().as_yoctonear() < reserve+AMOUNT+WalletEscrow::storage_deposit());
 reject(||{admitted(&mut e,terms(BUYER,1));});assert_eq!(e.liabilities,0);
 fund(&mut e,BUYER,1);fund(&mut e,OTHER,2);delivered(&mut e,BUYER,1);
 context(BUYER,NOW,reserve+AMOUNT,0,300,vec![]);
 reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),format!("{:032x}",1),1,"55".repeat(32)));});
 assert_eq!(e.pending_outgoing,0);invariants(&e);
}

#[test]fn delivery_auth_strict_versions_and_exact_acceptance(){
 let mut e=init();let h=fund(&mut e,BUYER,1);
 ctx(OTHER,NOW,0);reject(||{e.record_delivery(BUYER.parse().unwrap(),h.terms.job_id.clone(),1,"55".repeat(32));});
 let d=delivered(&mut e,BUYER,1);assert_eq!(delivered(&mut e,BUYER,1),d);
 ctx(BUYER,NOW,0);e.record_delivery(BUYER.parse().unwrap(),h.terms.job_id.clone(),2,"66".repeat(32));
 reject(||{e.record_delivery(BUYER.parse().unwrap(),h.terms.job_id.clone(),4,"77".repeat(32));});
 ctx(PROVIDER,NOW,0);reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),h.terms.job_id.clone(),2,"66".repeat(32)));});
 ctx(BUYER,NOW,0);reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),h.terms.job_id.clone(),1,"55".repeat(32)));});
 reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),h.terms.job_id.clone(),2,"77".repeat(32)));});invariants(&e);
}

#[test]fn payout_freezes_job_and_terminal_callback_is_exactly_once(){
 let mut e=init();fund(&mut e,BUYER,1);fund(&mut e,OTHER,2);delivered(&mut e,BUYER,1);release(&mut e,BUYER,1);
 assert_eq!(e.pending_outgoing,AMOUNT);assert_eq!(e.liabilities,2*AMOUNT);
 let r=get_created_receipts();assert_eq!(r.len(),2);assert_eq!(r[0].receiver_id,PROVIDER.parse::<AccountId>().unwrap());assert_eq!(r[1].receiver_id,CONTRACT.parse::<AccountId>().unwrap());
 assert!(matches!(&r[0].actions[0],near_sdk::mock::MockAction::Transfer{deposit,..} if deposit.as_yoctonear()==AMOUNT));
 ctx(BUYER,NOW+201,0);reject(||{drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));});
 ctx(BUYER,NOW,0);reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),format!("{:032x}",1),1,"55".repeat(32)));});
 assert!(callback(&mut e,BUYER,1,1,Action::Payout,PromiseResult::Successful(vec![])));
 assert_eq!(e.liabilities,AMOUNT);assert_eq!(e.total_paid,AMOUNT);assert_eq!(e.pending_outgoing,0);
 reject(||{callback(&mut e,BUYER,1,1,Action::Payout,PromiseResult::Successful(vec![]));});
 ctx(BUYER,NOW+201,0);reject(||{drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));});invariants(&e);
}

#[test]fn failed_payout_restores_delivered_without_spending_other_job(){
 let mut e=init();fund(&mut e,BUYER,1);fund(&mut e,OTHER,2);delivered(&mut e,BUYER,1);release(&mut e,BUYER,1);
 assert!(!callback(&mut e,BUYER,1,1,Action::Payout,PromiseResult::Failed));assert_eq!(e.liabilities,2*AMOUNT);assert_eq!(e.total_paid,0);
 assert_eq!(e.get_hold(BUYER.parse().unwrap(),format!("{:032x}",1)).unwrap().state,State::Delivered);
 release(&mut e,BUYER,1);
 reject(||{callback(&mut e,BUYER,1,1,Action::Payout,PromiseResult::Successful(vec![]));});
 assert!(callback(&mut e,BUYER,1,2,Action::Payout,PromiseResult::Successful(vec![])));assert_eq!(e.liabilities,AMOUNT);invariants(&e);
}

#[test]fn refund_transfer_failure_then_success_preserves_all_liabilities(){
 let mut e=init();fund(&mut e,BUYER,1);fund(&mut e,OTHER,2);
 ctx(BUYER,NOW+200,0);reject(||{drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));});
 ctx(OTHER,NOW+201,0);reject(||{drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));});
 ctx(BUYER,NOW+201,0);drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));
 let receipts=get_created_receipts();assert_eq!(receipts[0].receiver_id,BUYER.parse::<AccountId>().unwrap());assert!(matches!(&receipts[0].actions[0],near_sdk::mock::MockAction::Transfer{deposit,..} if deposit.as_yoctonear()==AMOUNT));
 assert_eq!(e.liabilities,2*AMOUNT);assert_eq!(e.total_refunded,0);
 assert!(!callback(&mut e,BUYER,1,1,Action::Refund,PromiseResult::Failed));
 assert_eq!(e.get_hold(BUYER.parse().unwrap(),format!("{:032x}",1)).unwrap().state,State::Held);
 ctx(BUYER,NOW+201,0);drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));
 reject(||{callback(&mut e,BUYER,1,2,Action::Payout,PromiseResult::Successful(vec![]));});
 assert!(callback(&mut e,BUYER,1,2,Action::Refund,PromiseResult::Successful(vec![])));
 assert_eq!(e.total_refunded,AMOUNT);assert_eq!(e.liabilities,AMOUNT);invariants(&e);
}

#[test]fn refund_failure_restores_delivered_and_allows_only_fresh_nonce(){
 let mut e=init();fund(&mut e,BUYER,1);delivered(&mut e,BUYER,1);
 ctx(BUYER,NOW+201,0);drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));
 assert!(!callback(&mut e,BUYER,1,1,Action::Refund,PromiseResult::Failed));
 let hold=e.get_hold(BUYER.parse().unwrap(),format!("{:032x}",1)).unwrap();assert_eq!(hold.state,State::Delivered);assert_eq!(hold.last_transfer_failure_nonce,Some(U64(1)));invariants(&e);
}

#[test]fn callback_private_nonce_action_and_uncertain_result_guards(){
 let mut e=init();fund(&mut e,BUYER,1);delivered(&mut e,BUYER,1);release(&mut e,BUYER,1);
 context(OTHER,NOW,10u128.pow(25),0,20,vec![PromiseResult::Successful(vec![])]);
 reject(||{e.on_transfer(BUYER.parse().unwrap(),format!("{:032x}",1),U64(1),Action::Payout);});
 reject(||{callback(&mut e,BUYER,1,0,Action::Payout,PromiseResult::Successful(vec![]));});
 reject(||{callback(&mut e,BUYER,1,1,Action::Refund,PromiseResult::Successful(vec![]));});
 assert!(!callback(&mut e,BUYER,1,1,Action::Payout,PromiseResult::Successful(vec![1])));
 assert_eq!(e.pending_outgoing,AMOUNT);assert_eq!(e.liabilities,AMOUNT);assert_eq!(e.total_paid,0);invariants(&e);
}

#[test]fn checked_nonce_exhaustion_and_gas_reject_before_new_pending(){
 let mut e=init();fund(&mut e,BUYER,1);delivered(&mut e,BUYER,1);
 context(BUYER,NOW,10u128.pow(25),0,99,vec![]);reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),format!("{:032x}",1),1,"55".repeat(32)));});
 e.holds.get_mut(&key(&BUYER.parse().unwrap(),&format!("{:032x}",1))).unwrap().nonce=U64(u64::MAX);
 ctx(BUYER,NOW,0);reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),format!("{:032x}",1),1,"55".repeat(32)));});assert_eq!(e.pending_outgoing,0);invariants(&e);
}

#[test]fn prepaid_records_have_no_shared_permanent_capacity(){
 let mut e=init();let state_bytes=near_sdk::borsh::to_vec(&e).unwrap().len();
 for id in 1..=128 {
  let buyer=format!("buyer-{id:04}.testnet");fund(&mut e,&buyer,id);
  assert_eq!(near_sdk::borsh::to_vec(&e).unwrap().len(),state_bytes,"global serialized state must remain constant");
 }
 assert_eq!(e.hold_count,128);assert_eq!(e.storage_deposits,128*WalletEscrow::storage_deposit());
 for id in 1..=128 {
  let buyer=format!("buyer-{id:04}.testnet");ctx(&buyer,NOW+201,0);drop(e.refund(buyer.parse().unwrap(),format!("{id:032x}")));
  assert!(callback(&mut e,&buyer,id,1,Action::Refund,PromiseResult::Successful(vec![])));
 }
 fund(&mut e,BUYER,129);assert_eq!(e.hold_count,129);assert_eq!(e.liabilities,AMOUNT);assert_eq!(e.total_refunded,128*AMOUNT);
 assert_eq!(e.storage_deposits,129*WalletEscrow::storage_deposit());
 ctx(PROVIDER,NOW+101,0);reject(||{e.record_delivery(BUYER.parse().unwrap(),format!("{:032x}",129),1,"55".repeat(32));});
}

#[test]fn largest_borsh_record_and_storage_key_fit_full_lifecycle_reservation(){
 let mut e=init();let buyer=format!("{}.testnet","b".repeat(56));let provider=format!("{}.testnet","p".repeat(56));
 let mut t=terms(&buyer,u128::MAX);t.provider=provider.parse().unwrap();t.amount=U128(MAX_HOLD);t.execution_deadline_ns=U64(u64::MAX-1);t.review_deadline_ns=U64(u64::MAX);
 let h=Hold{storage_deposit_yocto:U128(WalletEscrow::storage_deposit()),terms:t,binding_hash:"ff".repeat(32),state:State::PayoutPending,nonce:U64(u64::MAX),delivery:Some(Delivery{version:u32::MAX,output_hash:"ff".repeat(32)}),last_transfer_failure_nonce:Some(U64(u64::MAX)),pending:Some(PendingTransfer{action:Action::Payout,previous_state:State::Delivered})};
 let namespace=key(&h.terms.buyer_account,&h.terms.job_id);
 let serialized=near_sdk::borsh::to_vec(&h).unwrap().len();let key_bytes=1+near_sdk::borsh::to_vec(&namespace).unwrap().len();
 // NEAR runtime adds 40 bytes per trie record to the stored key/value bytes.
 assert_eq!(serialized,654);assert_eq!(key_bytes,102);assert!(serialized+key_bytes+40<=STORAGE_BYTES_PER_HOLD as usize);
 let before=env::storage_usage();e.holds.insert(namespace.clone(),h.clone());e.holds.flush();let used=env::storage_usage()-before;
 assert_eq!(used as usize,serialized+key_bytes+40);assert!(used<=STORAGE_BYTES_PER_HOLD);
 println!("MAX_RECORD serialized_hold={serialized} storage_key={key_bytes} runtime_overhead=40 actual_storage_delta={used} reserved={STORAGE_BYTES_PER_HOLD}");
 // A new maximum-size hold must prepay ALL future growth; no growth beyond this state.
 let mut initial=h.clone();initial.state=State::Held;initial.nonce=U64(0);initial.delivery=None;initial.last_transfer_failure_nonce=None;initial.pending=None;
 assert!(near_sdk::borsh::to_vec(&initial).unwrap().len()<serialized);
}

#[test]fn admission_rejects_unsigned_wrong_key_and_changed_terms_before_capacity(){
 let mut e=init();let original=terms(BUYER,100);let signature=admit(&original);
 ctx(BUYER,NOW,AMOUNT+WalletEscrow::storage_deposit());
 for sig in [String::new(),"00".repeat(64),encode_hex(&SigningKey::from_bytes(&[8;32]).sign(format!("{ADMISSION_DOMAIN}{}",binding(&original)).as_bytes()).to_bytes())]{
  reject(||{e.fund(original.clone(),sig);});assert!(e.hold_count==0);
 }
 let cases:Vec<Box<dyn Fn(&mut Terms)>>=vec![Box::new(|t|t.job_id="ff".repeat(16)),Box::new(|t|t.buyer_account=OTHER.parse().unwrap()),Box::new(|t|t.provider=OTHER.parse().unwrap()),Box::new(|t|t.amount=U128(AMOUNT+1)),Box::new(|t|t.buyer_commitment="66".repeat(32)),Box::new(|t|t.input_hash="77".repeat(32)),Box::new(|t|t.program_hash="88".repeat(32)),Box::new(|t|t.plan_hash="99".repeat(32)),Box::new(|t|t.execution_deadline_ns=U64(NOW+101)),Box::new(|t|t.review_deadline_ns=U64(NOW+201))];
 for change in cases{let mut t=original.clone();change(&mut t);ctx(t.buyer_account.as_str(),NOW,t.amount.0+WalletEscrow::storage_deposit());reject(||{e.fund(t,signature.clone());});assert!(e.hold_count==0);}
 // Same terms in a different contract produce another binding and cannot reuse admission.
 ctx(BUYER,NOW,AMOUNT+WalletEscrow::storage_deposit());let mut b=VMContextBuilder::new();b.current_account_id("foreign-escrow.testnet".parse().unwrap()).predecessor_account_id(BUYER.parse().unwrap()).account_balance(NearToken::from_near(10)).attached_deposit(NearToken::from_yoctonear(AMOUNT)).block_timestamp(NOW);testing_env!(b.build());
 reject(||{e.fund(original,signature);});assert!(e.hold_count==0);
}
#[test]fn admitted_funding_replay_and_admission_key_has_no_payment_authority(){
 let mut e=init();let t=terms(BUYER,1);let sig=admit(&t);ctx(BUYER,NOW,AMOUNT+WalletEscrow::storage_deposit());e.fund(t.clone(),sig.clone());
 reject(||{e.fund(t,sig);});assert_eq!(e.hold_count,1);delivered(&mut e,BUYER,1);
 ctx("admission-signer.testnet",NOW,0);reject(||{drop(e.accept_and_release(BUYER.parse().unwrap(),format!("{:032x}",1),1,"55".repeat(32)));});
 ctx("admission-signer.testnet",NOW+201,0);reject(||{drop(e.refund(BUYER.parse().unwrap(),format!("{:032x}",1)));});invariants(&e);
}
#[test]fn initialization_requires_explicit_nonzero_admission_key(){
 ctx(CONTRACT,NOW,0);for value in ["".to_string(),"00".repeat(32),"gg".repeat(32)]{reject(||{WalletEscrow::new(value);});}
}

#[test]fn four_thousand_distinct_wallets_pay_own_storage_without_global_state_growth(){
 let mut e=init();let bytes=near_sdk::borsh::to_vec(&e).unwrap().len();
 for id in 1..=4001u128 {
  let buyer=format!("scale-{id:04}.testnet");let t=terms(&buyer,id);
  let balance=10u128.pow(25)+id*(AMOUNT+WalletEscrow::storage_deposit());
  context(&buyer,NOW,balance,AMOUNT+WalletEscrow::storage_deposit(),300,vec![]);admitted(&mut e,t);
 }
 assert_eq!(e.hold_count,4001);assert_eq!(near_sdk::borsh::to_vec(&e).unwrap().len(),bytes);
 assert_eq!(e.storage_deposits,4001*WalletEscrow::storage_deposit());assert_eq!(e.liabilities,4001*AMOUNT);
 let cfg=e.get_config();assert_eq!(cfg.hold_count.0,4001);assert_eq!(cfg.storage_deposit_refundable,false);
 e.solvent(e.liabilities,0);
}
