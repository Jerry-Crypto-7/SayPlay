"""Offline evidence checks for the fixed actual200s command-timeout probe."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
import types
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('command_guardian', Path(__file__).parents[1] / 'subscription-systemd-guardian-fault.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class CommandDeadlineTests(unittest.TestCase):
    def report(self):
        unit = 'codex-cli-resource-' + 'a' * 32 + '.service'
        leaf = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit
        group = '0::' + leaf.removeprefix('/sys/fs/cgroup')
        identity = {'pid': 42, 'nspid': [42, 1], 'startTicks': 100, 'state': 'T',
                    'executable': '/usr/bin/python3', 'cgroup': group, 'expectedCgroup': group}
        return {'unit': unit, 'mode': 'command-deadline', 'trigger': {'triggered': True, 'stateT': True,
                'targetBefore': dict(identity), 'targetAfter': dict(identity), 'sample': {'leaf': leaf}},
                'managerMainPidBefore': 40, 'commandMainIdentity': {**identity, 'pid': 40, 'nspid': [40], 'executable': '/usr/bin/timeout'},
                'manager': {'Result': 'exit-code', 'ExecMainCode': '1', 'ExecMainStatus': '124',
                            'RuntimeMaxUSec': '3min 40s', 'TimeoutStopUSec': '5s', 'KillMode': 'control-group',
                            'ExecMainStartTimestampMonotonic': '1000000', 'ExecMainExitTimestampMonotonic': '201000000'},
                'externalHarnessCleanup': False, 'allPinnedPidsESRCH': True, 'leafAbsentBeforeReset': True,
                'unitAbsentAfterReset': True, 'errors': [], 'exitCode': 124,
                'sourceSha256Before': dict.fromkeys(probe.SOURCE_NAMES, 'a' * 64),
                'sourceSha256After': dict.fromkeys(probe.SOURCE_NAMES, 'a' * 64)}

    def test_original_and_new_mode_have_fixed_separate_budgets(self):
        self.assertEqual(probe.fixed_budgets('guardian-runtime'), {'guardianSeconds': 15, 'stopSeconds': 2, 'driverSeconds': 45})
        self.assertEqual(probe.fixed_budgets('command-deadline'), {'guardianSeconds': 220, 'stopSeconds': 5, 'driverSeconds': 235})
        with self.assertRaises(ValueError):
            probe.fixed_budgets('arbitrary')

    def test_exact_actual_command_timeout_evidence(self):
        result = probe.evaluate(self.report())
        self.assertEqual(result['status'], 'PASS')
        self.assertTrue(result['commandTimeoutMeasured'])
        self.assertEqual(result['sustainedUnresponsiveKill'], 'NOT_VALIDATED')

    def test_outer_timeout_cannot_substitute_for_inner_timeout(self):
        report = self.report()
        report['manager']['Result'] = 'timeout'
        self.assertFalse(probe.evaluate(report)['commandTimeoutMeasured'])

    def test_exit124_does_not_replace_duration_or_identity(self):
        for key, value in [('ExecMainStatus', '0'), ('ExecMainCode', '2'),
                           ('ExecMainExitTimestampMonotonic', '200999999'),
                           ('ExecMainStartTimestampMonotonic', None), ('RuntimeMaxUSec', '15s')]:
            report = self.report()
            report['manager'][key] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        for key, value in [('pid', 43), ('executable', '/usr/bin/other'), ('cgroup', '0::/foreign')]:
            report = self.report()
            report['commandMainIdentity'][key] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_wrapper_code_cleanup_and_source_stability_required(self):
        for key, value in [('exitCode', 0), ('externalHarnessCleanup', True), ('allPinnedPidsESRCH', False),
                           ('leafAbsentBeforeReset', False), ('sourceSha256After', {})]:
            report = self.report()
            report[key] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_elapsed_metadata_is_bounded_not_inferred_from_walltime(self):
        for value in ('-1', '1e9', '9' * 100, '', None):
            manager = self.report()['manager']
            manager['ExecMainStartTimestampMonotonic'] = value
            self.assertIsNone(probe.command_elapsed_ms(manager))
        report = self.report()
        report['elapsedMs'] = 999999
        del report['manager']['ExecMainExitTimestampMonotonic']
        self.assertFalse(probe.evaluate(report)['commandTimeoutMeasured'])

    def test_missing_wrong_or_unbound_manager_main_sends_zero_stop_signals(self):
        report = self.report()
        target = report['trigger']['targetBefore']
        main = report['commandMainIdentity']
        candidate = types.SimpleNamespace(leaf_path=lambda _: report['trigger']['sample']['leaf'],
                                         readback=lambda _: {'cgroup.procs': '42\n40', 'leaf': report['trigger']['sample']['leaf']})
        for manager_pid, executable in ((None, '/usr/bin/timeout'), (99, '/usr/bin/timeout'), (40, '/usr/bin/other')):
            seen_main = {**main, 'executable': executable}
            with patch.object(probe.os, 'pidfd_open', side_effect=lambda pid, _: pid + 100, create=True), \
                 patch.object(probe, 'own_identity', side_effect=lambda pid, _: target if pid == 42 else seen_main), \
                 patch.object(probe.signal, 'pidfd_send_signal', create=True) as sent:
                result, handles = probe.select_and_stop(candidate, report['unit'],
                    lambda identities, own_target, sample: probe.command_main_matches(seen_main, manager_pid, own_target['expectedCgroup']))
            self.assertFalse(result['triggered'])
            self.assertEqual(len(handles), 2)
            sent.assert_not_called()


if __name__ == '__main__':
    unittest.main()
