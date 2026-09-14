"""Fixed open-only worker probe. Requires a separately bound readonly marker."""
import errno
import hashlib
import json
import os
import re
import stat
import sys

MARKER_PATH = '/work/trusted-control-boundary.json'
MAX_MARKER_BYTES = 4096
DESCRIPTOR_ROLES = ('outerSupervisorControl', 'outerSupervisorOutput', 'appServerControl', 'appServerOutput')
OBJECT_ROLES = ('appServerHome', 'appServerSentinel')
PROTECTED_PATHS = ('/work/environment-appserver-home', '/work/environment-appserver-home/sentinel',
                   '/proc/1/root/work/environment-appserver-home', '/proc/1/root/work/environment-appserver-home/sentinel')
PROC_FD_PATHS = ('/proc/1/fd/0', '/proc/1/fd/1', '/proc/1/fd/2')
STATUS_FIELDS = ('NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff', 'CapBnd')


def integer(value, minimum=0):
    return type(value) is int and minimum <= value <= 9007199254740991


def exact(value, fields):
    return type(value) is dict and set(value) == set(fields)


def strict_json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('DUPLICATE_MARKER_KEY')
            result[key] = value
        return result
    def constant(_):
        raise ValueError('NONFINITE_MARKER_VALUE')
    return json.loads(raw.decode('utf-8'), object_pairs_hook=pairs, parse_constant=constant)


def tuple_identity(value):
    return (value['dev'], value['ino'], value['type'])


def valid_tuple(value, kind):
    return (exact(value, ('dev', 'ino', 'type')) and integer(value['dev']) and integer(value['ino'], 1)
            and type(value['type']) is int and value['type'] == kind)


def valid_namespace(value, kind):
    return type(value) is str and re.fullmatch(kind + r':\[[0-9]{1,20}\]', value) is not None


def validate_marker(marker):
    if (not exact(marker, ('version', 'namespaces', 'protectedDescriptors', 'authoredProtectedObjects'))
            or type(marker['version']) is not int or marker['version'] != 1
            or not exact(marker['namespaces'], ('trustedPid', 'trustedMount'))
            or not valid_namespace(marker['namespaces']['trustedPid'], 'pid')
            or not valid_namespace(marker['namespaces']['trustedMount'], 'mnt')
            or not exact(marker['protectedDescriptors'], DESCRIPTOR_ROLES)
            or not exact(marker['authoredProtectedObjects'], OBJECT_ROLES)):
        return False
    pipes = marker['protectedDescriptors']
    objects = marker['authoredProtectedObjects']
    return (all(valid_tuple(pipes[role], stat.S_IFIFO) for role in DESCRIPTOR_ROLES)
            and len({tuple_identity(value) for value in pipes.values()}) == 4
            and valid_tuple(objects['appServerHome'], stat.S_IFDIR)
            and valid_tuple(objects['appServerSentinel'], stat.S_IFREG))


def stat_identity(info):
    return {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode)}


def read_marker():
    # No caller path, no following /work or the final filename through symlinks.
    directory = os.open('/work', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        fd = os.open('trusted-control-boundary.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC,
                     dir_fd=directory)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_MARKER_BYTES:
            raise ValueError('MARKER_REGULAR_BOUNDED_REQUIRED')
        if not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('MARKER_READONLY_MOUNT_REQUIRED')
        raw = os.read(fd, MAX_MARKER_BYTES + 1)
        after = os.fstat(fd)
        if (len(raw) != before.st_size or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns)):
            raise ValueError('MARKER_CHANGED_OR_TRUNCATED')
        marker = strict_json(raw)
        if not validate_marker(marker):
            raise ValueError('FIXED_MARKER_SCHEMA_REQUIRED')
        return {'path': MARKER_PATH, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(),
                'rawHex': raw.hex(), 'file': stat_identity(before), 'readonlyMount': True, 'value': marker}
    finally:
        if fd is not None:
            os.close(fd)
        os.close(directory)


def descriptor(fd):
    return {'fd': fd, **stat_identity(os.fstat(fd))}


def open_only(path):
    # O_RDONLY open proves whether that open is possible. No content is read,
    # including when the access unexpectedly succeeds. Never write a byte.
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as failure:
        outcome = ('denied' if failure.errno in (errno.EACCES, errno.EPERM)
                   else 'absent' if failure.errno == errno.ENOENT else 'other-error')
        return {'opened': False, 'errno': failure.errno, 'outcome': outcome, 'bytesRead': 0, 'bytesWritten': 0}
    try:
        return {'opened': True, 'errno': None, 'outcome': 'opened', 'bytesRead': 0, 'bytesWritten': 0,
                'descriptor': descriptor(fd)}
    finally:
        os.close(fd)


def admission_errors(identity, status, marker):
    errors = []
    if (not exact(identity, ('pid', 'ppid', 'pidNamespace', 'mountNamespace', 'procInitPidNamespace', 'nspid'))
            or not integer(identity['pid'], 1) or not integer(identity['ppid'])
            or not valid_namespace(identity['pidNamespace'], 'pid') or not valid_namespace(identity['mountNamespace'], 'mnt')
            or identity['pidNamespace'] != identity['procInitPidNamespace']
            or identity['pidNamespace'] == marker['namespaces']['trustedPid']
            or identity['mountNamespace'] == marker['namespaces']['trustedMount']
            or type(identity['nspid']) is not str or re.fullmatch(r'[1-9][0-9]*(?:\s+[1-9][0-9]*)*', identity['nspid']) is None
            or identity['nspid'].split()[-1] != str(identity['pid'])):
        errors.append('FRESH_PRIVATE_PROC_NAMESPACE_REQUIRED')
    if (not exact(status, STATUS_FIELDS) or status['NoNewPrivs'] != '1' or status['Seccomp'] != '2'
            or status['CapEff'] != '0000000000000000' or status['CapBnd'] != '0000000000000000'
            or type(status['Seccomp_filters']) is not str or re.fullmatch(r'[1-9][0-9]*', status['Seccomp_filters']) is None):
        errors.append('POST_LOCKDOWN_STATUS_REQUIRED')
    return errors


def collect():
    if sys.platform != 'linux' or sys.argv[1:] or os.uname().machine != 'x86_64':
        raise ValueError('FIXED_LOCKDOWN_WORKER_REQUIRED')
    marker = read_marker()
    with open('/proc/self/status', encoding='ascii') as handle:
        raw_status = handle.read(16385)
    if len(raw_status) > 16384:
        raise ValueError('SELF_STATUS_LIMIT')
    fields = dict(line.split(':', 1) for line in raw_status.splitlines() if ':' in line)
    identity = {'pid': os.getpid(), 'ppid': os.getppid(), 'pidNamespace': os.readlink('/proc/self/ns/pid'),
                'mountNamespace': os.readlink('/proc/self/ns/mnt'), 'procInitPidNamespace': os.readlink('/proc/1/ns/pid'),
                'nspid': fields['NSpid'].strip()}
    status = {key: fields[key].strip() for key in STATUS_FIELDS}
    errors = admission_errors(identity, status, marker['value'])
    if errors:
        raise ValueError(','.join(errors))
    descriptors = []
    for name in os.listdir('/proc/self/fd'):
        if not name.isdecimal():
            raise ValueError('INVALID_SELF_FD')
        try:
            descriptors.append(descriptor(int(name)))
        except OSError as failure:
            if failure.errno != errno.EBADF:
                raise
    return {'version': 1, 'kind': 'FIXED_TRUSTED_CONTROL_BOUNDARY_OBSERVATIONS', 'marker': marker,
            'identity': identity, 'status': status, 'cwd': os.getcwd(), 'environmentKeys': sorted(os.environ),
            'descriptors': sorted(descriptors, key=lambda value: value['fd']),
            'paths': {path: open_only(path) for path in PROTECTED_PATHS + PROC_FD_PATHS},
            'protectedBodyBytesRead': 0, 'bytesWrittenToProtectedObjects': 0, 'credentialFilesRead': False,
            'actualModelCalls': 0, 'networkOperations': 0, 'cleanupAttestedHere': False, 'productionReady': False}


def validate_report(report, expected_marker):
    """Strict replay against externally source/identity-bound marker metadata."""
    try:
        def same(left, right):
            return json.dumps(left, sort_keys=True, allow_nan=False) == json.dumps(right, sort_keys=True, allow_nan=False)
        if not validate_marker(expected_marker) or not exact(report, ('version', 'kind', 'marker', 'identity', 'status', 'cwd',
                'environmentKeys', 'descriptors', 'paths', 'protectedBodyBytesRead', 'bytesWrittenToProtectedObjects',
                'credentialFilesRead', 'actualModelCalls', 'networkOperations', 'cleanupAttestedHere', 'productionReady')):
            return False
        if (type(report['version']) is not int or report['version'] != 1 or report['kind'] != 'FIXED_TRUSTED_CONTROL_BOUNDARY_OBSERVATIONS'
                or report['cwd'] != '/work/exec-worker' or report['environmentKeys'] != ['HOME', 'LANG', 'PATH', 'TMPDIR']
                or any(type(report[key]) is not int or report[key] != 0 for key in
                       ('protectedBodyBytesRead', 'bytesWrittenToProtectedObjects', 'actualModelCalls', 'networkOperations'))
                or any(report[key] is not False for key in ('credentialFilesRead', 'cleanupAttestedHere', 'productionReady'))):
            return False
        receipt = report['marker']
        if (not exact(receipt, ('path', 'bytes', 'sha256', 'rawHex', 'file', 'readonlyMount', 'value'))
                or receipt['path'] != MARKER_PATH or receipt['readonlyMount'] is not True
                or not valid_tuple(receipt['file'], stat.S_IFREG) or not same(receipt['value'], expected_marker)
                or type(receipt['rawHex']) is not str or not 0 < len(receipt['rawHex']) <= MAX_MARKER_BYTES * 2):
            return False
        raw = bytes.fromhex(receipt['rawHex'])
        if (raw.hex() != receipt['rawHex'] or not integer(receipt['bytes'], 1) or receipt['bytes'] != len(raw)
                or hashlib.sha256(raw).hexdigest() != receipt['sha256'] or not same(strict_json(raw), expected_marker)
                or admission_errors(report['identity'], report['status'], expected_marker)):
            return False
        protected = {tuple_identity(value) for value in expected_marker['protectedDescriptors'].values()}
        def valid_descriptor(value):
            return (exact(value, ('fd', 'dev', 'ino', 'type')) and integer(value['fd']) and integer(value['dev'])
                    and integer(value['ino'], 1) and type(value['type']) is int
                    and value['type'] in (stat.S_IFIFO, stat.S_IFCHR, stat.S_IFSOCK)
                    and tuple_identity(value) not in protected)
        descriptors = report['descriptors']
        if (type(descriptors) is not list or len(descriptors) != 3 or not all(valid_descriptor(value) for value in descriptors)
                or [value['fd'] for value in descriptors] != [0, 1, 2]
                or not exact(report['paths'], PROTECTED_PATHS + PROC_FD_PATHS)):
            return False
        for path, value in report['paths'].items():
            if (type(value) is not dict or any(type(value.get(key)) is not int or value[key] != 0 for key in ('bytesRead', 'bytesWritten'))):
                return False
            if value.get('opened') is True:
                if (path not in PROC_FD_PATHS or not exact(value, ('opened', 'errno', 'outcome', 'bytesRead', 'bytesWritten', 'descriptor'))
                        or value['errno'] is not None or value['outcome'] != 'opened' or not valid_descriptor(value['descriptor'])):
                    return False
            elif (value.get('opened') is not False or not exact(value, ('opened', 'errno', 'outcome', 'bytesRead', 'bytesWritten'))
                    or type(value['errno']) is not int or value['errno'] not in (1, 2, 13)
                    or value['outcome'] != ('absent' if value['errno'] == 2 else 'denied')):
                return False
        return True
    except (ValueError, TypeError, KeyError, IndexError, AttributeError, RecursionError):
        return False


if __name__ == '__main__':
    # Emitting observations is not declaring externally validated PASS.
    print(json.dumps(collect(), separators=(',', ':'), allow_nan=False), flush=True)
