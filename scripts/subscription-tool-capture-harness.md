# Authored Responses tool capture harness contract

Update, 11 September 2026: this library is now connected by the separate
`subscription-tool-capture-runner.py`, HTTP adapter and fixed capsule/host driver.
The stock-client capture experiment passed; see `subscription-tool-capture-runner.md`.
The observed catalog uses Responses Lite: tools arrive in exactly one developer
`additional_tools` input item, with no top-level tools field. The peer supports
that carrier and rejects ambiguous combined/duplicate catalogs. Failed HTTP
bodies are preserved as bounded diagnostic evidence. Historical unfinished-work
notes below describe the original offline milestone.

`subscription-tool-capture-harness.py` implements the offline protocol portion
of a separate stock-appserver capture experiment. It supplies fixed configuration,
one initialize/thread/start/turn/start controller, and a two-response authored
Responses peer. It is a library, **not a runtime launcher or HTTP listener**.

The intended experiment uses the installed stock client with a synthetic model
response. It can establish client serialization of that authored function call;
it cannot establish real inference or successful tool execution. A pinned Rust
handler build was not selected: no cargo/rustc was found on Windows or in the
checked WSL `/usr/bin:/bin` PATH, and the project has source fragments rather
than an established complete upstream checkout.

## Source basis

The archive `scratch/continuation-responses-fixture-source/receipt.json` records
public sources at commit `25af12f7e61572b0bc18ddb1008be543b91519b0`.
Its `findings.md` identifies the upstream appserver integration test
`turn_start.rs:4568`, provider helper `common/config.rs:33–75`, and Responses
event helpers. They establish the two authored SSE responses and custom HTTP
provider configuration. The successful-command upstream test does not prove
that this proposed remote capture refusal reaches a second model request.

The catalog's existing `gpt-5.6-sol` identifier is retained as fixture metadata;
no model is called. This does not change the coding agent's model settings.
The new provider is `capture-fixture`, uses only
`http://127.0.0.1:31317/v1`, disables auth, WebSockets and retries, and enables
shell/unified exec only in this separate configuration. `home_files()` returns
valid TOML bytes; it does not create files. The environment excludes local
execution and points to the capture endpoint, never the worker executor.

## Protocol and IO contract

`Controller` queues only initialize, initialized, thread/start and one turn/start.
Call `written(count)` for actual partial writes; responses arriving before full
delivery are rejected. A thread response must retain the fixed provider, model,
ephemeral state, workspace roots and read-only sandbox. The controller never
answers server requests, including approval requests. Other notifications are
bounded diagnostic data, not execution evidence. Completion requires the exact
thread/turn IDs, completed status and no error. Failure permanently closes it.

`ResponsesPeer.prepare(method, path, header_pairs, raw_body)` accepts at most two
POSTs at `/v1/responses`, with bounded uncompressed JSON and explicit content
length. It rejects credentials, cookies, duplicate headers, transfer encoding
and upgrades. The future HTTP adapter must bound the raw header/body reads
before calling this function; these checks do not replace HTTP framing.

The first request must expose one `exec_command` function. Its reply supplies
the fixed command `/usr/bin/python3 -I -S /usr/bin/trusted-cli-worker-probe.py`,
remote environment `fixed-worker`, workdir `/work/exec-worker`, login=false and
yield_time_ms=500. These are tool arguments; the real client still derives shell
argv and its own process handle. They are not admitted by the production gate.

Both replies use response.created → response.output_item.done →
response.completed SSE events, without a `[DONE]` sentinel. The caller serves
status 200 with Content-Type `text/event-stream`, writes the complete returned
bytes, flushes, then calls `delivered(byte_count)`. A second request cannot
advance before that acknowledgment. It must contain exactly one
function_call_output with the fixed call ID. Its reply is a final assistant
message. A third request or partial delivery permanently fails the peer.

The reports preserve request/event bytes and explicitly leave client provenance,
execution and inference unattested. Peer completion, appserver turn completion
and capture completion are separate facts. Neither the peer nor the controller
report establishes that a remote `process/start` occurred.

## Validation and unfinished runtime work

35 offline tests passed in 0.67 s:
`scratch/continuation-tool-capture-harness-v1.xml`. Tests cover an authored
two-response conversation, TOML parsing, partial writes, thread-profile drift,
completion IDs, unsolicited server requests, bounded notifications, malformed
HTTP metadata/JSON, response correlation and extra requests. No stock client,
HTTP socket, credentials, inference or Linux workload ran in these tests.

Scoped source review found no mismatch in SSE, provider configuration or tool
arguments. Two wire assumptions remain unverified: stock client requests use
uncompressed JSON with Content-Length, and its tool catalog exposes a flat
function named exec_command. The peer refuses other forms; the actual run must
observe them before claiming compatibility. `delivered()` records the parent's
write/flush assertion, not independent delivery provenance.

The next executable integration must supply a **new fixed Linux parent/profile**:

1. Validate its runtime identity and isolated mount/PID/network view before
   starting the client. Create fresh home/work directories and the returned
   files exclusively. Bind the capture endpoint, harness and catalog sources.
2. Provide only namespace-local loopback for the fixed HTTP endpoint. Bound
   HTTP parsing, appserver stdio and endpoint evidence, drain all pipes, and
   enforce a common absolute deadline and cleanup. Existing metadata profiles
   do not authorize this new transport or turn path.
3. Start stock appserver with the fixed fresh home and empty supplied environment
   apart from fixed runtime variables; drive the controller and Responses peer.
   Preserve capture stderr as its own stream: it may otherwise be swallowed or
   mixed into appserver diagnostics by the remote transport.
4. Require independent source/binary identity, endpoint capture, protocol result
   and process cleanup evidence. Preserve a refused command or early tool error
   as such; a completed authored turn alone is never capture success.

The earlier capture endpoint and production gate are unchanged. Actual client
serialization, parent/image/measure integration and process-handle admission
remain unfinished.
