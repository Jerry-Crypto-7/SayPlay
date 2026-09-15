"""Fixed read-only host/ancestor headroom admission for the 2 GiB diagnostic."""
import hashlib
import math
import os
import re
import stat
import time

MEMORY_RESERVE = 4 * 1024**3  # Candidate 2 GiB plus 2 GiB outside-leaf reserve.
TASK_RESERVE = 128           # Candidate 64 plus 64 outside-leaf tasks.
MAX_BYTES = 65536
_UNKNOWN = False


def _check(deadline):
    if time.monotonic() >= deadline: raise ValueError('CAPACITY_DEADLINE')


def _identity(info):
    return (info.st_dev, info.st_ino, stat.S_IFMT(info.st_mode))


def _read(path, deadline):
    """All paths are generated internally; walk directories without symlinks."""
    global _UNKNOWN
    _check(deadline)
    owned = []
    result = None
    try:
        fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW)
        owned.append(fd)
        parts = path.strip('/').split('/')
        for name in parts[:-1]:
            fd = os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=fd)
            owned.append(fd)
            _check(deadline)
        parent = fd
        fd = os.open(parts[-1], os.O_RDONLY | os.O_NONBLOCK | os.O_CLOEXEC | os.O_NOFOLLOW, dir_fd=parent)
        owned.append(fd)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode): raise ValueError('CAPACITY_REGULAR_FILE_REQUIRED')
        raw = bytearray()
        while True:
            _check(deadline)
            block = os.read(fd, min(4096, MAX_BYTES + 1 - len(raw)))
            if not block: break
            raw.extend(block)
            if len(raw) > MAX_BYTES: raise ValueError('CAPACITY_METADATA_BOUND')
        after = os.fstat(fd)
        named = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
        if _identity(before) != _identity(after) or _identity(before) != _identity(named):
            raise ValueError('CAPACITY_FILE_IDENTITY_CHANGED')
        raw = bytes(raw)
        result = {'path': path, 'identity': list(_identity(before)), 'rawHex': raw.hex(),
                  'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw)}
    finally:
        failed = False
        for fd in reversed(owned):
            try: os.close(fd)
            except BaseException: failed = True; _UNKNOWN = True
        if failed: raise ValueError('CAPACITY_CLOSE_UNKNOWN')
    _check(deadline)
    return result


def _number(record, unlimited=False):
    raw = bytes.fromhex(record['rawHex'])
    if unlimited and raw == b'max\n': return None
    if re.fullmatch(rb'(0|[1-9][0-9]{0,19})\n', raw) is None:
        raise ValueError('CAPACITY_NUMBER_INVALID')
    return int(raw)


def _available(record):
    raw = bytes.fromhex(record['rawHex'])
    lines = raw.splitlines()
    selected = [line for line in lines if line.startswith(b'MemAvailable:')]
    if len(selected) != 1: raise ValueError('MEMAVAILABLE_MISSING_OR_DUPLICATE')
    match = re.fullmatch(rb'MemAvailable:\s+([0-9]{1,20}) kB', selected[0])
    if match is None: raise ValueError('MEMAVAILABLE_FORMAT')
    return int(match[1]) * 1024


def check_capacity(absolute_deadline):
    """No caller path/UID/limit; one bounded observation, never a reservation."""
    if _UNKNOWN: raise ValueError('PRIOR_CAPACITY_CLOSE_UNKNOWN')
    if (type(absolute_deadline) not in (int, float) or not math.isfinite(absolute_deadline)
            or not 0 < absolute_deadline - time.monotonic() <= 5):
        raise ValueError('FIXED_CAPACITY_DEADLINE')
    uid = os.getuid()
    if type(uid) is not int or not 1 <= uid <= 4294967294: raise ValueError('NONROOT_UID_REQUIRED')
    roots = ['/sys/fs/cgroup/user.slice', '/sys/fs/cgroup/user.slice/user-' + str(uid) + '.slice']
    roots.append(roots[-1] + '/user@' + str(uid) + '.service')
    roots.append(roots[-1] + '/app.slice')
    host = _read('/proc/meminfo', absolute_deadline)
    available = _available(host)
    records = []
    for root in roots:
        files = {name: _read(root + '/' + name, absolute_deadline)
                 for name in ('memory.max', 'memory.current', 'pids.max', 'pids.current')}
        maximum, current = _number(files['memory.max'], True), _number(files['memory.current'])
        tasks_max, tasks_current = _number(files['pids.max'], True), _number(files['pids.current'])
        records.append({'path': root, 'files': files,
            'memoryHeadroom': None if maximum is None else maximum - current,
            'taskHeadroom': None if tasks_max is None else tasks_max - tasks_current})
    # Re-read host availability after all ancestor observations. Concurrent load
    # can still change after return; this does not reserve memory or prove cause.
    host_after = _read('/proc/meminfo', absolute_deadline)
    available_after = _available(host_after)
    enough = (min(available, available_after) >= MEMORY_RESERVE
              and all(v['memoryHeadroom'] is None or v['memoryHeadroom'] >= MEMORY_RESERVE for v in records)
              and all(v['taskHeadroom'] is None or v['taskHeadroom'] >= TASK_RESERVE for v in records))
    result = {'version': 1, 'admitted': enough, 'memoryReserveBytes': MEMORY_RESERVE,
        'taskReserve': TASK_RESERVE, 'hostBefore': host, 'hostAfter': host_after,
        'availableBeforeBytes': available, 'availableAfterBytes': available_after,
        'ancestors': records, 'reservationMade': False, 'resourceEnforcementValidated': False,
        'cgroupWrites': 0, 'metadataReads': 18, 'sealedMonotonic': time.monotonic()}
    _check(absolute_deadline)
    return result
