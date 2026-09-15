"""Read-only, credential-free cgroup v2 discovery. Never enforcement evidence.

CLI accepts no arguments and reads only fixed proc metadata and the fixed
/sys/fs/cgroup tree. No subprocesses, mutations, credentials or job execution.
"""
import json
import ctypes
import os
import re
import stat
import sys

MAX_BYTES = 65536
MAX_LINES = 512
ROOT = '/sys/fs/cgroup'
DELEGATE = 'codex-subscription'
FILES = ('cgroup.controllers', 'cgroup.subtree_control', 'cgroup.type',
         'cgroup.procs', 'cgroup.events', 'memory.max', 'memory.swap.max',
         'pids.max', 'memory.current', 'pids.current')


def bounded(value):
    if not isinstance(value, str) or len(value.encode('utf-8')) > MAX_BYTES:
        raise ValueError('METADATA_SIZE')
    if '\x00' in value or len(value.splitlines()) > MAX_LINES:
        raise ValueError('METADATA_FORMAT')
    return value


def tokens(value):
    items = bounded(value).split()
    if any(not re.fullmatch('[a-z][a-z0-9_]{0,63}', item) for item in items) or len(set(items)) != len(items):
        raise ValueError('CONTROLLER_FORMAT')
    return sorted(items)


def number(value, allow_max=False):
    value = bounded(value).strip()
    if value == 'max' and allow_max:
        return None
    if not re.fullmatch('0|[1-9][0-9]{0,18}', value) or int(value) > 2**63 - 1:
        raise ValueError('LIMIT_FORMAT')
    return int(value)


def membership(value):
    lines = bounded(value).splitlines()
    if len(lines) != 1 or not lines[0].startswith('0::/'):
        raise ValueError('UNIFIED_MEMBERSHIP_REQUIRED')
    path = lines[0][3:]
    if len(path) > 4096 or any(part in ('.', '..') for part in path.split('/')) or not re.fullmatch(r'/[A-Za-z0-9_./:@-]*', path):
        raise ValueError('MEMBERSHIP_PATH')
    return path


def mount(value):
    matches = []
    for line in bounded(value).splitlines():
        parts = line.split(' ')
        if len(parts) < 10 or '-' not in parts:
            raise ValueError('MOUNTINFO_FORMAT')
        sep = parts.index('-')
        if sep < 6 or len(parts) != sep + 4:
            raise ValueError('MOUNTINFO_FORMAT')
        if parts[4] == ROOT:
            matches.append(parts)
    if len(matches) != 1:
        raise ValueError('UNIQUE_CGROUP_MOUNT_REQUIRED')
    parts = matches[0]
    if parts[parts.index('-') + 1] != 'cgroup2' or parts[3] != '/':
        raise ValueError('FULL_CGROUP2_MOUNT_REQUIRED')
    return {'readOnly': 'ro' in parts[5].split(',') or 'ro' in parts[-1].split(',')}


def parse_files(raw):
    if type(raw) is not dict or set(raw) != set(FILES):
        raise ValueError('CGROUP_FILES_REQUIRED')
    kind = bounded(raw['cgroup.type']).strip()
    if kind not in ('domain', 'domain threaded', 'threaded', 'domain invalid'):
        raise ValueError('CGROUP_TYPE')
    pids = bounded(raw['cgroup.procs']).splitlines()
    for pid in pids:
        if number(pid) < 1:
            raise ValueError('PID_FORMAT')
    events = {}
    for line in bounded(raw['cgroup.events']).splitlines():
        fields = line.split()
        if len(fields) != 2 or fields[0] in events or fields[0] not in ('populated', 'frozen') or fields[1] not in ('0', '1'):
            raise ValueError('EVENT_FORMAT')
        events[fields[0]] = int(fields[1])
    if 'populated' not in events:
        raise ValueError('POPULATED_REQUIRED')
    return {'controllers': tokens(raw['cgroup.controllers']),
            'subtreeControl': tokens(raw['cgroup.subtree_control']), 'type': kind,
            'directProcessCount': len(set(pids)), 'events': events,
            **{name: number(raw[name], name.endswith('.max')) for name in
               ('memory.max', 'memory.swap.max', 'pids.max', 'memory.current', 'pids.current')}}


def assess(raw, mountinfo, own_membership, access):
    """Pure bounded validator for captured metadata, not a trusted attestation."""
    result = {'kind': 'subscription-resource-discovery', 'version': 1,
              'discoveryStatus': 'FAIL', 'productionReady': False,
              'enforcementStatus': 'NOT_RUN', 'delegationStatus': 'NOT_VERIFIED',
              'blockers': [], 'facts': None}
    try:
        if type(access) is not dict or set(access) != {'directory', 'procs', 'subtreeControl'} or any(type(v) is not bool for v in access.values()):
            raise ValueError('ACCESS_METADATA_REQUIRED')
        facts = parse_files(raw)
        facts.update(mount=mount(mountinfo), membership=membership(own_membership), accessHints=access)
        result['facts'] = facts
        if facts['mount']['readOnly']:
            result['blockers'].append('CGROUP_MOUNT_READ_ONLY')
        for key in ('controllers', 'subtreeControl'):
            if not {'memory', 'pids'}.issubset(facts[key]):
                result['blockers'].append(key.upper() + '_MISSING_MEMORY_OR_PIDS')
        if facts['type'] != 'domain' or facts['directProcessCount'] != 0:
            result['blockers'].append('EMPTY_DOMAIN_PARENT_REQUIRED')
        if not all(access.values()):
            result['blockers'].append('DELEGATION_ACCESS_HINTS_MISSING')
        if not result['blockers']:
            result['discoveryStatus'] = 'PASS'
    except (ValueError, TypeError, UnicodeError) as error:
        result['blockers'].append(str(error) if isinstance(error, ValueError) else 'INVALID_METADATA')
    return result


def read_fd(fd):
    chunks = []
    size = 0
    while size <= MAX_BYTES:
        chunk = os.read(fd, min(8192, MAX_BYTES + 1 - size))
        if not chunk:
            break
        chunks.append(chunk)
        size += len(chunk)
    value = b''.join(chunks)
    if len(value) > MAX_BYTES:
        raise ValueError('METADATA_SIZE')
    return bounded(value.decode('utf-8', errors='strict'))


def require_cgroup2(fd):
    # fstatfs writes struct statfs; use an oversized aligned buffer and inspect
    # only f_type (the first native long on supported Linux WSL architectures).
    buffer = (ctypes.c_long * 64)()
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.fstatfs(fd, ctypes.byref(buffer)) != 0:
        raise OSError(ctypes.get_errno(), 'FSTATFS_FAILED')
    if buffer[0] != 0x63677270:
        raise ValueError('CGROUP2_FILESYSTEM_REQUIRED')


def fixed_proc(name):
    if name not in ('mountinfo', 'cgroup'):
        raise ValueError('FIXED_PROC_ONLY')
    # /proc/self intentionally resolves to this process; the filename is fixed.
    fd = os.open('/proc/self/' + name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        return read_fd(fd)
    finally:
        os.close(fd)


def inventory():
    if sys.platform != 'linux':
        raise ValueError('LINUX_REQUIRED')
    before = fixed_proc('mountinfo')
    own = fixed_proc('cgroup')
    mount(before)
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW
    fd = os.open('/', flags)
    try:
        for component in ('sys', 'fs', 'cgroup', DELEGATE):
            try:
                next_fd = os.open(component, flags, dir_fd=fd)
            except FileNotFoundError:
                if component == DELEGATE:
                    raise ValueError('FIXED_DELEGATED_SUBTREE_NOT_FOUND') from None
                raise
            os.close(fd)
            fd = next_fd
            if component == 'cgroup':
                require_cgroup2(fd)
        require_cgroup2(fd)
        raw = {}
        for name in FILES:
            child = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
            try:
                if not stat.S_ISREG(os.fstat(child).st_mode):
                    raise ValueError('REGULAR_METADATA_REQUIRED')
                require_cgroup2(child)
                raw[name] = read_fd(child)
            finally:
                os.close(child)
        access = {'directory': os.access('.', os.W_OK | os.X_OK, dir_fd=fd, effective_ids=True),
                  'procs': os.access('cgroup.procs', os.W_OK, dir_fd=fd, effective_ids=True, follow_symlinks=False),
                  'subtreeControl': os.access('cgroup.subtree_control', os.W_OK, dir_fd=fd, effective_ids=True, follow_symlinks=False)}
        if fixed_proc('mountinfo') != before or fixed_proc('cgroup') != own:
            raise ValueError('RUNTIME_METADATA_CHANGED')
        return assess(raw, before, own, access)
    finally:
        os.close(fd)


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('NO_ARGUMENTS_ALLOWED')
        result = inventory()
    except (OSError, ValueError, UnicodeError) as error:
        result = {'kind': 'subscription-resource-discovery', 'version': 1,
                  'discoveryStatus': 'FAIL', 'productionReady': False,
                  'enforcementStatus': 'NOT_RUN', 'delegationStatus': 'NOT_VERIFIED',
                  'blockers': [str(error) if isinstance(error, ValueError) else type(error).__name__],
                  'facts': None}
    print(json.dumps(result, sort_keys=True))
    return 0 if result['discoveryStatus'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
