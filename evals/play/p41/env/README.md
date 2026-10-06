# P41 T30: six environments, blind recognition

Status: prepared protocol; no screenshots or judge results have been measured yet.
Acceptance requires the real capture test and at least **5/6** correct blind answers.
Human acceptance remains separate.

## Capture

`e2e/play-env.spec.ts` retains the existing grid panorama tests and adds one
six-scene native test. The six predeclared sentences cover desert/city (drive),
underwater/space (glide), forest (walker), and snow (ball), with seed 41.
It publishes each sentence through the real API and checks the resulting native
control; it never substitutes a hand-written spec to make routing pass.

Use the production-build workflow in `playwright.config.ts` (`npm run build`
followed by `next start`), an unused local port, and the existing environment
stub convention. For example in PowerShell, when authorized to build/measure:

```powershell
$env:E2E_PORT = '3293'
$env:PLAY_LAB = '1'
$env:PLAY_ENV_ENDPOINT = 'http://127.0.0.1:3295'
$env:PLAY_ENV_KEY = 'e2e-env-key'
npx playwright test e2e/play-env.spec.ts --project=chromium
```

The new test writes `01.png` through `06.png` and `manifest.json` here. It uses
1280x800, the real browser session's delayed robot inputs through tick 60, and
captures only WebGL canvas pixels after hiding all UI text. PNG metadata is
removed. The manifest records the sentence, expected environment, aliases,
actual control/theme, immutable version, seed, tick and screenshot hash. A new
capture invalidates the previous manifest before writing any images.

Native movement registration, scene/input integration and sentence routing must
already be implemented. A wrong control is a failure, not a reason to silently
change the six-sentence set. The capture alone does not prove recognizability.

## Blind subscription judge

```powershell
node scripts/p41/env-judge.mjs --run first
```

This reuses `codexArgs`, `ENV_ALLOWLIST`, and process-tree timeout handling from
`scripts/codex-shim.mjs`; the neutral temporary-image protocol follows
`scripts/p37d/judge-sheet.mjs`. It uses GPT-6 Astra, medium reasoning, standard
speed, existing ChatGPT subscription, no paid API fallback, no browser/web,
no shell/tool use, no repository rules or user-config instructions. It does not
open credentials, auth/session files, or inspect their contents.

For each image, Codex starts fresh in a newly created neutral `judge-*` temporary
directory containing only **sheet.png** and a generic **schema.json**. The
attached image is re-encoded again without metadata. Its prompt gives neither
sentence, candidate environment list, original filename, mapping, nor author
interpretation. The judge answers environment, ambiguity and visible cues.
The six calls are independent and sequential.

Only after **all six genuine answers** are persisted does the script read the
capture manifest. It verifies image hashes and compares the concise environment
to the aliases frozen in the capture test, with case/punctuation normalization.
Ambiguous answers fail. Do not add aliases after seeing a result; any protocol
revision must be explicit and followed by a complete new blind run.

Evidence is saved under `judgements/<run>/`: raw answers, CLI event logs, call
status/timing and final `report.json`. Existing run IDs cannot be overwritten.
Exit 0 = >=5/6; exit 1 = completed but below threshold; exit 2 = blocked.
Unavailable CLI/subscription, timeout, malformed answers or unexpected tool use
produce `status: blocked`, **score: null**, with no invented partial score.
No ground-truth metadata is read or revealed before six successful answers.

## Remaining work

- Apply and typecheck the prepared patch after the source freeze.
- Run the full environment E2E suite on the corresponding production build.
- Run the live blind judge; record the actual six answers and result.
- If live Codex is unavailable, retain the blocked evidence and complete other
  independent P41 work. Never replace it with a simulated or author-written score.
