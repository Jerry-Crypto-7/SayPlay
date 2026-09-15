"""Offline fixed-wire/protocol/budget tests; never launch CLI or access auth."""
import copy
import base64
import importlib.util
import json
from pathlib import Path
import unittest
from unittest.mock import MagicMock, patch

spec = importlib.util.spec_from_file_location('appserver_noenv', Path(__file__).parents[1] / 'subscription-appserver-noenv.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)
HOME = '/work/appserver-home/fixed-abcdefgh'


def initialize():
    return {'id': 1, 'result': {'userAgent': 'codex/0.145.0', 'codexHome': HOME,
                               'platformFamily': 'unix', 'platformOs': 'linux'}}


def fixed_config():
    return {'model_reasoning_effort': 'low', 'features.shell_tool': False,
            'features.apps': False, 'features.multi_agent': False,
            'features.multi_agent_v2': False, 'agents.enabled': False,
            'features.image_generation': False, 'features.goals': False,
            'features.memories': False, 'features.plugins': False,
            'features.code_mode': False, 'features.code_mode_only': False,
            'features.deferred_executor': False, 'features.token_budget': False,
            'features.current_time_reminder': False, 'features.skill_search': False,
            'tools.experimental_request_user_input.enabled': False,
            'orchestrator.skills.enabled': False, 'orchestrator.mcp.enabled': False,
            'skills.include_instructions': False,
            'model_catalog_json': '/usr/bin/text-model-catalog.json', 'web_search': 'disabled'}


def models():
    return {'id': 3, 'result': {'data': [{'id': 'gpt-5.6-sol', 'model': 'gpt-5.6-sol'}], 'nextCursor': None}}


def fixed_argv():
    return ('/usr/bin/codex',) + tuple(argument for key, value in fixed_config().items()
        for argument in ('-c', key + '=' + json.dumps(value))) + ('app-server', '--stdio')


def thread():
    return {'id': 2, 'result': {'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'reasoningEffort': 'low',
                               'cwd': '/work', 'approvalPolicy': 'never', 'runtimeWorkspaceRoots': [],
                               'sandbox': {'type': 'readOnly', 'networkAccess': False},
                               'thread': {'id': 'fixture-thread', 'ephemeral': True, 'path': None}}}


def ready_for_thread():
    protocol = p.Protocol(HOME)
    protocol.written(len(protocol.pending))
    protocol.receive(initialize())
    protocol.written(len(protocol.pending))
    return protocol


def report_fixture():
    first = {'id': 1, 'method': 'initialize', 'params': {
        'clientInfo': {'name': 'reality_compiler_probe', 'version': '1'},
        'capabilities': {'experimentalApi': True}}}
    initialized = {'method': 'initialized', 'params': {}}
    second = {'id': 2, 'method': 'thread/start', 'params': {
        'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'allowProviderModelFallback': False,
        'cwd': '/work', 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True,
        'environments': [], 'dynamicTools': [], 'selectedCapabilityRoots': [], 'runtimeWorkspaceRoots': [],
        'config': fixed_config()}}
    third = {'id': 3, 'method': 'model/list', 'params': {'includeHidden': True}}
    controls = sum(len((json.dumps(frame, separators=(',', ':')) + '\n').encode())
                   for frame in (first, initialized, second, third))
    raw = b''.join((json.dumps(frame) + '\n').encode() for frame in (initialize(), thread(), models()))
    return {'version': 2, 'profile': 'fixed-appserver-noenv-metadata-v2', 'success': True, 'error': None,
            'argv': list(fixed_argv()),
            'freshHome': HOME, 'history': [
                {'event': 'queued', 'frame': first}, {'event': 'written', 'id': 1},
                {'event': 'received', 'frame': initialize()}, {'event': 'queued', 'frame': initialized},
                {'event': 'queued', 'frame': second}, {'event': 'written', 'id': None},
                {'event': 'written', 'id': 2}, {'event': 'received', 'frame': thread()},
                {'event': 'queued', 'frame': third}, {'event': 'written', 'id': 3},
                {'event': 'received', 'frame': models()}],
            'cleanupHistory': [{'event': 'stdin-eof', 'elapsedMs': 80}],
            'stdoutBase64': base64.b64encode(raw).decode(), 'stderrBase64': '',
            'outputBytesObserved': len(raw), 'outputComplete': True, 'streamEOF': {'stdout': True, 'stderr': True},
            'controlBytesQueued': controls, 'controlBytesWritten': controls,
            'directChild': {'pid': 123, 'pinned': True, 'reaped': True, 'exitCode': 0},
            'descendantCleanupVerifiedHere': False, 'elapsedMs': 100, 'metadataCompletedMs': 75.25,
            'threadProfileValidated': True, 'environmentRequestEmpty': True, 'runtimeRegistryValidated': False,
            'modelCalls': 0, 'credentialFilesRead': False, 'productionReady': False}


class ReplayTests(unittest.TestCase):
    def test_independent_complete_report_replays(self):
        self.assertTrue(p.validate_report(report_fixture()))

    def test_every_report_field_required(self):
        for key in report_fixture():
            report = report_fixture()
            del report[key]
            with self.subTest(key=key):
                self.assertFalse(p.validate_report(report))

    def test_success_boolean_does_not_replace_wire_or_cleanup_evidence(self):
        for key, value in (('history', []), ('cleanupHistory', []), ('runtimeRegistryValidated', True),
                           ('productionReady', True), ('modelCalls', False), ('success', 1),
                           ('outputComplete', 1), ('threadProfileValidated', 1),
                           ('error', 'failure'), ('freshHome', '/host/home')):
            report = report_fixture()
            report[key] = value
            self.assertFalse(p.validate_report(report))
        for key, value in (('pinned', 1), ('reaped', False), ('exitCode', False), ('pid', True)):
            report = report_fixture()
            report['directChild'][key] = value
            self.assertFalse(p.validate_report(report))

    def test_queued_requests_cannot_be_altered_or_numeric_boolean_substituted(self):
        for key in [key for key, value in fixed_config().items() if value is False]:
            for value in (True, 0):
                report = report_fixture()
                report['history'][4]['frame']['params']['config'][key] = value
                self.assertFalse(p.validate_report(report))
        for key, value in (('environments', [{'id': 'host'}]), ('allowProviderModelFallback', 0),
                           ('ephemeral', 1), ('dynamicTools', [{'name': 'unsafe'}])):
            report = report_fixture()
            report['history'][4]['frame']['params'][key] = value
            self.assertFalse(p.validate_report(report))
        report = report_fixture()
        report['history'][1]['id'] = True
        self.assertFalse(p.validate_report(report))

    def test_missing_or_reordered_events_and_duplicate_response_rejected(self):
        for index in range(len(report_fixture()['history'])):
            report = report_fixture()
            del report['history'][index]
            self.assertFalse(p.validate_report(report))
        report = report_fixture()
        report['history'][5], report['history'][6] = report['history'][6], report['history'][5]
        self.assertFalse(p.validate_report(report))
        report = report_fixture()
        report['history'].append(copy.deepcopy(report['history'][-1]))
        self.assertFalse(p.validate_report(report))

    def test_raw_stdout_and_byte_totals_must_match_replayed_frames(self):
        for key, value in (('stdoutBase64', base64.b64encode(b'{}\n').decode()), ('stderrBase64', '!invalid!'),
                           ('controlBytesWritten', 0), ('outputBytesObserved', 0), ('controlBytesQueued', True)):
            report = report_fixture()
            report[key] = value
            self.assertFalse(p.validate_report(report))

    def test_cleanup_trace_requires_real_term_grace(self):
        report = report_fixture()
        report['elapsedMs'] = 9000
        report['cleanupHistory'] += [{'event': 'term-sent', 'elapsedMs': 2500}, {'event': 'kill-sent', 'elapsedMs': 7500}]
        self.assertTrue(p.validate_report(report))
        report['cleanupHistory'][-1]['elapsedMs'] = 7499
        self.assertFalse(p.validate_report(report))
        report['cleanupHistory'] = [{'event': 'kill-sent', 'elapsedMs': 100}]
        self.assertFalse(p.validate_report(report))

    def test_missing_late_nonfinite_boolean_or_impossible_completion_fails(self):
        for value in (None, True, False, -0.1, 12000, 12000.1, float('inf'), float('-inf'), float('nan'), '100', 101):
            report = report_fixture()
            report['metadataCompletedMs'] = value
            with self.subTest(value=value):
                self.assertFalse(p.validate_report(report))
        report = report_fixture()
        del report['metadataCompletedMs']
        self.assertFalse(p.validate_report(report))
        report = report_fixture()
        report.update(elapsedMs=20000, metadataCompletedMs=12000)
        self.assertFalse(p.validate_report(report))
        report = report_fixture()
        report['elapsedMs'] = 22001
        self.assertFalse(p.validate_report(report))

    def test_completion_uses_post_receive_time_and_strict_twelve_second_boundary(self):
        # select began before deadline; response parse completes just after it.
        before_select_ms, after_receive_ms = 11999, 12000.01
        self.assertTrue(p.metadata_completion_allowed(before_select_ms))
        self.assertFalse(p.metadata_completion_allowed(after_receive_ms))
        self.assertTrue(p.metadata_completion_allowed(11999.999))
        self.assertFalse(p.metadata_completion_allowed(12000))
        report = report_fixture()
        report.update(elapsedMs=12000, metadataCompletedMs=11999.999)
        self.assertTrue(p.validate_report(report))


class DisabledStatusTests(unittest.TestCase):
    def frame(self):
        return {'method': 'remoteControl/status/changed', 'params': {
            'status': 'disabled', 'serverName': 'fixture-host',
            'installationId': '12345678-1234-1234-1234-123456789abc', 'environmentId': None},
            'emittedAtMs': 1789037221180}

    def test_only_disabled_status_after_initialize_without_new_request(self):
        protocol = p.Protocol(HOME)
        protocol.written(len(protocol.pending))
        protocol.receive(initialize())
        pending = bytes(protocol.pending)
        protocol.receive(self.frame())
        self.assertEqual(bytes(protocol.pending), pending)
        self.assertFalse(protocol.done)
        with self.assertRaises(p.ProbeError):
            protocol.receive(self.frame())

    def test_early_enabled_environment_and_malformed_metadata_rejected(self):
        with self.assertRaises(p.ProbeError):
            p.Protocol(HOME).receive(self.frame())
        for key, value in [('status', 'enabled'), ('environmentId', 'remote'),
                           ('serverName', ''), ('serverName', 'x' * 257), ('serverName', 'bad\nname'),
                           ('installationId', 'not-a-uuid')]:
            frame = self.frame()
            frame['params'][key] = value
            with self.subTest(key=key, value=value), self.assertRaises(p.ProbeError):
                ready_for_thread().receive(frame)
        for value in [True, -1, 1.5, 9007199254740992, '123']:
            frame = self.frame()
            frame['emittedAtMs'] = value
            with self.subTest(timestamp=value), self.assertRaises(p.ProbeError):
                ready_for_thread().receive(frame)
        frame = self.frame()
        frame['params']['extra'] = False
        with self.assertRaises(p.ProbeError):
            ready_for_thread().receive(frame)

    def test_optional_timestamp_and_thread_timestamp(self):
        frame = self.frame()
        del frame['emittedAtMs']
        ready_for_thread().receive(frame)
        ready_for_thread().receive({'method': 'thread/started', 'params': {}, 'emittedAtMs': 0})


class ProtocolTests(unittest.TestCase):
    def test_exact_fixed_wire_has_no_inference_account_auth_or_reactive_rpc(self):
        self.assertEqual(p.ARGV, fixed_argv())
        protocol = p.Protocol(HOME)
        first = json.loads(protocol.pending)
        self.assertEqual(first, {'id': 1, 'method': 'initialize', 'params': {
            'clientInfo': {'name': 'reality_compiler_probe', 'version': '1'},
            'capabilities': {'experimentalApi': True}}})
        protocol.written(len(protocol.pending))
        protocol.receive(initialize())
        frames = [json.loads(line) for line in protocol.pending.splitlines()]
        self.assertEqual(frames[0], {'method': 'initialized', 'params': {}})
        self.assertEqual(frames[1], {'id': 2, 'method': 'thread/start', 'params': {
            'model': 'gpt-5.6-sol', 'modelProvider': 'openai', 'allowProviderModelFallback': False,
            'cwd': '/work', 'approvalPolicy': 'never', 'sandbox': 'read-only', 'ephemeral': True,
            'environments': [], 'dynamicTools': [], 'selectedCapabilityRoots': [], 'runtimeWorkspaceRoots': [],
            'config': fixed_config()}})
        self.assertLess(protocol.control_queued, 4096)

    def test_success_preserves_complete_metadata_without_environments_claim(self):
        protocol = ready_for_thread()
        response = thread()
        response['result']['opaqueMetadata'] = {'nested': ['kept']}
        protocol.receive(response)
        self.assertFalse(protocol.done)
        protocol.written(len(protocol.pending))
        protocol.receive(models())
        self.assertTrue(protocol.done)
        self.assertEqual(protocol.responses[2], response['result'])
        self.assertNotIn('environments', protocol.responses[2])
        self.assertFalse(protocol.pending)

    def test_response_requires_complete_actual_request_write(self):
        protocol = p.Protocol(HOME)
        protocol.written(len(protocol.pending) - 1)
        with self.assertRaisesRegex(p.ProbeError, 'OUT_OF_ORDER'):
            protocol.receive(initialize())
        protocol.written(1)
        protocol.receive(initialize())
        with self.assertRaisesRegex(p.ProbeError, 'OUT_OF_ORDER'):
            protocol.receive(thread())

    def test_catalog_selection_requires_written_request_one_exact_model_and_no_cursor(self):
        protocol = ready_for_thread()
        protocol.receive(thread())
        self.assertFalse(protocol.done)
        self.assertEqual(json.loads(protocol.pending), {'id': 3, 'method': 'model/list', 'params': {'includeHidden': True}})
        with self.assertRaisesRegex(p.ProbeError, 'OUT_OF_ORDER'):
            protocol.receive(models())
        for field, value in [('data', []), ('data', [{'id': 'gpt-5.6-sol', 'model': 'other'}]),
                             ('data', models()['result']['data'] * 2), ('nextCursor', 'more')]:
            candidate = ready_for_thread()
            candidate.receive(thread())
            candidate.written(len(candidate.pending))
            response = models()
            response['result'][field] = value
            with self.subTest(field=field, value=value), self.assertRaisesRegex(p.ProbeError, 'MODEL_CATALOG'):
                candidate.receive(response)

    def test_partial_writes_across_initialized_and_thread_frame(self):
        protocol = p.Protocol(HOME)
        size = len(protocol.pending)
        for _ in range(size):
            protocol.written(1)
        protocol.receive(initialize())
        size += len(protocol.pending)
        while protocol.pending:
            protocol.written(min(7, len(protocol.pending)))
        protocol.receive(thread())
        self.assertEqual(protocol.control_written, size)
        self.assertEqual(protocol.delivered, {1, 2})

    def test_duplicate_wrong_order_boolean_and_string_ids_fail(self):
        for value in (True, '1', 0, 2):
            protocol = p.Protocol(HOME)
            protocol.written(len(protocol.pending))
            response = initialize()
            response['id'] = value
            with self.assertRaises(p.ProbeError):
                protocol.receive(response)
        protocol = ready_for_thread()
        with self.assertRaises(p.ProbeError):
            protocol.receive(initialize())
        protocol.receive(thread())
        with self.assertRaises(p.ProbeError):
            protocol.receive(thread())

    def test_server_error_is_archived_and_never_starts_next_request(self):
        protocol = p.Protocol(HOME)
        protocol.written(len(protocol.pending))
        response = {'id': 1, 'error': {'code': -32600, 'message': 'fixture error', 'data': {'details': [1]}}}
        with self.assertRaisesRegex(p.ProbeError, 'SERVER_ERROR'):
            protocol.receive(response)
        self.assertEqual(protocol.history[-1]['frame'], response)
        self.assertFalse(protocol.pending)
        self.assertFalse(protocol.done)

    def test_unsolicited_requests_and_unknown_execution_notifications_fail(self):
        frames = [{'id': 3, 'method': 'item/commandExecution/requestApproval', 'params': {}},
                  {'method': 'turn/started', 'params': {}}, {'method': 'item/started', 'params': {}},
                  {'method': 'new/unknown', 'params': {}}]
        for frame in frames:
            protocol = ready_for_thread()
            with self.assertRaises(p.ProbeError):
                protocol.receive(frame)
            self.assertFalse(protocol.pending)
            self.assertEqual(protocol.history[-1]['frame'], frame)

    def test_known_notification_is_opaque_bounded_and_not_reactive(self):
        protocol = ready_for_thread()
        frame = {'method': 'thread/started', 'params': {'thread': {'id': 'opaque'}, 'more': [1, 2]}}
        protocol.receive(frame)
        self.assertEqual(protocol.history[-1]['frame'], frame)
        self.assertFalse(protocol.pending)
        with self.assertRaisesRegex(p.ProbeError, 'NOTIFICATION_BEFORE'):
            p.Protocol(HOME).receive(frame)

    def test_init_platform_and_fresh_home_binding_required(self):
        for key, value in (('userAgent', ''), ('codexHome', '/other'), ('platformFamily', 'windows'), ('platformOs', 'other')):
            protocol = p.Protocol(HOME)
            protocol.written(len(protocol.pending))
            response = initialize()
            response['result'][key] = value
            with self.assertRaisesRegex(p.ProbeError, 'INITIALIZE_IDENTITY'):
                protocol.receive(response)

    def test_every_model_provider_effort_ephemeral_field_required_and_exact(self):
        for key, value in (('model', 'other'), ('modelProvider', 'other'), ('reasoningEffort', 'high'),
                           ('cwd', '/other'), ('approvalPolicy', 'on-request'), ('runtimeWorkspaceRoots', ['/work']),
                           ('sandbox', {'type': 'readOnly', 'networkAccess': True}),
                           ('sandbox', {'type': 'readOnly', 'networkAccess': 0})):
            protocol = ready_for_thread()
            response = thread()
            response['result'][key] = value
            with self.assertRaisesRegex(p.ProbeError, 'THREAD_PROFILE'):
                protocol.receive(response)
        for key, value in (('ephemeral', 1), ('ephemeral', False), ('path', '/persistent')):
            protocol = ready_for_thread()
            response = thread()
            response['result']['thread'][key] = value
            with self.assertRaisesRegex(p.ProbeError, 'THREAD_PROFILE'):
                protocol.receive(response)
        for key in thread()['result']:
            protocol = ready_for_thread()
            response = thread()
            del response['result'][key]
            with self.assertRaises(p.ProbeError):
                protocol.receive(response)

    def test_envelope_extras_and_jsonrpc_version_fail(self):
        for field in ('jsonrpc', 'error', 'extra'):
            protocol = p.Protocol(HOME)
            protocol.written(len(protocol.pending))
            response = initialize()
            response[field] = '2.0'
            with self.assertRaises(p.ProbeError):
                protocol.receive(response)


class CaptureTests(unittest.TestCase):
    def test_fragmented_utf8_jsonl_and_stderr_preserved_exactly(self):
        protocol = p.Protocol(HOME)
        protocol.written(len(protocol.pending))
        capture = p.Capture(protocol)
        response = initialize()
        response['result']['userAgent'] = 'fixture-č'
        raw = (json.dumps(response, ensure_ascii=False) + '\n').encode()
        for byte in raw:
            capture.feed('stdout', bytes([byte]))
        capture.feed('stderr', b'fixture diagnostic\n')
        self.assertEqual(capture.stdout, raw)
        self.assertEqual(capture.stderr, b'fixture diagnostic\n')
        self.assertEqual(protocol.responses[1], response['result'])

    def test_cumulative_stdout_stderr_limit_and_retention_bound(self):
        capture = p.Capture(p.Protocol(HOME))
        capture.feed('stderr', b'x' * (p.MAX_OUTPUT - 1))
        with self.assertRaisesRegex(p.ProbeError, 'OUTPUT_LIMIT'):
            capture.feed('stdout', b'{}', parse=False)
        self.assertEqual(capture.observed_bytes, p.MAX_OUTPUT + 1)
        self.assertEqual(len(capture.stdout) + len(capture.stderr), p.MAX_OUTPUT)

    def test_truncated_line_and_invalid_json_fail(self):
        for raw in (b'{\n', b'\xff\n', b'\n', b'{"a":1,"a":2}\n', b'{"a":NaN}\n'):
            capture = p.Capture(p.Protocol(HOME))
            with self.assertRaises(p.ProbeError):
                capture.feed('stdout', raw)
            self.assertEqual(capture.stdout, raw)
        capture = p.Capture(p.Protocol(HOME))
        capture.feed('stdout', b'{')
        with self.assertRaisesRegex(p.ProbeError, 'TRUNCATED'):
            capture.feed('stdout', b'')

    def test_no_parse_after_rejection_keeps_raw_evidence(self):
        capture = p.Capture(p.Protocol(HOME))
        capture.feed('stdout', b'not-json\n', parse=False)
        capture.feed('stdout', b'', parse=False)
        self.assertEqual(capture.stdout, b'not-json\n')
        self.assertTrue(capture.eof['stdout'])
        with self.assertRaisesRegex(p.ProbeError, 'AFTER_EOF'):
            capture.feed('stdout', b'x')


class CleanupTests(unittest.TestCase):
    def test_fixed_eof_term_kill_deadlines_and_no_duplicate_signals(self):
        cleanup = p.Cleanup(10)
        self.assertIsNone(cleanup.action(11.999, False))
        self.assertEqual(cleanup.action(12, False), 'term')
        self.assertIsNone(cleanup.action(16.999, False))
        self.assertEqual(cleanup.action(17, False), 'kill')
        self.assertIsNone(cleanup.action(17.999, False))
        self.assertEqual(cleanup.action(18, False), 'unknown')

    def test_reaped_child_never_signaled(self):
        for time in (0, 2, 7, 8, 100):
            self.assertEqual(p.Cleanup(0).action(time, True), 'done')

    def test_clock_jump_never_skips_term_or_shortens_actual_grace(self):
        cleanup = p.Cleanup(0)
        self.assertEqual(cleanup.action(7.5, False), 'term')
        self.assertIsNone(cleanup.action(8, False))
        self.assertIsNone(cleanup.action(12.499, False))
        self.assertEqual(cleanup.action(12.5, False), 'kill')
        self.assertIsNone(cleanup.action(13.499, False))
        self.assertEqual(cleanup.action(13.5, False), 'unknown')

    def test_delayed_signal_send_starts_grace_after_send_returns(self):
        cleanup = p.Cleanup(0)
        self.assertEqual(cleanup.action(2, False), 'term')
        cleanup.sent('term', 4)
        self.assertIsNone(cleanup.action(8.999, False))
        self.assertEqual(cleanup.action(9, False), 'kill')
        cleanup.sent('kill', 10)
        self.assertIsNone(cleanup.action(10.999, False))
        self.assertEqual(cleanup.action(11, False), 'unknown')

    def test_failed_pidfd_pin_reports_unknown_and_never_pid_kills(self):
        process = MagicMock()
        process.pid = 123
        process.poll.return_value = None
        with patch.object(p.sys, 'platform', 'linux'), patch.object(p.tempfile, 'mkdtemp', return_value=HOME), \
             patch.object(p.Path, 'mkdir'), patch.object(p.subprocess, 'Popen', return_value=process) as launch, \
             patch.object(p.os, 'pidfd_open', side_effect=OSError('pin-failure'), create=True), \
             patch.object(p.signal, 'pidfd_send_signal', create=True) as signal_child:
            report = p.run_fixed_bridge()
        self.assertFalse(report['success'])
        self.assertEqual(report['error'], 'pin-failure')
        self.assertEqual(report['directChild'], {'pid': 123, 'pinned': False, 'reaped': False, 'exitCode': None})
        signal_child.assert_not_called()
        process.kill.assert_not_called()
        process.wait.assert_not_called()
        self.assertEqual(launch.call_args.args[0], fixed_argv())
        self.assertEqual(launch.call_args.kwargs['env'], {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
                         'HOME': HOME, 'CODEX_HOME': HOME, 'TMPDIR': HOME + '/tmp'})
        self.assertFalse(report['runtimeRegistryValidated'])
        self.assertFalse(report['productionReady'])
        self.assertEqual(report['modelCalls'], 0)

    def test_nonlinux_rejected_before_directory_or_spawn(self):
        with patch.object(p.sys, 'platform', 'win32'), patch.object(p.tempfile, 'mkdtemp') as directory, \
             patch.object(p.subprocess, 'Popen') as launch:
            with self.assertRaisesRegex(p.ProbeError, 'CAPSULE_LINUX_REQUIRED'):
                p.run_fixed_bridge()
            directory.assert_not_called()
            launch.assert_not_called()


if __name__ == '__main__':
    unittest.main()
