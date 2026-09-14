# Post-setup worker seccomp restriction

`subscription-worker-lockdown.py` exports `install_worker_lockdown()` and
`build_filter()`. The trusted caller invokes install in the worker **after** the
CLI/bwrap namespace and mount setup, before any untrusted code. Installing before
bwrap would block required trusted setup. Any exception terminates the worker;
the caller must never catch a failure and continue dispatch.

The installer supports only native Linux x86_64, 64-bit pointers, little endian.
It sets `PR_SET_NO_NEW_PRIVS`, installs classic BPF with `seccomp` TSYNC, rejects
both negative failure and positive unsynchronizable-thread results, and verifies
NNP=1/seccomp=2 readbacks. Receipt fields are `arch`, `noNewPrivs`, `seccompMode`,
`threadSync`, `instructionCount`, `filterSha256`. This receipt is a trusted-caller
observation, not remote attestation. The SHA hashes packed little-endian BPF.

The filter kills foreign syscall ABIs (including int80), x32-bit syscalls, and all
numbers >=512, including historical x32 512..547 aliases. Native clone denies
namespace flags; clone3 returns ENOSYS so runtimes can fall back to clone. Plain
fork, thread clone, vfork and exec remain allowed. Mount APIs, unshare/setns,
ptrace/process_vm, pidfd_getfd, open_by_handle_at, chroot, BPF and io_uring are
denied with EPERM. The conservative legacy-clone 0x80 denial covers NEWTIME even
though that bit occupies its exit-signal field; normal SIGCHLD remains allowed.

This is a focused deny policy, not a complete syscall allowlist. New native calls
below 512 need review. It does not isolate the filesystem, control/auth FDs,
cgroup hierarchy, networking, or process visibility; it does not enforce CPU/RAM
limits or prove cleanup. Caller setup must remove host mounts and foreign FDs,
drop capabilities, put worker in the intended resource leaf, and retain trusted
control outside that leaf. Ordinary signals remain allowed: PID/control isolation
is essential. Kernel vulnerabilities remain outside this guarantee. Additional
seccomp filters cannot weaken an existing filter, and fork/exec inherit it.

No-argument CLI runs only a finite credential-free denial/fork fixture. It accepts
no arbitrary command or caller path. The integrated capsule should import the
API rather than rely on this fixture as proof of mount/resource prerequisites.

Local unit tests interpret the emitted BPF and mock installation failures. They
prove policy encoding/control flow, **not kernel enforcement**. Actual Linux
capsule results must be recorded separately, including source identity and
failures; Windows test success cannot receive runtime/auth/inference credit.

Offline validation on 2026-09-10 initially reported 12 PASS / 1 FAIL for the
independent worker-boundary fixture. The fixture correctly used Linux clone3
ENOSYS=38, revealing host-dependent policy generation and validation: Windows
`errno.ENOSYS` is 40. The filter now embeds explicit Linux errno numbers; the
boundary validator was corrected separately. A regression test changes host
errno constants and requires byte-for-byte identical BPF. The subsequent
combined run passed 26 tests (12 lockdown, 14 boundary), using
`python -m pytest -q --tb=short --import-mode=importlib -p no:cacheprovider`
with both test files. This remains offline evidence, not a kernel run.

Sources: [Linux seccomp filter documentation](https://docs.kernel.org/userspace-api/seccomp_filter.html),
[seccomp ABI/TSYNC semantics](https://man7.org/linux/man-pages/man2/seccomp.2.html),
[clone flags](https://man7.org/linux/man-pages/man2/clone.2.html), and
[Linux v6.12 x86 syscall table](https://raw.githubusercontent.com/torvalds/linux/v6.12/arch/x86/entry/syscalls/syscall_64.tbl).
