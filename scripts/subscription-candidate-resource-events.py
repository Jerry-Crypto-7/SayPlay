"""Owned fixed-leaf event reader; no unit creation, cgroup writes or workload."""
import hashlib
import copy
import math
import os
import re
import stat
import time
import uuid

FILES = ('memory.max', 'memory.swap.max', 'pids.max', 'memory.oom.group',
         'memory.events', 'memory.events.local', 'pids.events', 'cgroup.events',
         'memory.current', 'pids.current', 'cgroup.procs')
OPTIONAL = frozenset(('memory.events.local',))
LIMITS = {'memory.max': 2147483648, 'memory.swap.max': 0, 'pids.max': 64, 'memory.oom.group': 0}
COUNTERS = {'memory.events': ('max', 'oom', 'oom_kill'),
            'memory.events.local': ('max', 'oom', 'oom_kill'), 'pids.events': ('max',)}
MAX_FILE_BYTES = 4096
MAX_SAMPLES = 32
_TOKEN = object()
_UNKNOWN = False


def identity(info):
    return {'dev': info.st_dev, 'ino': info.st_ino, 'mode': info.st_mode}


def decimal(raw):
    if not re.fullmatch(rb'(0|[1-9][0-9]{0,19})\n?', raw):
        raise ValueError('FIXED_UNSIGNED_METADATA')
    value = int(raw)
    if value > 18446744073709551615:
        raise ValueError('METADATA_INTEGER_LIMIT')
    return value


def parse_file(name, raw):
    if name not in FILES or type(raw) is not bytes or not 0 < len(raw) <= MAX_FILE_BYTES:
        # An empty cgroup.procs is valid only after the unit empties; that is not
        # an admitted sampling phase for this live-workload reader.
        raise ValueError('FIXED_NONEMPTY_RESOURCE_METADATA')
    if name in LIMITS or name in ('memory.current', 'pids.current'):
        return decimal(raw)
    if name == 'cgroup.procs':
        lines = raw.splitlines()
        values = [decimal(line) for line in lines]
        if not 1 <= len(values) <= 64 or len(set(values)) != len(values) or any(v < 2 or v > 2147483647 for v in values):
            raise ValueError('OWN_LEAF_PROCESS_LIST')
        return values
    values = {}
    for line in raw.splitlines():
        fields = line.split(b' ')
        if len(fields) != 2 or re.fullmatch(rb'[a-z_]{1,32}', fields[0]) is None:
            raise ValueError('RESOURCE_EVENT_LINE')
        key = fields[0].decode('ascii')
        if key in values or len(values) >= 16:
            raise ValueError('RESOURCE_EVENT_KEYS')
        values[key] = decimal(fields[1])
    required = COUNTERS.get(name, ('populated', 'frozen'))
    if not set(required) <= set(values):
        raise ValueError('RESOURCE_EVENT_MISSING')
    if name == 'cgroup.events' and (set(values) != {'populated', 'frozen'} or values != {'populated': 1, 'frozen': 0}):
        raise ValueError('LIVE_UNFROZEN_LEAF_REQUIRED')
    return values


def walk_directory(path):
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open('/', flags)
    try:
        for part in path.lstrip('/').split('/'):
            next_fd = os.open(part, flags, dir_fd=fd)
            previous = fd
            fd = next_fd
            # A failed close is never retried against a possibly reused number.
            os.close(previous)
        result = fd
        fd = None
        return result
    finally:
        if fd is not None:
            os.close(fd)


class EventReader:
    def __init__(self, deadline, token=None):
        if token is not _TOKEN:
            raise ValueError('OWN_READER_FACTORY_REQUIRED')
        self.deadline = deadline
        self._unit = 'codex-cli-resource-' + uuid.uuid4().hex + '.service'
        uid = str(os.getuid())
        self._path = '/sys/fs/cgroup/user.slice/user-' + uid + '.slice/user@' + uid + '.service/app.slice/' + self._unit
        self._directory = None
        self._files = {}
        self._identity = {}
        self._optional_absent = set()
        self._previous = None
        self._samples = 0
        self._opened = self._closed = self._failed = False

    @property
    def unit(self):
        return self._unit

    def _remaining(self):
        if self._closed or self._failed or time.monotonic() >= self.deadline:
            raise ValueError('RESOURCE_OBSERVER_CLOSED_OR_DEADLINE')

    def _outside(self):
        fd = os.open('/proc/self/cgroup', os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW)
        try:
            raw = os.read(fd, MAX_FILE_BYTES + 1)
        finally:
            os.close(fd)
        if len(raw) > MAX_FILE_BYTES or not re.fullmatch(rb'0::/[^\n\x00]*\n', raw):
            raise ValueError('OBSERVER_UNIFIED_CGROUP_REQUIRED')
        own = raw.decode('ascii')[3:].strip()
        leaf = self._path.removeprefix('/sys/fs/cgroup')
        if own == leaf or own.startswith(leaf + '/'):
            raise ValueError('OBSERVER_INSIDE_STRESSED_LEAF')
        return own

    def open(self):
        if self._opened:
            raise ValueError('RESOURCE_OBSERVER_SINGLE_OPEN')
        self._remaining()
        try:
            self._outside()
            self._directory = walk_directory(self._path)
            self._identity['directory'] = identity(os.fstat(self._directory))
            for name in FILES:
                try:
                    fd = os.open(name, os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK,
                                 dir_fd=self._directory)
                except OSError as error:
                    if error.errno != 2 or name not in OPTIONAL:
                        raise
                    self._optional_absent.add(name)
                    continue
                self._files[name] = fd
                info = os.fstat(fd)
                if not stat.S_ISREG(info.st_mode) or info.st_dev != self._identity['directory']['dev']:
                    raise ValueError('OWN_LEAF_REGULAR_METADATA_REQUIRED')
                self._identity[name] = identity(info)
            self._opened = True
            return self.sample()
        except BaseException:
            self._fail()
            self.close()
            raise

    def _fail(self):
        global _UNKNOWN
        self._failed = True
        _UNKNOWN = True

    def sample(self):
        fresh = None
        try:
            self._remaining()
            if not self._opened or self._samples >= MAX_SAMPLES:
                raise ValueError('RESOURCE_OBSERVER_SAMPLE_STATE')
            outside = self._outside()
            fresh = walk_directory(self._path)
            if identity(os.fstat(fresh)) != self._identity['directory'] or identity(os.fstat(self._directory)) != self._identity['directory']:
                raise ValueError('OWN_LEAF_DIRECTORY_REPLACED')
            values, evidence = {}, {}
            for name in FILES:
                self._remaining()
                if name in self._optional_absent:
                    try:
                        os.stat(name, dir_fd=fresh, follow_symlinks=False)
                    except OSError as error:
                        if error.errno != 2:
                            raise
                        values[name] = None
                        evidence[name] = {'available': False, 'errno': 2}
                        continue
                    raise ValueError('OPTIONAL_EVENT_SUPPORT_CHANGED')
                fd = self._files[name]
                expected = self._identity[name]
                if identity(os.fstat(fd)) != expected or identity(os.stat(name, dir_fd=fresh, follow_symlinks=False)) != expected:
                    raise ValueError('OWN_LEAF_EVENT_REPLACED')
                os.lseek(fd, 0, os.SEEK_SET)
                raw = os.read(fd, MAX_FILE_BYTES + 1)
                if identity(os.fstat(fd)) != expected:
                    raise ValueError('OWN_LEAF_EVENT_CHANGED')
                values[name] = parse_file(name, raw)
                evidence[name] = {'available': True, 'identity': dict(expected), 'bytes': len(raw),
                                  'sha256': hashlib.sha256(raw).hexdigest(), 'rawHex': raw.hex()}
            if any(values[k] != v for k, v in LIMITS.items()):
                raise ValueError('FIXED_CANDIDATE_LIMITS_REQUIRED')
            if values['pids.current'] > 64:
                raise ValueError('TASK_LIMIT_OBSERVATION_MISMATCH')
            if self._previous is not None:
                for name in COUNTERS:
                    now, before = values[name], self._previous[name]
                    if now is None and before is None:
                        continue
                    if type(now) is not dict or type(before) is not dict or set(now) != set(before) or any(now[k] < before[k] for k in now):
                        raise ValueError('RESOURCE_COUNTER_RESET_OR_SCHEMA_DRIFT')
            self._remaining()
            self._previous = copy.deepcopy(values)
            self._samples += 1
            result = {'version': 1, 'unit': self._unit, 'leaf': self._path,
                    'directory': dict(self._identity['directory']), 'observerCgroup': outside,
                    'sequence': self._samples, 'monotonic': time.monotonic(), 'values': values,
                    'files': evidence, 'unitCleanupAttestedHere': False, 'exhaustionValidatedHere': False}
        except BaseException:
            self._fail()
            raise
        finally:
            if fresh is not None:
                try:
                    os.close(fresh)
                except BaseException:
                    self._fail()
                    raise
        # The final pathname-check FD close and report copying are inside the
        # budget too. A pre-close timestamp must not admit a late sample.
        sealed_at = time.monotonic()
        if self._closed or self._failed or sealed_at >= self.deadline:
            self._fail()
            raise ValueError('RESOURCE_OBSERVER_FINAL_DEADLINE')
        result['sealedMonotonic'] = sealed_at
        return result

    def close(self):
        if self._closed:
            return not self._failed
        self._closed = True
        failure = None
        owned = list(self._files.values()) + ([] if self._directory is None else [self._directory])
        self._files = {}
        self._directory = None
        for fd in owned:
            try:
                os.close(fd)
            except BaseException as error:
                self._fail()
                failure = failure or error
        if failure is not None:
            raise failure
        return not self._failed


def create_event_reader(absolute_deadline):
    if _UNKNOWN:
        raise ValueError('PREVIOUS_RESOURCE_OBSERVER_UNCERTAIN')
    if type(absolute_deadline) not in (float, int) or not math.isfinite(absolute_deadline) or not 0 < absolute_deadline - time.monotonic() <= 180:
        raise ValueError('FIXED_ABSOLUTE_RESOURCE_DEADLINE')
    return EventReader(absolute_deadline, _TOKEN)


if __name__ == '__main__':
    raise SystemExit('RESOURCE_OBSERVER_REQUIRES_OWNED_UNIT_INTEGRATION')
