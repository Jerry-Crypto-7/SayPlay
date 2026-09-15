# Fixed interactive app-server metadata pipe

This child is an explicit credential-free experiment, not a production launcher
or model inference transport. The supervisor mode is `appserver-metadata-pipe`.
Its fixed CLI sandbox profile is `appserver-metadata`: read-only runtime,
synthetic private sentinel denied, a dedicated writable appserver-home mount and
scratch tmp. No caller command, environment or scenario is accepted.

Ready exposes `appServerMetadataPipeBoundary.helperSha256` with exactly:

- subscription-appserver-metadata-pipe-child.py
- subscription-appserver-noenv.py
- subscription-worker-lockdown.py
- subscription-text-model-catalog.json

The exact start frame has only type=start, mode and that four-hash map. Hashes
are calculated from the copied read-only helper image before dispatch. Input
reuses the existing bounded `fixture_input` frame (`seq`, base64 `data`) and
`fixture_input_ack` after an actual supervisor-to-child pipe write. This ACK is
not proof of app-server request admission or delivery; the child independently
gates requests and accounts actual child-to-app-server writes.

The child installs the fixed worker lockdown before importing the policy helper,
creating a fresh home or spawning app-server. A failure has no unfiltered
fallback. The unchanged noenv helper supplies the 22 fixed thread config
settings, matching process argv overrides, pinned text-only model catalog,
strict response parser and direct-child cleanup schedule. It is imported as a
module; its standalone bridge is never invoked or modified.

The only protocol differences from the standalone noenv metadata request are
fixed literals: clientInfo.name is `reality_compiler_generation`, version is `1`,
and thread developerInstructions is
`Metadata transport validation only; no inference.` No caller system text or
configuration is accepted. The allowed request sequence is initialize id1,
initialized notification, thread/start id2, optionally model/list id3. All
parameters must exactly match freshly generated fixed policy dictionaries.
Canonical JSON comparison distinguishes boolean from integer values; duplicate
keys, nonfinite constants, unknown fields, auth/account/turn/environment RPCs,
and out-of-order or duplicate requests fail before forwarding. Only immutable
policy bytes are written, never the caller's raw representation.

Response validation can prepare the next fixed request but cannot send it.
Explicit client approval and actual app-server write accounting are separate.
A partial write or EAGAIN cannot mark the request delivered; a premature server
response fails the gate. Rejected client input permanently fences pending writes.
No server request is answered and no tool or model response is fabricated.

HOME and CODEX_HOME refer to the same exclusively created fixed-* directory
under /work/appserver-home, with an exclusive tmp subdirectory. Environment is
constructed from fixed PATH, LANG, HOME, CODEX_HOME and TMPDIR values. No host
home or credential store is opened. This does not claim that the CLI never
attempts its own startup services: previous warmup socket attempts were denied
by the OS boundary and new observations must be recorded independently.

Client input is limited to 4096 bytes; server JSONL lines and each output queue
are limited to 65536 bytes. Raw stdout and stderr remain separate. Stderr may
also contain a bounded, explicitly prefixed `METADATA_PIPE_DIAGNOSTIC` with a
fixed bridge failure reason, so it is not always pure app-server stderr.
Supervisor observed-byte/hash accounting includes that marker. Normal mock
pipe tests establish exact byte preservation without fabricated responses.

The supervisor retains job180s, command200s, TERM grace5s and output8MiB. This
child uses a 180-second local job ceiling, then direct-child EOF2s -> TERM5s ->
KILL1s using the reused actual-send-based schedule and a maximum 12-second
cleanup loop. It does not use the standalone helper's 12-second metadata
completion deadline. Queues are nonblocking during cleanup. Returning before
direct cleanup completes gives no success/remote cleanup credit; the outer
supervisor independently pins/reaps descendants and is the cleanup authority.
No numeric-PID signaling fallback, global kill, cgroup write or host deletion
is introduced. The supervisor sends the first actual crossing output chunk for
this interactive mode and immediately initiates its existing limit cleanup.
Over-limit output is not a complete retained raw transcript.

Scoped offline validation: 64 PASS across the new child and supervisor unit
suites, including a mock OS pipe loop for valid metadata and prohibited turn
input. No kernel/CLI/auth/network/inference runtime was executed by these tests.
An actual experiment requires the separately reviewed transport/harness and
fresh before/after source evidence. Historical fixture and metadata PASS/FAIL
records remain unchanged and do not validate this new source profile.

The first actual metadata-pipe attempt remains FAIL at
`scratch/session8-appserver-metadata-pipe-f2bb5ff9-5947-487e-ab59-899188184ba0/summary.json`
(SHA-256 f091b7877c5f8f909db8983f7d65fda71edf938bdedb86c96db1e66c808d816c).
It received a valid initialize reply followed by a configWarning that the
strict reused parser did not recognize; no thread or turn was submitted.
Outer cleanup was confirmed for nine observed pidfds. That historical result
is not relabeled after the parser change.

Pinned-source review in `scratch/session8-configwarning-source/receipt.json`
identified this exact startup warning as advisory: the CLI logs it and continues.
Only the new child subclass now accepts it once, after a valid initialize reply,
with the exact summary `Codex's Linux sandbox uses bubblewrap and needs access
to create user namespaces.` and exactly `details:null`. An optional emittedAtMs
must be a nonnegative safe integer, never a boolean. Other warnings, extra fields,
pre-initialize warnings and duplicates still fail closed. The warning is retained
in received history and its original raw bytes pass through unchanged; it neither
authorizes a request nor alters the namespace filter. The historical noenv helper
is unchanged. This preserves evidence that the CLI's user-namespace probe could
not run; it is not a claim that nested sandbox operations are now supported.

Post-advisory scoped validation: 78 PASS across child and unchanged supervisor
unit suites. Tests include malformed/pre-init/repeated warnings, optional typed
timestamp, no new request/write credit, and noncanonical raw warning bytes in a
mock pipe loop. No new actual/kernel/auth/network run is represented by this count.
