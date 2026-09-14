# Systemd stock CLI proxy refusal measurement

Source implementation only; no actual run yet. The fixed relay selector is
`--cli-proxy-refusal`, with no FD198, SCM handoff, ingress broker or generic RPC.
Existing systemd ownership/ready/terminal records remain their actual wire
shapes. This wrapper reuses private-peer, MainPID generation, resource readback
and cleanup validators and the source-bound stock CLI refusal child replay.

The exact source inventory is30: basic refusal26 plus the resource measurement,
relay, resource probe and this wrapper. All copied helpers and actual parser/
validator dependencies are included. Before START, the own UUID/private peer,
fixed2GiB/swap0/tasks64 readback, ten current helper hashes, pinned CLI/bwrap and
owned loopback metadata must match. The separate prestart readback and identical
ready-to-terminal control generation remain mandatory. Limits220/200/5 and
proxy2s/metadata12/22s are unchanged.

Success needs the actual stock95-byte CONNECT, full local403, two same-process
endpoint observations and child/helper cleanup, plus complete capsule byte
accounting, pidfd/namespace cleanup and own unit/leaf/systemd-run removal.
Neither socket refusal nor systemd readback implies the other cleanup domain.
The observations are sequential holder evidence, not exclusive atomic byte
authorship. No credential/auth, upstream/TLS, model inference, candidate
exhaustion or general hostile-descendant guarantee follows.

Actual execution requires a new source archive and independent source review
handoff. Existing basic PASS and all earlier FAIL remain historical artifacts.
