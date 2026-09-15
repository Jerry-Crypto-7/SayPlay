"""Fixed post-CLI-sandbox worker probe. Only synthetic paths, no auth/network."""
import ctypes
import errno
import importlib.util
import json
import mmap
import os
from pathlib import Path
import signal
import stat
import sys
import threading
import time

PATHS = ('/private/sentinel', '/private/config.toml', '/work/private-alias',
         '/sys/fs/cgroup', '/sys/fs/cgroup/cgroup.procs', '/oldroot',
         '/proc/1/root/private/sentinel', '/proc/1/root/sys/fs/cgroup')
FD_PATHS = ('/proc/1/fd/0', '/proc/1/fd/1', '/proc/1/root/proc/1/fd/0', '/proc/1/root/proc/1/fd/1')
CLONE_FLAGS = {'newtime': 0x80, 'newns': 0x20000, 'newcgroup': 0x2000000,
               'newuts': 0x4000000, 'newipc': 0x8000000, 'newuser': 0x10000000,
               'newpid': 0x20000000, 'newnet': 0x40000000}


def identity(fd):
    info = os.fstat(fd)
    return {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode)}


def status():
    # /proc/self/status describes the main task even when called by a thread.
    fields = dict(line.split(':', 1) for line in Path('/proc/thread-self/status').read_text().splitlines() if ':' in line)
    return {key: fields[key].strip() for key in ('NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff', 'CapBnd')}


def paths():
    result = {}
    for path in (*PATHS, *FD_PATHS):
        try:
            fd = os.open(path, (os.O_WRONLY if path in FD_PATHS else os.O_RDONLY) | os.O_NONBLOCK | os.O_CLOEXEC)
            try:
                result[path] = {'opened': True, 'identity': identity(fd), 'errno': None, 'bytesRead': 0, 'bytesWritten': 0}
            finally:
                os.close(fd)
        except OSError as error:
            result[path] = {'opened': False, 'identity': None, 'errno': error.errno, 'bytesRead': 0, 'bytesWritten': 0}
    inherited = []
    for name in os.listdir('/proc/self/fd'):
        try:
            inherited.append(identity(int(name)))
        except OSError as error:
            if error.errno != errno.EBADF:
                raise
    return {'paths': result, 'inheritedDescriptors': inherited}


def denied_calls():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    # Invalid mount/process targets cannot mutate even if the filter is broken.
    calls = {'unshare-user': (272, 0x10000000), 'unshare-mount': (272, 0x20000),
             'unshare-combined': (272, 0x10020000), 'setns': (308, -1, 0),
             'clone3': (435, 0, 0), 'mount': (165, 0, 0, 0, 0, 0),
             'umount2': (166, 0, 0), 'pivot_root': (155, 0, 0),
             'open_tree': (428, -1, 0, 0), 'move_mount': (429, -1, 0, -1, 0, 0),
             'fsopen': (430, 0, 0), 'fsconfig': (431, -1, 0, 0, 0, 0),
             'fsmount': (432, -1, 0, 0), 'fspick': (433, -1, 0, 0),
             'mount_setattr': (442, -1, 0, 0, 0, 0),
             'ptrace': (101, 16, -1, 0, 0), 'process_vm_readv': (310, -1, 0, 0, 0, 0, 0),
             'process_vm_writev': (311, -1, 0, 0, 0, 0, 0), 'pidfd_getfd': (438, -1, -1, 0)}
    result = {}
    for name, args in calls.items():
        ctypes.set_errno(0)
        value = libc.syscall(*[ctypes.c_long(a) for a in args])
        result[name] = {'return': value, 'errno': ctypes.get_errno() if value == -1 else None}
    return result


def snapshot():
    return {'status': status(), 'namespaces': {key: os.readlink('/proc/thread-self/ns/' + key) for key in ('user', 'mnt', 'pid')},
            'calls': denied_calls(), 'boundary': paths()}


def collect_child(child, read_fd=None):
    """Bounded collection/reap of one direct owned child; only pidfd signaling.

    A pin failure aborts the fixture; the outer supervisor remains cleanup
    authority. No PID-number signal fallback or unbounded wait is permitted.
    """
    child_fd = None
    data, child_status, eof = bytearray(), None, read_fd is None
    timed_out = False
    try:
        child_fd = os.pidfd_open(child)
        if read_fd is not None:
            os.set_blocking(read_fd, False)
        until = time.monotonic() + 4
        while time.monotonic() < until:
            if read_fd is not None and not eof:
                try:
                    block = os.read(read_fd, 4096)
                    if block:
                        data.extend(block)
                    else:
                        eof = True
                except BlockingIOError:
                    pass
            if child_status is None:
                reaped, value = os.waitpid(child, os.WNOHANG)
                if reaped:
                    child_status = value
            if len(data) > 32768 or (eof and child_status is not None):
                break
            time.sleep(0.005)
        timed_out = not eof or child_status is None
    finally:
        if read_fd is not None:
            os.close(read_fd)
        if child_fd is not None and child_status is None:
            try:
                signal.pidfd_send_signal(child_fd, signal.SIGKILL)
            except ProcessLookupError:
                pass
            # Outer namespace supervisor remains authoritative if reaping fails.
            until = time.monotonic() + 1
            while time.monotonic() < until:
                reaped, value = os.waitpid(child, os.WNOHANG)
                if reaped:
                    child_status = value
                    break
                time.sleep(0.005)
        if child_fd is not None:
            os.close(child_fd)
    if child_status is None:
        raise RuntimeError('WORKER_CHILD_CLEANUP_UNKNOWN')
    if len(data) > 32768:
        raise RuntimeError('WORKER_CHILD_OUTPUT_LIMIT')
    return bytes(data), {'reaped': True, 'timedOut': timed_out,
                         'signal': os.WTERMSIG(child_status) if os.WIFSIGNALED(child_status) else None,
                         'exitCode': os.WEXITSTATUS(child_status) if os.WIFEXITED(child_status) else None}


def abi_instruction(kind, output_fd):
    import resource
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    if kind == 'x32-getpid':
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        os.write(output_fd, b'abi-ready:x32-getpid\n')
        libc.syscall(ctypes.c_long(0x40000000 | 39))
    elif kind == 'int80-getpid':
        # Fixed x86 stub: mov eax,20; int 0x80; ret. i386 getpid takes no
        # pointers/arguments. No arbitrary code bytes or command input.
        # Linux v6.12 arch/x86/entry/syscalls/syscall_32.tbl: getpid=20.
        stub = mmap.mmap(-1, mmap.PAGESIZE, prot=mmap.PROT_READ | mmap.PROT_WRITE | mmap.PROT_EXEC)
        stub.write(b'\xb8\x14\x00\x00\x00\xcd\x80\xc3')
        address = ctypes.addressof(ctypes.c_char.from_buffer(stub))
        instruction = ctypes.CFUNCTYPE(ctypes.c_long)(address)
        os.write(output_fd, b'abi-ready:int80-getpid\n')
        instruction()
    else:
        raise ValueError('FIXED_ABI_ONLY')
    os._exit(90)  # Surviving a forbidden ABI is a failed observation.


def fixed_process(kind):
    if kind not in ('fork', 'exec', 'x32-getpid', 'int80-getpid'):
        raise ValueError('FIXED_PROCESS_ONLY')
    read_fd, write_fd = os.pipe()
    child = os.fork()
    if child == 0:
        os.close(read_fd)
        try:
            if kind == 'exec':
                os.dup2(write_fd, 1)
                os.dup2(write_fd, 2)
                os.close(write_fd)
                os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S',
                          '/usr/bin/worker-boundary-child.py', '--inherited'],
                          {'PATH': '/usr/bin:/bin', 'HOME': '/work/home', 'LANG': 'C.UTF-8'})
            elif kind == 'fork':
                data = json.dumps(snapshot()).encode()
                if len(data) > 32768:
                    os._exit(2)
                while data:
                    data = data[os.write(write_fd, data):]
            else:
                abi_instruction(kind, write_fd)
        except BaseException:
            os._exit(91)
        os._exit(0)
    os.close(write_fd)
    data, outcome = collect_child(child, read_fd)
    if kind in ('fork', 'exec'):
        if outcome != {'reaped': True, 'timedOut': False, 'signal': None, 'exitCode': 0}:
            raise RuntimeError('WORKER_INHERITANCE_CHILD_FAILED')
        return json.loads(data)
    if data != ('abi-ready:' + kind + '\n').encode():
        raise RuntimeError('WORKER_ABI_NOT_REACHED')
    outcome['instructionReached'] = True
    return outcome


def clone_namespaces():
    libc = ctypes.CDLL(None, use_errno=True)
    libc.syscall.restype = ctypes.c_long
    results = {}
    for name, flag in CLONE_FLAGS.items():
        ctypes.set_errno(0)
        value = libc.syscall(*[ctypes.c_long(a) for a in (56, flag | 17, 0, 0, 0, 0)])
        error = ctypes.get_errno() if value == -1 else None
        if value == 0:
            os._exit(0)  # No maps/mounts/writes if a namespace unexpectedly exists.
        outcome = None
        if value > 0:
            _, outcome = collect_child(value)
        results[name] = {'flags': flag | 17, 'return': value, 'errno': error, 'child': outcome}
    return results


def main():
    if sys.argv[1:] == ['--inherited']:
        print(json.dumps(snapshot()), flush=True)
        return 0
    if len(sys.argv) != 1:
        raise ValueError('FIXED_WORKER_ONLY')
    before = status()
    spec = importlib.util.spec_from_file_location('lockdown', '/usr/bin/worker-lockdown.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    existing = {}
    ready, release = threading.Event(), threading.Event()
    def existing_worker():
        existing['before'] = status()
        ready.set()
        if not release.wait(4):
            return
        existing['after'] = snapshot()
    waiting = threading.Thread(target=existing_worker, daemon=True)
    waiting.start()
    if not ready.wait(2):
        raise RuntimeError('WORKER_EXISTING_THREAD_START_TIMEOUT')
    receipt = module.install_worker_lockdown()
    release.set()
    waiting.join(2)
    if waiting.is_alive() or set(existing) != {'before', 'after'}:
        raise RuntimeError('WORKER_EXISTING_THREAD_TIMEOUT')
    current = snapshot()
    thread_result = []
    thread = threading.Thread(target=lambda: thread_result.append(snapshot()), daemon=True)
    thread.start()
    thread.join(2)
    if thread.is_alive():
        raise RuntimeError('WORKER_THREAD_TIMEOUT')
    # Every thread has joined before any raw clone/fork probe below.
    exec_result, fork_result = fixed_process('exec'), fixed_process('fork')
    clones = clone_namespaces()
    abi = {name: fixed_process(name) for name in ('x32-getpid', 'int80-getpid')}
    print(json.dumps({'version': 2, 'profile': 'post-cli-worker-lockdown-v2', 'before': before,
                      'receipt': receipt, 'current': current, 'thread': thread_result,
                      'existingThread': existing, 'exec': exec_result, 'fork': fork_result,
                      'cloneNamespaces': clones, 'abi': abi,
                      'modelCalls': 0, 'credentialFilesRead': False, 'productionReady': False}), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
