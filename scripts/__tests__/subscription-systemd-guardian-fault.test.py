"""Offline guardian evidence tests. No processes, units or signals created."""
import copy
import importlib.util
from pathlib import Path
import sys
import types
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('guardian_fault', Path(__file__).parents[1] / 'subscription-systemd-guardian-fault.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class GuardianTests(unittest.TestCase):
    unit = 'codex-cli-resource-' + 'a' * 32 + '.service'
    leaf = '/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/' + unit

    def identity(self):
        return {'pid': 42, 'nspid': [42, 1], 'startTicks': 100, 'state': 'T',
                'executable': '/usr/bin/python3', 'cgroup': '0::' + self.leaf.removeprefix('/sys/fs/cgroup'),
                'expectedCgroup': '0::' + self.leaf.removeprefix('/sys/fs/cgroup')}

    def report(self):
        return {'unit': self.unit, 'trigger': {'triggered': True, 'stateT': True, 'targetBefore': self.identity(),
                                              'targetAfter': self.identity(), 'sample': {'leaf': self.leaf}},
                'manager': {'Result': 'timeout', 'RuntimeMaxUSec': '15s', 'TimeoutStopUSec': '2s', 'KillMode': 'control-group'},
                'externalHarnessCleanup': False, 'allPinnedPidsESRCH': True, 'leafAbsentBeforeReset': True,
                'unitAbsentAfterReset': True, 'errors': [], 'sourceSha256Before': dict.fromkeys(probe.SOURCE_NAMES, 'a' * 64),
                'sourceSha256After': dict.fromkeys(probe.SOURCE_NAMES, 'a' * 64)}

    def test_exact_positive_guardian_evidence(self):
        result = probe.evaluate(self.report())
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['guardianKillEscalation'], 'NOT_OBSERVED')
        self.assertEqual(result['sustainedUnresponsiveKill'], 'NOT_VALIDATED')
        self.assertEqual(result['scope'], 'manager-runtime-trigger-and-owned-cleanup-only')

    def test_fallback_unknown_trigger_cleanup_or_source_cannot_pass(self):
        for key, value in [('externalHarnessCleanup', True), ('allPinnedPidsESRCH', False),
                           ('leafAbsentBeforeReset', False), ('unitAbsentAfterReset', False),
                           ('errors', ['error']), ('sourceSha256After', {'source': 'b'})]:
            report = self.report()
            report[key] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        report = self.report()
        report['trigger']['triggered'] = False
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_exact_fixture_timer_and_manager_cause_required(self):
        for key, value in [('Result', 'success'), ('RuntimeMaxUSec', '200s'), ('TimeoutStopUSec', '5s'), ('KillMode', 'process')]:
            report = self.report()
            report['manager'][key] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_identity_needs_own_membership_pid1_and_executable(self):
        for key, value in [('executable', '/usr/bin/other'), ('cgroup', '0::/foreign'), ('nspid', [42, 2]), ('startTicks', 0), ('pid', 43)]:
            identity = self.identity()
            identity[key] = value
            self.assertFalse(probe.valid_target(identity))

    def test_unverified_target_never_receives_stop(self):
        candidate = types.SimpleNamespace(leaf_path=lambda _: '/own', readback=lambda _: {'cgroup.procs': '42'})
        with patch.object(probe.os, 'pidfd_open', return_value=99, create=True), \
             patch.object(probe, 'own_identity', side_effect=PermissionError(13, 'denied')), \
             patch.object(probe.signal, 'pidfd_send_signal', create=True) as sent:
            result, handles = probe.select_and_stop(candidate, 'unit')
        self.assertFalse(result['triggered'])
        self.assertEqual(handles, [(42, 99)])
        sent.assert_not_called()

    def test_properties_reject_unrequested_or_duplicate_metadata(self):
        self.assertEqual(probe.parse_properties('Result=timeout\n')['Result'], 'timeout')
        for value in ('Environment=private', 'Result=timeout\nResult=success', 'x' * 65537):
            with self.assertRaises(ValueError):
                probe.parse_properties(value)

    def test_empty_missing_partial_extra_and_invalid_source_maps_rejected(self):
        valid = self.report()['sourceSha256Before']
        for value in (None, {}, {'one': 'a' * 64}, {**valid, 'extra': 'a' * 64}, dict.fromkeys(probe.SOURCE_NAMES, 'bad')):
            report = self.report()
            report['sourceSha256Before'] = report['sourceSha256After'] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        report = self.report()
        del report['sourceSha256Before']
        del report['sourceSha256After']
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
    def test_new_capsule_helpers_require_versioned_source_identity(self):
        old = dict.fromkeys(probe.SOURCE_NAMES, 'a' * 64)
        current = dict.fromkeys(probe.SOURCE_NAMES_V2, 'a' * 64)
        self.assertTrue(probe.valid_source_identity(old, 1))
        self.assertTrue(probe.valid_source_identity(current, 2))
        self.assertFalse(probe.valid_source_identity(old, 2))
        self.assertFalse(probe.valid_source_identity(current, 1))
        catalog = dict.fromkeys(probe.SOURCE_NAMES_V3, 'a' * 64)
        self.assertTrue(probe.valid_source_identity(catalog, 3))
        self.assertFalse(probe.valid_source_identity(current, 3))
        self.assertFalse(probe.valid_source_identity(catalog, 2))
        fixture = dict.fromkeys(probe.SOURCE_NAMES_V4, 'a' * 64)
        self.assertTrue(probe.valid_source_identity(fixture, 4))
        self.assertFalse(probe.valid_source_identity(catalog, 4))
        self.assertFalse(probe.valid_source_identity(fixture, 3))
        for invalid_version in (True, '4', [], {}, None):
            self.assertFalse(probe.valid_source_identity(fixture, invalid_version))
        self.assertFalse(probe.valid_source_identity(current, True))
        self.assertFalse(probe.valid_source_identity(current, 3))

    def test_stopped_boolean_cannot_replace_actual_state_and_matching_identity(self):
        for key, value in [('state', 'S'), ('startTicks', 101), ('pid', 43), ('nspid', [42, 2])]:
            report = self.report()
            report['trigger']['targetAfter'][key] = value
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        report = self.report()
        report['trigger']['targetAfter'].update(pid=43, nspid=[43, 1])
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_report_unit_and_leaf_bind_both_identity_cgroups(self):
        report = self.report()
        report['unit'] = 'codex-cli-resource-' + 'b' * 32 + '.service'
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        report = self.report()
        report['trigger']['sample']['leaf'] = self.leaf.replace('user@1000', 'user@2000')
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        for value in (None, '0::/own', '0::/../private'):
            identity = self.identity()
            identity['cgroup'] = identity['expectedCgroup'] = value
            self.assertFalse(probe.valid_target(identity))


if __name__ == '__main__':
    unittest.main()
