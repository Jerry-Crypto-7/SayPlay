# Exec request capture peer

Update, 11 September 2026: the new isolated stock-client runner captured an
actual 1047-byte process/start and replayed this endpoint's evidence successfully.
See `subscription-tool-capture-runner.md` and the `5919e8bd…` actual archive.
The runtime uses an exclusive evidence file through the runner's capture wrapper;
the original stdio entry still publishes evidence on stderr.

After the initial bootstrap, the fixture now supports a finite authored discovery
tree: `/work/exec-worker`, `/work`, `/` are directories and their `.git` markers
are absent. Each may be statted once with the next integer RPC id. The observed
client queried cwd and the three markers, then sent process/start id9. These
replies involve no host filesystem reads. Direct post-bootstrap capture remains
supported for the original authored unit fixtures. Historical validation and
integration notes below describe the earlier endpoint-only milestone.

`subscription-exec-request-capture.py --stdio-fixture` is an authored exec-server
peer for a future isolated client experiment. It answers the fixed environment
bootstrap, preserves the first `process/start` frame byte for byte, replies with
an RPC error and exits. It never launches a process, forwards a request, opens a
requested path or connects to a network. It does not import the production gate.

The bootstrap has initialize id 1, initialized, environment/info id 2, and one
metadata request for each of `file:///work/.agents/skills` and
`file:///work/exec-worker/.agents/skills` with ids 3 and 4. Replies, including
the missing-path results, are authored fixture data. Bootstrap drift fails the
capture instead of silently fabricating support for other client operations.

The captured start needs an integer id greater than 4 and object params. Its
argv, environment, sandbox, trace and other fields are observed without being
admitted for execution. The fixture preserves unknown fields and whitespace.
Production admission must not reuse this deliberately broad observation rule.

Protocol responses use stdout; one JSON evidence document uses stderr. The
document includes bounded raw incoming frames, successfully written/flushed
fixture responses, exact request bytes and SHA-256. `captureComplete` means the
request was observed and the refusal was written and flushed locally. It does
not prove that the client consumed the refusal. Exit 0 means successful capture,
1 means capture/transport failure, and 2 means evidence publication failed.
The caller must verify both exit status and the complete evidence document.
An incomplete response write fails instead of retrying or reading more input.

Input is bounded to 128 KiB per line and 256 KiB total; duplicate JSON keys,
invalid UTF-8, malformed frames, unexpected methods and premature EOF fail.
The peer stops reading immediately after the first start. It has no internal
wall-clock timeout: its future parent must enforce deadline, isolation, pipe
draining and cleanup. Use only with an isolated credential-free client because
evidence intentionally contains the raw request, including its environment.

## Validation and remaining integration

22 tests passed in 0.78 s, recorded in
`scratch/continuation-exec-request-capture-v2.xml`. They include a real Python
stdio subprocess with an empty supplied environment and authored client bytes,
exact capture, bounds, protocol ordering, permanent refusal after invalid input,
partial writes and evidence failure. No Codex client was run. The initial run
had 21 passes and two setup/teardown errors on the same oversized-input case:
pytest expanded the bytes into a test id exceeding Windows' environment-variable
limit. Explicit short test ids fixed the harness; v1 evidence is retained.

Client provenance and inference are explicitly unattested; production readiness
is false. This endpoint is ready for harness integration, but there is still no
serialized request captured from the pinned Codex client.

`scratch/continuation-capture-launch-findings.md` identifies the integration seam:
the program/args/cwd environment configuration in
`subscription-exec-environment-metadata-parent.py`. Its current fixed profile
rejects turn/start, so it cannot be reused unchanged. The existing
`subscription-appserver-fixture-child.py` mimics an entire appserver and does not
invoke the real tool handler. The next step is a separate pinned Rust handler
harness or a stock appserver with a local authored Responses peer and a separate
fixed Linux lifecycle profile. Neither the production gate contract nor the
existing runtime runner was modified here.
