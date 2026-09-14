import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

spec = importlib.util.spec_from_file_location('trusted_boundary_probe', Path(__file__).with_name('subscription-trusted-control-boundary-probe.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


def marker():
    return {'version': 1, 'namespaces': {'trustedPid': 'pid:[10]', 'trustedMount': 'mnt:[11]'},
        'protectedDescriptors': {name: {'dev': 15, 'ino': index + 100, 'type': 0o010000} for index, name in enumerate(m.DESCRIPTOR_ROLES)},
        'authoredProtectedObjects': {'appServerHome': {'dev': 20, 'ino': 200, 'type': 0o040000},
                                    'appServerSentinel': {'dev': 20, 'ino': 201, 'type': 0o100000}}}


def report():
    value = marker()
    raw = json.dumps(value).encode()
    return {'version': 1, 'kind': 'FIXED_TRUSTED_CONTROL_BOUNDARY_OBSERVATIONS',
        'marker': {'path': m.MARKER_PATH, 'bytes': len(raw), 'sha256': hashlib.sha256(raw).hexdigest(), 'rawHex': raw.hex(),
                   'file': {'dev': 21, 'ino': 300, 'type': 0o100000}, 'readonlyMount': True, 'value': value},
        'identity': {'pid': 2, 'ppid': 1, 'pidNamespace': 'pid:[20]', 'mountNamespace': 'mnt:[21]',
                     'procInitPidNamespace': 'pid:[20]', 'nspid': '2'},
        'status': {'NoNewPrivs': '1', 'Seccomp': '2', 'Seccomp_filters': '2', 'CapEff': '0000000000000000', 'CapBnd': '0000000000000000'},
        'cwd': '/work/exec-worker', 'environmentKeys': ['HOME', 'LANG', 'PATH', 'TMPDIR'],
        'descriptors': [{'fd': index, 'dev': 15, 'ino': 400 + index, 'type': 0o010000} for index in range(3)],
        'paths': {path: {'opened': False, 'errno': 13, 'outcome': 'denied', 'bytesRead': 0, 'bytesWritten': 0}
                  for path in m.PROTECTED_PATHS + m.PROC_FD_PATHS},
        'protectedBodyBytesRead': 0, 'bytesWrittenToProtectedObjects': 0, 'credentialFilesRead': False,
        'actualModelCalls': 0, 'networkOperations': 0, 'cleanupAttestedHere': False, 'productionReady': False}


def opened():
    return {'opened': True, 'errno': None, 'outcome': 'opened', 'bytesRead': 0, 'bytesWritten': 0,
            'descriptor': {'fd': 3, 'dev': 15, 'ino': 900, 'type': 0o010000}}


def test_complete_authored_report_requires_external_marker():
    r = report()
    assert m.validate_report(r, marker())
    assert not m.validate_report(r, None)
    other = marker()
    other['protectedDescriptors']['appServerControl']['ino'] += 500
    assert not m.validate_report(r, other)


@pytest.mark.parametrize('role', m.DESCRIPTOR_ROLES)
@pytest.mark.parametrize('target', ['self', 'proc'])
def test_every_trusted_pipe_role_is_checked_separately(role, target):
    r = report()
    alias = marker()['protectedDescriptors'][role]
    if target == 'self':
        r['descriptors'][1].update(alias)
    else:
        r['paths']['/proc/1/fd/1'] = opened()
        r['paths']['/proc/1/fd/1']['descriptor'].update(alias)
    assert not m.validate_report(r, marker())


@pytest.mark.parametrize('path', m.PROC_FD_PATHS)
def test_inner_proc_fd_open_is_retained_not_called_denial(path):
    r = report()
    r['paths'][path] = opened()
    assert m.validate_report(r, marker())
    assert r['paths'][path]['outcome'] == 'opened'
    r['identity']['procInitPidNamespace'] = 'pid:[10]'
    assert not m.validate_report(r, marker())


@pytest.mark.parametrize('path', m.PROTECTED_PATHS)
def test_any_protected_object_open_fails_even_without_body_read(path):
    r = report()
    r['paths'][path] = opened()
    assert not m.validate_report(r, marker())


def test_absence_is_not_permission_denial():
    r = report()
    r['paths'][m.PROTECTED_PATHS[0]].update(errno=2, outcome='absent')
    assert m.validate_report(r, marker())
    r['paths'][m.PROTECTED_PATHS[0]]['outcome'] = 'denied'
    assert not m.validate_report(r, marker())


@pytest.mark.parametrize('path', m.PROTECTED_PATHS + m.PROC_FD_PATHS)
def test_incomplete_probe_never_passes(path):
    r = report()
    del r['paths'][path]
    assert not m.validate_report(r, marker())


@pytest.mark.parametrize('case', ['self-ns', 'mount-ns', 'proc-ns', 'nspid', 'nnp', 'seccomp', 'caps', 'fd-extra',
    'env-extra', 'cwd', 'bool-version', 'bool-bytes', 'read', 'write', 'readonly', 'raw', 'hash', 'count', 'ready'])
def test_malformed_or_overclaimed_report_fails(case):
    r = report()
    if case == 'self-ns': r['identity']['pidNamespace'] = 'pid:[10]'
    if case == 'mount-ns': r['identity']['mountNamespace'] = 'mnt:[11]'
    if case == 'proc-ns': r['identity']['procInitPidNamespace'] = 'pid:[99]'
    if case == 'nspid': r['identity']['nspid'] = '1'
    if case == 'nnp': r['status']['NoNewPrivs'] = '0'
    if case == 'seccomp': r['status']['Seccomp'] = '0'
    if case == 'caps': r['status']['CapEff'] = '0000000000000001'
    if case == 'fd-extra': r['descriptors'].append({'fd': 4, 'dev': 15, 'ino': 800, 'type': 0o010000})
    if case == 'env-extra': r['environmentKeys'].append('CODEX_HOME')
    if case == 'cwd': r['cwd'] = '/work'
    if case == 'bool-version': r['version'] = True
    if case == 'bool-bytes': r['protectedBodyBytesRead'] = False
    if case == 'read': r['paths'][m.PROTECTED_PATHS[0]]['bytesRead'] = 1
    if case == 'write': r['paths'][m.PROTECTED_PATHS[0]]['bytesWritten'] = 1
    if case == 'readonly': r['marker']['readonlyMount'] = False
    if case == 'raw': r['marker']['rawHex'] = '7b7d'
    if case == 'hash': r['marker']['sha256'] = 'a' * 64
    if case == 'count': r['marker']['bytes'] += 1
    if case == 'ready': r['productionReady'] = True
    assert not m.validate_report(r, marker())


@pytest.mark.parametrize('case', ['bool', 'unknown', 'pid', 'env', 'aliased', 'object-missing', 'object-wrong-type', 'unsafe'])
def test_marker_cannot_supply_pid_env_path_or_alias_override(case):
    value = marker()
    if case == 'bool': value['version'] = True
    if case == 'unknown': value['unknown'] = 1
    if case == 'pid': value['pid'] = 123
    if case == 'env': value['env'] = {'HOME': '/other'}
    if case == 'aliased': value['protectedDescriptors']['appServerControl'] = value['protectedDescriptors']['outerSupervisorControl']
    if case == 'object-missing': del value['authoredProtectedObjects']['appServerSentinel']
    if case == 'object-wrong-type': value['authoredProtectedObjects']['appServerHome']['type'] = 0o100000
    if case == 'unsafe': value['protectedDescriptors']['appServerOutput']['ino'] = 9007199254740992
    assert not m.validate_marker(value)


@pytest.mark.parametrize('raw', [b'{"a":1,"a":2}', b'{"a":NaN}', b'\xc3', b'{}\n{}'])
def test_noncanonical_json_structure_is_rejected(raw):
    with pytest.raises(ValueError):
        m.strict_json(raw)


def install_os_constants(monkeypatch):
    for name, value in {'O_DIRECTORY': 65536, 'O_NOFOLLOW': 131072, 'O_NONBLOCK': 2048, 'O_CLOEXEC': 524288, 'ST_RDONLY': 1}.items():
        monkeypatch.setattr(m.os, name, value, raising=False)


@pytest.mark.parametrize('mode,readonly,size,expected', [
    (0o010600, True, 1, 'REGULAR'), (0o100400, False, 1, 'READONLY'), (0o100400, True, 4097, 'BOUNDED')])
def test_marker_rejected_before_read_with_nonblocking_nofollow_open(monkeypatch, mode, readonly, size, expected):
    install_os_constants(monkeypatch)
    closed = []
    def open_fd(path, flags, **kwargs):
        assert flags & m.os.O_NOFOLLOW
        if path == '/work':
            assert flags & m.os.O_DIRECTORY and not kwargs
            return 7
        assert path == 'trusted-control-boundary.json' and kwargs == {'dir_fd': 7}
        assert flags & m.os.O_NONBLOCK
        return 8
    monkeypatch.setattr(m.os, 'open', open_fd)
    monkeypatch.setattr(m.os, 'fstat', lambda _: SimpleNamespace(st_mode=mode, st_size=size))
    monkeypatch.setattr(m.os, 'fstatvfs', lambda _: SimpleNamespace(f_flag=int(readonly)), raising=False)
    monkeypatch.setattr(m.os, 'read', lambda *_: pytest.fail('inadmissible marker must not be read'))
    monkeypatch.setattr(m.os, 'close', closed.append)
    with pytest.raises(ValueError, match=expected):
        m.read_marker()
    assert closed == [8, 7]


def test_successful_protected_open_never_reads_or_writes_body(monkeypatch):
    install_os_constants(monkeypatch)
    closed = []
    monkeypatch.setattr(m.os, 'open', lambda *_args: 3)
    monkeypatch.setattr(m.os, 'fstat', lambda _: SimpleNamespace(st_dev=1, st_ino=2, st_mode=0o100400))
    monkeypatch.setattr(m.os, 'read', lambda *_: pytest.fail('no protected body read'))
    monkeypatch.setattr(m.os, 'write', lambda *_: pytest.fail('no protected write'))
    monkeypatch.setattr(m.os, 'close', closed.append)
    result = m.open_only(m.PROTECTED_PATHS[1])
    assert result['opened'] and result['bytesRead'] == 0 and result['bytesWritten'] == 0
    assert closed == [3]


def test_wrong_entry_never_reads_marker(monkeypatch):
    monkeypatch.setattr(m.sys, 'platform', 'win32')
    monkeypatch.setattr(m, 'read_marker', lambda: pytest.fail('wrong entry cannot read marker'))
    with pytest.raises(ValueError, match='FIXED_LOCKDOWN_WORKER_REQUIRED'):
        m.collect()
