"""Independent complete report fixture and negative admission tests (offline)."""
import copy
from contextlib import ExitStack
import hashlib
import importlib.util
from pathlib import Path
import stat
import struct
import unittest
from unittest.mock import patch

SCRIPTS = Path(__file__).parents[1]


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


p = load('worker_boundary', 'subscription-worker-boundary.py')
lockdown = load('worker_lockdown_for_boundary_tests', 'subscription-worker-lockdown.py')
child_module = load('worker_boundary_child_tests', 'subscription-worker-boundary-child.py')


def sample():
    # No validator constants or report generators: all required observations
    # appear explicitly here; only the actual deployed filter identity is derived.
    instructions = lockdown.build_filter()
    expected = {
        'helperSha256': {name: hashlib.sha256((SCRIPTS / name).read_bytes()).hexdigest()
                         for name in ('subscription-worker-lockdown.py', 'subscription-worker-boundary-child.py')},
        'namespace': 'pid:[100]', 'mountNamespace': 'mnt:[200]',
        'output': {'dev': 1, 'ino': 2, 'type': stat.S_IFIFO},
        'control': {'dev': 1, 'ino': 3, 'type': stat.S_IFIFO},
    }
    snapshot = {
        'status': {'NoNewPrivs': '1', 'Seccomp': '2', 'Seccomp_filters': '3',
                   'CapEff': '0000000000000000', 'CapBnd': '0000000000000000'},
        'namespaces': {'user': 'user:[301]', 'mnt': 'mnt:[302]', 'pid': 'pid:[303]'},
        'calls': {name: {'return': -1, 'errno': 1} for name in (
            'unshare-user', 'unshare-mount', 'unshare-combined', 'setns', 'mount',
            'umount2', 'pivot_root', 'open_tree', 'move_mount', 'fsopen', 'fsconfig',
            'fsmount', 'fspick', 'mount_setattr', 'ptrace', 'process_vm_readv',
            'process_vm_writev', 'pidfd_getfd')},
        'boundary': {
            'paths': {name: {'opened': False, 'identity': None, 'errno': error,
                             'bytesRead': 0, 'bytesWritten': 0} for name, error in (
                ('/private/sentinel', 13), ('/private/config.toml', 13), ('/work/private-alias', 13),
                ('/sys/fs/cgroup', 2), ('/sys/fs/cgroup/cgroup.procs', 2), ('/oldroot', 2),
                ('/proc/1/root/private/sentinel', 2), ('/proc/1/root/sys/fs/cgroup', 2),
                ('/proc/1/fd/0', 13), ('/proc/1/fd/1', 13),
                ('/proc/1/root/proc/1/fd/0', 13), ('/proc/1/root/proc/1/fd/1', 13))},
            'inheritedDescriptors': [{'dev': 1, 'ino': 10, 'type': stat.S_IFCHR},
                                     {'dev': 1, 'ino': 11, 'type': stat.S_IFIFO}],
        },
    }
    snapshot['calls']['clone3'] = {'return': -1, 'errno': 38}
    report = {
        'version': 2, 'profile': 'post-cli-worker-lockdown-v2',
        'before': {'NoNewPrivs': '1', 'Seccomp': '2', 'Seccomp_filters': '2',
                   'CapEff': '0000000000000000', 'CapBnd': '0000000000000000'},
        'receipt': {'arch': 'linux-x86_64', 'noNewPrivs': 1, 'seccompMode': 2,
                    'threadSync': True, 'instructionCount': len(instructions),
                    'filterSha256': hashlib.sha256(b''.join(struct.pack('<HBBI', *i) for i in instructions)).hexdigest()},
        'current': copy.deepcopy(snapshot), 'thread': [copy.deepcopy(snapshot)],
        'exec': copy.deepcopy(snapshot), 'fork': copy.deepcopy(snapshot),
        'modelCalls': 0, 'credentialFilesRead': False, 'productionReady': False,
        'cloneNamespaces': {name: {'flags': flag | 17, 'return': -1, 'errno': 1, 'child': None}
                            for name, flag in (('newtime', 0x80), ('newns', 0x20000), ('newcgroup', 0x2000000),
                            ('newuts', 0x4000000), ('newipc', 0x8000000), ('newuser', 0x10000000),
                            ('newpid', 0x20000000), ('newnet', 0x40000000))},
        'abi': {name: {'reaped': True, 'timedOut': False, 'signal': 31, 'exitCode': None, 'instructionReached': True}
                for name in ('x32-getpid', 'int80-getpid')},
    }
    report['existingThread'] = {'before': copy.deepcopy(report['before']), 'after': copy.deepcopy(snapshot)}
    return report, expected


def snapshots(report):
    return (report['current'], report['thread'][0], report['exec'], report['fork'], report['existingThread']['after'])


class WorkerBoundaryTests(unittest.TestCase):
    def test_trusted_channels_must_be_distinct_pipes(self):
        report, expected = sample()
        expected['control'] = copy.deepcopy(expected['output'])
        self.assertFalse(p.validate_worker_report(report, expected))
        for key in ('control', 'output'):
            report, expected = sample()
            expected[key]['type'] = stat.S_IFREG
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_complete_five_snapshot_fixture(self):
        self.assertTrue(p.validate_worker_report(*sample()))

    def test_opened_local_namespace_fd_requires_distinct_identity(self):
        report, expected = sample()
        report['current']['boundary']['paths']['/proc/1/fd/1'].update(
            opened=True, identity={'dev': 1, 'ino': 42, 'type': stat.S_IFIFO}, errno=None)
        self.assertTrue(p.validate_worker_report(report, expected))
        for name in ('control', 'output'):
            changed = copy.deepcopy(report)
            changed['current']['boundary']['paths']['/proc/1/fd/1']['identity'] = expected[name].copy()
            self.assertFalse(p.validate_worker_report(changed, expected))

    def test_every_top_level_and_expected_field_required(self):
        for side in (0, 1):
            for key in sample()[side]:
                pair = sample()
                del pair[side][key]
                with self.subTest(side=side, key=key):
                    self.assertFalse(p.validate_worker_report(*pair))

    def test_snapshot_sections_and_status_fields_required(self):
        for index in range(5):
            for key in ('status', 'namespaces', 'calls', 'boundary'):
                report, expected = sample()
                del snapshots(report)[index][key]
                with self.subTest(index=index, key=key):
                    self.assertFalse(p.validate_worker_report(report, expected))
            for key in ('NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff', 'CapBnd'):
                report, expected = sample()
                del snapshots(report)[index]['status'][key]
                self.assertFalse(p.validate_worker_report(report, expected))

    def test_literal_booleans_and_integers_are_not_interchangeable(self):
        for key, value in (('version', True), ('modelCalls', False),
                           ('credentialFilesRead', 0), ('productionReady', 0)):
            report, expected = sample()
            report[key] = value
            self.assertFalse(p.validate_worker_report(report, expected))
        for key, value in (('noNewPrivs', True), ('seccompMode', True),
                           ('threadSync', 1), ('instructionCount', True)):
            report, expected = sample()
            report['receipt'][key] = value
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_wrong_helper_and_filter_identity(self):
        for name in sample()[1]['helperSha256']:
            report, expected = sample()
            expected['helperSha256'][name] = '0' * 64
            self.assertFalse(p.validate_worker_report(report, expected))
        for key, value in (('filterSha256', '0' * 64), ('instructionCount', 1), ('arch', 'linux-aarch64')):
            report, expected = sample()
            report['receipt'][key] = value
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_thread_cardinality_and_missing_fork_exec_fail(self):
        for threads in ([], [sample()[0]['current']] * 2, {}, None):
            report, expected = sample()
            report['thread'] = threads
            self.assertFalse(p.validate_worker_report(report, expected))
        for key in ('fork', 'exec'):
            report, expected = sample()
            report[key] = None
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_each_syscall_required_and_exact_denial(self):
        for index in range(5):
            for name in sample()[0]['current']['calls']:
                for mutation in ('missing', 'success', 'wrong-errno', 'boolean-return', 'boolean-errno'):
                    report, expected = sample()
                    calls = snapshots(report)[index]['calls']
                    if mutation == 'missing':
                        del calls[name]
                    elif mutation == 'success':
                        calls[name] = {'return': 0, 'errno': None}
                    elif mutation == 'wrong-errno':
                        calls[name]['errno'] = 22
                    elif mutation == 'boolean-return':
                        calls[name]['return'] = True
                    else:
                        calls[name]['errno'] = True
                    with self.subTest(index=index, name=name, mutation=mutation):
                        self.assertFalse(p.validate_worker_report(report, expected))

    def test_every_path_required_and_no_open_read_write_or_invalid_errno(self):
        for index in range(5):
            for name in sample()[0]['current']['boundary']['paths']:
                for mutation in ('missing', 'opened', 'read', 'write', 'errno', 'identity', 'boolean-count'):
                    report, expected = sample()
                    paths = snapshots(report)[index]['boundary']['paths']
                    if mutation == 'missing':
                        del paths[name]
                    else:
                        key, value = {'opened': ('opened', True), 'read': ('bytesRead', 1),
                                      'write': ('bytesWritten', 1), 'errno': ('errno', 22),
                                      'identity': ('identity', {'dev': 1, 'ino': 99, 'type': stat.S_IFIFO}),
                                      'boolean-count': ('bytesRead', False)}[mutation]
                        paths[name][key] = value
                    with self.subTest(index=index, path=name, mutation=mutation):
                        self.assertFalse(p.validate_worker_report(report, expected))

    def test_known_private_sentinel_missing_is_not_denial(self):
        for name in ('/private/sentinel', '/private/config.toml', '/work/private-alias'):
            report, expected = sample()
            report['current']['boundary']['paths'][name]['errno'] = 2
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_inherited_control_or_output_identity_fails_in_every_snapshot(self):
        for index in range(5):
            for name in ('control', 'output'):
                report, expected = sample()
                snapshots(report)[index]['boundary']['inheritedDescriptors'].append(copy.deepcopy(expected[name]))
                self.assertFalse(p.validate_worker_report(report, expected))

    def test_missing_or_malformed_descriptor_inventory_fails(self):
        for value in (None, [], {}, [{'dev': True, 'ino': 10, 'type': stat.S_IFIFO}], [{'dev': 1, 'ino': 10}]):
            report, expected = sample()
            report['current']['boundary']['inheritedDescriptors'] = value
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_all_descendants_share_each_namespace_and_differ_from_supervisor(self):
        for index in range(5):
            for namespace in ('user', 'mnt', 'pid'):
                report, expected = sample()
                snapshots(report)[index]['namespaces'][namespace] = namespace + ':[999]'
                self.assertFalse(p.validate_worker_report(report, expected))
        for key, outer in (('pid', 'namespace'), ('mnt', 'mountNamespace')):
            report, expected = sample()
            for snapshot in snapshots(report):
                snapshot['namespaces'][key] = expected[outer]
            self.assertFalse(p.validate_worker_report(report, expected))

    def test_filter_count_increment_exact_and_nnp_caps_enforced(self):
        for index in range(5):
            for key, value in (('Seccomp_filters', '2'), ('Seccomp_filters', '4'),
                               ('Seccomp_filters', 3), ('Seccomp', '0'), ('NoNewPrivs', '0'),
                               ('CapEff', '0000000000000001'), ('CapBnd', '0000000000000001')):
                report, expected = sample()
                snapshots(report)[index]['status'][key] = value
                self.assertFalse(p.validate_worker_report(report, expected))

    def test_existing_thread_requires_preinstall_status_and_complete_after(self):
        for value in ({}, {'before': sample()[0]['before']}, {'after': sample()[0]['current']}, None):
            report, expected = sample()
            report['existingThread'] = value
            self.assertFalse(p.validate_worker_report(report, expected))
        report, expected = sample()
        report['existingThread']['before']['Seccomp_filters'] = '3'
        self.assertFalse(p.validate_worker_report(report, expected))

    def test_each_clone_flag_requires_exact_denial_and_no_child(self):
        for name in sample()[0]['cloneNamespaces']:
            for mutation in ('missing', 'flags', 'return', 'errno', 'child', 'boolean-errno'):
                report, expected = sample()
                if mutation == 'missing':
                    del report['cloneNamespaces'][name]
                else:
                    key, value = {'flags': ('flags', 17), 'return': ('return', 123),
                                  'errno': ('errno', 22), 'child': ('child', {'reaped': True}),
                                  'boolean-errno': ('errno', True)}[mutation]
                    report['cloneNamespaces'][name][key] = value
                with self.subTest(name=name, mutation=mutation):
                    self.assertFalse(p.validate_worker_report(report, expected))

    def test_abi_requires_both_reached_sigsys_reaped_without_timeout(self):
        for name in ('x32-getpid', 'int80-getpid'):
            for mutation in ('missing', 'signal', 'exitCode', 'reaped', 'timedOut', 'instructionReached',
                             'boolean-signal', 'numeric-reaped', 'numeric-timeout', 'numeric-reached'):
                report, expected = sample()
                if mutation == 'missing':
                    del report['abi'][name]
                else:
                    key, value = {'signal': ('signal', 9), 'exitCode': ('exitCode', 90),
                                  'reaped': ('reaped', False), 'timedOut': ('timedOut', True),
                                  'instructionReached': ('instructionReached', False),
                                  'boolean-signal': ('signal', True), 'numeric-reaped': ('reaped', 1),
                                  'numeric-timeout': ('timedOut', 0), 'numeric-reached': ('instructionReached', 1)}[mutation]
                    report['abi'][name][key] = value
                with self.subTest(name=name, mutation=mutation):
                    self.assertFalse(p.validate_worker_report(report, expected))

    def test_historical_v1_cannot_receive_expanded_coverage(self):
        report, expected = sample()
        report.update(version=1, profile='post-cli-worker-lockdown-v1')
        self.assertFalse(p.validate_worker_report(report, expected))


class WorkerCollectorTests(unittest.TestCase):
    """Mocked process faults only: no fork, signals, or executable mappings."""
    def setup_collector(self, stack, read, wait, step=0.5):
        ticks = iter(i * step for i in range(10000))
        stack.enter_context(patch.object(child_module.time, 'monotonic', side_effect=lambda: next(ticks)))
        stack.enter_context(patch.object(child_module.time, 'sleep'))
        for name, value in (('WNOHANG', 1),):
            stack.enter_context(patch.object(child_module.os, name, value, create=True))
        for name, callback in (('WIFSIGNALED', lambda value: value == 9), ('WTERMSIG', lambda value: 9),
                               ('WIFEXITED', lambda value: value == 0), ('WEXITSTATUS', lambda value: 0)):
            stack.enter_context(patch.object(child_module.os, name, callback, create=True))
        stack.enter_context(patch.object(child_module.os, 'pidfd_open', return_value=55, create=True))
        stack.enter_context(patch.object(child_module.os, 'set_blocking'))
        stack.enter_context(patch.object(child_module.signal, 'SIGKILL', 9, create=True))
        stack.enter_context(patch.object(child_module.os, 'read', side_effect=read))
        stack.enter_context(patch.object(child_module.os, 'waitpid', side_effect=wait, create=True))
        close = stack.enter_context(patch.object(child_module.os, 'close'))
        kill = stack.enter_context(patch.object(child_module.signal, 'pidfd_send_signal', create=True))
        return close, kill

    def test_partial_output_and_hanging_child_timeout_kills_pinned_child_and_reaps(self):
        with ExitStack() as stack:
            chunks = iter((b'{',))
            def read(*_):
                try:
                    return next(chunks)
                except StopIteration:
                    raise BlockingIOError()
            close, kill = self.setup_collector(stack, read, lambda *_: (123, 9) if kill.called else (0, 0))
            data, outcome = child_module.collect_child(123, 44)
            self.assertEqual(data, b'{')
            self.assertEqual(outcome, {'reaped': True, 'timedOut': True, 'signal': 9, 'exitCode': None})
            kill.assert_called_once_with(55, child_module.signal.SIGKILL)
            self.assertEqual([call.args[0] for call in close.call_args_list], [44, 55])

    def test_overlimit_writer_killed_without_unbounded_drain(self):
        with ExitStack() as stack:
            _, kill = self.setup_collector(stack, lambda *_: b'x' * 4096,
                                           lambda *_: (123, 9) if kill.called else (0, 0), step=0.01)
            with self.assertRaisesRegex(RuntimeError, 'OUTPUT_LIMIT'):
                child_module.collect_child(123, 44)
            kill.assert_called_once_with(55, child_module.signal.SIGKILL)

    def test_unreaped_child_is_unknown_cleanup_not_success(self):
        with ExitStack() as stack:
            _, kill = self.setup_collector(stack, lambda *_: b'', lambda *_: (0, 0))
            with self.assertRaisesRegex(RuntimeError, 'CLEANUP_UNKNOWN'):
                child_module.collect_child(123, 44)
            kill.assert_called_once_with(55, child_module.signal.SIGKILL)

    def test_success_does_not_signal_reaped_child(self):
        with ExitStack() as stack:
            chunks = iter((b'{}', b''))
            _, kill = self.setup_collector(stack, lambda *_: next(chunks), lambda *_: (123, 0))
            data, outcome = child_module.collect_child(123, 44)
            self.assertEqual(data, b'{}')
            self.assertEqual(outcome, {'reaped': True, 'timedOut': False, 'signal': None, 'exitCode': 0})
            kill.assert_not_called()

    def test_failed_pin_closes_pipe_and_never_falls_back_to_pid_signal(self):
        with ExitStack() as stack:
            close, kill = self.setup_collector(stack, lambda *_: b'', lambda *_: (0, 0))
            stack.enter_context(patch.object(child_module.os, 'pidfd_open', side_effect=OSError('pin failed'), create=True))
            with self.assertRaisesRegex(OSError, 'pin failed'):
                child_module.collect_child(123, 44)
            close.assert_called_once_with(44)
            kill.assert_not_called()

    def test_arbitrary_process_mode_rejected_before_fork(self):
        with patch.object(child_module.os, 'fork', create=True) as fork:
            with self.assertRaisesRegex(ValueError, 'FIXED_PROCESS_ONLY'):
                child_module.fixed_process('arbitrary-command')
            fork.assert_not_called()


if __name__ == '__main__':
    unittest.main()
