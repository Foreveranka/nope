use super::*;
use near_sdk::{NearToken, test_utils::VMContextBuilder, testing_env};
use sha2::{Digest, Sha256};
use std::panic::{AssertUnwindSafe, catch_unwind};

fn account(value: &str) -> AccountId {
    value.parse().unwrap()
}
fn ctx(caller: &str, now: u64) {
    context(caller, caller, now, 0);
}
fn context(caller: &str, signer: &str, now: u64, deposit: u128) {
    let mut b = VMContextBuilder::new();
    b.current_account_id(account("registry.test.near"))
        .predecessor_account_id(account(caller))
        .signer_account_id(account(signer))
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit));
    testing_env!(b.build());
}
fn config() -> JobConfig {
    JobConfig {
        spec_hash: [1; 32],
        circuit_hash: [2; 32],
        key_hash: [3; 32],
        output_policy_hash: [4; 32],
        context_hash: [5; 32],
        input_hash: [6; 32],
        budget_commitment: [7; 32],
        bid_deadline_ns: U64(100),
        result_deadline_ns: U64(200),
        authorized_bidders: vec![account("zulu.near"), account("alpha.near")],
        executor: account("executor.near"),
    }
}
fn setup() -> (Registry, Job) {
    ctx("registry.test.near", 10);
    let mut r = Registry::new(account("buyer.near"), [42; 32]);
    ctx("buyer.near", 10);
    let j = r.create_job(config());
    (r, j)
}
fn committed() -> (Registry, Job) {
    let (mut r, j) = setup();
    ctx("zulu.near", 50);
    r.submit_bid(j.job_id, j.job_binding_hash, [9; 32]);
    (r, j)
}
fn executing() -> (Registry, Job) {
    let (mut r, j) = committed();
    ctx("anyone.near", 100);
    let root = r.close_bids(j.job_id);
    ctx("buyer.near", 101);
    r.begin_attempt(j.job_id, root);
    let j = r.get_job(j.job_id).unwrap();
    (r, j)
}
fn claim(j: &Job) -> ReceiptClaim {
    ReceiptClaim {
        job_id: j.job_id,
        attempt: j.attempt,
        job_binding_hash: j.job_binding_hash,
        attempt_binding_hash: j.attempt_binding_hash.unwrap(),
        bidset_root: j.bidset_root.unwrap(),
        spec_hash: j.config.spec_hash,
        circuit_hash: j.config.circuit_hash,
        key_hash: j.config.key_hash,
        output_policy_hash: j.config.output_policy_hash,
        context_hash: j.config.context_hash,
        input_hash: j.config.input_hash,
        budget_commitment: j.config.budget_commitment,
        output_hash: [10; 32],
    }
}
fn rejects(f: impl FnOnce()) {
    assert!(catch_unwind(AssertUnwindSafe(f)).is_err());
}
fn unchanged(r: &mut Registry, id: U64, f: impl FnOnce(&mut Registry)) {
    let before = r.get_job(id);
    rejects(|| f(r));
    assert_eq!(r.get_job(id), before, "failed call mutated state");
}

#[test]
fn self_initialization_only_and_nonzero_domain() {
    ctx("attacker.near", 10);
    rejects(|| {
        Registry::new(account("attacker.near"), [42; 32]);
    });
    ctx("registry.test.near", 10);
    rejects(|| {
        Registry::new(account("buyer.near"), [0; 32]);
    });
}

#[test]
fn predecessor_authorization_does_not_borrow_signer_authority() {
    let (mut r, j) = setup();
    context("forwarder.near", "buyer.near", 20, 0);
    rejects(|| {
        r.create_job(config());
    });
    context("forwarder.near", "alpha.near", 20, 0);
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [9; 32])
    });
}

#[test]
fn roster_is_canonical_unique_and_bounded() {
    let (mut r, j) = setup();
    assert_eq!(
        j.config.authorized_bidders,
        vec![account("alpha.near"), account("zulu.near")]
    );
    assert_eq!(
        j.bids.iter().map(|b| b.bidder.clone()).collect::<Vec<_>>(),
        j.config.authorized_bidders
    );
    for n in [0, 11] {
        let mut c = config();
        c.authorized_bidders = (0..n)
            .map(|i| account(&format!("bidder{i}.near")))
            .collect();
        rejects(|| {
            r.create_job(c);
        });
    }
    let mut c = config();
    c.authorized_bidders.push(account("alpha.near"));
    rejects(|| {
        r.create_job(c);
    });
    let mut c = config();
    c.authorized_bidders = (0..10)
        .map(|i| account(&format!("bidder{i}.near")))
        .collect();
    assert_eq!(r.create_job(c).bids.len(), 10);
}

#[test]
fn deadlines_are_strictly_monotonic_bounded_and_hashes_required() {
    let (mut r, _) = setup();
    for (bid, result) in [
        (10, 200),
        (100, 100),
        (100, 99),
        (100, 10 + MAX_WINDOW_NS + 1),
    ] {
        let mut c = config();
        c.bid_deadline_ns = U64(bid);
        c.result_deadline_ns = U64(result);
        rejects(|| {
            r.create_job(c);
        });
    }
    for index in 0..7 {
        let mut c = config();
        let fields = [
            &mut c.spec_hash,
            &mut c.circuit_hash,
            &mut c.key_hash,
            &mut c.output_policy_hash,
            &mut c.context_hash,
            &mut c.input_hash,
            &mut c.budget_commitment,
        ];
        *fields.into_iter().nth(index).unwrap() = [0; 32];
        rejects(|| {
            r.create_job(c);
        });
    }
}

#[test]
fn bidder_cannot_replace_copy_or_misroute_commitment() {
    let (mut r, j) = committed();
    ctx("zulu.near", 60);
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [11; 32])
    });
    ctx("alpha.near", 60);
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, [88; 32], [11; 32])
    });
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [9; 32])
    });
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [0; 32])
    });
    r.submit_bid(j.job_id, j.job_binding_hash, [11; 32]);
}

#[test]
fn buyer_and_stranger_cannot_freeze_early_or_change_closed_bids() {
    let (mut r, j) = committed();
    for caller in ["buyer.near", "anyone.near"] {
        ctx(caller, 99);
        unchanged(&mut r, j.job_id, |r| {
            r.close_bids(j.job_id);
        });
    }
    ctx("alpha.near", 100);
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [11; 32])
    });
    ctx("anyone.near", 100);
    r.close_bids(j.job_id);
    ctx("alpha.near", 101);
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [11; 32])
    });
    unchanged(&mut r, j.job_id, |r| {
        r.close_bids(j.job_id);
    });
    assert_eq!(r.get_job(j.job_id).unwrap().config, j.config);
}

// Independent encoding: deliberately does not call contract digest or Borsh.
fn string(out: &mut Vec<u8>, value: &str) {
    out.extend((value.len() as u32).to_le_bytes());
    out.extend(value.as_bytes());
}
fn sha(bytes: Vec<u8>) -> Hash {
    Sha256::digest(bytes).into()
}
fn independent_root(binding: Hash, bids: &[BidEntry]) -> Hash {
    let mut b = vec![];
    string(&mut b, "veil/bidset/v1");
    b.extend(binding);
    b.extend((bids.len() as u32).to_le_bytes());
    for bid in bids {
        string(&mut b, bid.bidder.as_str());
        if let Some(c) = bid.commitment {
            b.push(1);
            b.extend(c);
        } else {
            b.push(0);
        }
    }
    sha(b)
}

#[test]
fn full_root_independently_recomputes_and_detects_omission_order_and_substitution() {
    let (mut r, j) = committed();
    ctx("anyone.near", 100);
    let root = r.close_bids(j.job_id);
    let closed = r.get_job(j.job_id).unwrap();
    assert_eq!(root, independent_root(j.job_binding_hash, &closed.bids));
    let mut altered = closed.bids.clone();
    altered.pop();
    assert_ne!(root, independent_root(j.job_binding_hash, &altered));
    let mut altered = closed.bids.clone();
    altered.reverse();
    assert_ne!(root, independent_root(j.job_binding_hash, &altered));
    let mut altered = closed.bids.clone();
    altered[1].commitment = None;
    assert_ne!(root, independent_root(j.job_binding_hash, &altered));
    assert_ne!(root, independent_root([0; 32], &closed.bids));
}

#[test]
fn job_binding_independently_encodes_every_configuration_field() {
    let (_, j) = setup();
    let c = &j.config;
    let mut b = vec![];
    string(&mut b, "veil/job/v1");
    string(&mut b, "registry.test.near");
    b.extend([42; 32]);
    b.extend(j.job_id.0.to_le_bytes());
    string(&mut b, "buyer.near");
    for h in [
        c.spec_hash,
        c.circuit_hash,
        c.key_hash,
        c.output_policy_hash,
        c.context_hash,
        c.input_hash,
        c.budget_commitment,
    ] {
        b.extend(h);
    }
    b.extend(c.bid_deadline_ns.0.to_le_bytes());
    b.extend(c.result_deadline_ns.0.to_le_bytes());
    b.extend((c.authorized_bidders.len() as u32).to_le_bytes());
    for a in &c.authorized_bidders {
        string(&mut b, a.as_str());
    }
    string(&mut b, c.executor.as_str());
    assert_eq!(sha(b), j.job_binding_hash);
}

#[test]
fn begin_attempt_requires_buyer_closed_state_full_root_and_nonempty_set() {
    let (mut r, j) = committed();
    ctx("buyer.near", 90);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, [9; 32]);
    });
    ctx("anyone.near", 100);
    let root = r.close_bids(j.job_id);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, root);
    });
    ctx("buyer.near", 101);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, [9; 32]);
    });
    r.begin_attempt(j.job_id, root);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, root);
    });
    ctx("buyer.near", 10);
    let empty = r.create_job(config());
    ctx("anyone.near", 100);
    let root = r.close_bids(empty.job_id);
    ctx("buyer.near", 101);
    unchanged(&mut r, empty.job_id, |r| {
        r.begin_attempt(empty.job_id, root);
    });
}

#[test]
fn receipt_rejects_hostile_caller_and_every_wrong_context_field() {
    let (mut r, j) = executing();
    let c = claim(&j);
    context("forwarder.near", "executor.near", 110, 0);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c.clone());
    });
    ctx("executor.near", 110);
    for i in 0..12 {
        let mut wrong = c.clone();
        match i {
            0 => wrong.attempt = U64(2),
            1 => wrong.job_binding_hash = [77; 32],
            2 => wrong.attempt_binding_hash = [77; 32],
            3 => wrong.bidset_root = [77; 32],
            4 => wrong.spec_hash = [77; 32],
            5 => wrong.circuit_hash = [77; 32],
            6 => wrong.key_hash = [77; 32],
            7 => wrong.output_policy_hash = [77; 32],
            8 => wrong.context_hash = [77; 32],
            9 => wrong.input_hash = [77; 32],
            10 => wrong.budget_commitment = [77; 32],
            11 => wrong.output_hash = [0; 32],
            _ => unreachable!(),
        }
        unchanged(&mut r, j.job_id, |r| {
            r.report_result(wrong);
        });
    }
    let hash = r.report_result(c);
    let reported = r.get_job(j.job_id).unwrap();
    assert_eq!(reported.state, JobState::Reported);
    assert_eq!(reported.receipts[0].status, ReceiptStatus::ExecutorReported);
    assert_eq!(reported.receipts[0].receipt_hash, hash);
}

#[test]
fn receipt_replay_across_same_attempt_new_attempt_and_job_is_rejected() {
    let (mut r, j) = executing();
    let c = claim(&j);
    ctx("executor.near", 110);
    let hash = r.report_result(c.clone());
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c.clone());
    });
    ctx("buyer.near", 111);
    r.decide_result(j.job_id, hash, false);
    r.begin_attempt(j.job_id, j.bidset_root.unwrap());
    ctx("executor.near", 112);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c.clone());
    });
    let current = r.get_job(j.job_id).unwrap();
    assert_eq!(current.attempt, U64(2));
    assert_ne!(current.attempt_binding_hash, j.attempt_binding_hash);
    ctx("buyer.near", 10);
    let other = r.create_job(config());
    ctx("zulu.near", 50);
    r.submit_bid(other.job_id, other.job_binding_hash, [9; 32]);
    ctx("anyone.near", 100);
    let root = r.close_bids(other.job_id);
    ctx("buyer.near", 101);
    r.begin_attempt(other.job_id, root);
    let mut rerouted = c;
    rerouted.job_id = other.job_id;
    ctx("executor.near", 112);
    unchanged(&mut r, other.job_id, |r| {
        r.report_result(rerouted);
    });
}

#[test]
fn buyer_decision_is_explicit_exact_and_terminal_but_on_time_reports_can_be_decided_late() {
    let (mut r, j) = executing();
    let c = claim(&j);
    ctx("executor.near", 199);
    let hash = r.report_result(c.clone());
    unchanged(&mut r, j.job_id, |r| r.decide_result(j.job_id, hash, true));
    ctx("buyer.near", 200);
    unchanged(&mut r, j.job_id, |r| {
        r.decide_result(j.job_id, [55; 32], true)
    });
    unchanged(&mut r, j.job_id, |r| r.expire_job(j.job_id));
    r.decide_result(j.job_id, hash, true);
    assert_eq!(
        r.get_job(j.job_id).unwrap().receipts[0].status,
        ReceiptStatus::BuyerAccepted
    );
    unchanged(&mut r, j.job_id, |r| r.decide_result(j.job_id, hash, false));
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, j.bidset_root.unwrap());
    });
    ctx("executor.near", 201);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c);
    });
}

#[test]
fn expiry_boundary_blocks_late_callback_and_preserves_prior_history() {
    let (mut r, j) = executing();
    let c = claim(&j);
    ctx("anyone.near", 199);
    unchanged(&mut r, j.job_id, |r| r.expire_job(j.job_id));
    ctx("executor.near", 200);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c.clone());
    });
    ctx("anyone.near", 200);
    r.expire_job(j.job_id);
    assert_eq!(r.get_job(j.job_id).unwrap().state, JobState::Expired);
    ctx("executor.near", 201);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c);
    });
    ctx("buyer.near", 201);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, j.bidset_root.unwrap());
    });
}

#[test]
fn open_closed_and_rejected_can_expire_while_reported_is_preserved() {
    let (mut r, j) = setup();
    ctx("anyone.near", 200);
    r.expire_job(j.job_id);
    ctx("buyer.near", 10);
    let closed = r.create_job(config());
    ctx("anyone.near", 100);
    r.close_bids(closed.job_id);
    ctx("buyer.near", 200);
    unchanged(&mut r, closed.job_id, |r| {
        r.begin_attempt(
            closed.job_id,
            r.get_job(closed.job_id).unwrap().bidset_root.unwrap(),
        );
    });
    r.expire_job(closed.job_id);
    ctx("buyer.near", 10);
    let rejected = r.create_job(config());
    ctx("alpha.near", 50);
    r.submit_bid(rejected.job_id, rejected.job_binding_hash, [9; 32]);
    ctx("anyone.near", 100);
    let root = r.close_bids(rejected.job_id);
    ctx("buyer.near", 101);
    r.begin_attempt(rejected.job_id, root);
    ctx("executor.near", 110);
    let hash = r.report_result(claim(&r.get_job(rejected.job_id).unwrap()));
    ctx("buyer.near", 111);
    r.decide_result(rejected.job_id, hash, false);
    ctx("anyone.near", 200);
    r.expire_job(rejected.job_id);
    let expired = r.get_job(rejected.job_id).unwrap();
    assert_eq!(expired.state, JobState::Expired);
    assert_eq!(expired.receipts[0].status, ReceiptStatus::BuyerRejected);
}

#[test]
fn attempts_are_bounded_and_receipt_history_is_append_only() {
    let (mut r, mut j) = executing();
    for attempt in 1..=16 {
        ctx("executor.near", 110);
        let hash = r.report_result(claim(&j));
        ctx("buyer.near", 111);
        r.decide_result(j.job_id, hash, false);
        j = r.get_job(j.job_id).unwrap();
        assert_eq!(j.receipts.len(), attempt);
        assert!(
            j.receipts
                .iter()
                .all(|rec| rec.status == ReceiptStatus::BuyerRejected)
        );
        if attempt < 16 {
            r.begin_attempt(j.job_id, j.bidset_root.unwrap());
            j = r.get_job(j.job_id).unwrap();
        }
    }
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, j.bidset_root.unwrap());
    });
}

#[test]
fn every_mutation_explicitly_rejects_money_without_changing_state() {
    let (mut r, j) = executing();
    let c = claim(&j);
    context("buyer.near", "buyer.near", 110, 1);
    rejects(|| {
        r.create_job(config());
    });
    unchanged(&mut r, j.job_id, |r| {
        r.submit_bid(j.job_id, j.job_binding_hash, [9; 32])
    });
    unchanged(&mut r, j.job_id, |r| {
        r.close_bids(j.job_id);
    });
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, j.bidset_root.unwrap());
    });
    unchanged(&mut r, j.job_id, |r| {
        r.begin_selected_attempt(j.job_id, j.bidset_root.unwrap(), account("zulu.near"));
    });
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(c);
    });
    unchanged(&mut r, j.job_id, |r| {
        r.decide_result(j.job_id, [9; 32], true)
    });
    unchanged(&mut r, j.job_id, |r| r.expire_job(j.job_id));
    context("registry.test.near", "registry.test.near", 110, 1);
    rejects(|| {
        Registry::new(account("buyer.near"), [42; 32]);
    });
}

#[test]
fn selected_executor_is_buyer_authorized_committed_and_bound_without_config_mutation() {
    let (mut r, original) = committed();
    ctx("buyer.near", 90);
    unchanged(&mut r, original.job_id, |r| {
        r.begin_selected_attempt(original.job_id, [1; 32], account("zulu.near"));
    });
    ctx("anyone.near", 100);
    let root = r.close_bids(original.job_id);
    context("forwarder.near", "buyer.near", 101, 0);
    unchanged(&mut r, original.job_id, |r| {
        r.begin_selected_attempt(original.job_id, root, account("zulu.near"));
    });
    ctx("buyer.near", 101);
    for who in ["alpha.near", "hostile.near"] {
        unchanged(&mut r, original.job_id, |r| {
            r.begin_selected_attempt(original.job_id, root, account(who));
        });
    }
    unchanged(&mut r, original.job_id, |r| {
        r.begin_selected_attempt(original.job_id, [99; 32], account("zulu.near"));
    });
    let binding = r.begin_selected_attempt(original.job_id, root, account("zulu.near"));
    let j = r.get_job(original.job_id).unwrap();
    assert_eq!(j.config, original.config);
    assert_eq!(j.job_binding_hash, original.job_binding_hash);
    assert_eq!(j.selected_executor, Some(account("zulu.near")));
    assert_eq!(j.attempt_binding_version, Some(2));
    let mut bytes = vec![];
    string(&mut bytes, "veil/attempt/v2");
    bytes.extend(j.job_binding_hash);
    bytes.extend(root);
    bytes.extend(1u64.to_le_bytes());
    string(&mut bytes, "zulu.near");
    assert_eq!(binding, sha(bytes));
    ctx("executor.near", 110);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(claim(&j));
    });
    ctx("zulu.near", 110);
    let receipt = r.report_result(claim(&j));
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(claim(&j));
    });
    ctx("buyer.near", 111);
    r.decide_result(j.job_id, receipt, false);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_attempt(j.job_id, root);
    });
    unchanged(&mut r, j.job_id, |r| {
        r.begin_selected_attempt(j.job_id, root, account("alpha.near"));
    });
    r.begin_selected_attempt(j.job_id, root, account("zulu.near"));
    let retry = r.get_job(j.job_id).unwrap();
    assert_eq!(retry.attempt, U64(2));
    assert_ne!(retry.attempt_binding_hash, j.attempt_binding_hash);
    ctx("zulu.near", 112);
    unchanged(&mut r, j.job_id, |r| {
        r.report_result(claim(&j));
    });
    r.report_result(claim(&retry));
}

#[test]
fn legacy_attempt_cannot_switch_to_selected_mode_on_retry_and_selection_deadline_is_enforced() {
    let (mut r, j) = executing();
    assert_eq!(j.selected_executor, None);
    assert_eq!(j.attempt_binding_version, Some(1));
    ctx("executor.near", 110);
    let receipt = r.report_result(claim(&j));
    ctx("buyer.near", 111);
    r.decide_result(j.job_id, receipt, false);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_selected_attempt(j.job_id, j.bidset_root.unwrap(), account("zulu.near"));
    });
    ctx("buyer.near", 200);
    unchanged(&mut r, j.job_id, |r| {
        r.begin_selected_attempt(j.job_id, j.bidset_root.unwrap(), account("zulu.near"));
    });
}

#[test]
fn storage_flush_and_json_roundtrip_preserve_binding() {
    let (mut r, j) = executing();
    r.jobs.flush();
    let bytes = borsh::to_vec(&r).unwrap();
    let restored: Registry = borsh::from_slice(&bytes).unwrap();
    assert_eq!(restored.get_job(j.job_id), Some(j.clone()));
    let json = near_sdk::serde_json::to_value(&j).unwrap();
    assert_eq!(json["job_id"], "1");
    assert_eq!(json["config"]["bid_deadline_ns"], "100");
    let decoded: Job = near_sdk::serde_json::from_value(json).unwrap();
    assert_eq!(decoded, j);
}

#[test]
fn python_generated_golden_fixture_matches_all_four_onchain_hashes() {
    let fixture: near_sdk::serde_json::Value =
        near_sdk::serde_json::from_str(include_str!("../examples/lifecycle.json")).unwrap();
    let expected: JobConfig =
        near_sdk::serde_json::from_value(fixture["calls"][1]["args"]["config"].clone()).unwrap();
    let (mut r, j) = setup();
    assert_eq!(j.config, expected);
    assert_eq!(
        near_sdk::serde_json::to_value(j.job_binding_hash).unwrap(),
        fixture["job"]["job_binding_hash"]
    );
    ctx("zulu.near", 50);
    r.submit_bid(j.job_id, j.job_binding_hash, [9; 32]);
    ctx("anyone.near", 100);
    let root = r.close_bids(j.job_id);
    assert_eq!(
        near_sdk::serde_json::to_value(root).unwrap(),
        fixture["job"]["bidset_root"]
    );
    ctx("buyer.near", 101);
    let attempt = r.begin_attempt(j.job_id, root);
    assert_eq!(
        near_sdk::serde_json::to_value(attempt).unwrap(),
        fixture["job"]["attempt_binding_hash"]
    );
    let c: ReceiptClaim =
        near_sdk::serde_json::from_value(fixture["calls"][5]["args"]["claim"].clone()).unwrap();
    ctx("executor.near", 110);
    let receipt = r.report_result(c);
    assert_eq!(
        near_sdk::serde_json::to_value(receipt).unwrap(),
        fixture["receipt_hash"]
    );
}
