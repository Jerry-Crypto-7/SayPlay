# Fixed post-sandbox trampoline

`--trusted-cli-worker-boundary` adds one literal target: `/usr/bin/python3 -I -S /usr/bin/trusted-cli-worker-probe.py`. No extra argument, alternative target or combined selector is accepted. Existing targets remain fixed.

The new target follows the same path as existing probes: distinct PID and mount namespaces, PID 1 belonging to the fresh proc view, readonly `/usr/bin`, lockdown installation, closing every observed nonstandard FD, fixed cwd and clean replacement environment before exec. It does not forward a proxy socket or inherited environment to the worker. Source tests cover namespace/proc rejection, lockdown failure, close failure and exact final argv/environment. No actual invocation or isolation credit is claimed by these mocked tests.
