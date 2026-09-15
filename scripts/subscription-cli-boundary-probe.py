"""Fixed actual CLI boundary experiment; no production/security-attestation claim."""
import errno
import hashlib
import importlib.util
import json
import os
import re
from pathlib import Path
import stat
import sys


VALIDATOR_REVISION = 2
PATHS = {'/sys/fs/cgroup', '/sys/fs/cgroup/cgroup.procs', '/oldroot', '/proc/1/root/sys/fs/cgroup', '/proc/1/root/oldroot', '/proc/1/root/proc/1/root/sys/fs/cgroup', '/work/cgroup-view/cgroup.procs'}
DESCRIPTORS = {'/proc/1/fd/0', '/proc/1/fd/1', '/proc/1/root/proc/1/fd/0', '/proc/1/root/proc/1/fd/1'}

def namespace_ids(value, names):
    return (isinstance(value, dict) and set(value) == set(names) and
            all(isinstance(value[name], str) and re.fullmatch(name + r':\[[1-9][0-9]*\]', value[name]) for name in names))


def descriptor_identity(value):
    return (isinstance(value, dict) and set(value) == {'dev', 'ino', 'type'} and
            all(type(value[key]) is int and value[key] >= 0 for key in value) and value['ino'] > 0 and value['type'] > 0)


def operation(step, name, path=None):
    keys = {'operation', 'succeeded', 'errno'} | ({'path'} if path else set())
    return (isinstance(step, dict) and set(step) == keys and step['operation'] == name and
            (path is None or step['path'] == path) and type(step['succeeded']) is bool and
            (step['errno'] is None if step['succeeded'] else type(step['errno']) is int and step['errno'] > 0))


def permission_denial(step):
    return step['succeeded'] is False and step['errno'] in (errno.EPERM, errno.EACCES)


def boundary_complete(boundary, expected):
    if not isinstance(boundary, dict) or set(boundary) != {'paths', 'descriptors'}:
        return False
    if set(boundary['paths']) != PATHS or set(boundary['descriptors']) != DESCRIPTORS:
        return False
    for observation in boundary['paths'].values():
        if (set(observation) != {'opened', 'identity', 'errno'} or observation['opened'] is not False or
                observation['identity'] is not None or type(observation['errno']) is not int or
                observation['errno'] not in (errno.ENOENT, errno.EACCES, errno.EPERM)):
            return False
    for observation in boundary['descriptors'].values():
        if (set(observation) != {'opened', 'identity', 'errno', 'bytesWritten'} or
                type(observation['opened']) is not bool or type(observation['bytesWritten']) is not int or observation['bytesWritten'] != 0):
            return False
        if observation['opened']:
            if (observation['errno'] is not None or not descriptor_identity(observation['identity']) or
                    observation['identity'] in (expected['control'], expected['output'])):
                return False
        elif (observation['identity'] is not None or type(observation['errno']) is not int or
              observation['errno'] not in (errno.ENOENT, errno.EACCES, errno.EPERM)):
            return False
    return True


def attempt_complete(attempt, before, expected):
    base_keys = {'method', 'beforeNamespaces', 'steps', 'afterNamespaceBoundary'}
    method = attempt['method']
    if method not in ('combined', 'sequential') or attempt['beforeNamespaces'] != before:
        return False
    steps = attempt['steps']
    if not isinstance(steps, list) or not steps or not operation(steps[0], 'unshare-' + method):
        return False
    if not steps[0]['succeeded']:
        # A denied first syscall has no post-namespace observations to skip.
        return (set(attempt) == base_keys and len(steps) == 1 and
                attempt['afterNamespaceBoundary'] is None and permission_denial(steps[0]))
    if len(steps) < 4:
        return False
    for step, path in zip(steps[1:4], ['/proc/self/setgroups', '/proc/self/uid_map', '/proc/self/gid_map']):
        if not operation(step, 'new-namespace-map', path) or step['succeeded'] is not True:
            return False
    offset = 4
    if method == 'sequential':
        if len(steps) <= offset or not operation(steps[offset], 'unshare-mount'):
            return False
        if not steps[offset]['succeeded']:
            # Exact early-return branch emitted by the fixed child. EINVAL is
            # never accepted as an unshare permission-denial observation.
            return (set(attempt) == base_keys and len(steps) == 5 and
                    attempt['afterNamespaceBoundary'] is None and permission_denial(steps[offset]))
        offset += 1
    success_keys = base_keys | {'afterNamespaces', 'afterNamespaceStatus', 'procMounts',
                                'privateDescendantMountNamespace', 'afterMountBoundary', 'procLayers'}
    if set(attempt) != success_keys or not namespace_ids(attempt['afterNamespaces'], ['user', 'mnt', 'pid']):
        return False
    after = attempt['afterNamespaces']
    if after['pid'] != before['pid'] or any(after[name] == before[name] for name in ['user', 'mnt']):
        return False
    if attempt['privateDescendantMountNamespace'] is not True:
        return False
    status = attempt['afterNamespaceStatus']
    if (not isinstance(status, dict) or set(status) != {'CapEff', 'CapBnd', 'NoNewPrivs'} or status['NoNewPrivs'] != '1' or
            not all(isinstance(status[name], str) and re.fullmatch(r'[0-9a-f]{16}', status[name]) for name in ['CapEff', 'CapBnd'])):
        return False
    mounts = attempt['procMounts']
    if not isinstance(mounts, list) or not 1 <= len(mounts) <= 8 or any(entry != {'filesystem': 'proc', 'mountpoint': '/proc'} for entry in mounts):
        return False
    if not all(boundary_complete(attempt[key], expected) for key in ['afterNamespaceBoundary', 'afterMountBoundary']):
        return False
    layers = attempt['procLayers']
    if not isinstance(layers, list) or not 1 <= len(layers) <= 3 or len(steps) != offset + 2 + len(layers):
        return False
    for step, name in zip(steps[offset:offset + 2], ['mount-read-only-proc', 'mount-read-only-cgroup2']):
        if not operation(step, name) or (not step['succeeded'] and not permission_denial(step)):
            return False
    for index, (step, layer) in enumerate(zip(steps[offset + 2:], layers)):
        if (not operation(step, 'detach-local-proc') or set(layer) != {'unmount', 'boundary'} or
                layer['unmount'] != step or not boundary_complete(layer['boundary'], expected)):
            return False
        if not step['succeeded']:
            # EINVAL is preserved as an unsuccessful detach, not permission
            # evidence. The complete post-attempt snapshot is still required.
            if index != len(layers) - 1 or step['errno'] not in (errno.EINVAL, errno.EPERM, errno.EACCES):
                return False
    return True


def validate(facts, expected):
    try:
        if (set(expected) != {'control', 'output'} or not all(descriptor_identity(value) and value['type'] == stat.S_IFIFO for value in expected.values()) or
                expected['control'] == expected['output'] or facts['expectedProtectedDescriptors'] != expected):
            return False
        if facts['CapEff'] != '0000000000000000' or facts['CapBnd'] != '0000000000000000' or facts['NoNewPrivs'] != '1':
            return False
        before = facts['namespaces']
        if not namespace_ids(before, ['user', 'mnt', 'pid']) or not namespace_ids(facts['outerNamespaces'], ['mnt', 'pid']):
            return False
        if any(before[name] == facts['outerNamespaces'][name] for name in ['mnt', 'pid']):
            return False
        if not descriptor_identity(facts['ownOutputIdentity']) or facts['ownOutputIdentity'] in expected.values():
            return False
        attempts = facts['attempts']
        if not isinstance(attempts, list) or [a['method'] for a in attempts] != ['combined', 'sequential']:
            return False
        if not boundary_complete(facts['baseline'], expected) or not all(attempt_complete(a, before, expected) for a in attempts):
            return False
        return (type(facts['cgroupBytesWritten']) is int and facts['cgroupBytesWritten'] == 0 and
                type(facts['descriptorBytesWritten']) is int and facts['descriptorBytesWritten'] == 0 and facts['credentialFilesRead'] is False)
    except (KeyError, TypeError, ValueError, AttributeError):
        return False


def load_runtime():
    spec = importlib.util.spec_from_file_location('runtime_probe', Path(__file__).with_name('runtime_probe.py'))
    probe = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(probe)
    return probe


def main(probe):
    sandbox = probe.sandbox()
    hashes = {}
    for name in ['codex', 'bwrap']:
        with open('/usr/bin/' + name, 'rb') as stream:
            hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
    probe.check_runtime_identity(hashes['codex'], hashes['bwrap'])
    expected = {}
    for name, fd in [('control', 0), ('output', 1)]:
        info = os.fstat(fd)
        expected[name] = {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode)}
    Path('/work/expected-boundary.json').write_text(json.dumps(expected))
    Path('/work/proc-view').mkdir()
    Path('/work/cgroup-view').mkdir()
    result = probe.run(['sandbox', '--permission-profile', 'private-sentinel', '--',
                        '/usr/bin/python3', '-I', '-S', '/usr/bin/child-probe.py'], private_profile=True)
    try:
        facts = json.loads(result['stdout'])
    except ValueError:
        facts = None
    passed = bool(facts and result['exitCode'] == 0 and result['error'] is None and result['namespaceEmptyAfter'] and validate(facts, expected))
    print(json.dumps({'version': 1, 'validatorRevision': VALIDATOR_REVISION, 'profile': 'fixed-cli-descendant-boundary-v1', 'sandbox': sandbox,
                      'binarySha256': hashes['codex'], 'bwrapSha256': hashes['bwrap'], 'result': result,
                      'facts': facts, 'expectedProtectedDescriptors': expected, 'boundedExperimentPassed': passed,
                      'productionReady': False, 'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN',
                      'productionCleanup': 'NOT_RUN', 'modelCalls': 0, 'credentialFilesRead': False,
                      'limitations': ['Two fixed descendant namespace operations only; not hostile-proof attestation.',
                                      'New standalone capsule using frozen runtime setup, not rerun of production supervisor.',
                                      'Cgroup/descriptor probes only open/fstat; no control writes or file-body reads.',
                                      'Read-only mounts and proc detach only attempted after proving a new private descendant mount namespace.']}, sort_keys=True), flush=True)
    return 0 if passed else 1


if __name__ == '__main__':
    runtime = load_runtime()
    if sys.argv[1:] != ['--inside']:
        runtime.enter_root()
    raise SystemExit(main(runtime))
