# Five-language product and documentation audit — 14 November 2026

Scope: active landing, workspace/onboarding, customer/provider overview, jobs,
create-job, job detail, offer, delivery, payments, activity, settings, public
verification and new /docs. TR, EN, DE, ES, FR. Historical standalone engineering
experiments are not active product navigation.

## Implementation

- All five main UI catalogs contain 821 matching source keys. Numeric interpolation
  placeholders match. Internal English diagnostic source keys now have Turkish
  values in the Turkish catalog too. Unknown SDK/browser/RPC messages produce a
  localized visitor-facing failure, rather than leaking an unlocalized diagnostic.
- Explicit text/attribute bindings change built-in copy in place. No global
  translation of customer records, CSV headers/cells, public goals, display names,
  quote notes, addresses, hashes, amounts or serialized protocol fields is added.
- Existing country selection/manual preference remains. User-selected language
  survives navigation; switching never reloads or replaces filled workspace forms.
- Bottom-left documentation is available from workspace and verifier, including
  narrow layouts; landing footer links to it. /docs reuses workspace.css, same fonts,
  logo, cream/blue palette, sidebar, panels and controls.
- Documentation has 10 sections, 39 items, 6 logical components, 8 workflow steps,
  customer/provider directions, worked example, 3 copy-only templates, capability
  limits, visibility/trust boundaries, verification, FAQ and glossary. No template
  button uploads files, publishes a job, starts a model or sends a payment.
- Documentation catalogs are structurally checked, including invariant code/routes.
  Both catalog checks gate every build. Loader validates structure, bounds transfer,
  times out requests, and falls back coherently to English. Concurrent language
  requests cannot overwrite the latest selection. The current anchor is retained.

## Verification and its limits

Actual Chrome local UI checks used the real front-end, native language selector,
real local browser vault and a separate **read-only synthetic API fixture** on
127.0.0.1:8776. Only local fixture session creation was permitted; remote job,
model/proof/chain/payment mutations were disabled. These are localization checks,
not new real-payment or independent-proof evidence.

Observed in all five languages:
- Create-job labels/options and filled title remain intact across switches.
- Provider offer fields, invalid amount error and filled raw note remain intact.
- Provider encrypted execution/delivery controls and customer missing-vault state.
- Escrow HELD, PAID, REFUNDED, FUNDING_PENDING, ERROR; legacy manual DUE controls.
- Activity table headers/status/date and identity/vault warnings.
- All documentation section headings, eight stages and three template controls.

Documentation clipboard check copied the exact synthetic CSV. Switching French to
German at #templates retained that anchor and its translated active navigation
label. At a requested 375x812 viewport Chrome reported client/page width 360/360 in
all five languages: no horizontal page overflow; documentation link remained
visible. Viewport override was reset afterwards. No browser screenshots were sent.

Automated rendered-route audit covers **77 route/role/status cases × 5 languages**,
including 385 initial views plus 385 live switches, raw customer content retention,
local decoding, translations on dynamic labels, known/unknown errors and request
counts. Model/API/finality/proof metadata in these tests are explicit fixtures.
They do not claim a model download, SNARK prover or real-chain transaction.

Documentation tests additionally verify safe text-only rendering, clipboard-only
actions, missing/malformed/oversized catalog handling, coherent fallback and
anchor preservation. The documented mixed text/numeric example is independently
checked against the actual reference operations and compiler/proof limits.

The broader repository regression and production deployment checks are recorded
by the completing run; no payment, encryption algorithm, proof relation or escrow
contract is changed by this UI/documentation update.

## Regression outcome

The complete repository run had 434 tests: 433 passed; one old assertion expected
an unknown raw English SDK error in the interface. Its intended behavior changed
to a localized failure. The test was updated to also require no raw diagnostic
leak, while retaining zero-v3-fallback/zero-publication assertions. The corrected
proof UI plus i18n group passed 18/18. Final documentation/rendered-route/draft
group passed 15/15 after all Turkish diagnostic translations were frozen.
Both catalog gates and the production allowlisted build (77 static assets) pass.
Independent read-only review found an identity-translation membership edge case;
the membership helper and a specific regression test now cover it. No unresolved
finding remained in that review.
