use super::*;
use near_sdk::{
    PromiseResult,
    test_utils::{VMContextBuilder, get_created_receipts},
    testing_env,
};
use std::panic::{AssertUnwindSafe, catch_unwind};

const ACCOUNT: &str = "workspace-escrow.testnet";
const NOW: u64 = 1_000_000_000;
const EXEC: u64 = NOW + 100;
const REVIEW: u64 = NOW + 200;

fn context(
    caller: &str,
    time: u64,
    balance: u128,
    deposit: u128,
    gas: u64,
    results: Vec<PromiseResult>,
) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(ACCOUNT.parse().unwrap())
        .predecessor_account_id(caller.parse().unwrap())
        .signer_account_id(ACCOUNT.parse().unwrap())
        .account_balance(NearToken::from_yoctonear(balance))
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .storage_usage(1024)
        .block_timestamp(time)
        .prepaid_gas(Gas::from_tgas(gas));
    testing_env!(
        b.build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        Default::default(),
        results
    );
}
fn owner_context(time: u64) {
    context(ACCOUNT, time, 10u128.pow(25), 0, 300, vec![]);
}
fn callback(result: PromiseResult) {
    context(ACCOUNT, NOW, 10u128.pow(25), 0, 20, vec![result]);
}
fn terms(n: u128) -> Terms {
    Terms {
        job_id: format!("{n:032x}"),
        buyer_commitment: "11".repeat(32),
        provider: "provider.testnet".parse().unwrap(),
        amount: U128(MAX_HOLD),
        input_hash: "22".repeat(32),
        program_hash: "33".repeat(32),
        plan_hash: "00".repeat(32),
        execution_deadline_ns: U64(EXEC),
        review_deadline_ns: U64(REVIEW),
    }
}
fn reject(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}
fn setup() -> (WorkspaceEscrow, Hold) {
    owner_context(NOW);
    let mut escrow = WorkspaceEscrow::new();
    let hold = escrow.fund(terms(1));
    (escrow, hold)
}
fn delivered(escrow: &mut WorkspaceEscrow, hold: &Hold) -> Hold {
    escrow.record_delivery(
        hold.terms.job_id.clone(),
        hold.binding_hash.clone(),
        1,
        "44".repeat(32),
    )
}
fn release(escrow: &mut WorkspaceEscrow, hold: &Hold) {
    drop(escrow.accept_and_release(
        hold.terms.job_id.clone(),
        hold.binding_hash.clone(),
        1,
        "44".repeat(32),
    ));
}
fn on_transfer(escrow: &mut WorkspaceEscrow, hold: &Hold, nonce: u64) -> bool {
    escrow.on_transfer(
        hold.terms.job_id.clone(),
        hold.binding_hash.clone(),
        U64(nonce),
    )
}
fn invariants(e: &WorkspaceEscrow) {
    let config = e.get_config();
    assert_eq!(config.available.0 + config.held.0 + config.spent.0, POOL);
    assert!(config.pending.0 <= config.held.0);
    let held: u128 = e
        .holds
        .values()
        .filter(|h| {
            matches!(
                h.state,
                State::Held | State::Delivered | State::PayoutPending
            )
        })
        .map(|h| h.terms.amount.0)
        .sum();
    let spent: u128 = e
        .holds
        .values()
        .filter(|h| h.state == State::Paid)
        .map(|h| h.terms.amount.0)
        .sum();
    let pending: u128 = e
        .holds
        .values()
        .filter(|h| h.state == State::PayoutPending)
        .map(|h| h.terms.amount.0)
        .sum();
    assert_eq!((held, spent, pending), (e.held, e.spent, e.pending));
}

#[test]
fn exact_json_binding_all_string_fields_and_contract_domain() {
    let (mut e, h) = setup();
    let t = &h.terms;
    let array = near_sdk::serde_json::json!([
        DOMAIN,
        ACCOUNT,
        t.job_id,
        t.buyer_commitment,
        t.provider,
        t.amount.0.to_string(),
        t.input_hash,
        t.program_hash,
        t.plan_hash,
        EXEC.to_string(),
        REVIEW.to_string()
    ]);
    let expected = env::sha256(serde_json::to_vec(&array).unwrap())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();
    assert_eq!(h.binding_hash, expected);
    let serialized = serde_json::to_value(e.get_config()).unwrap();
    assert_eq!(serialized["total_pool"], POOL.to_string());
    assert_eq!(serialized["held"], MAX_HOLD.to_string());
    assert_eq!(serialized["max_holds"], 50);
    assert_eq!(serde_json::to_value(&h).unwrap()["nonce"], "0");
    for n in 0..10 {
        let mut changed = terms(2 + n);
        match n {
            0 => changed.buyer_commitment = "12".repeat(32),
            1 => changed.provider = "other.testnet".parse().unwrap(),
            2 => changed.amount = U128(1),
            3 => changed.input_hash = "24".repeat(32),
            4 => changed.program_hash = "35".repeat(32),
            5 => changed.plan_hash = "16".repeat(32),
            6 => changed.execution_deadline_ns = U64(EXEC + 1),
            7 => changed.review_deadline_ns = U64(REVIEW + 1),
            _ => (),
        }
        assert_ne!(binding(&changed), h.binding_hash);
    }
    assert_eq!(e.fund(t.clone()), h);
    invariants(&e);
}

#[test]
fn initialization_requires_self_testnet_no_deposit_and_separate_operating_funds() {
    context("attacker.testnet", NOW, 10u128.pow(25), 0, 300, vec![]);
    reject(|| {
        WorkspaceEscrow::new();
    });
    context(ACCOUNT, NOW, POOL + GAS_RESERVE, 0, 300, vec![]);
    reject(|| {
        WorkspaceEscrow::new();
    });
    context(ACCOUNT, NOW, 10u128.pow(25), 1, 300, vec![]);
    reject(|| {
        WorkspaceEscrow::new();
    });
    let mut b = VMContextBuilder::new();
    b.current_account_id("escrow.near".parse().unwrap())
        .predecessor_account_id("escrow.near".parse().unwrap());
    testing_env!(b.build());
    reject(|| {
        WorkspaceEscrow::new();
    });
}

#[test]
fn every_mutator_rejects_forwarder_and_any_attached_deposit() {
    let (mut e, h) = setup();
    for (caller, deposit) in [("attacker.testnet", 0), (ACCOUNT, 1)] {
        context(
            caller,
            NOW,
            10u128.pow(25),
            deposit,
            300,
            vec![PromiseResult::Successful(vec![])],
        );
        reject(|| {
            e.fund(terms(2));
        });
        reject(|| {
            delivered(&mut e, &h);
        });
        reject(|| {
            release(&mut e, &h);
        });
        reject(|| {
            e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
        });
        reject(|| {
            on_transfer(&mut e, &h, 1);
        });
    }
    assert_eq!(e.get_hold(h.terms.job_id.clone()), Some(h));
    invariants(&e);
}

#[test]
fn bounded_hex_accounts_amounts_and_terms_json_reject_malformed() {
    let (mut e, _) = setup();
    let mut bads = vec![];
    for job in [
        "0".repeat(31),
        "0".repeat(33),
        "A".repeat(32),
        "é".repeat(16),
    ] {
        let mut t = terms(2);
        t.job_id = job;
        bads.push(t);
    }
    for hash in [
        "x".repeat(64),
        "0".repeat(63),
        "0".repeat(65),
        "A".repeat(64),
    ] {
        for field in 0..4 {
            let mut t = terms(2);
            match field {
                0 => t.buyer_commitment = hash.clone(),
                1 => t.input_hash = hash.clone(),
                2 => t.program_hash = hash.clone(),
                _ => t.plan_hash = hash.clone(),
            };
            bads.push(t);
        }
    }
    for account in ["provider.near", ACCOUNT, "testnet"] {
        let mut t = terms(2);
        t.provider = account.parse().unwrap();
        bads.push(t);
    }
    for amount in [0, MAX_HOLD + 1, u128::MAX] {
        let mut t = terms(2);
        t.amount = U128(amount);
        bads.push(t);
    }
    for t in bads {
        reject(|| {
            e.fund(t);
        });
    }
    let mut raw = serde_json::to_value(terms(2)).unwrap();
    raw["extra"] = near_sdk::serde_json::json!("ignored?");
    assert!(serde_json::from_value::<Terms>(raw).is_err());
    for value in [
        near_sdk::serde_json::json!(1),
        near_sdk::serde_json::json!("x"),
        near_sdk::serde_json::json!("340282366920938463463374607431768211456"),
    ] {
        let mut raw = serde_json::to_value(terms(2)).unwrap();
        raw["amount"] = value;
        assert!(serde_json::from_value::<Terms>(raw).is_err());
    }
    let mut implicit = terms(2);
    implicit.provider = "ab".repeat(32).parse().unwrap();
    assert_eq!(e.fund(implicit).state, State::Held);
    invariants(&e);
}

#[test]
fn deadlines_and_unknown_or_cross_bound_hold_rejected() {
    let (mut e, h) = setup();
    for (execution, review) in [
        (NOW, REVIEW),
        (EXEC, EXEC),
        (EXEC, EXEC - 1),
        (EXEC, NOW + MAX_HORIZON_NS + 1),
    ] {
        let mut t = terms(2);
        t.execution_deadline_ns = U64(execution);
        t.review_deadline_ns = U64(review);
        reject(|| {
            e.fund(t);
        });
    }
    for (job, hash) in [
        (terms(9).job_id, h.binding_hash.clone()),
        (h.terms.job_id.clone(), "00".repeat(32)),
        ("x".repeat(32), h.binding_hash.clone()),
    ] {
        reject(|| {
            e.record_delivery(job, hash, 1, "44".repeat(32));
        });
    }
    assert!(e.get_hold(terms(9).job_id).is_none());
    owner_context(EXEC + 1);
    reject(|| {
        delivered(&mut e, &h);
    });
    owner_context(EXEC);
    delivered(&mut e, &h); // inclusive
    owner_context(REVIEW + 1);
    reject(|| {
        release(&mut e, &h);
    });
    owner_context(REVIEW);
    release(&mut e, &h); // inclusive
}

#[test]
fn immutable_duplicate_fund_never_inflates_pool_even_after_deadline_or_refund() {
    let (mut e, h) = setup();
    assert_eq!(e.fund(terms(1)), h);
    let before = e.get_config().available;
    let mut changed = terms(1);
    changed.amount = U128(1);
    reject(|| {
        e.fund(changed);
    });
    assert_eq!(e.get_config().available, before);
    owner_context(REVIEW + 1);
    let refunded = e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
    assert_eq!(e.fund(terms(1)), refunded);
    assert_eq!(e.get_config().available, U128(POOL));
    assert_eq!(e.holds.len(), 1);
    reject(|| {
        delivered(&mut e, &h);
    });
    reject(|| {
        release(&mut e, &h);
    });
    reject(|| {
        e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
    });
    invariants(&e);
}

#[test]
fn fifty_permanent_slots_pool_cap_and_topup_cannot_inflate_budget() {
    owner_context(NOW);
    let mut e = WorkspaceEscrow::new();
    for n in 0..50 {
        let mut t = terms(n);
        t.amount = U128(1);
        e.fund(t);
    }
    let mut next = terms(51);
    next.amount = U128(1);
    reject(|| {
        e.fund(next);
    });
    owner_context(REVIEW + 1);
    let h = e.get_hold(terms(0).job_id).unwrap();
    e.refund(h.terms.job_id, h.binding_hash);
    owner_context(NOW);
    let mut next = terms(52);
    next.amount = U128(1);
    reject(|| {
        e.fund(next);
    });
    assert_eq!(e.get_config().hold_count, 50);
    let (mut e, _) = setup();
    for n in 2..=5 {
        e.fund(terms(n));
    }
    assert_eq!(e.get_config().available, U128(0));
    context(ACCOUNT, NOW, u128::MAX / 2, 0, 300, vec![]); // a real topup cannot raise logical cap
    reject(|| {
        e.fund(terms(6));
    });
    assert_eq!(e.get_config().total_pool, U128(POOL));
    invariants(&e);
}

#[test]
fn delivery_strict_versions_idempotence_and_latest_only_acceptance() {
    let (mut e, h) = setup();
    reject(|| {
        e.record_delivery(
            h.terms.job_id.clone(),
            h.binding_hash.clone(),
            0,
            "44".repeat(32),
        );
    });
    reject(|| {
        e.record_delivery(
            h.terms.job_id.clone(),
            h.binding_hash.clone(),
            2,
            "44".repeat(32),
        );
    });
    reject(|| {
        release(&mut e, &h);
    });
    let d = delivered(&mut e, &h);
    assert_eq!(delivered(&mut e, &h), d);
    reject(|| {
        e.record_delivery(
            h.terms.job_id.clone(),
            h.binding_hash.clone(),
            1,
            "55".repeat(32),
        );
    });
    reject(|| {
        e.record_delivery(
            h.terms.job_id.clone(),
            h.binding_hash.clone(),
            3,
            "44".repeat(32),
        );
    });
    e.record_delivery(
        h.terms.job_id.clone(),
        h.binding_hash.clone(),
        2,
        "55".repeat(32),
    );
    reject(|| {
        release(&mut e, &h);
    });
    reject(|| {
        delivered(&mut e, &h);
    });
    drop(e.accept_and_release(
        h.terms.job_id.clone(),
        h.binding_hash.clone(),
        2,
        "55".repeat(32),
    ));
    assert_eq!(
        e.get_hold(h.terms.job_id)
            .unwrap()
            .delivery
            .unwrap()
            .version,
        2
    );
    invariants(&e);
}

#[test]
fn release_checks_gas_real_balance_and_freezes_before_native_transfer() {
    let (mut e, h) = setup();
    delivered(&mut e, &h);
    context(ACCOUNT, NOW, 10u128.pow(25), 0, 99, vec![]);
    reject(|| {
        release(&mut e, &h);
    });
    context(ACCOUNT, NOW, POOL + GAS_RESERVE, 0, 100, vec![]);
    reject(|| {
        release(&mut e, &h);
    });
    owner_context(NOW);
    release(&mut e, &h);
    let pending = e.get_hold(h.terms.job_id.clone()).unwrap();
    assert_eq!(pending.state, State::PayoutPending);
    assert_eq!(pending.nonce, U64(1));
    assert_eq!(e.get_config().spent, U128(0));
    assert_eq!(e.get_config().pending, U128(MAX_HOLD));
    let receipts = get_created_receipts();
    assert_eq!(receipts.len(), 2);
    assert_eq!(receipts[0].receiver_id, h.terms.provider);
    assert_eq!(
        receipts[1].receiver_id,
        ACCOUNT.parse::<AccountId>().unwrap()
    );
    reject(|| {
        release(&mut e, &h);
    });
    reject(|| {
        delivered(&mut e, &h);
    });
    owner_context(REVIEW + 1);
    reject(|| {
        e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
    });
    invariants(&e);
}

#[test]
fn callback_success_only_paid_and_replays_or_foreign_nonce_binding_rejected() {
    let (mut e, h) = setup();
    delivered(&mut e, &h);
    release(&mut e, &h);
    callback(PromiseResult::Successful(vec![]));
    reject(|| {
        on_transfer(&mut e, &h, 0);
    });
    reject(|| {
        e.on_transfer(h.terms.job_id.clone(), "00".repeat(32), U64(1));
    });
    assert!(on_transfer(&mut e, &h, 1));
    assert_eq!(
        e.get_hold(h.terms.job_id.clone()).unwrap().state,
        State::Paid
    );
    assert_eq!((e.held, e.spent, e.pending), (0, MAX_HOLD, 0));
    reject(|| {
        on_transfer(&mut e, &h, 1);
    });
    owner_context(NOW);
    reject(|| {
        release(&mut e, &h);
    });
    assert_eq!(e.fund(terms(1)).state, State::Paid);
    owner_context(REVIEW + 1);
    reject(|| {
        e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
    });
    invariants(&e);
}

#[test]
fn definitive_transfer_failure_returns_delivered_and_retry_uses_new_nonce() {
    let (mut e, h) = setup();
    delivered(&mut e, &h);
    release(&mut e, &h);
    callback(PromiseResult::Failed);
    assert!(!on_transfer(&mut e, &h, 1));
    let failed = e.get_hold(h.terms.job_id.clone()).unwrap();
    assert_eq!(failed.state, State::Delivered);
    assert_eq!(failed.last_transfer_failure_nonce, Some(U64(1)));
    assert_eq!((e.held, e.spent, e.pending), (MAX_HOLD, 0, 0));
    owner_context(NOW);
    release(&mut e, &h);
    callback(PromiseResult::Successful(vec![]));
    reject(|| {
        on_transfer(&mut e, &h, 1);
    });
    assert_eq!(
        e.get_hold(h.terms.job_id.clone()).unwrap().state,
        State::PayoutPending
    );
    assert!(on_transfer(&mut e, &h, 2));
    assert_eq!(e.get_hold(h.terms.job_id.clone()).unwrap().nonce, U64(2));
    invariants(&e);
}

#[test]
fn malformed_oversize_or_missing_callback_never_unlocks_unknown_payment() {
    let (mut e, h) = setup();
    delivered(&mut e, &h);
    release(&mut e, &h);
    context(ACCOUNT, NOW, 10u128.pow(25), 0, 20, vec![]);
    reject(|| {
        on_transfer(&mut e, &h, 1);
    });
    context(
        ACCOUNT,
        NOW,
        10u128.pow(25),
        0,
        20,
        vec![PromiseResult::Successful(vec![]), PromiseResult::Failed],
    );
    reject(|| {
        on_transfer(&mut e, &h, 1);
    });
    for data in [b"true".to_vec(), vec![0; 65]] {
        callback(PromiseResult::Successful(data));
        assert!(!on_transfer(&mut e, &h, 1));
        assert_eq!(
            e.get_hold(h.terms.job_id.clone()).unwrap().state,
            State::PayoutPending
        );
        assert_eq!(e.get_config().spent, U128(0));
    }
    owner_context(REVIEW + 1);
    reject(|| {
        e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
    });
    reject(|| {
        release(&mut e, &h);
    });
    invariants(&e);
}

#[test]
fn refund_only_after_review_returns_internal_reserve_without_transfer() {
    for deliver in [false, true] {
        let (mut e, h) = setup();
        if deliver {
            delivered(&mut e, &h);
        }
        owner_context(REVIEW);
        reject(|| {
            e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
        });
        owner_context(REVIEW + 1);
        let refunded = e.refund(h.terms.job_id.clone(), h.binding_hash.clone());
        assert_eq!(refunded.state, State::Refunded);
        assert_eq!(e.get_config().available, U128(POOL));
        assert!(get_created_receipts().is_empty());
        invariants(&e);
    }
    let (mut e, h) = setup();
    delivered(&mut e, &h);
    release(&mut e, &h);
    callback(PromiseResult::Failed);
    on_transfer(&mut e, &h, 1);
    owner_context(REVIEW + 1);
    assert_eq!(
        e.refund(h.terms.job_id, h.binding_hash).state,
        State::Refunded
    );
    invariants(&e);
}

#[test]
fn live_balance_floor_on_new_hold_preserves_storage_and_gas_and_pending_accounting() {
    let (mut e, h) = setup();
    context(ACCOUNT, NOW, POOL, 0, 300, vec![]);
    reject(|| {
        e.fund(terms(2));
    });
    owner_context(NOW);
    delivered(&mut e, &h);
    release(&mut e, &h);
    // Reserved native transfer is excluded from account's available balance.
    let storage = (1024 + u128::from(STORAGE_HEADROOM)) * env::storage_byte_cost().as_yoctonear();
    context(
        ACCOUNT,
        NOW,
        storage + GAS_RESERVE + POOL - MAX_HOLD,
        0,
        300,
        vec![],
    );
    e.fund(terms(2));
    invariants(&e);
}
