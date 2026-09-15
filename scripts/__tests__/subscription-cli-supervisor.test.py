import importlib.util
from pathlib import Path
import sys
import unittest
import json
from unittest.mock import patch, Mock
from types import SimpleNamespace
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('supervisor', Path(__file__).parents[1] / 'subscription-cli-supervisor.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
measure_spec = importlib.util.spec_from_file_location('measure', Path(__file__).parents[1] / 'subscription-cli-supervisor.measure.py')
m = importlib.util.module_from_spec(measure_spec)
measure_spec.loader.exec_module(m)
class ContractTests(unittest.TestCase):
    def test_cgroup_worker_requires_exclusive_bootstrap_and_closes_all_nonstdio(self):
        s.require_launch_profile(s.CGROUP_MODE, None, cgroup_worker=True)
        for mode, identity, http, cli, selected in ((s.CGROUP_MODE,None,False,False,False),
                ('version',None,False,False,True),(s.CGROUP_MODE,None,False,True,True),
                (s.CGROUP_MODE,self.ingress_identity(),False,False,True),
                (s.CGROUP_MODE,None,True,False,True),(s.CGROUP_MODE,None,False,False,1)):
            with self.subTest(mode=mode,identity=identity,http=http,cli=cli,selected=selected), self.assertRaises(ValueError):
                s.require_launch_profile(mode,identity,http,cli,selected)
        with patch.object(s.os,'closerange') as close, patch.object(s,'inspect_ingress_fd') as inspect:
            self.assertEqual(s.prepare_reexec(None,cgroup_worker=True),['--inside-trusted-cgroup-worker-boundary'])
            close.assert_called_once_with(3,65536); inspect.assert_not_called()
        with patch.object(s.os,'closerange') as close:
            for args in ((None,False,True,True),(self.ingress_identity(),False,False,True),(None,False,False,1)):
                with self.assertRaises(ValueError): s.prepare_reexec(*args)
            close.assert_not_called()

    def test_cgroup_worker_ten_hashes_and_fixed_child_forbid_control_import(self):
        frame={'type':'start','mode':s.CGROUP_MODE,'helperSha256':dict.fromkeys(s.CGROUP_FILES,'a'*64)}
        self.assertEqual(len(frame['helperSha256']),10)
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()),frame)
        for delta in ({'nonce':'a'*32},{'scenario':'normal'},{'argv':['/sys/fs/cgroup']},{'helperSha256':{}},{'fd':198}):
            with self.subTest(delta=delta),self.assertRaises(ValueError): s.parse_frame(json.dumps({**frame,**delta}).encode())
        self.assertEqual(s.fixed_command(s.CGROUP_MODE),['/usr/bin/python3','-I','-S','/usr/bin/trusted-cgroup-worker-child.py'])
        with self.assertRaises(ValueError): s.fixed_command(s.CGROUP_MODE,'normal')

    def test_cli_proxy_refusal_requires_exclusive_bootstrap_without_ingress(self):
        s.require_launch_profile(s.CLI_PROXY_MODE, None, cli_proxy_refusal=True)
        for mode, identity, http, selected in ((s.CLI_PROXY_MODE,None,False,False),
                ('version',None,False,True), (s.CLI_PROXY_MODE,self.ingress_identity(),False,True),
                (s.CLI_PROXY_MODE,self.ingress_identity(),True,True), (s.CLI_PROXY_MODE,None,False,1)):
            with self.subTest(mode=mode, identity=identity, selected=selected), self.assertRaises(ValueError):
                s.require_launch_profile(mode, identity, http, selected)

    def test_cli_proxy_reexec_drops_all_nonstdio_fds(self):
        with patch.object(s.os, 'closerange') as close, patch.object(s, 'inspect_ingress_fd') as inspect:
            self.assertEqual(s.prepare_reexec(None, cli_proxy_refusal=True), ['--inside-cli-proxy-refusal'])
        close.assert_called_once_with(3,65536); inspect.assert_not_called()
        with self.assertRaises(ValueError): s.prepare_reexec(self.ingress_identity(), cli_proxy_refusal=True)

    def test_cli_proxy_fixed_ten_helpers_forbid_nonce_or_scenario(self):
        frame = {'type':'start','mode':s.CLI_PROXY_MODE,'helperSha256':dict.fromkeys(s.CLI_PROXY_FILES,'a'*64)}
        self.assertEqual(len(frame['helperSha256']),10)
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()),frame)
        for change in ({'nonce':'a'*32},{'scenario':'normal'},{'argv':['login']},{'helperSha256':{}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame,**change}).encode())
        self.assertEqual(s.fixed_command(s.CLI_PROXY_MODE), ['/usr/bin/python3','-I','-S','/usr/bin/cli-proxy-refusal-child.py'])
        with self.assertRaises(ValueError): s.fixed_command(s.CLI_PROXY_MODE,'normal')

    @staticmethod
    def ingress_identity():
        return {'dev': 1, 'ino': 12, 'type': 49152, 'family': 1, 'socketType': 1}
    def test_ingress_mode_never_uses_default_launch_and_forbids_other_modes(self):
        s.require_launch_profile(s.INGRESS_MODE, self.ingress_identity())
        with self.assertRaises(ValueError): s.require_launch_profile(s.INGRESS_MODE, None)
        for mode in s.MODES:
            if mode in (s.INGRESS_MODE, s.HTTP_INGRESS_MODE, s.CLI_PROXY_MODE, s.TRUSTED_CLI_MODE, s.CGROUP_MODE, *s.STRESS_MODES): continue
            s.require_launch_profile(mode, None)
            with self.assertRaises(ValueError): s.require_launch_profile(mode, self.ingress_identity())
    def test_http_ingress_is_a_distinct_explicit_launch_profile(self):
        identity = self.ingress_identity()
        s.require_launch_profile(s.HTTP_INGRESS_MODE, identity, True)
        for mode, value, selected in ((s.HTTP_INGRESS_MODE, identity, False), (s.INGRESS_MODE, identity, True),
                (s.HTTP_INGRESS_MODE, None, True), ('version', identity, True), ('version', None, True)):
            with self.subTest(mode=mode, selected=selected), self.assertRaises(ValueError):
                s.require_launch_profile(mode, value, selected)
        with patch.object(s, 'inspect_ingress_fd') as inspect, patch.object(s.os, 'closerange') as close, patch.object(s.os, 'set_inheritable'):
            flags = s.prepare_reexec(identity, True)
            self.assertEqual(flags[0], '--inside-trusted-http-ingress-fd')
            inspect.assert_called_once_with(identity)
            self.assertEqual([call.args for call in close.call_args_list], [(3, 198), (199, 65536)])
        with patch.object(s.os, 'closerange') as close:
            with self.assertRaises(ValueError): s.prepare_reexec(None, True)
            close.assert_not_called()
    def test_http_start_requires_fourteen_hashes_and_cannot_select_old_image(self):
        frame = {'type': 'start', 'mode': s.HTTP_INGRESS_MODE, 'nonce': 'a' * 32,
                 'helperSha256': {name: 'b' * 64 for name in s.HTTP_INGRESS_FILES}}
        self.assertEqual(len(frame['helperSha256']), 14)
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'mode': s.INGRESS_MODE}, {'helperSha256': {name: 'b' * 64 for name in s.INGRESS_FILES}},
                {'scenario': 'normal'}, {'fd': 198}, {'nonce': True}, {'argv': ['login']}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **change}).encode())
        self.assertEqual(s.fixed_command(s.HTTP_INGRESS_MODE), ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-http-ingress-child.py'])
        self.assertNotIn(s.HTTP_INGRESS_MODE, s.INTERACTIVE_MODES)
        with self.assertRaises(ValueError): s.fixed_command(s.HTTP_INGRESS_MODE, 'normal')
    def test_ingress_start_is_ten_hashes_and_one_bounded_nonce_only(self):
        frame = {'type': 'start', 'mode': s.INGRESS_MODE, 'nonce': 'a' * 32,
                 'helperSha256': {name: 'b' * 64 for name in s.INGRESS_FILES}}
        self.assertEqual(len(frame['helperSha256']), 10)
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for extra in ({'nonce': 'x' * 32}, {'nonce': 'a' * 33}, {'fd': 198}, {'socket': self.ingress_identity()},
                      {'helperSha256': {}}, {'scenario': 'normal'}, {'argv': ['login']}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **extra}).encode())
        self.assertEqual(s.fixed_command(s.INGRESS_MODE), ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-ingress-child.py'])
        self.assertNotIn(s.INGRESS_MODE, s.INTERACTIVE_MODES)
    def test_ingress_packet_preserves_actual_outer_facts_and_socket_role(self):
        raw = s.ingress_startup_packet(self.control_boundary(), self.ingress_identity(), 'a' * 32)
        self.assertLessEqual(len(raw), 4096)
        packet = json.loads(raw)
        self.assertEqual(packet.pop('ingress'), {'fd': 198, 'socket': self.ingress_identity(), 'nonce': 'a' * 32})
        self.assertEqual(packet, json.loads(s.trusted_control_startup_packet(self.control_boundary())))
        with self.assertRaises(ValueError): s.ingress_startup_packet(self.control_boundary(), {}, 'a' * 32)
    def test_reexec_old_profile_closes_every_nonstdio_descriptor(self):
        with patch.object(s.os, 'closerange') as close, patch.object(s.os, 'set_inheritable') as inherit:
            self.assertEqual(s.prepare_reexec(None), ['--inside'])
            close.assert_called_once_with(3, 65536)
            inherit.assert_not_called()
    def test_reexec_only_preserves_verified_fixed_slot(self):
        with patch.object(s, 'inspect_ingress_fd') as inspect, patch.object(s.os, 'closerange') as close, \
                patch.object(s.os, 'set_inheritable') as inherit:
            flags = s.prepare_reexec(self.ingress_identity())
            inspect.assert_called_once_with(self.ingress_identity())
            self.assertEqual([call.args for call in close.call_args_list], [(3, 198), (199, 65536)])
            inherit.assert_called_once_with(198, True)
            self.assertEqual(flags[0], '--inside-trusted-ingress-fd')
            self.assertEqual(json.loads(flags[1]), self.ingress_identity())
        with patch.object(s, 'inspect_ingress_fd', side_effect=ValueError('drift')), patch.object(s.os, 'closerange') as close:
            with self.assertRaises(ValueError): s.prepare_reexec(self.ingress_identity())
            close.assert_not_called()
    def test_ingress_inspection_detaches_owned_connected_unix_stream(self):
        endpoint = Mock(family=1)
        endpoint.getsockopt.side_effect = lambda level, option: 1 if option == s.socket.SO_TYPE else 0
        info = SimpleNamespace(st_mode=49152, st_dev=1, st_ino=12)
        with patch.object(s.os, 'fstat', return_value=info), patch.object(s.socket, 'socket', return_value=endpoint):
            self.assertEqual(s.inspect_ingress_fd(self.ingress_identity()), self.ingress_identity())
            endpoint.getpeername.assert_called_once()
            endpoint.detach.assert_called_once()
            endpoint.close.assert_not_called()
    def test_ingress_inspection_refuses_non_socket_listener_unconnected_and_drift(self):
        info = SimpleNamespace(st_mode=49152, st_dev=1, st_ino=12)
        for case in ('regular', 'family', 'datagram', 'listener', 'unconnected', 'drift'):
            endpoint = Mock(family=2 if case == 'family' else 1)
            endpoint.getsockopt.side_effect = lambda level, option: (2 if case == 'datagram' else 1) if option == s.socket.SO_TYPE else int(case == 'listener')
            if case == 'unconnected': endpoint.getpeername.side_effect = OSError('not connected')
            actual = SimpleNamespace(st_mode=32768, st_dev=1, st_ino=12) if case == 'regular' else info
            expected = {**self.ingress_identity(), 'ino': 13} if case == 'drift' else self.ingress_identity()
            with self.subTest(case=case), patch.object(s.os, 'fstat', return_value=actual), \
                    patch.object(s.socket, 'socket', return_value=endpoint) as wrap:
                with self.assertRaises((ValueError, OSError)): s.inspect_ingress_fd(expected)
                if case == 'regular': wrap.assert_not_called()
                else: endpoint.detach.assert_called_once()
    def test_ingress_close_never_closes_a_reused_foreign_descriptor(self):
        with patch.object(s.os, 'fstat', return_value=SimpleNamespace(st_mode=49152, st_dev=1, st_ino=13)), \
                patch.object(s.os, 'close') as close:
            with self.assertRaises(ValueError): s.close_ingress_fd(self.ingress_identity())
            close.assert_not_called()
    def test_controlled_bootstrap_keeps_distinct_fixed_entry(self):
        mode = 'exec-environment-bootstrap-controlled'
        self.assertEqual(s.fixed_command(mode), ['/usr/bin/python3', '-I', '-S',
            '/usr/bin/exec-environment-metadata-parent.py', '--bootstrap-controlled-cleanup'])
        self.assertNotIn(mode, s.INTERACTIVE_MODES)
        frame = {'type': 'start', 'mode': mode, 'helperSha256': {n: 'a' * 64 for n in s.ENVIRONMENT_FILES}}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
    def test_trusted_control_only_accepts_eight_helpers_and_no_caller_packet(self):
        self.assertEqual(len(s.TRUSTED_CONTROL_FILES), 8)
        self.assertEqual(s.fixed_command(s.TRUSTED_CONTROL_MODE), ['/usr/bin/python3', '-I', '-S',
            '/usr/bin/trusted-control-boundary-parent.py'])
        self.assertNotIn(s.TRUSTED_CONTROL_MODE, s.INTERACTIVE_MODES)
        frame = {'type': 'start', 'mode': s.TRUSTED_CONTROL_MODE,
                 'helperSha256': {n: 'a' * 64 for n in s.TRUSTED_CONTROL_FILES}}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for extra in ({'packet': {}}, {'argv': []}, {'scenario': 'normal'}, {'helperSha256': {}}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **extra}).encode())
    def test_trusted_startup_packet_is_bounded_and_fixed(self):
        boundary = self.control_boundary()
        raw = s.trusted_control_startup_packet(boundary)
        self.assertLessEqual(len(raw), 4096)
        self.assertEqual(json.loads(raw), {'version': 1, 'sourceOfOuter': 'supervisor-fixed-startup-pipe',
            'namespaces': {'trustedPid': 'pid:[123]', 'trustedMount': 'mnt:[456]'},
            'protectedDescriptors': {'outerSupervisorControl': boundary['control'], 'outerSupervisorOutput': boundary['output']}})
    @staticmethod
    def control_boundary():
        return {'namespace': 'pid:[123]', 'mountNamespace': 'mnt:[456]',
                'control': {'dev': 1, 'ino': 2, 'type': 4096}, 'output': {'dev': 1, 'ino': 3, 'type': 4096}}
    def test_trusted_startup_rejects_invalid_or_aliased_facts(self):
        for extra in ({'namespace': 'pid:[0]'}, {'mountNamespace': 'pid:[1]'},
                      {'control': {'dev': True, 'ino': 2, 'type': 4096}},
                      {'control': {'dev': 1, 'ino': 2, 'type': 32768}},
                      {'control': self.control_boundary()['output']}):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                s.trusted_control_startup_packet({**self.control_boundary(), **extra})
    def test_trusted_startup_requires_pinning_and_closes_after_full_write(self):
        process = SimpleNamespace(pid=3, stdin=Mock())
        process.stdin.fileno.return_value = 9
        with patch.object(s.os, 'write', side_effect=lambda fd, raw: len(raw)) as write:
            with self.assertRaises(ValueError): s.write_trusted_control_startup(process, {}, self.control_boundary())
            write.assert_not_called()
            s.write_trusted_control_startup(process, {3: 10}, self.control_boundary())
            self.assertEqual(write.call_count, 1)
            process.stdin.close.assert_called_once()
    def test_trusted_startup_does_not_retry_partial_or_blocked_writes(self):
        for failure in (1, BlockingIOError(), BrokenPipeError()):
            process = SimpleNamespace(pid=3, stdin=Mock())
            with patch.object(s.os, 'write', side_effect=failure if isinstance(failure, Exception) else None,
                              return_value=failure) as write:
                with self.assertRaises((OSError, RuntimeError)):
                    s.write_trusted_control_startup(process, {3: 10}, self.control_boundary())
                write.assert_called_once()
                process.stdin.close.assert_called_once()
    def setUp(self):
        patcher = patch.object(s.os, "WNOHANG", 1, create=True)
        patcher.start()
        self.addCleanup(patcher.stop)
    def test_transcript_mismatch_is_explicit(self):
        frames = [{'type': 'child_output', 'encoding': 'base64', 'stream': 'stdout', 'data': 'YQ=='}]
        terminal = {'outputComplete': True, 'outputBytes': 2, 'observedOutputSha256': '0' * 64}
        self.assertFalse(m.transcript_check(frames, terminal)['transcriptIntegrity'])
    def test_transcript_hash_and_size_must_both_match(self):
        frames = [{'type': 'child_output', 'encoding': 'base64', 'stream': 'stdout', 'data': 'YQ=='}]
        terminal = {'outputComplete': True, 'outputBytes': 1, 'observedOutputSha256': m.hashlib.sha256(b'a').hexdigest()}
        self.assertTrue(m.transcript_check(frames, terminal)['transcriptIntegrity'])
        terminal['outputComplete'] = False
        self.assertFalse(m.transcript_check(frames, terminal)['transcriptIntegrity'])
    def test_missing_terminal_never_passes(self):
        self.assertFalse(m.evaluate('version', {'terminal': None}))
    def test_cleanup_is_not_successful_version(self):
        report = {'terminal': {'cleanup': {'verified': True}, 'outputComplete': True, 'productionReady': False,
                              'modelCalls': 0, 'reason': 'EXITED', 'exitCode': 7},
                  'sourceSha256Before': {}, 'sourceSha256After': {}, 'errors': [], 'driverTimeout': False, 'exitCode': 0, 'transcriptIntegrity': True}
        self.assertFalse(m.evaluate('version', report))
    def test_changed_source_never_passes(self):
        self.assertFalse(m.evaluate('version', {'terminal': {'x': True}, 'sourceSha256Before': {'x': 'a'},
                                              'sourceSha256After': {'x': 'b'}}))
    def test_early_deadline_is_not_measured_as_180_seconds(self):
        report = {'terminal': {'cleanup': {'verified': True}, 'outputComplete': True, 'productionReady': False,
                              'modelCalls': 0, 'reason': 'JOB_DEADLINE', 'exitCode': -15, 'elapsedMs': 179999},
                  'sourceSha256Before': {}, 'sourceSha256After': {}, 'errors': [], 'driverTimeout': False, 'exitCode': 0, 'transcriptIntegrity': True}
        self.assertFalse(m.evaluate('deadline', report))
    def test_unknown_measure_scenario_rejected_before_spawn(self):
        with patch.object(m.subprocess, 'Popen') as spawn, self.assertRaises(ValueError):
            m.measure('exec')
        spawn.assert_not_called()
    def test_fixed_limits(self):
        self.assertEqual((s.JOB_SECONDS, s.COMMAND_SECONDS, s.TERM_GRACE_SECONDS, s.MAX_OUTPUT), (180, 200, 5, 8388608))
    def test_runtime_aliases_require_real_readonly_same_tree(self):
        info = SimpleNamespace(st_mode=0o040755, st_dev=1, st_ino=2)
        with patch.object(s.os, 'lstat', return_value=info), patch.object(s.os, 'stat', return_value=info), \
                patch.object(s.os, 'statvfs', return_value=SimpleNamespace(f_flag=1), create=True), \
                patch.object(s.os, 'ST_RDONLY', 1, create=True):
            s.validate_runtime_aliases()
    def test_runtime_alias_rejects_symlink_different_tree_and_writable_mount(self):
        source = SimpleNamespace(st_mode=0o040755, st_dev=1, st_ino=2)
        for mode, dev, ino, flags in ((0o120777, 1, 2, 1), (0o040755, 2, 2, 1),
                                      (0o040755, 1, 3, 1), (0o040755, 1, 2, 0)):
            with self.subTest(mode=mode, dev=dev, ino=ino, flags=flags), \
                    patch.object(s.os, 'lstat', return_value=SimpleNamespace(st_mode=mode, st_dev=dev, st_ino=ino)), \
                    patch.object(s.os, 'stat', return_value=source), \
                    patch.object(s.os, 'statvfs', return_value=SimpleNamespace(f_flag=flags), create=True), \
                    patch.object(s.os, 'ST_RDONLY', 1, create=True), self.assertRaises(ValueError):
                s.validate_runtime_aliases()
    def test_runtime_alias_metadata_denial_stops_admission(self):
        with patch.object(s.os, 'lstat', side_effect=PermissionError('denied')), self.assertRaises(PermissionError):
            s.validate_runtime_aliases()
    def test_exec_worker_direct_entry_is_fixed_and_separate_from_cli_sandbox(self):
        self.assertEqual(s.fixed_command('exec-server-worker'), [
            '/usr/bin/python3', '-I', '-S', '/usr/bin/exec-server-worker-gate.py', '--inside'])
        self.assertEqual(s.fixed_command('version'), ['/usr/bin/codex', '--version'])
        with self.assertRaises(ValueError):
            s.fixed_arguments('exec-server-worker')
        with self.assertRaises(ValueError):
            s.fixed_command('exec-server-worker', 'normal')
    def test_exec_worker_start_requires_all_six_fixed_helpers(self):
        self.assertEqual(len(s.EXEC_WORKER_FILES), 6)
        frame = {'type': 'start', 'mode': 'exec-server-worker',
                 'helperSha256': {name: 'a' * 64 for name in s.EXEC_WORKER_FILES}}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'helperSha256': {}}, {'scenario': 'normal'}, {'argv': []},
                       {'helperSha256': {**frame['helperSha256'], 'extra': 'a' * 64}},
                       {'helperSha256': {**frame['helperSha256'], 'subscription-exec-worker-probe.py': 'g' * 64}}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **change}).encode())
        self.assertTrue(s.deliver_crossing_chunk('exec-server-worker', s.MAX_OUTPUT + 1, False))
    def test_environment_parent_is_fixed_noninteractive_seven_helper_entry(self):
        self.assertEqual(s.fixed_command('exec-environment-metadata'), [
            '/usr/bin/python3', '-I', '-S', '/usr/bin/exec-environment-metadata-parent.py'])
        self.assertNotIn('exec-environment-metadata', s.INTERACTIVE_MODES)
        self.assertEqual(len(s.ENVIRONMENT_FILES), 7)
        frame = {'type': 'start', 'mode': 'exec-environment-metadata',
                 'helperSha256': {name: 'a' * 64 for name in s.ENVIRONMENT_FILES}}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'scenario': 'normal'}, {'helperSha256': {}}, {'argv': ['login']}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **change}).encode())
        with self.assertRaises(ValueError):
            s.fixed_command('exec-environment-metadata', 'normal')
    def test_bootstrap_parent_is_distinct_literal_noninteractive_entry(self):
        mode = 'exec-environment-bootstrap-metadata'
        self.assertEqual(s.fixed_command(mode), ['/usr/bin/python3', '-I', '-S',
                         '/usr/bin/exec-environment-metadata-parent.py', '--bootstrap-metadata'])
        self.assertNotIn(mode, s.INTERACTIVE_MODES)
        frame = {'type': 'start', 'mode': mode, 'helperSha256': {name: 'a' * 64 for name in s.ENVIRONMENT_FILES}}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'scenario': 'normal'}, {'helperSha256': {}}, {'argv': ['login']}, {'path': '/root'}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **change}).encode())
        with self.assertRaises(ValueError): s.fixed_command(mode, 'normal')
    def test_fixture_crossing_policy_shared_by_normal_and_final_drain(self):
        self.assertTrue(s.deliver_crossing_chunk('appserver-fixture', s.MAX_OUTPUT + 1, False))
        self.assertFalse(s.deliver_crossing_chunk('appserver-fixture', s.MAX_OUTPUT, False))
        self.assertFalse(s.deliver_crossing_chunk('appserver-fixture', s.MAX_OUTPUT + 1, True))
        for mode in s.MODES:
            if mode not in s.INTERACTIVE_MODES:
                self.assertFalse(s.deliver_crossing_chunk(mode, s.MAX_OUTPUT + 1, False))
        self.assertTrue(s.deliver_crossing_chunk('appserver-metadata-pipe', s.MAX_OUTPUT + 1, False))
    def test_fixture_start_requires_helper_and_fixed_scenario(self):
        frame = {'type': 'start', 'mode': 'appserver-fixture', 'scenario': 'normal',
                 'helperSha256': {'subscription-appserver-fixture-child.py': 'a' * 64,
                                  'subscription-worker-lockdown.py': 'b' * 64}}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'scenario': 'exec'}, {'argv': ['login']}, {'helperSha256': {}}, {'scenario': []}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **change}).encode())
        self.assertEqual(s.fixed_arguments('appserver-fixture', 'cancel')[-2:], ['/usr/bin/appserver-fixture-child.py', 'cancel'])
        with self.assertRaises(ValueError):
            s.fixed_arguments('appserver-fixture', 'login')
    def test_fixture_requires_exact_lockdown_helper_key_and_digest(self):
        self.assertEqual(s.FIXTURE_FILES, {
            'subscription-appserver-fixture-child.py': '/usr/bin/appserver-fixture-child.py',
            'subscription-worker-lockdown.py': '/usr/bin/worker-lockdown.py'})
        frame = {'type': 'start', 'mode': 'appserver-fixture', 'scenario': 'normal',
                 'helperSha256': {name: 'a' * 64 for name in s.FIXTURE_FILES}}
        for helpers in [
            {'subscription-appserver-fixture-child.py': 'a' * 64},
            {**frame['helperSha256'], '/tmp/worker-lockdown.py': 'a' * 64},
            {**frame['helperSha256'], 'subscription-worker-lockdown.py': None},
            {**frame['helperSha256'], 'subscription-worker-lockdown.py': 'g' * 64},
            {**frame['helperSha256'], 'subscription-worker-lockdown.py': 'a' * 63},
        ]:
            with self.subTest(helpers=helpers), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, 'helperSha256': helpers}).encode())
    def test_fixture_input_is_canonical_bounded_and_sequenced(self):
        import base64
        frame = {'type': 'fixture_input', 'seq': 1, 'data': base64.b64encode(b'x' * 2048).decode()}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'seq': True}, {'seq': 0}, {'seq': 2049}, {'data': ''}, {'data': 'YQ='},
                       {'data': base64.b64encode(b'x' * 2049).decode()}, {'argv': []}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                s.parse_frame(json.dumps({**frame, **change}).encode())
    def test_fixture_relay_ack_waits_for_complete_actual_write(self):
        relay = s.FixtureInput()
        relay.accept({'seq': 1, 'data': 'YWJj'})
        with patch.object(s.os, 'write', side_effect=[BlockingIOError(), 1, 2]):
            self.assertIsNone(relay.drain(123))
            self.assertEqual(relay.pending, b'abc')
            self.assertIsNone(relay.drain(123))
            self.assertEqual(relay.pending, b'bc')
            self.assertEqual(relay.drain(123), 1)
        self.assertIsNone(relay.drain(123))
    def test_fixture_relay_bounds_pending_cumulative_and_sequence(self):
        relay = s.FixtureInput()
        relay.accept({'seq': 1, 'data': 'YQ=='})
        with self.assertRaises(ValueError):
            relay.accept({'seq': 2, 'data': 'Yg=='})
        with patch.object(s.os, 'write', return_value=1):
            relay.drain(123)
        with self.assertRaises(ValueError):
            relay.accept({'seq': 1, 'data': 'Yg=='})
        relay.total = 2 * 1024 * 1024
        with self.assertRaises(ValueError):
            relay.accept({'seq': 2, 'data': 'Yg=='})
        self.assertEqual(relay.pending, b'')
    def test_control_rejects_command_and_overrides(self):
        for raw in [b'{"type":"start","mode":"version","argv":["exec"]}', b'{"type":"start","mode":"exec"}', b'{"type":"heartbeat","jobMs":1}', b'[]', b'null']:
            with self.subTest(raw=raw), self.assertRaises(ValueError): s.parse_frame(raw)
    def test_fault_modes_are_fixed(self):
        self.assertEqual(s.fixed_arguments('stopped-cli')[-1], 'sleep')
        self.assertEqual(s.fixed_arguments('paced-output')[-1], 'paced-output')
        with self.assertRaises(ValueError):
            s.parse_frame(b'{"type":"start","mode":"stopped-cli","pid":42}')
    def test_stopped_cli_requires_actual_kill_and_five_seconds(self):
        terminal = {'cleanup': {'verified': True, 'killSent': True}, 'outputComplete': True,
                    'productionReady': False, 'modelCalls': 0, 'reason': 'CANCELLED', 'exitCode': -9,
                    'fixture': {'kind': 'owned-cli-stopped', 'state': 'T', 'signal': 'SIGSTOP', 'executable': '/usr/bin/codex'},
                    'terminationElapsedMs': 5000}
        report = {'terminal': terminal, 'sourceSha256Before': {}, 'sourceSha256After': {}, 'errors': [],
                  'driverTimeout': False, 'exitCode': 0, 'transcriptIntegrity': True,
                  'frames': [{'type': 'ready', 'utsBoundary': {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[123]'}}]}
        self.assertTrue(m.evaluate('stopped-cli', report))
        terminal['terminationElapsedMs'] = 4999
        self.assertFalse(m.evaluate('stopped-cli', report))
        terminal['terminationElapsedMs'] = 5000
        terminal['exitCode'] = -15
        self.assertFalse(m.evaluate('stopped-cli', report))
    def test_paced_output_needs_cap_crossing_and_bounded_persistence(self):
        terminal = {'cleanup': {'verified': True}, 'outputComplete': True, 'productionReady': False,
                    'modelCalls': 0, 'reason': 'OUTPUT_LIMIT', 'exitCode': -15,
                    'outputLimitExceeded': True, 'outputBytes': 8388609}
        report = {'terminal': terminal, 'sourceSha256Before': {}, 'sourceSha256After': {}, 'errors': [],
                  'driverTimeout': False, 'exitCode': 1, 'transcriptIntegrity': False, 'receivedOutputBytes': 8388608,
                  'frames': [{'type': 'ready', 'utsBoundary': {'hostname': 'reality-compiler-probe', 'namespace': 'uts:[123]'}}]}
        self.assertTrue(m.evaluate('paced-output', report))
        report['receivedOutputBytes'] = 8388609
        self.assertFalse(m.evaluate('paced-output', report))
        report['receivedOutputBytes'] = 8388608
        terminal['reason'] = 'OUTPUT_BACKPRESSURE'
        self.assertFalse(m.evaluate('paced-output', report))
    def test_frame_limit(self):
        with self.assertRaises(ValueError): s.parse_frame(b'x' * (s.MAX_FRAME + 1))
    def test_fixed_control(self):
        for mode in s.MODES:
            frame = {'type': 'start', 'mode': mode}
            if mode == 'worker-boundary':
                frame['helperSha256'] = {name: 'a' * 64 for name in s.WORKER_FILES}
            if mode == 'appserver-noenv':
                frame['helperSha256'] = {name: 'a' * 64 for name in s.APPSERVER_FILES}
            if mode == 'appserver-metadata-pipe':
                frame['helperSha256'] = {name: 'a' * 64 for name in s.METADATA_PIPE_FILES}
            if mode == 'exec-server-worker':
                frame['helperSha256'] = {name: 'a' * 64 for name in s.EXEC_WORKER_FILES}
            if mode == s.TRUSTED_CONTROL_MODE:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.TRUSTED_CONTROL_FILES}
            if mode == s.INGRESS_MODE:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.INGRESS_FILES}
                frame['nonce'] = 'a' * 32
            if mode == s.HTTP_INGRESS_MODE:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.HTTP_INGRESS_FILES}
                frame['nonce'] = 'a' * 32
            if mode in s.ENVIRONMENT_MODES:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.ENVIRONMENT_FILES}
            if mode == s.CLI_PROXY_MODE:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.CLI_PROXY_FILES}
            if mode == s.TRUSTED_CLI_MODE:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.TRUSTED_CLI_FILES}
            if mode == s.CGROUP_MODE:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.CGROUP_FILES}
            if mode in s.STRESS_MODES:
                frame['helperSha256'] = {name: 'a' * 64 for name in s.STRESS_FILES}
            if mode == 'appserver-fixture':
                frame['helperSha256'] = {name: 'a' * 64 for name in s.FIXTURE_FILES}
                frame['scenario'] = 'normal'
            self.assertEqual(s.parse_frame(json.dumps(frame).encode())['mode'], mode)
        self.assertEqual(s.parse_frame(b'{"type":"cancel"}'), {'type': 'cancel'})
    def test_worker_start_requires_frozen_helper_identity(self):
        before = {'scripts/' + name: 'a' * 64 for name in s.WORKER_FILES}
        ready = {'workerBoundary': {'helperSha256': {name: 'a' * 64 for name in s.WORKER_FILES}}}
        frame = m.worker_start(ready, before)
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        with self.assertRaises(ValueError): s.parse_frame(b'{"type":"start","mode":"worker-boundary"}')
        ready['workerBoundary']['helperSha256']['subscription-worker-lockdown.py'] = 'b' * 64
        with self.assertRaises(ValueError): m.worker_start(ready, before)
        with self.assertRaises(ValueError): m.worker_start(ready, {})
    def test_appserver_start_is_fixed_and_image_bound(self):
        name = 'subscription-appserver-noenv.py'
        before = {'scripts/' + key: 'a' * 64 for key in s.APPSERVER_FILES}
        ready = {'appServerBoundary': {'helperSha256': {key: 'a' * 64 for key in s.APPSERVER_FILES}}}
        frame = m.appserver_start(ready, before)
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        self.assertEqual(s.fixed_arguments('appserver-noenv'), ['sandbox', '--permission-profile', 'appserver-metadata', '--',
            '/usr/bin/python3', '-I', '-S', '/usr/bin/appserver-noenv.py'])
        with self.assertRaises(ValueError): s.parse_frame(b'{"type":"start","mode":"appserver-noenv"}')
        ready['appServerBoundary']['helperSha256'][name] = 'b' * 64
        with self.assertRaises(ValueError): m.appserver_start(ready, before)
    def test_metadata_pipe_start_binds_four_readonly_helpers_without_scenario_or_argv(self):
        helpers = {key: 'a' * 64 for key in s.METADATA_PIPE_FILES}
        self.assertEqual(set(helpers), {'subscription-appserver-metadata-pipe-child.py',
            'subscription-appserver-noenv.py', 'subscription-worker-lockdown.py', 'subscription-text-model-catalog.json'})
        frame = {'type': 'start', 'mode': 'appserver-metadata-pipe', 'helperSha256': helpers}
        self.assertEqual(s.parse_frame(json.dumps(frame).encode()), frame)
        for change in ({'scenario': 'normal'}, {'argv': ['--version']}, {'helperSha256': {}},
                       {'helperSha256': {**helpers, 'subscription-worker-lockdown.py': 'bad'}}):
            with self.assertRaises(ValueError): s.parse_frame(json.dumps({**frame, **change}).encode())
        with self.assertRaises(ValueError):
            s.parse_frame(b'{"type":"start","mode":"appserver-metadata-pipe"}')
        self.assertEqual(s.fixed_arguments('appserver-metadata-pipe'), ['sandbox', '--permission-profile', 'appserver-metadata', '--',
            '/usr/bin/python3', '-I', '-S', '/usr/bin/appserver-metadata-pipe-child.py'])
    def test_no_caller_argv(self):
        with self.assertRaises(ValueError): s.fixed_arguments('exec')
        self.assertEqual(s.fixed_arguments('version'), ['--version'])
        self.assertEqual(s.fixed_arguments('private-sentinel')[-1], '/usr/bin/child-probe.py')
        self.assertEqual(s.fixed_arguments('partial-setup')[-1], 'setsid')
    def test_reap_preserves_child_failure_racing_poll(self):
        process = Mock(pid=42, returncode=None)
        with patch.object(s.os, 'waitpid', side_effect=[(42, 9 << 8), (0, 0)]), patch.object(s.os, 'waitstatus_to_exitcode', side_effect=lambda code: code >> 8):
            s.reap_process(process)
        self.assertEqual(process.returncode, 9)
    def test_adopted_pid_reuse_cannot_overwrite_direct_status(self):
        process = Mock(pid=42, returncode=7)
        with patch.object(s.os, 'waitpid', side_effect=[(42, 0), (0, 0)]):
            s.reap_process(process)
        self.assertEqual(process.returncode, 7)
    def test_no_children_is_clean(self):
        with patch.object(s.os, 'waitpid', side_effect=ChildProcessError):
            s.reap_process(None)
    def test_backpressure_queue_is_bounded_and_nonblocking(self):
        with patch.object(s.os, 'set_blocking'), patch.object(s.os, 'write', side_effect=BlockingIOError):
            channel = s.Channel()
            for _ in range(100): channel.emit('child_output', data='x' * 4096)
            self.assertTrue(channel.failed)
            self.assertLessEqual(len(channel.pending), s.MAX_QUEUE)
    def test_fixture_kind_does_not_collide_with_event_type(self):
        with patch.object(s.os, 'set_blocking'), patch.object(s.os, 'write', side_effect=lambda fd, data: len(data)) as write:
            channel = s.Channel()
            self.assertTrue(channel.emit('fixture_ready', kind='owned-cli-stopped'))
            frame = m.json.loads(write.call_args.args[1])
            self.assertEqual(frame['type'], 'fixture_ready')
            self.assertEqual(frame['kind'], 'owned-cli-stopped')
    def test_broken_peer_does_not_block(self):
        with patch.object(s.os, 'set_blocking'), patch.object(s.os, 'write', side_effect=BrokenPipeError):
            channel = s.Channel()
            self.assertFalse(channel.emit('ready'))
            self.assertEqual(channel.pending, b'')
class HttpLoopbackBootstrapTests(unittest.TestCase):
    def execute(self, *, mapping='1000 1000 1', owner_matches=True, interfaces=None,
                before=8, after=73, pid=1, ioctl_error=None, close_error=False):
        from contextlib import ExitStack
        control = Mock(); control.fileno.return_value = 20
        context = Mock(); context.__enter__ = Mock(return_value=control)
        context.__exit__ = Mock(return_value=False)
        reads = iter([before, after]); self.writes = []
        def ioctl(fd, command, data=None):
            if command == 0xb701:
                if ioctl_error: raise OSError(1, 'owner denied')
                return 12
            if command == 0x8913: return s.struct.pack('16sH22x', b'lo', next(reads))
            if command == 0x8914:
                self.writes.append((fd, data)); return data
            raise AssertionError('UNEXPECTED_IOCTL')
        self.closes = Mock(side_effect=([OSError(5, 'close failed'), None, None] if close_error else None))
        self.socket_factory = Mock(return_value=context)
        links = {'/proc/self/ns/net': 'net:[42]', '/proc/1/ns/net': 'net:[42]', '/proc/self/ns/user': 'user:[43]'}
        with ExitStack() as stack:
            for target, name, value in ((s.os, 'getpid', lambda: pid), (s.os, 'geteuid', lambda: 1000),
                    (s.os, 'uname', lambda: SimpleNamespace(machine='x86_64')),
                    (s.os, 'readlink', lambda path: links[path]),
                    (s.os, 'open', Mock(side_effect=[10, 11])), (s.os, 'close', self.closes),
                    (s.os, 'fstat', lambda fd: SimpleNamespace(st_dev=1, st_ino=43 if fd==11 or owner_matches else 99)),
                    (s.socket, 'socket', self.socket_factory),
                    (s.socket, 'if_nameindex', lambda: [(1, 'lo')] if interfaces is None else interfaces)):
                stack.enter_context(patch.object(target, name, value, create=True))
            stack.enter_context(patch.object(s.os, 'O_CLOEXEC', 0x80000, create=True))
            stack.enter_context(patch.object(s.Path, 'read_text', return_value=mapping))
            stack.enter_context(patch.dict(sys.modules, {'fcntl': SimpleNamespace(ioctl=ioctl)}))
            return s.bootstrap_http_loopback()

    def test_only_owned_loopback_is_brought_up_and_actual_flags_reported(self):
        result = self.execute()
        self.assertEqual(result, {'interface':'lo','namespace':'net:[42]','ownerUserNamespace':'user:[43]', 'beforeFlags':8,'afterFlags':73})
        self.assertEqual(self.writes, [(20, s.struct.pack('16sH22x', b'lo', 9))])
        self.assertEqual([call.args[0] for call in self.closes.call_args_list], [12,11,10])

    def test_already_up_does_not_mutate_flags(self):
        self.execute(before=73); self.assertEqual(self.writes, [])

    def test_initial_or_wrong_user_mapping_never_creates_control_socket(self):
        for mapping in ('0 0 4294967295', '1000 0 1', '1001 1001 1', '1000 1000 2', '', 'x y z'):
            with self.subTest(mapping=mapping), self.assertRaisesRegex(ValueError, 'MAPPED_USER'):
                self.execute(mapping=mapping)
            self.socket_factory.assert_not_called()

    def test_foreign_network_owner_never_mutates_and_all_ns_fds_close(self):
        with self.assertRaisesRegex(ValueError, 'NETWORK_OWNER'):
            self.execute(owner_matches=False)
        self.socket_factory.assert_not_called()
        self.assertEqual([call.args[0] for call in self.closes.call_args_list], [12,11,10])

    def test_owner_ioctl_denial_closes_previously_opened_fds(self):
        with self.assertRaises(OSError): self.execute(ioctl_error=True)
        self.socket_factory.assert_not_called()
        self.assertEqual([call.args[0] for call in self.closes.call_args_list], [11,10])

    def test_other_interface_or_non_pid1_is_refused(self):
        for args in ({'interfaces':[(1,'lo'),(2,'eth0')]}, {'pid':2}):
            with self.subTest(args=args), self.assertRaises(ValueError): self.execute(**args)
            self.socket_factory.assert_not_called()

    def test_missing_loopback_flag_or_failed_up_readback_refused(self):
        for args in ({'before':0}, {'after':8}, {'after':1}):
            with self.subTest(args=args), self.assertRaises(ValueError): self.execute(**args)
            self.assertEqual(self.closes.call_count, 3)

    def test_close_failure_does_not_skip_other_owned_fds_or_return_success(self):
        with self.assertRaises(OSError): self.execute(close_error=True)
        self.assertEqual([call.args[0] for call in self.closes.call_args_list], [12,11,10])

if __name__ == '__main__': unittest.main()
