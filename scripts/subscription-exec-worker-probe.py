"""Fixed non-secret executor worker probe; run only in the owned capsule."""
import ctypes
import errno
import json
import os
from pathlib import Path
import stat
import sys

PATHS = (
    '/private/sentinel', '/private/config.toml', '/work/executor-home',
    '/work/executor-home/sentinel',
    '/proc/1/root/private/sentinel', '/proc/1/root/work/executor-home',
    '/proc/1/fd/0', '/proc/1/fd/1', '/sys/fs/cgroup',
    '/sys/fs/cgroup/cgroup.procs', '/oldroot', '/mnt', '/home', '/root',
)
# Mount/process targets are invalid. Namespace probes affect only this owned
# worker if lockdown is unexpectedly missing; the outer capsule owns cleanup.
CALLS = {
    'unshare-user': (272, 0x10000000),
    'unshare-mount': (272, 0x20000),
    'setns-invalid': (308, -1, 0),
    'mount-invalid': (165, 0, 0, 0, 0, 0),
    'ptrace-invalid': (101, 16, -1, 0, 0),
    'pidfd-getfd-invalid': (438, -1, -1, 0),
    'clone3-invalid': (435, 0, 0),
}


def descriptor(fd):
    info = os.fstat(fd)
    return {'fd': fd, 'dev': info.st_dev, 'ino': info.st_ino,
            'type': stat.S_IFMT(info.st_mode)}


def open_probe(path):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as error:
        return {'opened': False, 'errno': error.errno, 'bytesRead': 0, 'bytesWritten': 0}
    try:
        return {'opened': True, 'errno': None, 'bytesRead': 0,
                'bytesWritten': 0, 'descriptor': descriptor(fd)}
    finally:
        os.close(fd)


def syscall_probes():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    result = {}
    for name, args in CALLS.items():
        ctypes.set_errno(0)
        returned = libc.syscall(*args)
        result[name] = {'return': returned, 'errno': ctypes.get_errno()}
    return result


def namespace_metadata(path):
    try:
        return {'value': os.readlink(path), 'errno': None}
    except OSError as error:
        return {'value': None, 'errno': error.errno}


def collect():
    if len(sys.argv) != 1 or sys.platform != 'linux' or os.uname().machine != 'x86_64':
        raise ValueError('FIXED_EXEC_WORKER_CAPSULE_REQUIRED')
    fields = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    descriptors = []
    for name in os.listdir('/proc/self/fd'):
        try:
            descriptors.append(descriptor(int(name)))
        except OSError as error:
            if error.errno != errno.EBADF:
                raise
    # Only names are reported: no inherited environment values, file contents,
    # descriptor targets, host credential stores or arbitrary input are read.
    return {'kind': 'ACTUAL_FIXED_EXECUTOR_WORKER_PROBE', 'schemaVersion': 1,
            'identity': {'pid': os.getpid(), 'ppid': os.getppid(),
                         'pidNamespace': os.readlink('/proc/self/ns/pid'),
                         'mountNamespace': os.readlink('/proc/self/ns/mnt'),
                         'procInitPidNamespace': namespace_metadata('/proc/1/ns/pid'),
                         'nspid': fields['NSpid'].strip()},
            'status': {key: fields[key].strip() for key in
                       ('NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff', 'CapBnd')},
            'environmentKeys': sorted(os.environ), 'cwd': os.getcwd(),
            'descriptors': sorted(descriptors, key=lambda entry: entry['fd']),
            'paths': {path: open_probe(path) for path in PATHS},
            'syscalls': syscall_probes(), 'actualModelCalls': 0,
            'credentialFilesRead': False, 'networkOperations': 0}


if __name__ == '__main__':
    print(json.dumps(collect(), separators=(',', ':'), allow_nan=False), flush=True)
