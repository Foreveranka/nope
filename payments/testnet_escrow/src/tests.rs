use super::*;
use near_sdk::{PromiseResult, test_utils::VMContextBuilder, testing_env};
use std::panic::{AssertUnwindSafe, catch_unwind};

fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn context(caller: &str, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("escrow.testnet"))
        .predecessor_account_id(id(caller))
        .signer_account_id(id("buyer.testnet"))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(b.build());
}
fn callback(result: PromiseResult) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(id("escrow.testnet"))
        .predecessor_account_id(id("escrow.testnet"))
        .prepaid_gas(Gas::from_tgas(300));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}
fn terms() -> Terms {
    Terms {
        job_id: U64(1),
        buyer: id("buyer.testnet"),
        provider: id("provider.testnet"),
        amount: U128(10u128.pow(21)),
        context_hash: [1; 32],
        job_binding_hash: [2; 32],
    }
}
fn acceptance() -> Acceptance {
    Acceptance {
        attempt: U64(1),
        attempt_binding_hash: [3; 32],
        receipt_hash: [4; 32],
        output_hash: [5; 32],
    }
}
fn setup() -> Escrow {
    context("escrow.testnet", 0);
    let mut e = Escrow::new(id("buyer.testnet")); // pilot: registry owner == registry account == buyer
    context("buyer.testnet", terms().amount.0 + STORAGE_TOPUP);
    e.fund(terms());
    e
}

#[test]
fn outsider_cannot_preempt_real_job_by_naming_it_with_own_buyer() {
    let mut e = setup();
    let mut attack = terms();
    attack.job_id = U64(2);
    attack.buyer = id("attacker.testnet");
    context("attacker.testnet", attack.amount.0 + STORAGE_TOPUP);
    reject(|| {
        e.fund(attack.clone());
    });
    assert!(
        e.get_hold(U64(2)).is_none(),
        "attacker must not reserve real job ID"
    );
    // Borrowing the actual buyer's signer through a forwarder is no bypass.
    let mut honest = terms();
    honest.job_id = U64(2);
    context("attacker.testnet", honest.amount.0 + STORAGE_TOPUP);
    reject(|| {
        e.fund(honest.clone());
    });
    context("buyer.testnet", honest.amount.0 + STORAGE_TOPUP);
    assert_eq!(e.fund(honest).state, State::Held);
}
fn registry() -> serde_json::Value {
    json!({"job_id":"1","buyer":"buyer.testnet","state":"Accepted",
        "config":{"context_hash":vec![1;32],"executor":"provider.testnet"},
        "job_binding_hash":vec![2;32],"attempt":"1","attempt_binding_hash":vec![3;32],
        "selected_executor":null,"attempt_binding_version":1,
        "receipts":[{"receipt_hash":vec![4;32],"status":"BuyerAccepted","decided_at_ns":"100",
            "claim":{"job_id":"1","attempt":"1","job_binding_hash":vec![2;32],
                "attempt_binding_hash":vec![3;32],"context_hash":vec![1;32],"output_hash":vec![5;32]}}]})
}
fn reject(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}
fn verifying(e: &mut Escrow) {
    context("buyer.testnet", 0);
    let _ = e.release(U64(1), acceptance());
}

#[test]
fn fund_exact_deposit_distinct_roles_and_no_replay() {
    let mut e = setup();
    let before = e.get_hold(U64(1));
    reject(|| {
        e.fund(terms());
    });
    assert_eq!(before, e.get_hold(U64(1)));
    let mut other = terms();
    other.job_id = U64(2);
    context("forwarder.testnet", other.amount.0 + STORAGE_TOPUP);
    reject(|| {
        e.fund(other.clone());
    }); // signer buyer does not authorize predecessor
    context("buyer.testnet", other.amount.0);
    reject(|| {
        e.fund(other.clone());
    });
    context("buyer.testnet", other.amount.0 + STORAGE_TOPUP);
    other.provider = other.buyer.clone();
    reject(|| {
        e.fund(other.clone());
    });
    other.provider = id("provider.near");
    reject(|| {
        e.fund(other.clone());
    });
    other.provider = id("provider.testnet");
    other.amount = U128(MAX_AMOUNT + 1);
    reject(|| {
        e.fund(other.clone());
    });
    assert!(e.get_hold(U64(2)).is_none());
}

#[test]
fn initialization_and_release_auth() {
    context("attacker.testnet", 0);
    reject(|| {
        Escrow::new(id("registry.testnet"));
    });
    context("escrow.testnet", 0);
    reject(|| {
        Escrow::new(id("registry.near"));
    });
    let mut e = setup();
    context("provider.testnet", 0);
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    context("buyer.testnet", 1);
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::Held);
}

#[test]
fn exact_accepted_view_then_successful_transfer_only_marks_paid() {
    let mut e = setup();
    verifying(&mut e);
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::Verifying);
    context("buyer.testnet", 0);
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    callback(PromiseResult::Successful(
        serde_json::to_vec(&registry()).unwrap(),
    ));
    assert!(matches!(
        e.on_registry(U64(1), U64(1)),
        PromiseOrValue::Promise(_)
    ));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::PayoutPending);
    context("buyer.testnet", 0);
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    callback(PromiseResult::Successful(vec![]));
    assert!(e.on_transfer(U64(1), U64(1), false));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::Paid);
    reject(|| {
        e.on_transfer(U64(1), U64(1), false);
    });
    context("buyer.testnet", 0);
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    reject(|| {
        let _ = e.refund(U64(1));
    });
}

#[test]
fn all_registry_identity_version_and_hash_mismatches_fail_closed() {
    let mut e = setup();
    verifying(&mut e);
    let hold = e.get_hold(U64(1)).unwrap();
    let mut bad = Vec::new();
    for key in ["job_id", "attempt"] {
        let mut j = registry();
        j[key] = json!("2");
        bad.push(j);
    }
    for key in ["state", "buyer"] {
        let mut j = registry();
        j[key] = json!("Reported");
        bad.push(j);
    }
    for key in ["job_binding_hash", "attempt_binding_hash"] {
        let mut j = registry();
        j[key] = json!(vec![9; 32]);
        bad.push(j);
    }
    let mut j = registry();
    j["config"]["executor"] = json!("attacker.testnet");
    bad.push(j);
    let mut j = registry();
    j["config"]["context_hash"] = json!(vec![9; 32]);
    bad.push(j);
    let mut j = registry();
    j["attempt_binding_version"] = json!(99);
    bad.push(j);
    let mut j = registry();
    j["receipts"] = json!([]);
    bad.push(j);
    let mut j = registry();
    j["receipts"][0]["status"] = json!("ExecutorReported");
    bad.push(j);
    let mut j = registry();
    j["receipts"][0]["decided_at_ns"] = json!(null);
    bad.push(j);
    let mut j = registry();
    j["receipts"][0]["receipt_hash"] = json!(vec![9; 32]);
    bad.push(j);
    for key in [
        "context_hash",
        "job_binding_hash",
        "attempt_binding_hash",
        "output_hash",
    ] {
        let mut j = registry();
        j["receipts"][0]["claim"][key] = json!(vec![9; 32]);
        bad.push(j);
    }
    for j in bad {
        assert!(!accepted(&serde_json::to_vec(&j).unwrap(), &hold));
    }
    let mut j = registry();
    j["attempt_binding_version"] = json!(2);
    j["selected_executor"] = json!("provider.testnet");
    assert!(accepted(&serde_json::to_vec(&j).unwrap(), &hold));
    j["selected_executor"] = json!("other.testnet");
    assert!(!accepted(&serde_json::to_vec(&j).unwrap(), &hold));
    assert!(!accepted(b"null", &hold));
    assert!(!accepted(b"not JSON", &hold));
}

#[test]
fn failed_view_resets_only_before_any_transfer_and_callbacks_are_private() {
    let mut e = setup();
    verifying(&mut e);
    context("attacker.testnet", 0);
    reject(|| {
        let _ = e.on_registry(U64(1), U64(1));
    });
    callback(PromiseResult::Failed);
    assert!(matches!(
        e.on_registry(U64(1), U64(1)),
        PromiseOrValue::Value(false)
    ));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::Held);
    verifying(&mut e);
    callback(PromiseResult::Successful(b"null".to_vec()));
    reject(|| {
        let _ = e.on_registry(U64(1), U64(1));
    }); // stale nonce
    assert!(matches!(
        e.on_registry(U64(1), U64(2)),
        PromiseOrValue::Value(false)
    ));
}

#[test]
fn failed_transfer_can_retry_but_missing_or_unknown_callback_never_can() {
    let mut e = setup();
    verifying(&mut e);
    callback(PromiseResult::Successful(
        serde_json::to_vec(&registry()).unwrap(),
    ));
    let _ = e.on_registry(U64(1), U64(1));
    callback(PromiseResult::Successful(vec![1]));
    assert!(!e.on_transfer(U64(1), U64(1), false));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::PayoutPending);
    context("buyer.testnet", 0);
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    // Separate proven-failure execution, not a retry after UNKNOWN.
    e.holds.get_mut(&1).unwrap().state = State::PayoutPending;
    callback(PromiseResult::Failed);
    assert!(!e.on_transfer(U64(1), U64(1), false));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::Held);
    verifying(&mut e);
    assert_eq!(e.get_hold(U64(1)).unwrap().nonce, U64(2));
}

#[test]
fn refund_requires_both_roles_and_proven_transfer_success() {
    let mut e = setup();
    context("buyer.testnet", 0);
    reject(|| {
        let _ = e.refund(U64(1));
    });
    reject(|| {
        e.approve_refund(U64(1));
    });
    context("provider.testnet", 0);
    e.approve_refund(U64(1));
    reject(|| {
        let _ = e.refund(U64(1));
    });
    context("buyer.testnet", 0);
    let _ = e.refund(U64(1));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::RefundPending);
    reject(|| {
        let _ = e.refund(U64(1));
    });
    reject(|| {
        let _ = e.release(U64(1), acceptance());
    });
    callback(PromiseResult::Successful(vec![]));
    reject(|| {
        e.on_transfer(U64(1), U64(1), false);
    });
    assert!(e.on_transfer(U64(1), U64(1), true));
    assert_eq!(e.get_hold(U64(1)).unwrap().state, State::Refunded);
}
