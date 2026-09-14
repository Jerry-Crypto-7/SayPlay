# Fixed common-view metadata service child

This additive child is not integrated or actually launched. It samples only its
own metadata through the source-bound common-view helper, emits one bounded
report, then stays alive for an external owner to bind MainPID, generation,
pidfd and manager ControlGroup. Pipe delivery does not attest that binding.

Two fixed source hashes are admitted over stdin; no path, command, PID or
network target is accepted. Bootstrap is five seconds within a total twenty
seconds. Sampling gets at most five remaining seconds; report output is capped
at 512 KiB with nonblocking writes and deadline-bound backpressure. Exact release
bytes are required. Every incomplete run, including source or sampler close
uncertainty, fences another run in the module. Fixed source opens are nonblocking
and must admit a bounded regular file before reading any bytes.

The prospective owner must retain and verify its own process handles and unit
cleanup independently. Process exit alone does not supply namespace, cgroup or
resource-enforcement credit. The sample describes a visible hierarchy, never
the protected manager namespace or an initial-host/global-capacity guarantee.
