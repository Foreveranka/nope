//! Immutable timestamped commitments only; no privacy/execution proof.
use near_sdk::env;
pub const OWNER: &str = "veil-reg-e138f5c88250f821.testnet";
pub const PROFILE: &str = "nope-csv-evidence-v1";
fn check(ok: bool, e: &str) {
    if !ok {
        env::panic_str(e)
    }
}
fn nonpayable() {
    check(env::attached_deposit().as_yoctonear() == 0, "NO_DEPOSIT")
}
fn owner() -> Vec<u8> {
    env::storage_read(b"owner").unwrap_or_else(|| env::panic_str("NOT_INITIALIZED"))
}
pub fn initialize(value: &str) {
    nonpayable();
    check(!env::storage_has_key(b"owner"), "ALREADY_INITIALIZED");
    check(
        value == OWNER && env::predecessor_account_id().as_str() == value,
        "OWNER_ONLY_INIT",
    );
    env::storage_write(b"owner", value.as_bytes());
}
fn key(h: &str) -> Vec<u8> {
    check(h.len() == 64, "HASH32_HEX_REQUIRED");
    let mut k = vec![b'm'];
    for p in h.as_bytes().chunks(2) {
        let n = |b| match b {
            b'0'..=b'9' => b - b'0',
            b'a'..=b'f' => b - b'a' + 10,
            _ => env::panic_str("LOWERCASE_HEX_REQUIRED"),
        };
        k.push(n(p[0]) * 16 + n(p[1]));
    }
    k
}
fn decimal(mut n: u64) -> String {
    let mut b = [0u8; 20];
    let mut i = 20;
    loop {
        i -= 1;
        b[i] = b'0' + (n % 10) as u8;
        n /= 10;
        if n == 0 {
            break;
        }
    }
    let mut s = String::new();
    for x in &b[i..] {
        s.push(*x as char)
    }
    s
}
pub fn get(h: &str) -> String {
    owner();
    match env::storage_read(&key(h)) {
        None => "null".into(),
        Some(d) => {
            check(d.len() == 10, "STATE_CORRUPT");
            let mut bytes = [0u8; 8];
            bytes.copy_from_slice(&d[2..]);
            let t = u64::from_le_bytes(bytes);
            let mut s = String::from("{\"manifest_hash\":\"");
            s.push_str(h);
            s.push_str("\",\"profile\":\"");
            s.push_str(PROFILE);
            s.push_str("\",\"row_count\":");
            s.push_str(&decimal(d[0] as u64));
            s.push_str(",\"batch_count\":");
            s.push_str(&decimal(d[1] as u64));
            s.push_str(",\"recorded_at\":\"");
            s.push_str(&decimal(t));
            s.push_str("\",\"owner\":\"");
            s.push_str(OWNER);
            s.push_str("\"}");
            s
        }
    }
}
pub fn record(h: &str, p: &str, r: u8, b: u8) -> String {
    nonpayable();
    check(
        env::predecessor_account_id().as_bytes() == owner(),
        "OWNER_ONLY",
    );
    check(p == PROFILE, "PROFILE_INVALID");
    check(
        (1..=32).contains(&r) && (1..=8).contains(&b),
        "COUNTS_OUT_OF_RANGE",
    );
    check(b == r.div_ceil(4), "BATCH_ROW_MISMATCH");
    let k = key(h);
    if let Some(d) = env::storage_read(&k) {
        check(
            d.len() == 10 && d[0] == r && d[1] == b,
            "MANIFEST_REPLAY_MISMATCH",
        )
    } else {
        let mut d = vec![r, b];
        d.extend_from_slice(&env::block_timestamp().to_le_bytes());
        env::storage_write(&k, &d);
    }
    get(h)
}
// Strict flat JSON: only allowlisted fields, strings without escapes, integer counts.
fn arguments(s: &[u8], fields: &[&str]) -> Vec<String> {
    fn ws(s: &[u8], i: &mut usize) {
        while *i < s.len() && matches!(s[*i], b' ' | b'\n' | b'\r' | b'\t') {
            *i += 1
        }
    }
    fn token(s: &[u8], i: &mut usize) -> String {
        check(*i < s.len(), "INVALID_JSON");
        let q = s[*i] == b'"';
        if q {
            *i += 1
        }
        let start = *i;
        while *i < s.len()
            && if q {
                s[*i] != b'"'
            } else {
                s[*i].is_ascii_digit()
            }
        {
            check(
                s[*i].is_ascii_alphanumeric() || matches!(s[*i], b'-' | b'_' | b'.'),
                "INVALID_TOKEN",
            );
            *i += 1
        }
        check(*i > start, "EMPTY_TOKEN");
        let mut v = String::new();
        for b in &s[start..*i] {
            v.push(*b as char)
        }
        if q {
            check(s.get(*i) == Some(&b'"'), "INVALID_JSON");
            *i += 1
        } else {
            check(v == "0" || !v.starts_with('0'), "INVALID_NUMBER")
        }
        v
    }
    check(s.len() <= 512, "ARGUMENTS_TOO_LARGE");
    let mut i = 0;
    ws(s, &mut i);
    check(s.get(i) == Some(&b'{'), "INVALID_JSON");
    i += 1;
    let mut v = vec![String::new(); fields.len()];
    loop {
        ws(s, &mut i);
        check(s.get(i) == Some(&b'"'), "FIELD_REQUIRED");
        let f = token(s, &mut i);
        ws(s, &mut i);
        check(s.get(i) == Some(&b':'), "INVALID_JSON");
        i += 1;
        ws(s, &mut i);
        let n = fields
            .iter()
            .position(|x| *x == f)
            .unwrap_or_else(|| env::panic_str("UNKNOWN_FIELD"));
        check(v[n].is_empty(), "DUPLICATE_FIELD");
        check(
            (s.get(i) == Some(&b'"')) == !matches!(fields[n], "row_count" | "batch_count"),
            "INVALID_FIELD_TYPE",
        );
        v[n] = token(s, &mut i);
        ws(s, &mut i);
        match s.get(i) {
            Some(b',') => i += 1,
            Some(b'}') => {
                i += 1;
                break;
            }
            _ => env::panic_str("INVALID_JSON"),
        }
    }
    ws(s, &mut i);
    check(
        i == s.len() && v.iter().all(|x| !x.is_empty()),
        "MISSING_FIELDS_OR_TRAILING_JSON",
    );
    v
}
#[cfg(target_arch = "wasm32")]
fn input(f: &[&str]) -> Vec<String> {
    arguments(&env::input().unwrap_or_default(), f)
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn new() {
    let a = input(&["owner"]);
    initialize(&a[0]);
    env::value_return(b"null")
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn get_manifest() {
    let a = input(&["manifest_hash"]);
    env::value_return(get(&a[0]).as_bytes())
}
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn record_manifest() {
    let a = input(&["manifest_hash", "profile", "row_count", "batch_count"]);
    let n = |s: &str| {
        s.parse::<u8>()
            .unwrap_or_else(|_| env::panic_str("COUNTS_OUT_OF_RANGE"))
    };
    env::value_return(record(&a[0], &a[1], n(&a[2]), n(&a[3])).as_bytes())
}
#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn ctx(w: &str, t: u64) {
        testing_env!(
            VMContextBuilder::new()
                .current_account_id("csv.testnet".parse().unwrap())
                .predecessor_account_id(w.parse().unwrap())
                .block_timestamp(t)
                .build()
        );
    }
    #[test]
    fn append_replay_read() {
        ctx(OWNER, 7);
        initialize(OWNER);
        let h = "ab".repeat(32);
        assert_eq!(get(&h), "null");
        let a = record(&h, PROFILE, 32, 8);
        ctx(OWNER, 99);
        assert_eq!(record(&h, PROFILE, 32, 8), a);
        assert!(a.contains("\"recorded_at\":\"7\""));
        record(&"cd".repeat(32), PROFILE, 1, 1);
        assert_eq!(get(&h), a);
    }
    #[test]
    #[should_panic(expected = "OWNER_ONLY")]
    fn auth() {
        ctx(OWNER, 1);
        initialize(OWNER);
        ctx("evil.testnet", 2);
        record(&"ab".repeat(32), PROFILE, 1, 1);
    }
    #[test]
    #[should_panic(expected = "MANIFEST_REPLAY_MISMATCH")]
    fn mismatch() {
        ctx(OWNER, 1);
        initialize(OWNER);
        record(&"ab".repeat(32), PROFILE, 1, 1);
        record(&"ab".repeat(32), PROFILE, 2, 1);
    }
    #[test]
    #[should_panic(expected = "COUNTS_OUT_OF_RANGE")]
    fn bounds() {
        ctx(OWNER, 1);
        initialize(OWNER);
        record(&"ab".repeat(32), PROFILE, 0, 1);
    }
    #[test]
    #[should_panic(expected = "BATCH_ROW_MISMATCH")]
    fn invalid_pair() {
        ctx(OWNER, 1);
        initialize(OWNER);
        record(&"ab".repeat(32), PROFILE, 5, 1);
    }
    #[test]
    #[should_panic(expected = "PROFILE_INVALID")]
    fn profile() {
        ctx(OWNER, 1);
        initialize(OWNER);
        record(&"ab".repeat(32), "bad", 1, 1);
    }
    #[test]
    #[should_panic(expected = "HASH32_HEX_REQUIRED")]
    fn hash_size() {
        ctx(OWNER, 1);
        initialize(OWNER);
        record("abc", PROFILE, 1, 1);
    }
    #[test]
    #[should_panic(expected = "LOWERCASE_HEX_REQUIRED")]
    fn hash_chars() {
        ctx(OWNER, 1);
        initialize(OWNER);
        record(&"ZZ".repeat(32), PROFILE, 1, 1);
    }
    #[test]
    #[should_panic(expected = "ALREADY_INITIALIZED")]
    fn reinit() {
        ctx(OWNER, 1);
        initialize(OWNER);
        initialize(OWNER);
    }
    #[test]
    #[should_panic(expected = "OWNER_ONLY_INIT")]
    fn init_auth() {
        ctx("evil.testnet", 1);
        initialize(OWNER);
    }
    #[test]
    fn parser() {
        assert_eq!(
            arguments(
                br#"{"row_count":32,"batch_count":8}"#,
                &["row_count", "batch_count"]
            ),
            vec!["32", "8"]
        );
    }
    #[test]
    #[should_panic(expected = "UNKNOWN_FIELD")]
    fn plaintext_denied() {
        arguments(br#"{"plaintext":"secret"}"#, &["owner"]);
    }
    #[test]
    #[should_panic(expected = "DUPLICATE_FIELD")]
    fn duplicate_denied() {
        arguments(br#"{"owner":"a","owner":"b"}"#, &["owner"]);
    }
    #[test]
    #[should_panic(expected = "INVALID_FIELD_TYPE")]
    fn quoted_count_denied() {
        arguments(br#"{"row_count":"1"}"#, &["row_count"]);
    }
}
