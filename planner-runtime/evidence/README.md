# Frozen evidence, not a general quality claim

`approved-38ce0d9/generation-evidence.json` is an exact copy from commit 38ce0d9.
`approved-38ce0d9/freeze.json` records hashes of the unchanged worker, lifecycle,
model manifest, dependency lock and native generation script. It also hashes the
actual shared message builder's output for each public synthetic task. Both Node
and browser call that worker's same `generatePlan` / `buildPlannerMessages`, with
non-thinking greedy decoding and at most 256 new tokens. Backends may still differ.

The eight checks mean: **four exact supported plans, two explicit unsupported
refusals, two mixed requests rejected for malformed output**. They do not establish
eight correct semantic interpretations or general natural-language usability.
The original active evidence file remains unchanged; this copy and hashes prevent
later test runs from silently replacing the approved snapshot.

`earlier-observed-failures.json` preserves log excerpts transcribed from this chat's
earlier actual native runs. Its provenance is explicitly weaker than the frozen
original artifact: the initial JSON evidence was overwritten before freezing and
has not been recovered. The initial nested prompt source remains in commit
45263b0. Historical validation messages are not reinterpreted using today's parser.

The exact additional UI paraphrase was tested without changing any active model,
prompt, dependency or worker. See `../ui-phrase-evidence.json` and rerun with
`node planner-runtime/verify-ui-phrase.mjs` (exit 1 on a nonexact plan). It failed in
3971 ms after loading on CPU, emitting:

```json
{"operations":[["C2","trim","leading","spaces"],["C2","lowercase"],["C3","fill",0],["C3","clamp",0,100]]}
```

`trim` has four tuple fields instead of two; the adapter rejects everything. This
reproduces the reported browser rejection. It is a supported goal the current
candidate could not encode reliably. The evidence implicates model/prompt
paraphrase handling rather than a browser-only runtime problem; it does not isolate
model capacity from prompt design. The frozen candidate must not be described as
a generally usable cleaning planner based on the original four positives alone.
Evaluate any proposed prompt/model upgrade separately against this paraphrase and
additional held-out tasks before replacing the frozen candidate. No hidden
fallback, tuple repair, keyword planner or dropped operation was introduced.
