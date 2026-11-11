use std::collections::BTreeSet;
use wasmparser::{Parser, Payload, Validator};

#[test]
fn compiled_wasm_validates_exports_registry_methods_and_has_no_payment_actions() {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/target/wasm32-unknown-unknown/release/veil_registry.wasm"
    );
    let wasm = std::fs::read(path).expect("build Wasm first (README.md)");
    Validator::new().validate_all(&wasm).expect("invalid Wasm");
    let mut exports = BTreeSet::new();
    for payload in Parser::new(0).parse_all(&wasm) {
        match payload.unwrap() {
            Payload::ExportSection(section) => {
                for export in section {
                    exports.insert(export.unwrap().name.to_owned());
                }
            }
            Payload::ImportSection(section) => {
                for import in section {
                    let import = import.unwrap();
                    assert_eq!(import.module, "env");
                    assert!(
                        !import.name.starts_with("promise_"),
                        "unexpected cross-contract/fund action: {}",
                        import.name
                    );
                }
            }
            _ => {}
        }
    }
    for name in [
        "new",
        "owner",
        "network_domain_hash",
        "get_job",
        "create_job",
        "submit_bid",
        "close_bids",
        "begin_attempt",
        "begin_selected_attempt",
        "report_result",
        "decide_result",
        "expire_job",
    ] {
        assert!(exports.contains(name), "missing Wasm export {name}");
    }
}
