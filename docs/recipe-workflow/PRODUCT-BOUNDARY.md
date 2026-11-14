# First private-work workflow: enterprise data preparation

Status: bounded recipe executor and buyer/provider integration implemented and tested. Not a completed generic private-AI system.

## Evidence and inference

The original idea was a Codex synthesis, not an instruction or endorsement from a judge. The source archive is `/Users/mete/Desktop/NEAR-Hackathon-2026-Arastirma/Juri-X-6-Ay/TEZLER-VE-PROJE-FIKIRLERI.md`; it explicitly limits X coverage and separates authors' views from official judging criteria.

Rechecked 14 November 2026:
- https://a16zfrontier.com/posts/article/building-networks-for-agents/ — business procurement, matching price/delivery/payment terms, reliable performance and dispute rules. Author Guy Wuollet; not a personal statement by judge Eddy Lazzarin.
- https://electriccapital.substack.com/p/open-sourcing-quest — company finance, legal, customer and email context, user-controlled disclosure. An internal trust boundary, not encrypted execution where all processing code remains blind.
- https://www.sapiom.ai/blog/the-next-trillion-agents/ — agents purchasing services, runtime policy, cost and outcome accounting. Describes Sapiom; not evidence of demand for NOPE.
- https://docs.market.near.ai/ — common brief/deliverable job protocol and agent subcontracting. Payment documentation is version-sensitive: held balances in the current product must not be conflated with historical NEAR-token escrow.
- https://docs.zama.org/concrete-ml/llms/inference — encrypted hybrid LLM inference exists, with local nonlinear layers and remote encrypted linear layers. This does not provide a drop-in general LLM server for the existing application.

## Product choice

Implement a narrow, real confidential service procurement workflow first: a company commissions a clearly specified normalization of a customer/supplier export, and evaluates its delivery against immutable transformation rules. This is an implementation choice derived from the sources, not a claim that judges requested CSV cleaning. Do not turn a demo preset into a claim that arbitrary company workflows are supported.

A public job brief, processing recipe, row count and limits can be disclosed; customer/supplier rows, unrelated columns and output decoding information remain on the buyer's device. Providers bid without receiving those records. The selected provider invokes computation on labels/tables, and returns encoded output. The buyer decodes and compares locally. Rules may be planned from an approved public schema and synthetic examples; real records must not be sent to an ordinary remote LLM.

## Still required after this stage

An agent-native procurement planner must be integrated before claiming autonomous hiring/planning. A configurable deterministic encrypted executor is infrastructure for an agent, not itself a general AI model. Text normalization does not perform semantic entity resolution, legal interpretation, address inference, translation or arbitrary AI tasks. Current private bounds and formula safety must be explicit in the UI.

Customer reference checks are not transferable zero-knowledge execution proofs. Testnet escrow and objective dispute settlement are separate subsequent stages; direct testnet transfers are not escrow. Do not advertise those stages as completed by this change.
