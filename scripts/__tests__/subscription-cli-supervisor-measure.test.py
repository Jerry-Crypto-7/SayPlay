"""Offline source binding tests; no CLI, process, credential or network calls."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import Mock, patch

SCRIPTS = Path(__file__).parents[1]


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


measure = load('capsule_measure_source_tests', SCRIPTS / 'subscription-cli-supervisor.measure.py')
# Reuse the independent explicit metadata fixture, not the implementation's
# Protocol generator; importing this test module does not execute unittest.main.
fixtures = load('metadata_explicit_fixture', SCRIPTS / '__tests__' / 'subscription-appserver-noenv.test.py')
HELPER = 'subscription-appserver-noenv.py'
CATALOG = 'subscription-text-model-catalog.json'


def environment_sample(bootstrap=False, controlled=False):
    fixture = load('environment_parent_explicit_fixture', SCRIPTS / 'subscription-exec-environment-metadata-parent.test.py')
    hashes = {name: hashlib.sha256((SCRIPTS / name).read_bytes()).hexdigest() for name in measure.ENVIRONMENT_HELPERS}
    body = fixture.complete_controlled_bootstrap_report() if controlled else fixture.complete_bootstrap_report() if bootstrap else fixture.complete_report()
    mode = 'exec-environment-bootstrap-controlled' if controlled else 'exec-environment-bootstrap-metadata' if bootstrap else 'exec-environment-metadata'
    body['helperSha256Before'] = dict(hashes)
    body['helperSha256After'] = dict(hashes)
    raw = json.dumps(body).encode()
    terminal = {'type': 'terminal', 'reason': 'EXITED', 'mode': mode, 'exitCode': 0,
        'productionReady': False, 'modelCalls': 0, 'credentialFilesRead': False, 'registryOverflow': False,
        'outputComplete': True, 'outputLimitExceeded': False, 'streamEOF': {'stdout': True, 'stderr': True},
        'outputBytes': len(raw), 'observedOutputSha256': hashlib.sha256(raw).hexdigest(),
        'cleanup': {'verified': True, 'namespaceEmpty': True, 'allObservedPidfdsESRCH': True, 'observedPidfds': 7, 'signalFailures': []}}
    return {'scenario': mode, 'sourceSha256Before': dict(hashes), 'sourceSha256After': dict(hashes),
        'errors': [], 'driverTimeout': False, 'exitCode': 0, 'stderr': '', 'terminal': terminal, 'transcriptIntegrity': True,
        'frames': [{'type': 'ready', 'utsBoundary': {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[123]'},
            'execEnvironmentMetadataBoundary': {'helperSha256': hashes}}, {'type': 'started', 'mode': mode, 'pid': 2},
            {'type': 'child_output', 'stream': 'stdout', 'encoding': 'base64', 'data': base64.b64encode(raw).decode()}, terminal]}


class EnvironmentMeasureTests(unittest.TestCase):
    def test_bootstrap_uses_distinct_replay_and_start_without_relabeling_old_profile(self):
        report = environment_sample(bootstrap=True)
        mode = 'exec-environment-bootstrap-metadata'
        self.assertTrue(measure.evaluate(mode, report))
        self.assertEqual(measure.environment_start(report['frames'][0], report['sourceSha256Before'], mode)['mode'], mode)
        self.assertFalse(measure.evaluate('exec-environment-metadata', report))
        legacy = environment_sample()
        legacy['scenario'] = legacy['terminal']['mode'] = legacy['frames'][1]['mode'] = mode
        self.assertFalse(measure.evaluate(mode, legacy))
        with self.assertRaises(ValueError): measure.environment_start(report['frames'][0], report['sourceSha256Before'], 'arbitrary')
    def test_real_validator_replay_and_exact_fixed_start(self):
        report = environment_sample()
        self.assertTrue(measure.environment_evaluation(report))
        self.assertTrue(measure.evaluate('exec-environment-metadata', report))
        start = measure.environment_start(report['frames'][0], report['sourceSha256Before'])
        self.assertEqual(set(start), {'type', 'mode', 'helperSha256'})
        self.assertEqual(start['mode'], 'exec-environment-metadata')
        self.assertEqual(len(start['helperSha256']), 7)
        for name in measure.ENVIRONMENT_HELPERS:
            self.assertIn('scripts/' + name, measure.SOURCES)
        self.assertIn('scripts/subscription-appserver-metadata-pipe-child.py', measure.SOURCES)

    def test_absent_malformed_foreign_or_spoofed_hashes_fail_before_import(self):
        for case in ('absent', 'extra', 'malformed', 'foreign', 'spoofed'):
            report = environment_sample()
            boundary = report['frames'][0]['execEnvironmentMetadataBoundary']
            if case == 'absent': del report['frames'][0]['execEnvironmentMetadataBoundary']
            if case == 'extra': boundary['helperSha256']['foreign.py'] = 'a' * 64
            if case == 'malformed': boundary['helperSha256'][measure.ENVIRONMENT_HELPERS[0]] = 7
            if case == 'foreign': report['frames'][0]['execServerWorkerBoundary'] = report['frames'][0].pop('execEnvironmentMetadataBoundary')
            if case == 'spoofed':
                name = 'subscription-exec-environment-metadata-parent.py'
                boundary['helperSha256'][name] = report['sourceSha256Before'][name] = '0' * 64
            with patch.object(measure.importlib.util, 'module_from_spec') as imported:
                self.assertFalse(measure.environment_evaluation(report), case)
                imported.assert_not_called()

    def test_partial_wrong_mode_terminal_or_raw_claim_never_passes(self):
        for case in ('partial', 'mode', 'started-mode', 'stderr', 'stream', 'encoding', 'duplicate-terminal',
                     'exit-bool', 'cleanup-bool', 'namespace', 'esrch', 'overflow', 'output-count', 'source-after', 'malformed-frame', 'eof-int'):
            report = environment_sample(); terminal = report['terminal']
            if case == 'partial': report['frames'][2]['data'] = base64.b64encode(b'{').decode()
            if case == 'mode': terminal['mode'] = 'exec-server-worker'
            if case == 'started-mode': report['frames'][1]['mode'] = 'exec-server-worker'
            if case == 'stderr': report['stderr'] = 'unexpected'
            if case == 'stream': report['frames'][2]['stream'] = 'stderr'
            if case == 'encoding': report['frames'][2]['encoding'] = 'text'
            if case == 'duplicate-terminal': report['frames'].append(copy.deepcopy(terminal))
            if case == 'exit-bool': terminal['exitCode'] = False
            if case == 'cleanup-bool': terminal['cleanup']['verified'] = 1
            if case == 'namespace': terminal['cleanup']['namespaceEmpty'] = False
            if case == 'esrch': terminal['cleanup']['allObservedPidfdsESRCH'] = False
            if case == 'overflow': terminal['registryOverflow'] = True
            if case == 'output-count': terminal['outputBytes'] += 1
            if case == 'source-after': report['sourceSha256After']['changed'] = '0' * 64
            if case == 'malformed-frame': report['frames'].append(None)
            if case == 'eof-int': terminal['streamEOF']['stdout'] = 1
            self.assertFalse(measure.evaluate('exec-environment-metadata', report), case)


class UtsReadyTests(unittest.TestCase):
    def test_direct_capsule_owns_uts_without_deadline_change(self):
        self.assertEqual(measure.COMMAND.count('--uts'), 1)
        self.assertLess(measure.COMMAND.index('/usr/bin/unshare'), measure.COMMAND.index('--uts'))
        self.assertLess(measure.COMMAND.index('--uts'), measure.COMMAND.index('/bin/sh'))
        timeout = measure.COMMAND.index('/usr/bin/timeout')
        self.assertEqual(measure.COMMAND[timeout + 1:timeout + 4], ['--signal=TERM', '--kill-after=5', '200'])

    def test_exact_hostname_namespace_ready_and_negative_completeness(self):
        ready = {'utsBoundary': {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[123]'}}
        self.assertTrue(measure.validate_uts_ready(ready))
        for value in (None, {}, {'hostname': 'host', 'namespace': 'uts:[123]'},
                      {'hostname': 'reality-compiler-probe'},
                      {'hostname': 'reality-compiler-probe', 'namespace': 'pid:[123]'},
                      {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[0]'},
                      {'hostname': 'reality-compiler-probe', 'namespace': 123},
                      {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[123]', 'extra': True}):
            self.assertFalse(measure.validate_uts_ready({'utsBoundary': value}))

    def test_evaluate_requires_single_current_uts_ready(self):
        report = {'terminal': {'cleanup': {'verified': True}, 'outputComplete': True,
                              'productionReady': False, 'modelCalls': 0, 'reason': 'EXITED', 'exitCode': 0},
                  'sourceSha256Before': {}, 'sourceSha256After': {}, 'errors': [], 'driverTimeout': False,
                  'exitCode': 0, 'transcriptIntegrity': True,
                  'frames': [{'type': 'ready', 'utsBoundary': {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[123]'}}]}
        self.assertTrue(measure.evaluate('version', report))
        ready = report['frames'][0]
        for frames in ([], [{'type': 'ready'}], [ready, ready]):
            report['frames'] = frames
            self.assertFalse(measure.evaluate('version', report))


class ShellUtsPreconditionTests(unittest.TestCase):
    """Execute only the extracted Python guard with fake kernel/FD modules."""
    @classmethod
    def setUpClass(cls):
        cls.shell = (SCRIPTS / 'subscription-cli-supervisor.sh').read_text()
        cls.source = cls.shell.split("<<'UTS_PY'\n", 1)[1].split('\nUTS_PY\n', 1)[0]

    def environment(self, mapping='1000 1000 1\n', same_owner=True, hostname='reality-compiler-probe'):
        setter = Mock(return_value=0)
        libc = types.SimpleNamespace(sethostname=setter)
        ctypes_module = types.SimpleNamespace(CDLL=Mock(return_value=libc), c_char_p=object, c_size_t=object,
                                             c_int=object, get_errno=lambda: 1)
        close = Mock()
        os_module = types.SimpleNamespace(geteuid=lambda: 1000, O_RDONLY=0, O_CLOEXEC=0x80000,
                    open=Mock(side_effect=[10, 11]), close=close,
                    fstat=lambda fd: types.SimpleNamespace(st_dev=1, st_ino=77 if fd == 11 or same_owner else 88),
                    uname=lambda: types.SimpleNamespace(nodename=hostname))
        ioctl = Mock(return_value=12)
        modules = {'ctypes': ctypes_module, 'fcntl': types.SimpleNamespace(ioctl=ioctl), 'os': os_module,
                   'pathlib': types.SimpleNamespace(Path=lambda _: types.SimpleNamespace(read_text=lambda: mapping))}
        return modules, setter, close, ioctl

    def execute(self, modules):
        with patch.dict(sys.modules, modules):
            exec(compile(self.source, 'capsule-uts-guard-fixture', 'exec'), {})

    def test_owned_mapped_namespace_sets_fixed_name_and_closes_all_fds(self):
        modules, setter, close, ioctl = self.environment()
        self.execute(modules)
        setter.assert_called_once_with(b'reality-compiler-probe', len(b'reality-compiler-probe'))
        ioctl.assert_called_once_with(10, 0xb701)
        self.assertEqual([call.args[0] for call in close.call_args_list], [12, 11, 10])
        self.assertLess(self.shell.index('UTS_PY\n'), self.shell.index('mount --make-rprivate'))

    def test_initial_host_user_mapping_cannot_mutate_hostname(self):
        modules, setter, _, _ = self.environment(mapping='0 0 4294967295\n')
        with self.assertRaisesRegex(SystemExit, 'MAP_CURRENT_USER_REQUIRED'):
            self.execute(modules)
        setter.assert_not_called()
        modules['os'].open.assert_not_called()

    def test_ancestor_uts_owner_cannot_mutate_hostname(self):
        modules, setter, close, _ = self.environment(same_owner=False)
        with self.assertRaisesRegex(SystemExit, 'UTS_OWNER_MISMATCH'):
            self.execute(modules)
        setter.assert_not_called()
        self.assertEqual(close.call_count, 3)

    def test_owner_ioctl_failure_is_closed_without_hostname_mutation(self):
        modules, setter, close, ioctl = self.environment()
        ioctl.side_effect = PermissionError('ancestor owner unavailable')
        with self.assertRaises(PermissionError):
            self.execute(modules)
        setter.assert_not_called()
        self.assertEqual([call.args[0] for call in close.call_args_list], [11, 10])

    def test_post_set_readback_must_match(self):
        modules, setter, close, _ = self.environment(hostname='other')
        with self.assertRaisesRegex(SystemExit, 'HOSTNAME_READBACK_MISMATCH'):
            self.execute(modules)
        setter.assert_called_once()
        self.assertEqual(close.call_count, 3)

    def test_sethostname_kernel_failure_is_not_accepted(self):
        modules, setter, close, _ = self.environment()
        setter.return_value = -1
        with self.assertRaisesRegex(OSError, 'SETHOSTNAME_FAILED'):
            self.execute(modules)
        self.assertEqual(close.call_count, 3)

    def test_malformed_foreign_or_multiple_user_mapping_rejected(self):
        for mapping in ('', '1000 1000\n', 'x x 1\n', '1000 2000 1\n', '0 0 1\n', '1000 1000 1\n1001 1001 1\n'):
            modules, setter, _, _ = self.environment(mapping=mapping)
            with self.assertRaises(SystemExit):
                self.execute(modules)
            setter.assert_not_called()


def sample():
    digest = hashlib.sha256((SCRIPTS / HELPER).read_bytes()).hexdigest()
    catalog_digest = hashlib.sha256((SCRIPTS / CATALOG).read_bytes()).hexdigest()
    hashes = {HELPER: digest, CATALOG: catalog_digest}
    body = json.dumps(fixtures.report_fixture()).encode()
    return {'sourceSha256Before': dict(hashes), 'frames': [
        {'type': 'ready', 'appServerBoundary': {'helperSha256': dict(hashes)}},
        {'type': 'child_output', 'stream': 'stdout', 'encoding': 'base64',
         'data': base64.b64encode(body).decode()}]}


class AppserverMeasureSourceTests(unittest.TestCase):
    def test_positive_explicit_transcript_with_current_frozen_helper(self):
        self.assertTrue(measure.appserver_evaluation(sample()))

    def test_agreeing_ready_and_before_hash_cannot_spoof_loaded_validator(self):
        report = sample()
        report['sourceSha256Before'][HELPER] = '0' * 64
        report['frames'][0]['appServerBoundary']['helperSha256'][HELPER] = '0' * 64
        with patch.object(measure.importlib.util, 'module_from_spec') as imported:
            self.assertFalse(measure.appserver_evaluation(report))
            imported.assert_not_called()

    def test_ready_before_disagreement_fails_before_reading_validator(self):
        report = sample()
        report['frames'][0]['appServerBoundary']['helperSha256'][HELPER] = '0' * 64
        with patch.object(measure.Path, 'read_bytes') as read:
            self.assertFalse(measure.appserver_evaluation(report))
            read.assert_not_called()

    def test_prefixed_source_key_supported_and_bound(self):
        report = sample()
        report['sourceSha256Before']['scripts/' + HELPER] = report['sourceSha256Before'].pop(HELPER)
        self.assertTrue(measure.appserver_evaluation(report))
        report['sourceSha256Before']['scripts/' + HELPER] = '0' * 64
        self.assertFalse(measure.appserver_evaluation(report))

    def test_exact_hashed_bytes_execute_without_second_helper_read(self):
        report = sample()
        source = (SCRIPTS / HELPER).read_bytes()
        catalog = (SCRIPTS / CATALOG).read_bytes()
        with patch.object(measure.Path, 'read_bytes', side_effect=[source, catalog, AssertionError('third read')]) as read:
            self.assertTrue(measure.appserver_evaluation(report))
            self.assertEqual(read.call_count, 2)

    def test_agreeing_catalog_hashes_cannot_spoof_current_readonly_policy(self):
        report = sample()
        report['sourceSha256Before'][CATALOG] = '0' * 64
        report['frames'][0]['appServerBoundary']['helperSha256'][CATALOG] = '0' * 64
        with patch.object(measure.importlib.util, 'module_from_spec') as imported:
            self.assertFalse(measure.appserver_evaluation(report))
            imported.assert_not_called()

    def test_missing_validator_source_fails_closed(self):
        report = sample()
        with patch.object(measure.Path, 'read_bytes', side_effect=OSError('missing fixture source')):
            self.assertFalse(measure.appserver_evaluation(report))


if __name__ == '__main__':
    unittest.main()


def test_controlled_bootstrap_distinct_validator_and_no_trusted_control_dispatch():
    report = environment_sample(controlled=True)
    mode = 'exec-environment-bootstrap-controlled'
    assert measure.evaluate(mode, report)
    assert measure.environment_start(report['frames'][0], report['sourceSha256Before'], mode)['mode'] == mode
    assert not measure.evaluate('exec-environment-bootstrap-metadata', report)
    # The default image also contains the two existing AF_UNIX ingress helpers.
    # Conditional HTTP and CLI-refusal helpers belong to dedicated inventories.
    assert len(measure.SOURCES) == 21
    assert 'scripts/subscription-trusted-ingress-child.py' in measure.SOURCES
    assert 'scripts/subscription-trusted-ingress-worker-probe.py' in measure.SOURCES
    assert 'scripts/subscription-cli-proxy-refusal-child.py' not in measure.SOURCES
    assert 'trusted-control-boundary' not in measure.SCENARIOS
    natural = environment_sample(bootstrap=True)
    natural['scenario'] = natural['terminal']['mode'] = natural['frames'][1]['mode'] = mode
    assert not measure.evaluate(mode, natural)
