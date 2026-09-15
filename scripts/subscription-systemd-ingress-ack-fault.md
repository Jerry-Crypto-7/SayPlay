# Stopped owned receiver before SCM_RIGHTS

This fixed fault experiment is implemented in four new files; shared receiver,
rendezvous and relay sources are unchanged. Actual chronology is recorded below.
The main agent dispatches the Windows measurement only after joint source gate.
No entry accepts arguments. The Windows command is a fixed clean WSL invocation;
the Linux entry selects the existing ingress profile in a private relay module.

The experiment wraps one private rendezvous instance. It first lets the real
receiver HELLO pass the existing validation and lets the actual fixed fd_offer
write complete. It then rechecks own-unit binding, duplicates the already
retained receiver pidfd, sets CLOEXEC, and compares same-generation process
metadata. Only that duplicate receives SIGSTOP. Its live state, start ticks and
cgroup are checked before and after observing stopped state T/t. No numeric
kill, manager signal, arbitrary target, SIGCONT or direct TERM/KILL is added.

The original transfer then performs its unchanged readback/binding/source/path
checks and exactly one SCM_RIGHTS send. The observer forwards the actual call
and records its return count. The stopped receiver cannot acknowledge that
handoff during the original five-second setup deadline. A return count of one
means kernel send acceptance; receiver installation remains unknown. This is
not a short-byte-send claim or proof that FD198 was installed.

The expected experiment PASS requires all of: actual STOP before the one send;
send return count one; no ACK; original deadline reached; persistent companion
fence; refusal by the same module's next constructor before any new provisioning;
known relay failure; exact own-unit/leaf/systemd-run cleanup; rendezvous path and
socket cleanup; and ESRCH through the separately retained pidfd before closing
it. The route never starts. A ready, capsule or successful handoff frame rejects
this expectation. The underlying transfer/relay outcome remains FAIL even when
the expected-fault measurement passes.

The manager may resume a stopped process while delivering its normal termination
signal. No KILL escalation, permanently stopped process or observed five-second
TERM grace is required or credited. Existing resource properties, setup 5s,
manager grace 5s and guardian 220s remain unchanged. This adds no capsule,
namespace-cleanup, credential, auth, external-network or inference credit.

After that resume the receiver could process queued rights during cleanup.
Installation therefore remains unknown; absence of a relay ready frame does
not prove that no later descendant or namespace ever existed. Only the final
owned-unit/pidfd cleanup state is credited. An observed capsule terminal is
outside this preselected expected wire and fails this particular experiment.

The final Linux report is emitted only through an explicitly nonblocking bounded
2-second write. The Windows capture has a predeclared 35-second local wait and
bounded 2 MiB retention per stream. An unknown local wait or reader cleanup is
a failure, with no restart or numeric process cleanup. It does not authorize
another experiment. Unique scratch JSON preserves the raw wire bytes, source
hashes and failed receipts. The same 30-source integration inventory plus both
new runtime measurement files is bound before, after and during current replay.

The driver owns an empty stdin PIPE kept open until wait completes or local
setup fails. No START or other bytes are written. This allows the relay to
register its input with epoll; /dev/null is not a compatible input. Thread
setup failure records unknown wait, closes unassigned streams and the owned
stdin writer, and archives bounded observations without signalling a WSL PID.

Offline tests cover independent expected-failure replay, each timing/send/ACK/
cleanup negative, wrong generation/foreign manager and signal failure before
SCM, exact wrapper ordering through the existing companion, same-module fence,
nonblocking write admission and isolation of the single systemd-run Popen hook
from subprocess.run's ordinary systemctl subprocesses.

## Actual run and isolated classifier correction

The first local attempt `3018cbcd-bd82-4e1b-bc8a-c05333c5aa6d` was blocked by
`Wsl/Service/E_ACCESSDENIED` before Linux admission. The separately authorized
same-command escalation produced raw attempt
`e6c44cbb-0fe3-4fcb-999c-10df9dd287dc`, SHA-256
`dcd396ae845541544b85704c4f7e54e3c08f0e74d489dad412bb6d3614906a67`.
It remains FAIL against its original exact classifier: the companion's
`receive_plain` raises `HANDOFF_DEADLINE`; the initial classifier incorrectly
expected the receiver module's different `RECEIVER_SETUP_DEADLINE`.

The raw records HELLO, own pidfd STOP, matching state T, one SCM send returning
one, zero ACKs, timeout after 5008.6 ms, the same-module fence/refusal, retained
pidfd ESRCH and closure, and owned unit/leaf/run/socket/directory cleanup.
Receiver installation remains unknown. All 32 archived source bytes matched
before/after/current at original finalization. The archive
`session8-ack-fault-source-archive-f3ac38b6-e130-4818-b0ed-27f6d18b2324` and raw
FAIL are unchanged.

Only the two exact classifier literals and corresponding tests were corrected
after that run. The receiver setup timeout is now an explicit negative test;
arbitrary timeout messages are not accepted. This correction does not change
any runtime deadline or retroactively turn the original report into PASS.
Any separately labelled offline revalidation requires independent review;
no additional actual experiment is needed for this classifier-only change.
