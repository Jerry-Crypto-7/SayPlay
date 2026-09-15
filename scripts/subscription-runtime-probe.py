"""Run only fixed CLI help/version in a credential-free, networkless capsule.

This validates an executable/runtime baseline, not production CLI confinement,
authentication, network egress, inference or production process cleanup.
"""
import ctypes
import errno
import hashlib
import json
import os
from pathlib import Path
import selectors
import signal
import subprocess
import sys
import stat
import time

CLI_SHA256 = 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14'
BWRAP_SHA256 = '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c'


def check_runtime_identity(cli_hash, bwrap_hash):
    if cli_hash != CLI_SHA256 or bwrap_hash != BWRAP_SHA256:
        raise ValueError('FIXED_RUNTIME_IDENTITY_MISMATCH')


def enter_root():
    # x86_64 Linux syscall number; fail closed on any other runtime.
    assert os.uname().machine == 'x86_64' and os.getpid() == 1
    assert len(sys.argv) == 2
    root = Path(sys.argv[1])
    assert str(root).startswith('/tmp/rc-runtime.') and root.resolve() == root
    (root / 'oldroot').mkdir()
    libc = ctypes.CDLL(None, use_errno=True)
    os.chdir(root)
    if libc.syscall(155, b'.', b'oldroot') != 0:
        raise OSError(ctypes.get_errno(), 'PIVOT_ROOT_FAILED')
    os.chdir('/')
    if libc.umount2(b'/oldroot', 2) != 0:
        raise OSError(ctypes.get_errno(), 'OLD_ROOT_DETACH_FAILED')
    os.rmdir('/oldroot')
    os.closerange(3, 65536)
    os.execve('/usr/bin/python3', ['/usr/bin/python3', '-I', '-S',
        '/usr/bin/probe.py', '--inside'], {'PATH': '/usr/bin:/bin'})


def children():
    return sorted(int(p.name) for p in Path('/proc').iterdir()
                  if p.name.isdigit() and p.name != '1')


def check_mounts(mounts, allow_runtime_aliases=False):
    if type(allow_runtime_aliases) is not bool:
        raise ValueError('FIXED_MOUNT_PROFILE_REQUIRED')
    base = {'/', '/usr', '/proc', '/dev/null', '/dev/zero', '/dev/full', '/dev/random', '/dev/urandom', '/dev/tty'}
    aliases = {'/bin', '/lib', '/lib64'} if allow_runtime_aliases else set()
    assert all(len(line) >= 7 and line[4] in base | aliases for line in mounts), 'UNEXPECTED_MOUNT'
    assert sum(line[4] == '/' for line in mounts) == 1, 'ROOT_MOUNT_REQUIRED'
    for alias in aliases:
        observed = [line for line in mounts if line[4] == alias]
        assert len(observed) == 1 and {'ro', 'nosuid', 'nodev'} <= set(observed[0][5].split(',')), 'READONLY_RUNTIME_ALIAS_MOUNT_REQUIRED'


def sandbox(allow_runtime_aliases=False):
    assert os.getpid() == 1 and children() == [], 'EXCLUSIVE_PID_NAMESPACE_REQUIRED'
    assert not any(Path(p).exists() for p in ['/home', '/mnt', '/root', '/oldroot']), 'HOST_PATH_EXPOSED'
    mounts = [line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()]
    check_mounts(mounts, allow_runtime_aliases)
    assert os.stat('/dev/tty').st_rdev == os.stat('/dev/null').st_rdev, 'NULL_TTY_REQUIRED'
    interfaces = [line.split(':')[0].strip() for line in Path('/proc/net/dev').read_text().splitlines()[2:]]
    assert interfaces == ['lo'], 'NETWORK_ISOLATION_REQUIRED'
    try:
        Path('/usr/denied-write').write_text('synthetic')
    except OSError as error:
        assert error.errno == errno.EROFS, 'READ_ONLY_RUNTIME_REQUIRED'
    else:
        raise AssertionError('READ_ONLY_RUNTIME_REQUIRED')
    assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0, 'NONDUMPABLE_REQUIRED'
    Path('/work/home').mkdir()
    Path('/private').mkdir()
    Path('/private/config.toml').write_text('[permissions.private-sentinel.filesystem]\n":root" = "read"\n"/private" = "deny"\n\n[permissions.private-sentinel.network]\nenabled = false\n')
    Path('/private/sentinel').write_text('synthetic-private-control')
    Path('/work/public-sentinel').write_text('synthetic-public-control')
    Path('/work/private-alias').symlink_to('/private/sentinel')
    os.chdir('/work')
    return {'pidNamespaceInit': True, 'hostHomeMounted': False,
            'hostMntMounted': False, 'networkInterfaces': interfaces,
            'uid': os.getuid(), 'gid': os.getgid(),
            'ttyIsNullDevice': True,
            'runtimeWriteDenied': True, 'parentNondumpable': True}


def run(arguments, executable='/usr/bin/codex', private_profile=False):
    # Separate fixed data channel. Never accept argv from stdin or the caller.
    process = subprocess.Popen(['/usr/bin/setpriv', '--bounding-set=-all',
        '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
        executable, *arguments], stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, close_fds=True,
        start_new_session=True, env={'PATH': '/usr/bin:/bin', 'HOME': '/work/home',
        'CODEX_HOME': '/private' if private_profile else '/work/home', 'LANG': 'C.UTF-8', 'TMPDIR': '/tmp',
        'RC_PROBE_SUPERVISOR_PID_NS': os.readlink('/proc/self/ns/pid'),
        'RC_PROBE_SUPERVISOR_MOUNT_NS': os.readlink('/proc/self/ns/mnt'),
        'RC_PROBE_OUTPUT_DEV': str(os.fstat(1).st_dev), 'RC_PROBE_OUTPUT_INO': str(os.fstat(1).st_ino),
        'RC_PROBE_OUTPUT_TYPE': str(stat.S_IFMT(os.fstat(1).st_mode))})
    buffers = {'stdout': bytearray(), 'stderr': bytearray()}
    selector = selectors.DefaultSelector()
    for stream, pipe in [('stdout', process.stdout), ('stderr', process.stderr)]:
        os.set_blocking(pipe.fileno(), False)
        selector.register(pipe, selectors.EVENT_READ, stream)
    deadline = time.monotonic() + 10
    error = None
    try:
        while selector.get_map():
            if time.monotonic() >= deadline:
                error = 'PROBE_TIMEOUT'
                break
            for key, _ in selector.select(0.05):
                block = os.read(key.fd, 4096)
                if not block:
                    selector.unregister(key.fileobj)
                    continue
                buffers[key.data].extend(block)
                if sum(len(b) for b in buffers.values()) > 131072:
                    error = 'PROBE_OUTPUT_LIMIT'
                    break
            if error:
                break
    finally:
        # Every process in this exclusive namespace is owned by this probe.
        # This cleanup is a probe safety measure, not production cancel evidence.
        cleanup_deadline = time.monotonic() + 3
        while children() and time.monotonic() < cleanup_deadline:
            process.poll()
            for pid in children():
                try:
                    os.kill(pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for pid in children():
                if pid == process.pid:
                    continue
                try:
                    os.waitpid(pid, os.WNOHANG)
                except (ChildProcessError, ProcessLookupError):
                    pass
            time.sleep(0.01)
        process.poll()
        selector.close()
        process.stdout.close()
        process.stderr.close()
    return {'executable': executable, 'arguments': arguments, 'exitCode': process.returncode, 'error': error,
            'stdout': buffers['stdout'].decode('utf-8', errors='replace'),
            'stderr': buffers['stderr'].decode('utf-8', errors='replace'),
            'namespaceEmptyAfter': children() == []}


def output_protection(child, expected):
    try:
        if child['supervisorOutputIdentity'] != expected['output'] or child['supervisorPidNamespace'] != expected['namespace']:
            return None
        if child['openedOutputIdentity'] == expected['output'] or expected['output'] in child['inheritedDescriptors']:
            return None
        if child['pidNamespace'] == expected['namespace']:
            if child['parentOutputDenied'] is True and child['parentOutputErrno'] in (errno.EACCES, errno.EPERM):
                return 'permission-denied'
        elif (child['initPidNamespace'] == child['pidNamespace'] and child['procMountpoints'] and
              all(path == '/proc' for path in child['procMountpoints']) and child['procPropagationPrivate'] is True and
              child['supervisorMountNamespace'] == expected['mountNamespace'] and child['mountNamespace'] != expected['mountNamespace'] and
              child['procUnmountProbe'] == {'attempted': True, 'succeeded': False, 'errno': errno.EPERM} and
              child['openedOutputIdentity'] == child['ownOutputIdentity'] and child['openedOutputIdentity'] is not None and
              child['parentOutputDenied'] is False and child['parentOutputErrno'] is None):
            return 'nested-namespace-own-output'
    except (KeyError, TypeError):
        pass
    return None


def checks(result, work_allowed, expected, private_allowed=True):
    try:
        child = json.loads(result['stdout'])
        return {'capabilitiesDropped': child['CapEff'] == '0000000000000000' and child['CapBnd'] == '0000000000000000',
                'noNewPrivileges': child['NoNewPrivs'] == '1',
                'runtimeWriteDenied': child['usrWrite']['allowed'] is False and child['usrWrite']['errno'] in (errno.EROFS, errno.EACCES, errno.EPERM),
                'workWriteExpected': child['workWrite']['allowed'] is work_allowed and
                    (child['workWrite']['errno'] is None if work_allowed else child['workWrite']['errno'] in (errno.EROFS, errno.EACCES, errno.EPERM)),
                'networkDenied': child['networkConnect']['allowed'] is False and child['networkConnect']['errno'] in (errno.ENETUNREACH, errno.EACCES, errno.EPERM),
                'protectedOutputNotExposed': output_protection(child, expected) is not None,
                'publicControlReadable': child['publicControlReadable'] is True,
                'privateReadExpected': all(observation['allowed'] is private_allowed and
                    (observation['matches'] is True if private_allowed else observation['errno'] in (errno.EACCES, errno.EPERM, errno.ENOENT))
                    for observation in [child['privateRead'], child['privateAliasRead']])}
    except (KeyError, TypeError, ValueError):
        return {'syntheticFactsAvailable': False}


def main():
    facts = sandbox()
    with open('/usr/bin/codex', 'rb') as binary:
        assert binary.read(4) == b'\x7fELF', 'LINUX_ELF_REQUIRED'
        binary.seek(0)
        cli_hash = hashlib.file_digest(binary, 'sha256').hexdigest()
    with open('/usr/bin/bwrap', 'rb') as binary:
        bwrap_hash = hashlib.file_digest(binary, 'sha256').hexdigest()
    check_runtime_identity(cli_hash, bwrap_hash)
    results = [run(args) for args in [['--version'], ['--help'], ['exec', '--help'], ['sandbox', '--help']]]
    direct = run(['-I', '-S', '/usr/bin/child-probe.py'], '/usr/bin/python3')
    cli_sandbox = run(['sandbox', '-c', 'sandbox_mode="read-only"', '--',
                       '/usr/bin/python3', '-I', '-S', '/usr/bin/child-probe.py'])
    private_sandbox = run(['sandbox', '--permission-profile', 'private-sentinel', '--',
                          '/usr/bin/python3', '-I', '-S', '/usr/bin/child-probe.py'], private_profile=True)
    direct_after = run(['-I', '-S', '/usr/bin/child-probe.py'], '/usr/bin/python3')
    output = os.fstat(1)
    expected = {'namespace': os.readlink('/proc/self/ns/pid'),
                'mountNamespace': os.readlink('/proc/self/ns/mnt'),
                'output': {'dev': output.st_dev, 'ino': output.st_ino, 'type': stat.S_IFMT(output.st_mode)}}
    direct_checks = checks(direct, True, expected)
    cli_checks = checks(cli_sandbox, False, expected)
    private_checks = checks(private_sandbox, False, expected, False)
    direct_after_checks = checks(direct_after, True, expected)
    passed = all(r['exitCode'] == 0 and r['error'] is None and r['namespaceEmptyAfter']
                 for r in [*results, direct, cli_sandbox, private_sandbox, direct_after]) and all(direct_checks.values()) and all(cli_checks.values()) and all(private_checks.values()) and all(direct_after_checks.values())
    report = {'version': 'subscription-runtime-probe-v2',
              'profile': 'codex-0.145.0-linux-musl-private-probe-v2',
              'binarySha256': cli_hash, 'bwrapSha256': bwrap_hash,
              'sandbox': facts, 'results': results,
              'directSyntheticProbe': direct, 'cliSandboxSyntheticProbe': cli_sandbox,
              'privateProfileProbe': private_sandbox, 'privateProfileChecks': private_checks,
              'directAfterProbe': direct_after, 'directAfterChecks': direct_after_checks,
              'directChecks': direct_checks, 'cliSandboxChecks': cli_checks,
              'expectedProtectedOutput': expected,
              'credentialFreeProbePassed': passed,
              'credentialFilesRead': False, 'modelCalls': 0,
              'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN',
              'productionCleanup': 'NOT_RUN', 'productionReady': False}
    report['limitations'] = ['Fixed credential-free synthetic probe only; not production auth/network/cleanup.',
        'Current namespace unmount denial does not prove hostile descendant cannot create another user/mount namespace.']
    print(json.dumps(report, sort_keys=True), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    if sys.argv[1:] != ['--inside']:
        enter_root()
    raise SystemExit(main())
