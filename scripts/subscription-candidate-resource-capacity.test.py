import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
import stat
import pytest

spec = importlib.util.spec_from_file_location('capacity_test', Path(__file__).with_name('subscription-candidate-resource-capacity.py'))
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)


def record(raw): return {'rawHex': raw.hex()}


@pytest.fixture(autouse=True)
def clean():
    c._UNKNOWN = False
    yield
    c._UNKNOWN = False


def observations(path, deadline):
    if path == '/proc/meminfo': return record(b'MemTotal: 99999999 kB\nMemAvailable: 8388608 kB\n')
    name = path.rsplit('/', 1)[-1]
    return record({'memory.max': b'8589934592\n', 'memory.current': b'1073741824\n',
                   'pids.max': b'512\n', 'pids.current': b'100\n'}[name])


def test_exact_fixed_paths_and_no_resource_or_reservation_credit():
    with patch.object(c.os, 'getuid', return_value=1000, create=True), patch.object(c.time, 'monotonic', return_value=10), patch.object(c, '_read', side_effect=observations) as read:
        value = c.check_capacity(15)
    assert value['admitted'] is True and value['metadataReads'] == 18
    assert not value['reservationMade'] and not value['resourceEnforcementValidated']
    assert len(read.call_args_list) == 18
    assert {call.args[0].rsplit('/', 1)[0] for call in read.call_args_list} == {
        '/proc', '/sys/fs/cgroup/user.slice', '/sys/fs/cgroup/user.slice/user-1000.slice',
        '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service',
        '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice'}


@pytest.mark.parametrize('failure', ['host-before', 'host-after', 'ancestor-memory', 'ancestor-tasks', 'over-limit'])
def test_insufficient_headroom_refuses_without_changing_limits(failure):
    calls = 0
    def read(path, deadline):
        nonlocal calls
        if path == '/proc/meminfo':
            calls += 1
            if failure == 'host-before' and calls == 1 or failure == 'host-after' and calls == 2:
                return record(b'MemAvailable: 1048576 kB\n')
        if failure == 'ancestor-memory' and path.endswith('/memory.max'): return record(b'2147483648\n')
        if failure == 'ancestor-tasks' and path.endswith('/pids.max'): return record(b'128\n')
        if failure == 'over-limit' and path.endswith('/memory.current'): return record(b'99999999999\n')
        return observations(path, deadline)
    with patch.object(c.os, 'getuid', return_value=1000, create=True), patch.object(c.time, 'monotonic', return_value=10), patch.object(c, '_read', side_effect=read):
        assert c.check_capacity(15)['admitted'] is False


def test_max_is_unlimited_not_zero_and_absence_is_not_unlimited():
    assert c._number(record(b'max\n'), True) is None
    with pytest.raises(ValueError): c._number(record(b''), True)
    with pytest.raises(ValueError): c._number(record(b'max\n'))


@pytest.mark.parametrize('raw', [b'', b'MemAvailable: 1 MB\n', b'MemAvailable: 1 kB\nMemAvailable: 2 kB\n'])
def test_missing_or_ambiguous_host_metadata_fails(raw):
    with pytest.raises(ValueError): c._available(record(raw))


@pytest.mark.parametrize('deadline', [True, 10, 16, float('nan'), float('inf')])
def test_fixed_deadline_rejects_before_reads(deadline):
    with patch.object(c.time, 'monotonic', return_value=10), patch.object(c, '_read') as read:
        with pytest.raises(ValueError): c.check_capacity(deadline)
        read.assert_not_called()


@pytest.mark.parametrize('failure', ['close', 'late-close', 'replaced', 'too-large', None])
def test_readonly_nofollow_reads_close_every_owned_fd_and_final_deadline(failure):
    now = [10]
    info = SimpleNamespace(st_dev=1, st_ino=2, st_mode=stat.S_IFREG | 0o444)
    other = SimpleNamespace(st_dev=1, st_ino=3, st_mode=stat.S_IFREG | 0o444)
    closed = []
    def close(fd):
        closed.append(fd)
        if failure == 'close' and fd == 9: raise OSError('close unknown')
        if failure == 'late-close': now[0] = 16
    with patch.object(c.os, 'O_DIRECTORY', 65536, create=True), patch.object(c.os, 'O_CLOEXEC', 524288, create=True), patch.object(c.os, 'O_NOFOLLOW', 131072, create=True), patch.object(c.os, 'O_NONBLOCK', 2048, create=True), \
         patch.object(c.os, 'open', side_effect=[7, 8, 9]) as opened, patch.object(c.os, 'close', side_effect=close), \
         patch.object(c.os, 'fstat', return_value=info), patch.object(c.os, 'stat', return_value=other if failure == 'replaced' else info), \
         patch.object(c.os, 'read', side_effect=None if failure == 'too-large' else [b'1\n', b''], return_value=b'x'*4096), \
         patch.object(c.time, 'monotonic', side_effect=lambda: now[0]):
        if failure:
            with pytest.raises(ValueError): c._read('/proc/meminfo', 15)
        else: assert c._read('/proc/meminfo', 15)['rawHex'] == b'1\n'.hex()
        assert all(call.args[1] & c.os.O_NOFOLLOW for call in opened.call_args_list)
        assert all(not call.args[1] & (c.os.O_WRONLY | c.os.O_RDWR | c.os.O_CREAT | c.os.O_TRUNC) for call in opened.call_args_list)
    assert closed == [9, 8, 7]
    assert c._UNKNOWN is (failure == 'close')
    if failure == 'close':
        with pytest.raises(ValueError, match='PRIOR_CAPACITY'): c.check_capacity(15)


def test_missing_ancestor_propagates_no_zero_or_admitted_result():
    with patch.object(c.os, 'getuid', return_value=1000, create=True), patch.object(c.time, 'monotonic', return_value=10), patch.object(c, '_read', side_effect=FileNotFoundError):
        with pytest.raises(FileNotFoundError): c.check_capacity(15)
