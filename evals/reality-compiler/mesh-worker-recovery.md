# Native worker recovery with synthetic fault injection

Opt-in PowerShell command:

```powershell
$env:RC_MESH_WORKER_RECOVERY='1'
node_modules/.bin/vitest.cmd run --config vitest.measure.mts evals/reality-compiler/mesh-worker-recovery.measure.ts
```

The harness bundles the actual mesh-client.ts and mesh-worker.ts and their local
dependencies, serves only three fixed routes on its own ephemeral 127.0.0.1 HTTP
server, and opens a fresh Playwright Chromium browser/context. Local esbuild was
not installed or on PATH; the parent approved using already installed rolldown
1.2.4. No packages are installed and no network download is performed. Browser
requests are restricted to the own localhost origin.

The real createMeshClient uses its injected factory to create native browser
Workers from the bundled actual mesh-worker module, with main-thread fallback
explicitly disabled. First it completes a fixed radius0.6 sphere warmup on the
first Worker, making its actual startup and subsequent close observable. It then
starts small fixed sphere A and queues sphere B. While
A is pending in the same main-thread turn, the fixture dispatches an untrusted
synthetic MessageEvent('messageerror') on A's Worker. A must reject; B must move
to a second native Worker. Synthetic late messageerror/error events on the
retired Worker must leave B running. B then performs real meshing and sends real
typed-array output through a trusted native message event. The harness validates
array types/counts, finite positions/normals, index ranges, nonempty topology and
bounded positions before disposing the client.

This is actual browser/Worker execution with synthetic fault injection. It is not
an actual structured-clone/deserialization failure, rendered 3D frame, GPU/VRAM
measurement, model call, inference result, or general malicious-worker guarantee.
The saved workerComputeElapsedMs is the returned small-mesh computation duration,
not a production latency benchmark. No source runtime file is edited.

Current pinned A8 source prerequisites:

- mesh-client.ts SHA-256
  `9df2ad3e3ace63713f3df0e5dd1316cd89177e4bdbb53d57ec1d4a91d8f12bb9`.
- mesh.test.ts SHA-256
  `aa83e337a5d7ed82ac834dc1c08320c7aaa41e8b04e0a5f544e12b1a017ff8a7`.

Every run writes a fresh UUID directory under
`scratch/session8-mesh-worker-recovery/`. It records declared inputs, initial
relevant source hashes, every consumed bundle module's bytes/hash, bundle
bytes/hash, the same sources before browser execution and after cleanup, raw
mesh arrays, native Worker events, HTTP requests and cleanup. Unrelated dispatcher
or application modules are excluded. Hash comparisons are observed stability
checks rather than an atomic snapshot or historical build attestation.

Cleanup disposes the mesh client, observes native Worker close events, closes the
fresh context and browser, closes only the owned HTTP server/connections, and
checks its former localhost port refuses a connection. Failures are archived;
cleanup attempts continue if a preceding browser cleanup step throws.

The first attempt (`1bf886df-93d0-4a95-b064-908d37a20b24`) failed before creating a
native Worker: Vite rewrote the evaluate callback's dynamic import to its SSR
helper, which does not exist in a browser. That FAIL is preserved; its context,
browser and server closed and the old port refused connections. The harness now
uses a fixed browser Function/import to keep the import outside Vite's transform.
The local bundler's deprecated inlineDynamicImports option was also replaced by
codeSplitting false. Neither change modifies mesh runtime source.

The second attempt (`0ae6b8a1-6128-4759-8a96-dc5636ba8b48`) exposed an actual
browser compatibility gap and remains FAIL: synthetic messageerror did not call
the assigned onmessageerror property. A subsequent synthetic error event activated
the existing onerror path, so B eventually produced a mesh through the wrong
failure path. Independent native-interface diagnosis on HeadlessChrome
151.0.7922.34 confirmed `onmessageerror in worker` false and only the registered
EventTarget listener fired. The initial Node-e diagnostic had a shell quoting
SyntaxError before browser creation; passing the fixed script on stdin succeeded.
Its own empty Worker and browser were closed.

The parent then authorized a source correction: messageerror now registers via
addEventListener when available; the property fallback remains for injected
doubles without EventTarget support. Existing identity/retirement guards and all
six previous regression cases remain. Two new listener registration/cancellation
tests bring the mesh suite to 64 passing tests. Earlier attempts used client hash
`adeb5b5bd8c1cdc3d80386467b05309bd5886fdd63c702169a637cff13b6482c` and test hash
`befb0d51f7286a12ef05ba9aa58310296d7ce79bca940d43e19910d4b89aabbf`; they are not
relabelled as runs of the corrected source.

The third attempt (`f9455f2e-b5b2-4381-8dab-a3c7f7a85a6f`) exercised the corrected
messageerror path and recovered B correctly, but remains FAIL against the declared
two native Worker close observations: A was terminated in the constructor's first
task before Playwright attached, so only B's create/close events were observed.
The context, browser and server still closed and the old port refused connections.
The next declared experiment adds the fixed first-Worker warmup described above;
it preserves the two-close requirement and does not change runtime source or
relabel that earlier failed observation.
