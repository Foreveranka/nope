# Remote transport profile: implemented validator, pending native edits

12 November 2026. This step owns only new `mpc/network_profile.py`, new
`tests/test_mpc_network_profile.py` and these new operator deployment templates/
notes. Existing native files, transport patch, sealed client, bootstrap, build
stamp, operator daemon and other workers' files were not edited. No native build,
provisioning, deployment, credential operation or network test was performed.

## Runnable implementation now

```sh
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests \
  -p test_mpc_network_profile.py -v

PYTHONDONTWRITEBYTECODE=1 python3 -m mpc.network_profile \
  --profile /etc/veil-mpc/network-profile.json \
  --expected-sha256 "$APPROVED_NETWORK_PROFILE_HASH" \
  --selection-manifest /etc/veil-mpc/selection.json \
  --party 0 --allow-remote-network
```

**22 tests passed.** The CLI exits **3** for a valid rendering and **2** for
invalid/unapproved/not-opted-in input. It never launches a command, writes a peer
file, connects, resolves DNS or changes loopback behavior. The template contains
deliberately invalid placeholders and no trusted synthetic committee or keys.
Approved hashes must arrive through an authenticated operator configuration
channel, never be recomputed and trusted from an HTTP request.

Callable interfaces:

```python
validate_profile(profile, approved_sha256, selection_manifest,
                 allow_remote=True, now=unix_seconds)  # frozen ValidatedProfile
render_profile(profile, approved_sha256, selection_manifest,
               party=0, allow_remote=True, now=unix_seconds)  # public dict
```

`allow_remote` must be the actual boolean `True`. Strict UTF-8/size/depth/duplicate
checks, exact schemas, literal canonical IPv4 only, three distinct ordered party
addresses, seven distinct P/C leaf DER pins and a distinct CA DER pin are enforced.
DNS, URLs, IPv6, loopback, link-local/metadata, multicast, wildcard, reserved and
ambiguous address representations fail. Public and private/VPN addresses may be
declared by an approved administrator; ownership/reachability is not checked.

Ports are fixed: client base **17400**, peer base **17500**, each plus party
number. No port/base override field is accepted. These are raw MP-SPDZ TLS ports,
not HTTPS services. The v2 manifest's authoritative validator and domain-tagged
digest bind full frozen commitments/intent/roster, registry job ID/binding hash,
and selection round. The profile expires in at most 24 hours and no later than
the job result deadline. Clock checks use integer seconds conservatively; a job
closed within the current fractional second can require waiting to the next
second. Epoch is a pinned declaration, not a durable anti-rollback journal.

Rendering provides `peers_text` (ordered `address:peer_port` lines), own bind
address/ports, P TLS identity/pin, client endpoint tuples, fixed working/config
paths and per-party/per-client argv arrays. `pending_native_argv` and
`pending_client_argv` include future, **currently unimplemented** profile flags;
they are launch specifications, not executable support today. Do not strip these
flags or tunnel around the current loopback guard. No arbitrary executable,
path, flags, shell command, private input or environment fields are accepted.

The `program` declaration pins source, patch, recipe, binary, bytecode and
schedule; its safe basename must start with `sealed_v2_<selectionDigest[:16]>`.
The current circuit already accepts client port base as a public compile
argument. Approved bytecode must actually be compiled with **17400**; this module
does not inspect bytecode or claim those declarations were built/installed.

Every valid report keeps `execution_blocked:true`, `launch_supported:false`,
`commands_executable_now:false`, `deployment_allowed:false`, and all actual
TLS/artifact/finality/network/independence checks false. The existing operator
daemon's execution-blocked status is unchanged.

## Exact next native/client edits, before applying them

The source paths below are under `mpc/vendor/MP-SPDZ/`. They were inspected at
the pinned upstream with the existing `mpc/patches/local-transport.patch` applied.
Any durable change must be represented in that tracked patch, not just vendor
working files.

| File/function | Necessary change | Compatibility/security requirement |
| --- | --- | --- |
| `Tools/NetworkOptions.h/.cpp`: `NetworkOptionsWithNumber`, `start_networking` | Register explicit remote opt-in/profile/path/hash flags; validate or consume a rigorously validated local profile before `Names` constructs sockets; force three parties and the approved address/port table. Expose validated own bind address for peer and external listeners. | No default activation or env-only wildcard bind. Missing/invalid pins, wrong slot, unknown transport, altered peer file or changed profile must abort before listening. The rendered flags are the proposed interface; native profile consumption is not implemented yet. |
| `Networking/ServerSocket.h/.cpp`: constructor | Add an explicit bind-address path using strict IPv4 parsing. Keep the existing loopback constructor/default. Reject unspecified/wildcard and unapproved addresses in remote mode. Forward this through `AnonymousServerSocket`. | Do not replace `INADDR_LOOPBACK` with `INADDR_ANY`. Preserve local tests and accept/cleanup behavior. |
| `Networking/Player.h/.cpp`: `Names::setup_server`, `PlainPlayer::setup_sockets` | Carry the approved own endpoint to `ServerSocket`. Keep upstream `-ip` ordered `host:port` loading, but compare all three lines with the approved profile. In remote mode, change **self-connect** from hard-coded `127.0.0.1` to the approved own bind IP. | `CryptoPlayer` internally creates two `PlainPlayer` instances, so a remote-only listener otherwise fails before peer TLS. Preserve loopback self-connect for the default mode. |
| `Processor/ExternalClients.cpp`: `ExternalClients::start_listening` | Pass approved own bind IP to the anonymous client listener and require the compiled base 17400/own slot port in remote mode. | Preserve each C0–C3 exact expected identity and existing TLS handling; no wildcard HTTP-controlled listener. |
| `Networking/ssl_sockets.h` existing patch hunk | Preserve `verify_peer`, `verify_fail_if_no_peer_cert`, chain/role-name verification and exact DER comparison for each expected P/C certificate. Profile-to-local CA/leaf file digest checks must happen before any native listener. | No relaxation, CA-only replacement or use of endpoint IP as TLS identity. Normally no semantic change to this TLS hunk is needed. |
| `mpc/sealed_client.py`: `connect`, `run`, CLI | Add optional keyword-only approved profile/pin/explicit opt-in; validate v2 selection/profile before connecting; use approved address/client port for P0–P2 while keeping server names P0–P2 and exact pinned DER. Match own C identity/key and pinned local CA/leaves first. CLI accepts the same future profile flags. | Existing positional `run(...)` and local `connect(...)` behavior stay intact. Keep secret stdin, exact active triples, frame bounds, manifest hello, completion markers, timeouts and cleanup. Close the newly opened raw/wrapped socket if TLS verification fails before appending it to the connected list. |

The native profile-consumption implementation/launcher is an additional code
extension, not supplied by this offline step. It must connect these hooks as
one validated configuration; merely adding flags or an address environment
variable is insufficient. Avoid automatically provisioning addresses from an
incoming job. A dedicated per-party launcher should reuse the new immutable
validator, verify actual local artifacts/TLS key ownership, reserve the round,
and supervise only its own party. No existing all-input synthetic harness should
be promoted to a real bidder coordinator.

`service/bid_client.py` imports/calls `sealed_client.run(..., codec_version=2,
expected_manifest_hash=...)`. **No service or packaging edit is necessary for
default behavior.** Introduce only optional keyword parameters; remote client
configuration should later be server-owned, never fields in a bid POST.

## Build overlap and verification cost

Native edits above affect `libSPDZ.so` and the SPDZ2k executable. Header changes
can also rebuild broad dependent objects/templates. The existing Makefile links
`spdz2k-party.x` against `libSPDZ.so`; do not assume a single-file quick rebuild.
Refresh `mpc/.local/build-stamp.json` and build evidence through the approved
bootstrap flow only after a successful secure build, because `run_local.py`
compares binary, shared-library, config and transport-patch hashes. There is no
need to change/re-download dependencies, disable secure OT, or change the
arithmetic circuit for this transport step.

Do **not** overlap a large native build with the active payments Cargo compile.
Defer it until resources are free; use the established native `-j1` policy.
Source preparation can be reviewed separately. The renderer/validator and these
tests need no native build.

After extension: rerun old local v1/v2 and all native TLS negatives; then run an
actual three-host/network-namespace synthetic selection, including wrong
slot/leaf/CA, missing client, foreign manifest, timeout/abort and cleanup. Measure
WAN behavior rather than projecting loopback runtime. Existing separate provider
testnet accounts map to C1–C3 bidders; P0–P2 are computing operators. Three account
keys or three technical servers under one administrator establish neither
independent administration nor publicly provable execution. External runtime
and authenticated chain-to-profile binding remain unverified until tested.
