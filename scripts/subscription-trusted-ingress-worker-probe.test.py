import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import pytest


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), Path(__file__).with_name(name + '.py'))
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    return module


m = load('subscription-trusted-ingress-worker-probe')
f = load('subscription-trusted-control-boundary-probe.test')


def base(): return load('subscription-trusted-control-boundary-probe')


def marker():
    value = f.marker()
    value['trustedIngressSocket'] = {'dev': 99, 'ino': 999, 'type': 0o140000}
    return value


def report():
    value = f.report()
    value['kind'] = m.KIND
    raw = json.dumps(marker()).encode()
    value['marker'].update(path=m.MARKER_PATH, value=marker(), rawHex=raw.hex(), bytes=len(raw), sha256=hashlib.sha256(raw).hexdigest())
    value['paths']['/proc/1/fd/198'] = {'opened': False, 'errno': 2, 'outcome': 'absent', 'bytesRead': 0, 'bytesWritten': 0}
    return value


def test_new_socket_schema_is_separate_from_old_four_fifo():
    assert m.validate_report_with(base(), report(), marker())
    assert not base().validate_marker(marker())
    assert not m.validate_marker_with(base(), f.marker())
    assert not m.validate_report_with(base(), report(), None)


@pytest.mark.parametrize('target', ['fd0', 'fd1', 'fd2', 'proc0', 'proc198', 'inherited198'])
def test_any_socket_alias_or_extra_inherited_descriptor_is_rejected(target):
    value = report()
    protected = marker()['trustedIngressSocket']
    if target.startswith('fd'):
        value['descriptors'][int(target[-1])].update(protected)
    elif target == 'inherited198':
        value['descriptors'].append({'fd': 198, **protected})
    else:
        value['paths']['/proc/1/fd/' + ('198' if target == 'proc198' else '0')] = {
            'opened': True, 'errno': None, 'outcome': 'opened', 'bytesRead': 0, 'bytesWritten': 0,
            'descriptor': {'fd': 3, **protected}}
    assert not m.validate_report_with(base(), value, marker())


def test_fresh_proc_fd198_open_can_be_nonalias_without_being_called_denial():
    value = report()
    value['paths']['/proc/1/fd/198'] = {'opened': True, 'errno': None, 'outcome': 'opened', 'bytesRead': 0, 'bytesWritten': 0,
        'descriptor': {'fd': 3, 'dev': 99, 'ino': 1000, 'type': 0o140000}}
    assert m.validate_report_with(base(), value, marker())
    value['identity']['procInitPidNamespace'] = 'pid:[10]'
    assert not m.validate_report_with(base(), value, marker())


@pytest.mark.parametrize('case', ['fifo', 'bool', 'missing198', 'readbody', 'foreign-marker'])
def test_socket_type_identity_and_complete_open_only_report(case):
    expected = marker(); value = report()
    if case == 'fifo': expected['trustedIngressSocket']['type'] = 0o010000
    if case == 'bool': expected['trustedIngressSocket']['ino'] = True
    if case == 'missing198': del value['paths']['/proc/1/fd/198']
    if case == 'readbody': value['paths']['/proc/1/fd/198']['bytesRead'] = 1
    if case == 'foreign-marker': expected['trustedIngressSocket']['ino'] += 1
    assert not m.validate_report_with(base(), value, expected)
