# Fixed executor worker probe

`subscription-exec-worker-probe.py` is copied read-only to
`/usr/bin/exec-worker-probe.py` in the credential-free runtime capsule. It accepts
no arguments. The executor trampoline installs the existing fixed lockdown before
executing it. Do not run it directly on the host.

The single JSON report records the worker's own status, environment variable
names, descriptor metadata, fixed path open outcomes and fixed syscall outcomes.
Protected-path probes open and close descriptors without reading or writing any
bytes. `/private/sentinel` and `/work/executor-home/sentinel` are newly authored
non-secret files, never existing credential stores. No network operation exists.

Namespace probes could create namespaces in this owned worker if its filter is
missing; outer capsule cleanup remains responsible for every descendant. Other
mount/process syscall probes use invalid targets. The report does not declare
PASS: the external driver must check completeness, source identity, expected
denials and owned process cleanup. A proc path referring to the worker's own PID
namespace must not be confused with access to a trusted outer descriptor.

Offline tests mock file operations; they do not validate kernel permissions or
the CLI executor. The initial Windows test run failed because Linux open flags
were missing in the mock, followed by the corrected five-test PASS. Actual
executor validation is a separate pending step.
