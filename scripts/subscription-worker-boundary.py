"""Strict offline validation for the fixed post-CLI worker boundary experiment."""
import errno
import hashlib
import importlib.util
from pathlib import Path
import re
import struct
import stat

HELPERS = ('subscription-worker-lockdown.py', 'subscription-worker-boundary-child.py')
PATHS = ('/private/sentinel', '/private/config.toml', '/work/private-alias',
         '/sys/fs/cgroup', '/sys/fs/cgroup/cgroup.procs', '/oldroot',
         '/proc/1/root/private/sentinel', '/proc/1/root/sys/fs/cgroup')
FD_PATHS = ('/proc/1/fd/0', '/proc/1/fd/1', '/proc/1/root/proc/1/fd/0', '/proc/1/root/proc/1/fd/1')
CALLS = {'unshare-user', 'unshare-mount', 'unshare-combined', 'setns', 'clone3', 'mount', 'umount2',
         'pivot_root', 'open_tree', 'move_mount', 'fsopen', 'fsconfig', 'fsmount', 'fspick',
         'mount_setattr', 'ptrace', 'process_vm_readv', 'process_vm_writev', 'pidfd_getfd'}
CLONE_FLAGS = {'newtime': 0x80, 'newns': 0x20000, 'newcgroup': 0x2000000,
               'newuts': 0x4000000, 'newipc': 0x8000000, 'newuser': 0x10000000,
               'newpid': 0x20000000, 'newnet': 0x40000000}


def helper_hashes():
    return {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in HELPERS}


def validate_worker_image(expected):
    if type(expected) is not dict or expected.get('helperSha256') != helper_hashes():
        raise ValueError('WORKER_IMAGE_IDENTITY_MISMATCH')


def descriptor(value):
    return (type(value) is dict and set(value) == {'dev', 'ino', 'type'} and
            all(type(v) is int for v in value.values()) and value['dev'] >= 0 and value['ino'] > 0 and value['type'] > 0)


def namespaces(value):
    return (type(value) is dict and set(value) == {'user', 'mnt', 'pid'} and
            all(isinstance(v, str) and re.fullmatch(k + r':\[[1-9][0-9]*\]', v) for k, v in value.items()))


def status(value):
    return (type(value) is dict and set(value) == {'NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff', 'CapBnd'} and
            value['NoNewPrivs'] == '1' and value['Seccomp'] == '2' and value['CapEff'] == value['CapBnd'] == '0000000000000000' and
            isinstance(value['Seccomp_filters'], str) and re.fullmatch(r'[1-9][0-9]{0,3}', value['Seccomp_filters']))


def validate_worker_report(report, expected):
    try:
        validate_worker_image(expected)
        if set(expected) != {'helperSha256', 'namespace', 'mountNamespace', 'output', 'control'}:
            return False
        if not descriptor(expected['output']) or not descriptor(expected['control']):
            return False
        if expected['output'] == expected['control'] or any(expected[key]['type'] != stat.S_IFIFO for key in ('output', 'control')):
            return False
        if not re.fullmatch(r'pid:\[[1-9][0-9]*\]', expected['namespace']) or not re.fullmatch(r'mnt:\[[1-9][0-9]*\]', expected['mountNamespace']):
            return False
        if type(report) is not dict or set(report) != {'version', 'profile', 'before', 'receipt', 'current', 'thread', 'exec', 'fork', 'existingThread', 'cloneNamespaces', 'abi', 'modelCalls', 'credentialFilesRead', 'productionReady'}:
            return False
        if type(report['version']) is not int or report['version'] != 2 or report['profile'] != 'post-cli-worker-lockdown-v2':
            return False
        if type(report['modelCalls']) is not int or report['modelCalls'] != 0 or report['credentialFilesRead'] is not False or report['productionReady'] is not False:
            return False
        spec = importlib.util.spec_from_file_location('worker_filter', Path(__file__).with_name('subscription-worker-lockdown.py'))
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        instructions = module.build_filter()
        receipt = report['receipt']
        if type(receipt) is not dict or receipt != {'arch': 'linux-x86_64', 'noNewPrivs': 1, 'seccompMode': 2, 'threadSync': True,
                'instructionCount': len(instructions), 'filterSha256': hashlib.sha256(b''.join(struct.pack('<HBBI', *i) for i in instructions)).hexdigest()}:
            return False
        if any(type(receipt[key]) is not int for key in ('noNewPrivs', 'seccompMode', 'instructionCount')) or receipt['threadSync'] is not True:
            return False
        if not status(report['before']) or type(report['thread']) is not list or len(report['thread']) != 1:
            return False
        existing = report['existingThread']
        if type(existing) is not dict or set(existing) != {'before', 'after'} or existing['before'] != report['before']:
            return False
        clones = report['cloneNamespaces']
        if type(clones) is not dict or set(clones) != set(CLONE_FLAGS):
            return False
        for name, flag in CLONE_FLAGS.items():
            value = clones[name]
            if type(value) is not dict or value != {'flags': flag | 17, 'return': -1, 'errno': 1, 'child': None}:
                return False
            if any(type(value[key]) is not int for key in ('flags', 'return', 'errno')):
                return False
        if type(report['abi']) is not dict or set(report['abi']) != {'x32-getpid', 'int80-getpid'}:
            return False
        for outcome in report['abi'].values():
            if type(outcome) is not dict or outcome != {'reaped': True, 'timedOut': False, 'signal': 31, 'exitCode': None, 'instructionReached': True}:
                return False
            if outcome['reaped'] is not True or outcome['timedOut'] is not False or type(outcome['signal']) is not int or outcome['instructionReached'] is not True:
                return False
        current_ns = report['current']['namespaces']
        if not namespaces(current_ns) or current_ns['pid'] == expected['namespace'] or current_ns['mnt'] == expected['mountNamespace']:
            return False
        for sample in (report['current'], report['thread'][0], report['exec'], report['fork'], existing['after']):
            if type(sample) is not dict or set(sample) != {'status', 'namespaces', 'calls', 'boundary'} or sample['namespaces'] != current_ns:
                return False
            if not status(sample['status']) or int(sample['status']['Seccomp_filters']) != int(report['before']['Seccomp_filters']) + 1:
                return False
            if type(sample['calls']) is not dict or set(sample['calls']) != CALLS:
                return False
            for name, result in sample['calls'].items():
                if type(result) is not dict or set(result) != {'return', 'errno'} or type(result['return']) is not int or type(result['errno']) is not int:
                    return False
                # The report is Linux even when offline validation runs on Windows.
                if result != {'return': -1, 'errno': 38 if name == 'clone3' else 1}:
                    return False
            boundary = sample['boundary']
            if type(boundary) is not dict or set(boundary) != {'paths', 'inheritedDescriptors'} or set(boundary['paths']) != set(PATHS + FD_PATHS):
                return False
            inherited = boundary['inheritedDescriptors']
            if type(inherited) is not list or not inherited or len(inherited) > 64 or any(not descriptor(v) or v in (expected['output'], expected['control']) for v in inherited):
                return False
            for path, result in boundary['paths'].items():
                if type(result) is not dict or set(result) != {'opened', 'identity', 'errno', 'bytesRead', 'bytesWritten'} or type(result['opened']) is not bool:
                    return False
                if any(type(result[key]) is not int or result[key] != 0 for key in ('bytesRead', 'bytesWritten')):
                    return False
                if result['opened']:
                    if path not in FD_PATHS or result['errno'] is not None or not descriptor(result['identity']) or result['identity'] in (expected['output'], expected['control']):
                        return False
                elif result['identity'] is not None or type(result['errno']) is not int or result['errno'] not in ((errno.EACCES, errno.EPERM) if path in PATHS[:3] else (errno.ENOENT, errno.EACCES, errno.EPERM)):
                    return False
        return True
    except (KeyError, ValueError, TypeError, AttributeError, OSError):
        return False
