"""Post-namespace worker filter; never install in the trusted setup process.

This is a syscall restriction, not a credential or filesystem sandbox. The caller
must isolate mounts/PIDs/FDs/resources and drop capabilities before this call.
"""
import ctypes
import errno
import hashlib
import json
import os
import platform
import struct
import sys

AUDIT_ARCH_X86_64 = 0xC000003E
KILL_PROCESS = 0x80000000
ALLOW = 0x7FFF0000
ERRNO = 0x00050000
# Policy targets Linux even when generated/validated offline on Windows, whose
# errno.ENOSYS is 40. Host errno values must never affect the deployed filter.
LINUX_EPERM, LINUX_ENOSYS = 1, 38
LD_W_ABS, JMP_JEQ_K, JMP_JGE_K, JMP_JSET_K, RET_K = 0x20, 0x15, 0x35, 0x45, 0x06
# NEWNS, NEWCGROUP, NEWUTS, NEWIPC, NEWUSER, NEWPID, NEWNET.
# NEWTIME (0x80) is an exit-signal bit for legacy clone, and is rejected
# conservatively too; ordinary SIGCHLD fork/thread flags remain accepted.
NAMESPACE_FLAGS = 0x00020000 | 0x02000000 | 0x04000000 | 0x08000000 | 0x10000000 | 0x20000000 | 0x40000000 | 0x80
DENIED_SYSCALLS = {
    'ptrace': 101, 'pivot_root': 155, 'chroot': 161, 'mount': 165,
    'umount2': 166, 'unshare': 272, 'setns': 308,
    'process_vm_readv': 310, 'process_vm_writev': 311,
    'open_by_handle_at': 304, 'bpf': 321,
    'io_uring_setup': 425, 'io_uring_enter': 426, 'io_uring_register': 427,
    'open_tree': 428, 'move_mount': 429, 'fsopen': 430, 'fsconfig': 431,
    'fsmount': 432, 'fspick': 433, 'pidfd_getfd': 438, 'mount_setattr': 442,
}


def build_filter():
    """Immutable classic-BPF instructions, for native little-endian x86_64."""
    ins = [(LD_W_ABS, 0, 0, 4),
           (JMP_JEQ_K, 1, 0, AUDIT_ARCH_X86_64), (RET_K, 0, 0, KILL_PROCESS),
           (LD_W_ABS, 0, 0, 0),
           # Also rejects negative syscall numbers and old x32 512..547 aliases.
           (JMP_JGE_K, 0, 1, 512), (RET_K, 0, 0, KILL_PROCESS),
           (JMP_JEQ_K, 0, 1, 435), (RET_K, 0, 0, ERRNO | LINUX_ENOSYS)]
    for nr in sorted(DENIED_SYSCALLS.values()):
        ins += [(JMP_JEQ_K, 0, 1, nr), (RET_K, 0, 0, ERRNO | LINUX_EPERM)]
    ins += [(JMP_JEQ_K, 0, 4, 56),
            (LD_W_ABS, 0, 0, 16),
            (JMP_JSET_K, 0, 1, NAMESPACE_FLAGS),
            (RET_K, 0, 0, ERRNO | LINUX_EPERM), (RET_K, 0, 0, ALLOW),
            (RET_K, 0, 0, ALLOW)]
    return tuple(ins)


def require_supported_abi():
    if (sys.platform != 'linux' or platform.machine() != 'x86_64'
            or ctypes.sizeof(ctypes.c_void_p) != 8 or sys.byteorder != 'little'):
        raise RuntimeError('WORKER_LOCKDOWN_UNSUPPORTED_ABI')


def install_worker_lockdown():
    """Set NNP and install filter with TSYNC, raising on every failed readback.

    Caller must terminate on exception; NNP may already have been installed.
    The receipt describes this call, and is not an external attestation.
    """
    require_supported_abi()
    class SockFilter(ctypes.Structure):
        _fields_ = [('code', ctypes.c_ushort), ('jt', ctypes.c_ubyte),
                    ('jf', ctypes.c_ubyte), ('k', ctypes.c_uint32)]
    class SockFprog(ctypes.Structure):
        _fields_ = [('len', ctypes.c_ushort), ('filter', ctypes.POINTER(SockFilter))]
    instructions = build_filter()
    array = (SockFilter * len(instructions))(*(SockFilter(*i) for i in instructions))
    program = SockFprog(len(instructions), array)
    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.restype = ctypes.c_int
    libc.syscall.restype = ctypes.c_long
    if libc.prctl(38, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), 'WORKER_LOCKDOWN_NNP_FAILED')
    # seccomp(SECCOMP_SET_MODE_FILTER, SECCOMP_FILTER_FLAG_TSYNC, &program).
    # Positive return is a failing thread ID, not success.
    result = libc.syscall(ctypes.c_long(317), ctypes.c_uint(1), ctypes.c_uint(1), ctypes.byref(program))
    if result != 0:
        raise RuntimeError(f'WORKER_LOCKDOWN_FILTER_FAILED result={result} errno={ctypes.get_errno()}')
    nnp = libc.prctl(39, 0, 0, 0, 0)
    mode = libc.prctl(21, 0, 0, 0, 0)
    if nnp != 1 or mode != 2:
        raise RuntimeError('WORKER_LOCKDOWN_READBACK_FAILED')
    return {'arch': 'linux-x86_64', 'noNewPrivs': nnp, 'seccompMode': mode,
            'threadSync': True, 'instructionCount': len(instructions),
            'filterSha256': hashlib.sha256(b''.join(struct.pack('<HBBI', *i) for i in instructions)).hexdigest()}


def fixed_fixture():
    """Finite, credential-free denial and ordinary-fork fixture only."""
    receipt = install_worker_lockdown()
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    observations = {}
    # Invalid pointers are deliberate: no successful namespace/mount operation
    # is needed. Exact EPERM demonstrates the installed filter before EFAULT.
    for name, nr in DENIED_SYSCALLS.items():
        ctypes.set_errno(0)
        value = libc.syscall(ctypes.c_long(nr), ctypes.c_long(0), ctypes.c_long(0),
                             ctypes.c_long(0), ctypes.c_long(0), ctypes.c_long(0), ctypes.c_long(0))
        observations[name] = {'return': value, 'errno': ctypes.get_errno()}
        if value != -1 or ctypes.get_errno() != errno.EPERM:
            raise RuntimeError('WORKER_LOCKDOWN_DENIAL_FAILED:' + name)
    child = os.fork()
    if child == 0:
        os._exit(0)
    _, status = os.waitpid(child, 0)
    if status != 0:
        raise RuntimeError('WORKER_LOCKDOWN_FORK_FAILED')
    print(json.dumps({'fixture': 'worker-lockdown-v1', 'receipt': receipt,
                      'denials': observations, 'ordinaryFork': True}), flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 1:
        raise SystemExit('WORKER_LOCKDOWN_FIXED_FIXTURE_ONLY')
    fixed_fixture()
