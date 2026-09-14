# Pure candidate observation replay

`validate_observations(phase, frames, child_report, expected_source_hashes)`
accepts the original complete ordered JSONL frame list, the separately replayed
actual child report, and the five exact externally bound observer source hashes.
It performs no imports of runtime helpers, filesystem reads, process discovery,
allocation, signals, or cgroup writes. All parsing is local and deterministic.

The caller still must validate the full source-bound child protocol, every
actual control write/ACK ordering, complete capsule output, private systemd
identity/readback, and all capsule/unit/leaf/wrapper cleanup domains. This
validator does not replace any of those checks. Its bool means the bounded
observation evidence is consistent with the actual child records, not a generic
production or hostile-candidate assurance.

Admission requires the exact before-unit capacity → baseline → before-work
capacity → workers-held → release-observation sequence, one actual ready and
terminal, matching unit and resource control, the exact terminal five-source
map, every ordered observation SHA, and known local observer-handle closure.
Observation hashes use the emitted JSON object's actual insertion order, not a
new sorted representation. Baseline/source/readback facts are independently
cross-bound to the resource ready rather than inferred from releaseAdmitted.

Each retained file record is decoded from bounded raw hex and verified for
byte length, SHA, regular-file identity and parsed value. The same directory
and file identities persist across increasing sample sequence and monotonic
times. Counter key sets cannot change or reset; optional memory.events.local
absence is explicit ENOENT and must remain unchanged. The observer cgroup
must be outside the leaf and match the independently supplied ready control.

Both capacity samples reparse actual /proc/meminfo and the four fixed ancestor
memory/pids limit/current files. They require the declared 4 GiB memory and
128-task headroom; max means unlimited, never a missing file. Host-before and
host-after metadata retain the same identity. Matching outside pid/cgroup
namespace views accompany both capacity observations; the worker's fresh PID
namespace must differ. These observations are not resource reservations.

The actual worker held identity and every child start tick are matched to
observer host-PID/NSpid mappings within its retained leaf sample. Outcome
records must preserve these mappings, keep the worker alive, and cannot turn
a previously readable pidfd back into a live one. Observer returnCode remains
null and reapedByObserver remains false: actual worker wait results supply
the exit status, not a fabricated observer reap.

Tasks require actual fork EAGAIN, pids.current=64 at held and release, a rising
pids.events.max counter, and all held children normally reaped after release.
Memory requires both held allocators, actual ramp-complete, rising max/oom/
oom_kill counters (also local counters when available), a matching allocator
pidfd exit and worker wait -SIGKILL. Every normally reaped survivor must have
H,F progress and must not already have been observed exited before release.
The still-live worker and complete source-bound child cleanup remain required;
an OOM-killed supervisor cannot satisfy this contract.

Tests are authored offline fixtures. `complete_observations(phase,
expected_source_hashes=None, boundary=None, optional=True)` returns `(frames,
child_report)` for downstream complete measure tests. The caller may supply
its actual resource-boundary fixture; `rehash(frames)` recomputes observation
hashes after an explicitly authored test mutation. Neither function creates
runtime evidence. No exhaustion experiment has been run by this component.
# Explicit common-view profile (additive)

`validate_common_observations(phase, frames, child_report, expected12, deps)` is a separate entry. `deps` is exactly `(codec, service, sampler, target, events, linkage)` supplied as captured/source-bound private modules, with each `__source_sha256__` equal to its expected source hash. These annotations are trusted caller bookkeeping, not cryptographic object provenance. The service/target/linkage validators receive the same sampler/events instances; this module neither imports source nor creates an EventReader.

The legacy four-argument source5 validator retains its exact terminal/profile contract. The common entry accepts source12 and the explicit `common-visible-cgroup2-v1` terminal plus `documents` mapping of codec summaries. It replays all six codec documents, validates original service/target/linkage content, preflight receipt counters/cleanup/source binding, common-ready digest and ordering, then runs shared raw capacity/event/worker outcome checks on the original frames. No rewritten terminal or synthetic legacy observation is constructed. The driver separately proves original JSONL bytes equal canonical codec frames before supplying parsed frames here.

Capacity observations in the new entry carry `{namespaceEvidenceProfile, view:{beforeDocument,afterDocument}, capacity}`. Snapshot labels bracket the original capacity seal; actual raw ancestor file devices must match the bound visible directory devices. The service observer identity/private manager peer fields must match the actual target boundary. Baseline, target's two retained-reader samples and held sample preserve directory/file identities, counter monotonicity and increasing sequence. Target uses the exact after-open snapshot; full document transmission must precede its dependent observation. Driver still owns actual control-write freshness, capsule/source replay, systemd unit cleanup and shared wire limits. Codec completion alone grants nothing.

New-profile tests use real service, sampler, target and linkage pure validators, both stress phases, source/profile confusion, partial/duplicate documents, accurate new hashes over corrupt content, receipt failures, capacity timing/device/reference failures, manager/driver mismatch and target-to-held sample continuity. No actual workload, service or OS metadata reads are performed by the validator.
