# Fixed systemd exec-environment metadata measurement

Run from the repository root with no arguments:

`python -B scripts/subscription-exec-environment-systemd.measure.py`

This is a new measurement, not an authenticated dispatcher. Actual execution requires the separately reviewed basic metadata prerequisite and source gate. No actual run was performed during implementation;32 scoped offline tests pass using explicit synthetic receipts and the real parent report validator.

The module reuses the existing `subscription-cli-supervisor.measure.py` reader/control/heartbeat/source-receipt loop. It supplies only the literal WSL clean-env command invoking `subscription-systemd-fixture-transport.py --environment-metadata`. There is no caller command, environment, profile, unit, PID or resource-limit input. The existing driver208s local bound is unchanged; a local wrapper kill never proves remote cleanup. The independent systemd guardian remains220/5s, inner command200/5s, job180s and output8MiB. Candidate aggregate limits are2GiB/swap0/tasks64; exact readback is measured, not exhaustion or hostile escape resistance.

Before dispatch, the wrapper observes exactly one immutable systemd ownership frame and validates the resource-ready receipt against its UUID, UID, leaf, controller PID and frozen relay/probe hashes. It requires pinned CLI/bwrap IDs, private socket peer profile, manager UID, namespace socket component metadata, manager/MainPID generation fields, and controller/manager outside the owned leaf. Only then does the original driver's seven-helper metadata start admission run. Failure/duplicate ownership cannot grant start admission. No additional stdout reader competes for the pipe.

Final validation requires ready-to-terminal equality for all resource/control metadata, exact preStartReadback, no relay errors and own unit/leaf/systemd-run cleanup. The original validator independently requires matching mode/start/terminal, EXITED/child0/wrapper0, raw output hashes, namespace-empty pidfd/ESRCH evidence and the actual parent metadata report. Known failure frames never pass. Resource metadata are sequential trusted-controller observations, not atomic cgroup or executable attestation against a privileged concurrent writer.

All current copied helper sources plus supervisor, shell, parent/gate validators, relay, systemd probe and both measurement files are hashed before and after. The reused driver is compiled from exact checked bytes; its loaded digest must also match the pre-launch inventory. Current offline revalidation refuses changed sources before invoking the real parent validator. Historical manifests and earlier basic runs receive no new credit.

Each attempt creates `scratch/session8-systemd-exec-environment-metadata-UUID/receipt.json` and `candidate-frames.jsonl`, plus the existing driver's uniquely matched `scratch/session8-cli-exec-environment-metadata-measure-UUID.json`. The wrapper receipt begins PREPARED and records final failure/success, candidate byte/hash evidence and the driver artifact hash. The JSONL file preserves exact candidate lines passed by the existing bounded reader, including malformed JSON/pre-ready failures. Overlong or cumulative-overbudget lines rejected before that seam are outside this archive: it is not an unconditional full-wire transcript. Parent stdout/stderr bytes remain separately base64-archived inside the original driver's child report.

Offline tests cover full parent/resource receipt replay, before-start ownership gating, retained pre-ready failure evidence, spoofed/current-source mismatch before import, changed command/helper, peer/UID/cgroup/socket/generation drift, wrong readbacks, false exhaustion credit, bool-vs-int confusion and missing unit/leaf/process cleanup. They do not launch a capsule, systemd unit, socket, model or network operation.

Main source review found malformed ready values could raise AttributeError before the explicit admission refusal, leaving a reader exception until the lease expired. An initial dictionary guard now returns false; null/list negatives verify that the dispatch wrapper raises its bounded ValueError immediately and never calls start. Updated scoped suite:35 PASS. No actual run occurred; the earlier32-case result remains historical.
# Separate fixed bootstrap selector

No arguments retain the original no-filesystem metadata measurement.
The sole additional argument `--bootstrap-metadata` selects the distinct
bootstrap scenario and matching literal relay flag. The expected scenario is
bound to the command, start, parent validator and final evaluation; changing a
report label cannot convert one profile into another. The resource and cleanup
requirements remain identical. Neither profile has actual systemd credit until
its own reviewed run succeeds.

## Explicit controlled-bootstrap measurement

`--bootstrap-controlled-cleanup` selects only the literal relay argument
`--environment-bootstrap-controlled` and capsule mode
`exec-environment-bootstrap-controlled`. The existing no-argument and
`--bootstrap-metadata` profiles retain their original validators and lifecycle
expectations. The new basic replay invokes only
`parent.validate_controlled_bootstrap_report`; changing a natural-profile label
cannot grant its controlled-cleanup credit. All existing exact seven helper,
source-before/after, private-peer identity, prestart resource readback, unit/leaf
absence and wrapper cleanup requirements remain shared and strict. No timeout,
resource limit, queue or escalation rule changed.

The basic source inventory now includes the copied trusted-control parent and
probe (19 entries); their presence does not enable a trusted-control runtime
scenario. 174 scoped offline tests across the basic measurement, relay and this
systemd measurement passed, including new profile selectors, exact helper/start
admission, foreign profile rejection and actual independent parent replay fixtures.
No runtime was performed for this implementation; fixtures confer no actual credit.
