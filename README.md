# WORLDSTREAM — Reality Compiler pilot

A short source describes a discrete spatial procedure. The application proposes a runnable 3D scenario, links rules to source excerpts, and compares the same recorded actions before and after a timer intervention.

The current handoff is an **own local demo using a Codex subscription**. Public hosting and a completed competition submission are not available. Source citations retain their review status: a valid byte range does not prove that a rule accurately represents its source.

## Run the local demo

Prerequisites: Node.js and the dependencies in `package-lock.json`, Playwright Chromium, a production build, and the existing validated Ubuntu-24.04 WSL2 environment with the official Codex CLI signed in through ChatGPT. The local launcher runs `codex` from the WSL PATH; override it with `CODEX_WSL_BINARY` and `CODEX_WSL_DISTRO`. Another machine must configure its own installation and validate its sandbox. Do not copy credentials between machines.

```powershell
npm ci
npx playwright install chromium
npm run build
npm run demo:subscription
```

Use **Build from a source** in the Chromium window opened by the launcher. It starts its own server at `127.0.0.1:3116`; an ordinary browser tab at that address does not have the subscription bridge. Closing the controlled window ends the demo; the session also ends after 30 minutes. Maximum 12 model calls per demo session, sequential, with no API fallback or automatic model retries.

The prefilled fictional source is editable. The server accepts up to 2,000 characters; unsupported mechanisms and missing critical conditions can be rejected or require clarification. The pilot supports discrete grid movement and a single timer intervention per project. Reloading loses the tab's project. Geometry is schematic.

The current holdout exposed missing-duration cases accepted without the clarification required by the protocol. Use explicitly complete procedures for the local demo and review critical parameters manually. A successful simulation does not establish faithful interpretation of an ambiguous source.

Two successful development runs took 85.5 and 93.6 seconds for model generation alone. These are individual observations, not a p95 or a guarantee. Subscription use consumes the account's available allowance; the launcher does not invent a per-token USD price.

## Evidence and validation

- [Demo walkthrough and attempt archives](evals/reality-compiler/subscription-demo.md)
- [Subscription benchmark](evals/reality-compiler/subscription-report.md)
- [Decision and limits](evals/reality-compiler/decision.md)
- [Handoff readiness](evals/reality-compiler/submission-readiness.md)
- [Human study protocol](evals/reality-compiler/user-study.md)

```powershell
npm run typecheck
npx vitest run scripts/__tests__/measure-reality-compiler.test.ts scripts/__tests__/codex-subscription.test.ts
# Explicit local subscription measurement; up to 60 calls / 30 planned pairs:
$env:RC_SUBSCRIPTION_AUTHORIZED='1'
npm run measure:reality-compiler-subscription
```

The benchmark preserves failures and unattempted pairs. Its oracle is never included in the model request. Human semantic review and five actual participants remain separate evidence requirements. Historical prepared worlds, offline fixtures and API measurement paths remain in the repository and do not establish the current pilot's quality.

Third-party components and source provenance are recorded in `disclosure.json`. See the handoff report for unresolved release requirements.
