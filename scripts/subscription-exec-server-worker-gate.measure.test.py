import copy
import importlib.util
import json
import re
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('executor_measure', Path(__file__).with_name('subscription-exec-server-worker-gate.measure.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
ENVIRONMENT_KEYS = ('HOME', 'LANG', 'PATH', 'TMPDIR')
OUTER = {'namespace': 'pid:[10]', 'mountNamespace': 'mnt:[11]',
         'control': {'dev': 15, 'ino': 200, 'type': 0o010000}, 'output': {'dev': 15, 'ino': 201, 'type': 0o010000}}


def test_measure_receipts_cover_every_repository_helper_copied_into_capsule():
    root = Path(__file__).resolve().parent.parent
    shell = (root / 'scripts/subscription-cli-supervisor.sh').read_text(encoding='utf8')
    copied = set(re.findall(r'^cp /mnt/d/claude/Hackaton/(scripts/[^ ]+) ', shell, re.M))
    assert copied, 'Shell copy inventory was not recognized'
    assert copied <= set(m.SOURCES)
    for name in ('subscription-cli-probe-transport', 'subscription-appserver-fixture-transport',
                 'subscription-systemd-fixture-transport', 'subscription-appserver-metadata-transport',
                 'subscription-appserver-systemd-metadata-transport'):
        source = (root / f'evals/reality-compiler/{name}.measure.ts').read_text(encoding='utf8')
        inventory = source.split('const paths = [', 1)[1].split('];', 1)[0]
        declared = set(re.findall(r"'(scripts/[^']+)'", inventory))
        assert copied <= declared, (name, sorted(copied - declared))


def complete():
    return {'kind': 'ACTUAL_FIXED_EXECUTOR_WORKER_PROBE', 'schemaVersion': 1,
            'identity': {'pid': 1, 'ppid': 0, 'pidNamespace': 'pid:[12]', 'mountNamespace': 'mnt:[13]',
                         'procInitPidNamespace': {'value': 'pid:[12]', 'errno': None}, 'nspid': '1'},
            'status': {'NoNewPrivs': '1', 'Seccomp': '2', 'Seccomp_filters': '3',
                       'CapEff': '0000000000000000', 'CapBnd': '0000000000000000'},
            'environmentKeys': sorted(ENVIRONMENT_KEYS), 'cwd': '/work/exec-worker',
            'descriptors': [{'fd': fd, 'dev': 1, 'ino': fd + 1, 'type': 0o010000} for fd in range(3)],
            'paths': {path: {'opened': False, 'errno': 2, 'bytesRead': 0, 'bytesWritten': 0} for path in m.PROBE_PATHS},
            'syscalls': {name: {'return': -1, 'errno': number} for name, number in m.SYSCALL_ERRNOS.items()},
            'actualModelCalls': 0, 'credentialFilesRead': False, 'networkOperations': 0}


def test_complete_authored_report_is_offline_validator_fixture_only():
    report = complete()
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER) == []
    assert m.decode_probe(json.dumps(report).encode(), ENVIRONMENT_KEYS, OUTER) == report


@pytest.mark.parametrize('key', list(complete()))
def test_missing_top_level_field_cannot_pass(key):
    report = complete()
    del report[key]
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)


@pytest.mark.parametrize('path', m.PROBE_PATHS)
def test_every_missing_path_fails_completeness(path):
    report = complete()
    del report['paths'][path]
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER) == ['PATH_COMPLETENESS']


@pytest.mark.parametrize('call', m.SYSCALL_ERRNOS)
def test_every_missing_call_fails_completeness(call):
    report = complete()
    del report['syscalls'][call]
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER) == ['SYSCALL_COMPLETENESS']


@pytest.mark.parametrize('change', [{'opened': True}, {'bytesRead': 1}, {'bytesWritten': 1}, {'errno': 0},
                                   {'errno': True}, {'bytesRead': False}, {'descriptor': {}}])
def test_open_or_read_or_write_never_receives_denial_credit(change):
    report = complete()
    report['paths']['/private/sentinel'].update(change)
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)


@pytest.mark.parametrize('section,key,value', [
    ('status', 'NoNewPrivs', '0'), ('status', 'Seccomp', '0'), ('status', 'Seccomp_filters', '0'),
    ('status', 'CapEff', '0000000000000001'), ('status', 'CapBnd', '0000000000000001'),
    ('syscalls', 'unshare-user', {'return': 0, 'errno': 0}),
    ('syscalls', 'clone3-invalid', {'return': -1, 'errno': 1}),
])
def test_wrong_lockdown_fails(section, key, value):
    report = complete()
    report[section][key] = value
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)


@pytest.mark.parametrize('kind', ['extra-fd', 'missing-fd', 'duplicate-fd', 'extra-env', 'duplicate-env', 'wrong-cwd', 'model-bool'])
def test_worker_identity_is_complete_and_exact(kind):
    report = complete()
    if kind == 'extra-fd':
        report['descriptors'].append({'fd': 9, 'dev': 1, 'ino': 9, 'type': 0o010000})
    elif kind == 'missing-fd':
        report['descriptors'].pop()
    elif kind == 'duplicate-fd':
        report['descriptors'][1]['fd'] = 0
    elif kind == 'extra-env':
        report['environmentKeys'].append('SECRET')
    elif kind == 'duplicate-env':
        report['environmentKeys'].append('PATH')
    elif kind == 'wrong-cwd':
        report['cwd'] = '/private'
    else:
        report['actualModelCalls'] = False
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)


@pytest.mark.parametrize('raw', [b'', b'{}\n{}', b'{"a":1,"a":2}', b'{"a":NaN}', b'\xc3', b' ' * (m.MAX_PROBE_BYTES + 1)],
                         ids=['empty', 'two-frames', 'duplicate-key', 'nonfinite', 'incomplete-utf8', 'over-limit'])
def test_raw_malformed_or_partial_report_fails(raw):
    with pytest.raises((ValueError, UnicodeError)):
        m.decode_probe(raw, ENVIRONMENT_KEYS, OUTER)


def test_inner_pid1_descriptor_open_is_not_automatically_outer_escape_or_denial():
    report = complete()
    report['paths']['/proc/1/fd/0'] = {'opened': True, 'errno': None, 'bytesRead': 0, 'bytesWritten': 0,
                                    'descriptor': {'fd': 3, 'dev': 15, 'ino': 999, 'type': 0o010000}}
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER) == []
    assert report['paths']['/proc/1/fd/0']['opened'] is True  # Retained as an open, not reported denied.


@pytest.mark.parametrize('key', ['control', 'output'])
def test_pid1_open_or_standard_fd_cannot_alias_outer_pipe(key):
    report = complete()
    report['paths']['/proc/1/fd/1'] = {'opened': True, 'errno': None, 'bytesRead': 0, 'bytesWritten': 0,
                                    'descriptor': {'fd': 3, **OUTER[key]}}
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)
    report = complete()
    report['descriptors'][1] = {'fd': 1, **OUTER[key]}
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)


@pytest.mark.parametrize('change', [
    {'pidNamespace': 'pid:[10]'}, {'mountNamespace': 'mnt:[11]'}, {'nspid': '2'},
    {'procInitPidNamespace': {'value': 'pid:[10]', 'errno': None}},
    {'procInitPidNamespace': {'value': None, 'errno': 13}},
])
def test_fresh_proc_and_namespaces_must_be_observed_not_inferred(change):
    report = complete()
    report['identity'].update(change)
    assert m.validate_probe(report, ENVIRONMENT_KEYS, OUTER)


def test_duplicate_output_read_and_notification_never_duplicate_probe_bytes():
    chunks = m.ProcessOutput()
    value = {'seq': 1, 'stream': 'stdout', 'chunk': 'YQ=='}
    chunks.add(value)
    chunks.add(copy.deepcopy(value))
    assert chunks.bytes('stdout') == b'a'
    with pytest.raises(ValueError, match='CONFLICT'):
        chunks.add({**value, 'chunk': 'Yg=='})


@pytest.mark.parametrize('value', [
    {'seq': True, 'stream': 'stdout', 'chunk': 'YQ=='}, {'seq': 1, 'stream': 'other', 'chunk': 'YQ=='},
    {'seq': 1, 'stream': 'stdout', 'chunk': 'YQ='}, {'seq': 1, 'stream': 'stdout', 'chunk': 'YQ==', 'extra': True},
])
def test_malformed_process_chunk_fails(value):
    with pytest.raises(ValueError):
        m.ProcessOutput().add(value)


def ready():
    before = {'scripts/' + name: 'a' * 64 for name in m.HELPERS}
    frame = {'version': 1, 'type': 'ready', 'execServerWorkerBoundary': {'helperSha256': {name: 'a' * 64 for name in m.HELPERS}},
             'binarySha256': 'a2a05dafaa1acb002a45eaec0a462de5b13694fcfcd7bc43305f14781ce7be14',
             'bwrapSha256': '77360cb751ccedc5971391444ac86a8a33c15b04d6b4a6fe45f5d25496e62c4c',
             'utsBoundary': {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[9]'},
             'sandbox': {'pidNamespaceInit': True, 'hostHomeMounted': False, 'hostMntMounted': False,
                         'networkInterfaces': ['lo'], 'ttyIsNullDevice': True, 'runtimeWriteDenied': True, 'parentNondumpable': True},
             'limits': {'jobMs': 180000, 'commandMs': 200000, 'termGraceMs': 5000, 'maxOutputBytes': 8388608,
                        'commandBudgetEnforcedHere': False, 'aggregateResourcesEnforced': False}}
    return frame, before


def test_exact_six_hash_ready_admits_only_fixed_start():
    frame, before = ready()
    start = m.admit_ready(frame, before)
    assert set(start) == {'type', 'mode', 'helperSha256'}
    assert start['mode'] == 'exec-server-worker'


@pytest.mark.parametrize('field', ['binarySha256', 'bwrapSha256', 'execServerWorkerBoundary', 'limits', 'sandbox', 'utsBoundary'])
def test_missing_or_changed_ready_never_admits(field):
    frame, before = ready()
    del frame[field]
    with pytest.raises(ValueError):
        m.admit_ready(frame, before)


def terminal():
    return {'version': 1, 'type': 'terminal', 'mode': m.MODE, 'reason': 'CANCELLED', 'exitCode': -15, 'elapsedMs': 10,
            'outputBytes': 1, 'observedOutputSha256': 'a' * 64, 'outputComplete': True,
            'streamEOF': {'stdout': True, 'stderr': True}, 'outputLimitExceeded': False, 'registryOverflow': False,
            'cleanup': {'verified': True, 'namespaceEmpty': True, 'observedPidfds': 2, 'allObservedPidfdsESRCH': True,
                        'killSent': False, 'signalFailures': []}, 'privateChecks': None, 'credentialFilesRead': False,
            'modelCalls': 0, 'productionReady': False, 'productionAuth': 'NOT_RUN', 'productionNetwork': 'NOT_RUN', 'productionCleanup': 'NOT_RUN'}


def test_terminal_requires_complete_cleanup_and_exact_counts_hash():
    value = terminal()
    assert m.verify_terminal(value, 1, 'a' * 64)
    assert not m.verify_terminal(value, 2, 'a' * 64)
    assert not m.verify_terminal(value, 1, 'b' * 64)
    for key in list(value):
        partial = copy.deepcopy(value)
        del partial[key]
        assert not m.verify_terminal(partial, 1, 'a' * 64)
    for key in ('verified', 'namespaceEmpty', 'allObservedPidfdsESRCH'):
        altered = copy.deepcopy(value)
        altered['cleanup'][key] = False
        assert not m.verify_terminal(altered, 1, 'a' * 64)


@pytest.mark.parametrize('change', [
    {'reason': 'SETUP_FAILED'}, {'reason': 'CONTROL_EOF'}, {'reason': 'JOB_TIMEOUT'},
    {'exitCode': 1}, {'exitCode': 0}, {'exitCode': -9}, {'exitCode': True}, {'version': True},
])
def test_complete_valid_probe_cannot_hide_fatal_or_unplanned_terminal(change):
    assert m.validate_probe(complete(), ENVIRONMENT_KEYS, OUTER) == []
    value = terminal()
    value.update(change)
    assert not m.verify_terminal(value, 1, 'a' * 64)


@pytest.mark.parametrize('status', [1, -15, None, False])
def test_complete_probe_and_terminal_cannot_hide_wrapper_failure(status):
    assert m.validate_probe(complete(), ENVIRONMENT_KEYS, OUTER) == []
    assert not m.verify_terminal(terminal(), 1, 'a' * 64, status)


def test_ready_boolean_version_is_not_protocol_version_one():
    frame, before = ready()
    frame['version'] = True
    with pytest.raises(ValueError):
        m.admit_ready(frame, before)


@pytest.mark.parametrize('denied,valid', [(None, True), (False, True), (0, False), (True, False), ('false', False)])
def test_exit_notification_boolean_is_not_integer_alias(denied, valid):
    assert m.valid_exit_notification({'processId': 'fixed-worker', 'seq': 1, 'exitCode': 0, 'sandboxDenied': denied}) is valid
