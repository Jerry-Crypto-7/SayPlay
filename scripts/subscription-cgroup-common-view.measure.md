# Fixed common-view Windows measurement

Draft under integration; no actual execution or stress admission. The no-argument
driver captures six fixed source files, archives exact bytes, and invokes only
the new metadata service through clean WSL Python. Five service hashes are the
only input. The service owns its UUID and process lifecycle.

Raw stdout is capped at 2 MiB and stderr at 64 KiB. Reader threads continue
draining invalid bytes until EOF or the fixed process deadline; overflow,
missing EOF and read errors prevent success. The Windows wait is 40 seconds;
terminating its own client cannot establish remote cleanup. Any incomplete or
unpersisted attempt leaves the module fenced.

Replay binds before/after source bytes and exact raw hashes, then invokes the
archived service's pure validator with its archived sampler. Full service
composition, source review and actual evidence remain prerequisites; wire
fixtures provide no common-hierarchy, resource, authentication or model credit.
