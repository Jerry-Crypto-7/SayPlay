# Actual authored fixture transport measurement

Explicit opt-in `RC_APPSERVER_FIXTURE_SMOKE=1` runs three fixed scenarios through
the actual WSL clean-env capsule and OS pipes. Normal/cancel get a 20-second
remaining generation budget; paced output-limit gets 60 seconds, preserving the
original outer 200/5 and capsule 180/5 limits. The first actual output attempt
used 20 seconds and correctly hit the generation deadline before its paced
producer crossed 8 MiB; that run remains FAIL against its original expectation.
It performs no authentication, network operation or model inference. Protocol
turns and model fields are authored by the Python fixture.

A new UUID scratch directory preserves planned expectations, source SHA before
and after, separate retained stdout/stderr files, per-scenario accounting and
terminal pidfd cleanup evidence. Output overflow distinguishes delivered bytes,
retained prefix bytes and supervisor observed bytes; the logs are never a full
overlimit transcript. Any first failure is preserved with its original status.
This is one integration test containing three scenarios, not three unit tests.

Pre-accounting actual session8 run `scratch/session8-appserver-fixture-ts-d5a9d36e-1864-4296-92b9-916e3b010ccf/summary.json`
passed all three scenarios with unchanged before/after source hashes. Normal
returned authored JSON (1383 bytes); cancellation stopped after 661 bytes. Each
scenario verified six owned pidfds ESRCH and an empty PID namespace, then the
local WSL wrapper closed. The overflow scenario observed/delivered 8,389,269
bytes and retained only 661 stdout + 8,384,512 stderr bytes; it rejected with
OUTPUT_LIMIT and wrapper exit 1, as expected. Actual model calls remained zero.
The summary SHA-256 is
`6267c9e1e6e447edfa932e63134eb33c8df14209ceb2577a146021e9d2585684`.

The original 20-second overflow expectation remains FAIL at
`scratch/session8-appserver-fixture-ts-3ae8889f-2154-4104-afcd-c573941f6781/summary.json`
(SHA-256 `913e87676c90b7a72d43e4618aa2077ce46c26d927526c004bb449859755fea1`).
It reached 5,128,853 bytes before GENERATION_DEADLINE; all its owned cleanup
checks passed. An earlier runner startup used a nonexistent config filename and
failed before any fixture launch; the actual runs used `vitest.measure.mts`.

After accounting callback integration, a separate actual run at
`scratch/session8-appserver-fixture-ts-deae1580-79ca-4893-8c0d-79acb012fd44/summary.json`
passed one test / three scenarios in 41.91 seconds with unchanged source hashes.
All three reported validated terminal watermarks before cleanup settlement.
Normal received/observed 1383 bytes, cancel 661, overflow 8,389,269 (661 stdout
+ 8,388,608 stderr). Overflow retained 8,385,173 total bytes and rejected with
OUTPUT_LIMIT. Verified owned pidfd counts were 6/5/5, respectively, with empty
namespaces and closed local wrappers. Every actual withheld count was zero;
nonzero withheld-tail handling is covered by unit tests, not claimed as observed
in this runtime. Summary SHA-256:
`b491694bc89a23d2a2e8044c61c11d0d01fb5237fd2cd31f02498e6b728393ff`.
