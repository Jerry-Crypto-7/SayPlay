# Fixed app-server generation protocol seam

The pinned initialization `configWarning` about bubblewrap requiring user
namespaces is preserved as one typed `configurationAdvisories` entry with kind
`linux-sandbox-user-namespace-unavailable`, exact summary, null details and the
optional validated envelope timestamp. It is admitted only after validated
initialize and at most once. Different text, extra params (including path/range),
malformed timestamps, pre-initialize or repeated warnings fail closed. The exact
raw frame and its byte accounting remain unchanged; accepted evidence is copied
and frozen at sealing, and late raw notifications cannot mutate returned records.
This is an upstream startup advisory, not sandbox readiness or permission to
dispatch a model turn. Pinned lib.rs queues/logs this specific warning without
aborting, and the initialize notification path sends it after the reply. The
existing transport's independent turn denial and every policy/cleanup gate remain.

This module implements an offline-testable request/event state machine. It has no
launcher, credentials, account RPC, network access or default production import.
`createAppServerGenerationAdapter(factory).generate({request, remainingBudgetMs},
signal, onTurnStart, onLate)` accepts only the existing model/system/user text
request. It freezes the text before asynchronous work, creates a fresh transport
and ephemeral thread, and sends the fixed no-environment profile on both thread
and turn. It does not forward caller configuration, argv, attachments or tools.

The fixed model is gpt-5.6-sol, provider openai, effort low, approval never,
read-only sandbox. Auth method and subscription identity cannot be established by
these frames. `productionReady` is always false. The transport factory is an
explicit trusted-caller seam: it must own source identity, isolated configuration,
auth/network prerequisites, raw stdout/stderr delivery and independently verified
local/remote cleanup. A fabricated cleanup promise is not an attestation. This
adapter does not solve the missing production OS/auth transport or prove that
no-environment configuration disables every internal/background model operation.
Pinned multi_agent defaults on: the fixed thread config therefore explicitly sets
both `features.multi_agent` and `features.multi_agent_v2` false. Caller overrides
are rejected before transport creation. This restricts those two tool sources;
it is not evidence that every internal tool registry is disabled.
The final pinned registry profile also disables agents, image generation, goals,
memories, plugins, apps, code mode and code-mode-only, deferred executor, token
budget, current-time reminder, skill search, experimental request-user-input,
orchestrator skills/MCP and skill instructions. Shell remains false and web search
disabled. All are fixed thread config, never caller overrides. A fixed
`model_catalog_json: '/usr/bin/text-model-catalog.json'` names the derived catalog
whose selected entry uses tool_mode direct and multi_agent_version disabled.
The trusted transport MUST preload that catalog via process CLI configuration
BEFORE StaticModelsManager construction; thread config alone does not activate it.
It must verify the read-only catalog image bytes and preserve the isolation and
configuration prerequisites. This module does not add a model/list RPC or a
runtime factory. The unconditional PlanHandler remains bookkeeping; there is no
claim of zero tools. Earlier metadata/fixture runs retain their earlier profiles
and do not become validation of this final profile.

The deadline is min(180000 ms, remaining overall chain budget), beginning at
generate entry. Cancellation sends turn/interrupt only when its own thread and
turn identities have been bound by observed turn/started. Its acknowledgement is
never cleanup. Close asks the trusted transport to stop only its owned tree;
adapter cleanup observation is bounded to 5000 additional ms. A later cleanup
cannot reopen the sticky unknown-termination fence. Concurrent calls are rejected.
An outer ordinary runner must retain its existing chain deadline and shared fence;
creating a new adapter is not a legitimate way to retry unknown termination.

Wire sources are pinned to OpenAI commit
`25af12f7e61572b0bc18ddb1008be543b91519b0`:

- `app-server-protocol/src/protocol/v2/{thread,turn,item,thread_data}.rs`:
  thread developerInstructions, fixed turn params, identities, item phases.
- `app-server/src/bespoke_event_handling.rs`: started/completed notifications
  have empty items and itemsView notLoaded; final text comes from item/completed.
- `app-server/src/request_processors/turn_processor.rs`: response can race notifications.
- `memories/write/src/start.rs`: its first ephemeral guard skips memories startup
  for this profile. That closes this specific background-work concern, but a turn
  count still cannot establish model attempts/retries or complete model accounting.

Detailed immutable receipts are in
`scratch/session8-production-worker-seam-review.md`. This is source evidence, not
proof that the pinned ELF was reproducibly built from that commit.

Supported events are thread/started, turn/started, turn/completed,
item/started/completed for matching userMessage and text agentMessage,
agentMessage deltas, and bounded integer token-usage notifications. Unknown
notifications, tools, server requests, reasoning items, error notifications and
non-final/unknown final phases fail closed. This deliberately narrow subset may
reject legitimate server traffic. It has not been tested against live inference.
Only one final_answer with consistent deltas/completion, a matching completed
turn, a nonempty JSON object and confirmed local and remote cleanup can succeed.
JSON grammar, duplicate keys, nesting, UTF8, sequencing and identity are checked;
compiler schema/grammar validation remains the upstream core's responsibility.

Pinned `v2/remote_control.rs` and `app-server/src/outgoing_message.rs` additionally
document an optional outer notification `emittedAtMs` (nonnegative safe integer)
and `remoteControl/status/changed`. At most one such status is accepted after a
validated initialize reply: exact params must contain status disabled,
environmentId null, a nonempty serverName of at most 256 UTF8 bytes without C0/DEL,
and a canonical UUID installationId (case-insensitive). Enabled/connecting/error,
unknown statuses/methods, extra keys and malformed metadata fail closed. No
remote-control RPC is sent. The fields are metadata only and do not attest to
disabled remote infrastructure or authorize networking. Unknown outer keys remain
rejected on all notifications. This compatibility was prompted by the actual
metadata-only run recorded as FAIL in
`scratch/session8-systemd-cli-appserver-noenv-codex-cli-resource-a464dc32582b48aea6b82b1978c1ddae.service.json`;
that historical failure is not relabelled by offline adapter tests.

`jsonText` is final provider message text; `wireRaw` is retained JSONL protocol
output, never a substitute for that text. `outputBytes` includes all known raw
stdout+stderr bytes before sealing, including rejected and over-limit chunks.
Retention stops at an aggregate 8 MiB and never retains a whole rejected oversized
chunk. Late output reports byte counts/hashes separately through onLate without
rewriting sealed results. The trusted transport must report all output; the
adapter cannot detect bytes it never receives. `observedTurns` counts validated
turn/started, while `modelCalls` remains null after any turn dispatch, including
successful turns; zero applies only when no turn was dispatched. Token usage is
not a model-call count.

Validation: scoped offline Vitest, no app-server process, auth, network or
inference. Initial sandbox test startup failed Vite spawn EPERM; identical scoped
test command succeeded with narrow escalation. No live credit or production
readiness follows from these fixture tests.

Initial scoped verification: 39/39 offline tests and TypeScript passed. Independent
source review identified incomplete UTF8 hidden after a terminal frame and a
delayed-timer deadline race; both were corrected with negative tests and the
reviewer confirmed both findings closed. Live protocol compatibility of the
deliberately narrow event subset remains unverified.
After the narrow metadata compatibility change: 59/59 offline tests and TypeScript
passed. These are overlapping suites, not 98 independent tests.

## Count-only transport accounting

The factory may call `callbacks.onOutputAccounting?.({observedBytes})` with an
aggregate stdout+stderr safe-integer watermark or explicit null. This is a count
receipt from the trusted transport, not app-server wire data or fabricated body
bytes. It permits a supervisor to report an observed drain tail withheld after
the output limit. No per-stream totals are inferred from the aggregate receipt.

Existing `outputBytes` retains its backward-compatible meaning: raw bytes received
before sealing. `outputAccounting` separately contains receivedBytes, the actual
receivedByStream stdout/stderr counts, observedBytes and withheldBytes (both null
if unknown), and status unreported/reported/unknown/invalid. Old factories need
not report counts; their aggregate total remains unreported/null while existing
raw-delivery completion behavior is preserved. Absence of a callback never means
observedBytes equals receivedBytes or zero.

Numeric receipts must be nonnegative safe integers, at least the bytes received
when reported, and no less than any previous numeric watermark; equal watermarks
are valid. Raw output may subsequently pass a prior watermark during streaming,
but before sealing an opted-in transport must report a final total at least as
large as all delivered bytes. A stale final watermark fails with invalid/null
accounting rather than negative withheld bytes. Final reported bytes greater than
received bytes cannot yield a successful generation even below the cap: unseen
bytes could contain unparsed protocol data (`OUTPUT_WITHHELD`). Observed bytes
above 8 MiB trigger OUTPUT_LIMIT without appending synthetic data or changing the
existing 8 MiB raw retention rule.

Explicit null replaces earlier numeric credit with unknown/null and fails the
operation. A later valid numeric receipt may describe newly established accounting
but cannot restore operation success. Invalid receipts permanently invalidate
accounting for that invocation; later numeric receipts do not repair it. An
existing primary failure remains primary if accounting also fails. Neither count
receipt nor zero withheld bytes establishes process cleanup or model-call counts.

Transport ordering matters: deliver all queued raw callbacks first, then the
terminal count receipt, and only then resolve cleanup. Both received counters and
reports before sealing contribute to the returned snapshot, including bytes after
an earlier failure. Callbacks after sealing go to explicit late evidence:
kind output-accounting, a fresh accounting snapshot and a validation error or null.
Late raw bytes count toward those later lifetime comparisons, while every field
of the already returned nested accounting object stays unchanged. Late invalid
reports remain explicit invalid/null evidence; they do not rewrite old success or
cleanup claims. The caller must archive late evidence rather than silently merge
it into a historical result.

Scoped accounting regression: 83/83 offline tests passed, including malformed and
decreasing totals, null after known, equal watermarks, cross-stream limit crossing,
withheld totals after completion before cleanup, stale final totals, late invalid
evidence and immutable sealed results. No OS fixture, CLI or inference runtime was
executed for this change; those require separate transport integration receipts.
