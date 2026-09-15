# Fixed authored JSONL child

This Python program runs only inside the existing credential-free CLI capsule.
It imports no client SDK, creates no subprocess and performs no auth, model or
network request. Four fixed protocol steps produce an explicitly authored JSON
answer. `cancel` stays idle after authored turn/start; `output-limit` writes a
bounded 8 MiB+64 KiB stream to stderr. All descriptors are nonblocking; input is
bounded to 2 MiB, an individual line to 1,100,000 bytes, queued responses to
64 KiB and total lifetime to 180 seconds. PID1 remains the independent cleanup
authority. EOF exits; normal completion waits for client EOF/cancellation.

Reported thread/model fields are authored protocol fixtures and prove no actual
runtime registry, model availability or model call. The input content is data;
there is no command evaluation or generic argv facility.

The child now synchronously installs the existing post-namespace worker filter
after exact argv/scenario validation and before constructing `Protocol`, creating
the selector, or operating on descriptors 0/1/2. It loads only the fixed read-only
image path `/usr/bin/worker-lockdown.py`. Loader, ABI, installation and readback
errors propagate and prevent protocol operation; there is no fallback. Python
may report an uncaught startup exception to stderr; that is failure evidence,
not a protocol response. The filter is never installed in trusted PID1/setup.

The supervisor's existing fixture ready/start helper map now requires both the
fixture child and lockdown source hashes. The existing shell already copies the
helper before remounting `/usr` read-only. Callers must adopt the two-entry map;
old single-entry requests fail closed. The filter continues to allow the fixture's
ordinary pipe, selector and timing syscalls. Compatibility of all three scenarios
requires a new reviewed actual run; offline ordering tests are not runtime proof.

Historical basic/systemd fixture runs preceded this change and receive no new
worker-lockdown credit. This addition is a syscall restriction, not authenticated
production isolation, resource exhaustion validation or a general descendant
safety guarantee. Model events remain authored and actual model calls remain zero.
