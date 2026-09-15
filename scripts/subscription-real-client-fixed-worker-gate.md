# Fixed real-client worker gate

This standalone draft admits the client's initialize/initialized exchange, one
environment/info request (id 2), two distinct bootstrap metadata requests (ids
3 and 4), and one fixed worker start (id 5). It does not inject client RPCs.
The source-pinned base gate rewrites the accepted worker request to the fixed
trampoline and sandbox. Caller argv, environment, network and stdin overrides
remain rejected. The executable entry is Linux-only `--inside`.

Completion requires a zero worker exit with explicit `sandboxDenied: false`,
through either a closed read response or ordered exited/closed notifications.
Protocol completion is not a semantic validation of the worker's output.
The loop drains buffered server frames after executor exit before checking
completion. Success also requires client/server/stderr EOF and drained output.
Partial writes and EAGAIN retain queued bytes and cannot advance admission.

`validate_terminal` replays the protocol and checks terminal consistency: pinned
base source, namespace labels supplied by the caller, executor exit zero,
reported local handle closure/reaping, empty partial/undelivered buffers, all
EOFs, matching byte counts and transport limits. It rejects extra terminal
fields and boolean exit codes. These are checks on a report, not independent
kernel attestations. Nonempty stderr is represented only by count and digest;
the validator cannot reconstruct it. Remote cleanup and production readiness
remain explicitly unattested/false.

Offline tests run the actual loop with mocked OS/process operations. They cover
buffered final output after executor exit, partial writes/EAGAIN, source and
request rejection, both completion paths, and terminal tampering. No actual
client, appserver-triggered tool, upstream or inference claim follows.

`read_terminal` is the parent-facing, Linux-only reader for the fixed owned
terminal path. Call it after gate exit; it does not wait for publication or prove
exit itself. It pins the base validator before opening, requires a regular file
within the publisher's size limit, handles short reads, checks EOF and file
identity/size/timestamps before and after reading, rejects duplicate JSON keys
and incomplete protocol evidence, and preserves exact accepted bytes plus their
digest. A close failure blocks further reads in that module instance. These
checks do not attest namespace ancestry, remote cleanup or worker semantics.
The reader is implemented but not yet called by a runtime parent.

Offline gate/reader regression: **52 PASS**, recorded in
`scratch/continuation-real-client-terminal-reader-v2.xml`. The first run (34 PASS,
18 FAIL) lacked mocked Linux open flags on Windows; v2 fixes the test harness,
without changing Linux runtime flags. All new filesystem operations are mocked.

## Trigger compatibility — 11 September 2026

The profile is not yet wired into the parent, image or measuring runner.
The archived client source at commit
`25af12f7e61572b0bc18ddb1008be543b91519b0` rules out the three direct RPC candidates
for this configured remote environment (`include_local = false`):

- `scratch/session8-appserver-command-source/codex-rs__app-server__src__request_processors__command_exec_processor.rs:31`
  calls `require_local_environment`; lines 81–86 reject an absent local environment.
- The same directory's `codex-rs__app-server__src__request_processors__process_exec_processor.rs:68`
  requires the local environment for `process/spawn`.
- `codex-rs__app-server__src__request_processors__thread_processor.rs:1929`
  describes `thread/shellCommand` as a local-host escape hatch and requires local
  execution. `codex-rs__core__src__tasks__user_shell.rs:205` supplies no remote
  exec-server configuration.

The archive's `receipt.json` records that commit. This is a source finding, not
a new runtime failure. Current [official App Server documentation](https://learn.chatgpt.com/docs/app-server#command-execution)
documents `command/exec` as a sandboxed one-off command; that general API contract
does not establish remote routing in the pinned client.

Next work must establish the normal turn/tool call chain into remote
`process/start` and its actual serialized request. Bootstrap alone does not
produce the gate's fixed worker request. Preserve the exact argv, environment,
network and sandbox restrictions while assessing compatibility. Only then wire
parent/image/measure with bound sources. No actual client, credentials, upstream
or inference was run during this continuation.

## Normal tool path — compatibility blocked

Source review at the same pinned commit now establishes the remote
`exec_command` path: model function call → tool router/handler → unified exec
process manager and sandbox runtime → environment exec backend →
`RemoteProcess::start` → `client.start_process` → `call_rpc(EXEC_METHOD, &params)`.
The source archive, URL/SHA receipt and line references are in
`scratch/continuation-tool-trigger-source/{receipt.json,findings.md}`.

There is a decisive incompatibility before parent integration:
`core/src/unified_exec/process_manager.rs:172–196` constructs `processId` from
an internally allocated `i32`, either as decimal text or decimal text followed
by a UUID when an executor sandbox is present. Neither branch produces this
gate's required `fixed-worker`. The tool has no argument to supply that handle.
Additionally, `tools/handlers/unified_exec.rs:90–114` derives shell argv from
`cmd`; the remote `Direct` mode still applies that transformation. It does not
mean the gate's direct Python argv. Environment policy, sandbox fields, request
sequencing and trace metadata still need an actual serialized capture.

Two offline regression witnesses change only the process handle in an otherwise
accepted start request. Both upstream handle forms are refused before any
worker bytes are queued, and the refusal fences a subsequent valid request.
The **54-test suite passed** in
`scratch/continuation-tool-trigger-gate-v1.xml`. These are source-derived
counterexamples, not captured requests or a successful client integration.

The runtime contract remains unchanged. Merely wiring the parent/image/measure
would leave this tool path unusable. The next coherent implementation needs a
separate credential-free fixture that obtains a real serialized client frame,
then a reviewed one-process handle mapping and exact command admission contract
bound to that frame. An internal router fixture or authored model response must
be labelled as such; neither establishes real model inference. No supported
app-server request that invokes this tool path without inference was established.
