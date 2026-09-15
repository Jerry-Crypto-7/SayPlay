"""Fixed namespace-descendant experiments; no credentials, cgroup writes or host mounts."""
import ctypes
import errno
import json
import os
from pathlib import Path
import signal
import stat
import time

CLONE_NEWUSER = 0x10000000
CLONE_NEWNS = 0x00020000
libc = ctypes.CDLL(None, use_errno=True)


def identity(fd):
    info = os.fstat(fd)
    return {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode)}


def syscall(name, *args):
    result = getattr(libc, name)(*args)
    return {'succeeded': result == 0, 'errno': None if result == 0 else ctypes.get_errno()}


def inspect_boundary():
    observations = {}
    # Read-only opens/fstat only: never read file bodies or write to descriptors.
    paths = ['/sys/fs/cgroup', '/sys/fs/cgroup/cgroup.procs', '/oldroot',
             '/proc/1/root/sys/fs/cgroup', '/proc/1/root/oldroot',
             '/proc/1/root/proc/1/root/sys/fs/cgroup', '/work/cgroup-view/cgroup.procs']
    for path in paths:
        try:
            fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
            observations[path] = {'opened': True, 'identity': identity(fd), 'errno': None}
            os.close(fd)
        except OSError as error:
            observations[path] = {'opened': False, 'identity': None, 'errno': error.errno}
    descriptors = {}
    for path in ['/proc/1/fd/0', '/proc/1/fd/1', '/proc/1/root/proc/1/fd/0', '/proc/1/root/proc/1/fd/1']:
        try:
            fd = os.open(path, os.O_WRONLY | os.O_NONBLOCK)
            descriptors[path] = {'opened': True, 'identity': identity(fd), 'errno': None, 'bytesWritten': 0}
            os.close(fd)
        except OSError as error:
            descriptors[path] = {'opened': False, 'identity': None, 'errno': error.errno, 'bytesWritten': 0}
    return {'paths': observations, 'descriptors': descriptors}


def attempt(method):
    before = {name: os.readlink('/proc/self/ns/' + name) for name in ['user', 'mnt', 'pid']}
    uid, gid = os.getuid(), os.getgid()
    steps = [{'operation': 'unshare-' + method,
              **syscall('unshare', CLONE_NEWUSER | (CLONE_NEWNS if method == 'combined' else 0))}]
    result = {'method': method, 'beforeNamespaces': before, 'steps': steps, 'afterNamespaceBoundary': None}
    if not steps[-1]['succeeded']:
        return result
    # These maps target only this newly created user namespace; no host maps/cgroups.
    for path, data in [('/proc/self/setgroups', 'deny'), ('/proc/self/uid_map', f'{uid} {uid} 1'), ('/proc/self/gid_map', f'{gid} {gid} 1')]:
        try:
            Path(path).write_text(data)
            steps.append({'operation': 'new-namespace-map', 'path': path, 'succeeded': True, 'errno': None})
        except OSError as error:
            steps.append({'operation': 'new-namespace-map', 'path': path, 'succeeded': False, 'errno': error.errno})
    if method == 'sequential':
        steps.append({'operation': 'unshare-mount', **syscall('unshare', CLONE_NEWNS)})
        if not steps[-1]['succeeded']:
            return result
    after = {name: os.readlink('/proc/self/ns/' + name) for name in ['user', 'mnt', 'pid']}
    result['afterNamespaces'] = after
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    result['afterNamespaceStatus'] = {name: status[name].strip() for name in ['CapEff', 'CapBnd', 'NoNewPrivs']}
    mountinfo = Path('/proc/self/mountinfo').read_text().splitlines()
    result['procMounts'] = [{'mountpoint': line.split()[4], 'filesystem': line.split(' - ', 1)[1].split()[0]} for line in mountinfo if line.split(' - ', 1)[1].split()[0] == 'proc']
    private = not any(field.startswith(('shared:', 'master:')) for line in mountinfo for field in line.split(' - ', 1)[0].split()[6:])
    if after['mnt'] == before['mnt'] or after['user'] == before['user'] or not private:
        result['mutationRefused'] = 'NEW_PRIVATE_DESCENDANT_NAMESPACES_REQUIRED'
        return result
    result['privateDescendantMountNamespace'] = True
    result['afterNamespaceBoundary'] = inspect_boundary()
    # Mount attempts are read-only and confined to the proven new private namespace.
    for fs, target in [(b'proc', b'/work/proc-view'), (b'cgroup2', b'/work/cgroup-view')]:
        steps.append({'operation': 'mount-read-only-' + fs.decode(),
                      **syscall('mount', fs, target, fs, 1 | 2 | 4 | 8, None)})
    result['afterMountBoundary'] = inspect_boundary()
    # At most three local proc layers, never a host mount or another namespace.
    result['procLayers'] = []
    for _ in range(3):
        operation = {'operation': 'detach-local-proc', **syscall('umount2', b'/proc', 2)}
        steps.append(operation)
        result['procLayers'].append({'unmount': operation, 'boundary': inspect_boundary()})
        if not operation['succeeded']:
            break
    return result


def isolated_attempt(method):
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        try:
            result = attempt(method)
        except Exception as error:
            result = {'method': method, 'error': type(error).__name__ + ': ' + str(error)}
        data = json.dumps(result).encode()
        os.write(write_fd, data[:32768])
        os.close(write_fd)
        os._exit(0)
    os.close(write_fd)
    os.set_blocking(read_fd, False)
    data = bytearray()
    until = time.monotonic() + 2
    complete = False
    while time.monotonic() < until:
        try:
            block = os.read(read_fd, 4096)
            if not block:
                complete = True
                break
            data.extend(block)
        except BlockingIOError:
            time.sleep(0.005)
        if len(data) > 32768:
            break
    os.close(read_fd)
    if not complete:
        os.kill(pid, signal.SIGKILL)
    os.waitpid(pid, 0)
    if not complete:
        return {'method': method, 'error': 'BOUNDED_CHILD_TIMEOUT_OR_OUTPUT'}
    return json.loads(data)


def main():
    assert len(os.sys.argv) == 1
    status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
    expected = json.loads(Path('/work/expected-boundary.json').read_text())
    facts = {'namespaces': {name: os.readlink('/proc/self/ns/' + name) for name in ['user', 'mnt', 'pid']},
             'CapEff': status['CapEff'].strip(), 'CapBnd': status['CapBnd'].strip(), 'NoNewPrivs': status['NoNewPrivs'].strip(),
             'outerNamespaces': {'pid': os.environ['RC_PROBE_SUPERVISOR_PID_NS'], 'mnt': os.environ['RC_PROBE_SUPERVISOR_MOUNT_NS']},
             'expectedProtectedDescriptors': expected, 'ownOutputIdentity': identity(1),
             'baseline': inspect_boundary(), 'attempts': [isolated_attempt(mode) for mode in ['combined', 'sequential']],
             'cgroupBytesWritten': 0, 'descriptorBytesWritten': 0, 'credentialFilesRead': False}
    print(json.dumps(facts, sort_keys=True))


if __name__ == '__main__':
    main()
