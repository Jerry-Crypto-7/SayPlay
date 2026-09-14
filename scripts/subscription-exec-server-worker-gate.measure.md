# Executor worker gate measurement

This is the isolated driver for the fixed credential-free executor mode. The
first integration uses the basic capsule, with aggregate resource enforcement
explicitly unvalidated. It is not an authenticated execution transport, model
call, broad hostile-descendant guarantee or cgroup-exhaustion experiment.

The strict probe validator requires the full exact path/call/status/environment/
descriptor report. All sentinel and boundary probes are open-only with zero
bytes read or written. Protected paths must report a denied open. The two
`/proc/1/fd` paths may report an open only when its descriptor differs from both
outer protected control/output tuples. Standard descriptors 0/1/2 must also
differ from those tuples. An observed open remains an open, never a denial.
Worker PID namespace must differ from the outer namespace and equal the
observed `/proc/1/ns/pid` namespace; mount namespace must differ too. Missing
proc-view evidence fails validation.
All seven syscall results are required: EPERM for the fixed namespace/mount/
inspection calls, ENOSYS for clone3. NoNewPrivs=1, Seccomp=2, nonzero filter count,
zero effective/bounding capabilities, exact reviewed environment keys, fixed cwd
and exactly descriptors 0/1/2 are required.

The predeclared protocol budget is 30 seconds plus 12 seconds for owned cleanup;
the capsule retains its original 180/200/5-second job/command/grace limits and
8 MiB output limit. Success requires the complete probe and process/read closed
with exit zero, followed by controlled outer cancellation: terminal reason
`CANCELLED`, gate exit `-15` (SIGTERM), wrapper exit zero, complete byte/hash
accounting and verified namespace cleanup. Natural gate exit zero, KILL escalation
and unrelated terminal reasons are not accepted for this experiment. If the
finite worker is already closed, terminate is explicitly NOT_NEEDED and gains
no terminate-delivery credit. Otherwise only its fixed process ID is terminated;
that response is an acknowledgement, never cleanup proof.

Run only after an explicit runtime handoff with
`python -B scripts/subscription-exec-server-worker-gate.measure.py --actual-fixed-executor-probe`.
Each invocation creates new UUID artifacts with before/after source hashes,
outer wire and CLI pipe bytes, deduplicated worker output, structured failures
and cleanup evidence. Input acknowledgement means supervisor-to-gate write only.
No unknown cleanup permits a subsequent dispatch in this single-job driver.

Offline tests use authored report fixtures. They do not establish actual syscall
or path denial. No actual invocation is authorized until all fixed gate/trampoline/
probe/supervisor sources, exact wire contract and lifecycle checks are complete,
frozen and independently reviewed. Historical evidence remains unchanged.
