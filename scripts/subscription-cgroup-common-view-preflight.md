# Owned asynchronous common-view preflight

This component runs only the fixed source-bound metadata service in one owned Python worker thread and hands its complete validated report to the fixed evidence codec. It is not integrated with the relay, creates no subprocess directly and exposes no CLI, arbitrary command, path, unit or PID adoption. No actual service or workload ran during this implementation.

`create_preflight(reader, expected_service_hashes, absolute_deadline, deps)` takes `(service, sampler, codec, events)` from the trusted source-bound caller. Each module carries its captured `__source_sha256__`; the service and sampler hashes must match the exact five service source hashes. The codec/events hashes are included in the small terminal receipt for the caller's separate inventory binding. These module annotations express trusted-caller provenance, not cryptographic attestation against code in the same interpreter.

The reader must be the exact private events module's factory class, with its internally generated UUID and fixed current-UID leaf path. It may be unopened: pretarget service work does not read a nonexistent target leaf. The component never closes or recreates that caller-owned reader. The controller's deadline is at most35 seconds and clamped to the reader deadline; the one service invocation gets at most30 seconds within that same deadline. Source and service behavior remain governed by their existing reviewed limits.

API:

- `start()` is single-use and starts the one fixed worker. No public work callback is accepted.
- `poll()` returns at most one canonical JSONL bytes frame or None. It never joins a live worker or waits for the producer's queue lock.
- `cancel()` immediately sets the same Event passed to the service, clears queued future delivery and fences further factories.
- `finished()` reports the worker's completion event AND observed thread termination.
- `result()` returns a fresh parsed report only after complete queue handoff, producer completion, known thread termination, source-bound service validation and known service handles. Cancellation and deadline are rechecked around retrieval.
- `close()` is idempotent, requests cancellation for a live worker and joins at most one second within the existing deadline. Unknown join/state/local cleanup leaves the fence set and does not release the active owner. Callers should keep pumping until the worker is known finished before finalization.
- `terminal()` contains only source/unit/digest/byte/count/state information, never another full report.

The worker checks cancellation before invoking the service, after its return, after pure replay, before each codec frame and within bounded queue waits. The main thread checks cancellation at poll and result retrieval too, so a late cancel cannot reuse an earlier component success. Incomplete, invalid or unknown service outcomes never become admission. Any error/cancel leaves this module conservatively fenced even when later local thread close is known.

The complete canonical service document is retained once, bounded at2MiB. `encode_document(target_unit,'service',raw)` yields lazy canonical frames of at most45000 bytes. The Condition queue holds at most four frames and262144 serialized bytes; full-queue waits release the lock and recheck deadline/cancellation at most every50ms. No bulk list of chunks is constructed. The main pump is free to continue heartbeat/control/output work while the service or producer waits. No model/session/evidence limit is increased.

`framesPolled`, `wireBytesPolled` and `queueDocumentDrained` mean frames handed from this component's queue to its caller. They do NOT prove stdout OS writes, driver receipt, parser acknowledgment or durable archival. The later relay owner must still track its actual outbound drain and the driver's complete source-bound evidence validation before any dependent action. This component's terminal always retains releaseAdmitted=false and productionReady=false.

Tests use owned Python threads, the real pure service/sampler fixture and the real codec with a mocked service invocation. An expanded authored metadata fixture validates through those real parsers to exercise more than four frames; it is not a claimed kernel observation. Tests cover active-worker nonblocking polls, lock contention, frame/queue bounds, full codec reconstruction, result copy isolation, cancellation after service return/during replay/after queue delivery, deadline under backpressure, source/reader/path/parallel admission, and thread start/join uncertainty. V1 preserved11 PASS/1 test-fixture sizing failure (the small fixture produced only three frames); v2's explicitly larger valid fixture passed12; v3 passed15. No systemd unit, process launch, network, credentials or workload was exercised.

Final scoped v4 after explicit queue-handoff naming:15 mocked PASS in0.76s (scratch/session8-common-view-preflight-unit-v4.xml). No actual runtime. Terminal names distinguish polling from actual wire delivery as agreed with the integration owner.
