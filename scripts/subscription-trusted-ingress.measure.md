# Fixed inherited ingress measurement

`subscription-trusted-ingress.measure.py` is a dedicated, fixed Windows-to-WSL
driver. Its first actual basic run passed with an archived source freeze and
independent replay, as recorded below. It accepts no arguments and invokes only the clean-env
`subscription-trusted-ingress-launcher.py` path.

The driver reuses the existing supervisor measurement loop without editing it.
Its source inventory contains 24 files: the base inventory of 21 plus this
driver, the launcher, and the proxy. It binds current bytes and before/after
hashes, including the loaded driver identity. The launcher's separate 14-source
map and the ready/start 10-helper map are checked independently; these counts
are overlapping inventories, not independent tests.

Before dispatch, the driver requires the prior ownership frame's exact nonce,
FD 198 socket identity and source map; the matching ready socket, restricted
bootstrap inheritance declaration and helper hashes; the pinned CLI and bwrap;
the exact 180000/200000/5000 ms and 8 MiB limits; and explicit sandbox facts.
UID/GID are typed nonnegative integers. The only network interface is `lo`.
The capsule does not claim aggregate resource enforcement.

Successful replay requires exactly ordered ownership, ready, started, capsule
terminal, and ingress terminal records. It preserves actual candidate JSONL
and decoded child stdout separately. The child validator receives source-bound
modules and externally supplied ready/ownership facts; the child's own marker
or startup packet cannot attest its own origin. Malformed, unknown, duplicate,
out-of-order or incomplete evidence fails closed.

The authored Unix-socket exchange is exact: CONNECT and its fixed response,
BEFORE 40 bytes, AFTER 39 bytes, ACK replies 44 and 43 bytes, then EOF. Broker
observed ingress is CONNECT length + 79, observed upstream 87; delivered
ingress is response length + 87, delivered upstream 79. The broker retains its
5-second deadline; the child retains its 22-second work/30-second total
budget. Rounded broker milliseconds may equal 5000 only with the separate EOF
outcome and the child's stricter elapsed evidence. No budget is extended.

Capsule pidfd/namespace cleanup and launcher socket/thread cleanup are separate
requirements. The launcher must report known capsule wait status 0, closed
peers/threads, exact counters and no errors. Its remote process cleanup field
must remain `NOT_ATTESTED_BY_LAUNCHER`; only the capsule supplies its own process
cleanup evidence. This is a basic credential-free fixture route, not provider
CONNECT authorization, authenticated transport, inference, or systemd resource
validation. Actual model calls are zero for the fixed authored experiment.

Each invocation creates a unique scratch receipt, candidate wire file and child
stdout artifact. Failed attempts remain separate and do not authorize retries.
Offline tests cover the complete independently bound child replay, pre-start
admission, runtime pins, ordering, raw corruption, accounting, both cleanup
domains and source drift. The first test collection error was a local fixture
loader path error; it is preserved in `session8-trusted-ingress-measure-unit.xml`.
The corrected final scoped suite is recorded in
`session8-trusted-ingress-measure-unit-v3.xml` (61 passed).

## First actual basic run

`scratch/session8-trusted-ingress-actual-summary.json` describes attempt
`e94224ca-6bfa-4ac7-859c-ddc5806abc46`: PASS in 6969 ms, with 24 archived
source files matching before/after/current at replay. Exact child stdout is
41424 bytes, SHA256 `ab42e01bcae0f014d7742965c888a4175899a9b5e5f50dcb330cca7466565c29`.
Independent replay: `scratch/session8-trusted-ingress-actual-replay.json`, SHA256
`ddfe7c833c8a19d519a31aea7457d34b53d75b7452f579bfac669ec80a6d103c`.

The owned socket identity matches before/after pivot and both nonce challenge
exchanges. Broker elapsed time is 450 ms, observed ingress/upstream 146/87 bytes,
delivered 126/79 bytes, then EOF and all broker threads/peers closed. The separate
worker has only local nonalias stdio; `/proc/1/fd/198` returned ENOENT (absence,
not permission denial). App-server initialization remains separate from the
fixed worker probe; this does not claim an actual app-server tool invocation.
Both direct processes exited naturally with code 0. Capsule cleanup separately
verified 10 pinned processes ESRCH and an empty namespace, without KILL.

The first attempt `46983fae-023e-4c63-a6b2-3a30f527bb9f` remains FAIL: WSL Service
E_ACCESSDENIED before ready, no terminal, cleanup unknown. The subsequent same
command used narrow sandbox escalation. No credentials, external network,
systemd transfer, aggregate resources or production readiness were validated.
