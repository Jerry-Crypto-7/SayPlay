"""Offline validators; never launch systemd or mutate cgroups."""
import importlib.util
from pathlib import Path
import sys
import unittest
import json
import copy
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('systemd_resource', Path(__file__).parents[1] / 'subscription-systemd-resource-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ProbeTests(unittest.TestCase):
    def frames(self):
        facts = {'membership': '/unique.service', 'memory.max': '67108864', 'memory.swap.max': '0',
                 'pids.max': '16', 'pids.current': '1', 'pids.events': 'max 0', 'memory.events': 'oom_kill 0'}
        return [{'type': 'before', 'facts': facts},
                {'type': 'fork', 'children': 15, 'errno': 11, 'facts': {**facts, 'pids.current': '16', 'pids.events': 'max 1'}},
                {'type': 'memory', 'childSignaled': True, 'childSignal': 9,
                 'facts': {**facts, 'memory.events': 'oom_kill 1'}}]

    def evaluate(self, frames, code=0, absent=True):
        return probe.assess_experiment('\n'.join(json.dumps(frame) for frame in frames), code, absent)

    def test_complete_observations_pass_only_synthetic_checks(self):
        self.assertEqual(self.evaluate(self.frames())['status'], 'PASS')

    def test_exit_zero_without_facts_is_not_enforcement(self):
        for value in ('', '{}', '[]', 'not json', 'x' * 65537):
            self.assertEqual(probe.assess_experiment(value, 0, True)['status'], 'FAIL')

    def test_each_event_and_limits_cleanup_required(self):
        for index, key, value in [(1, 'pids.events', 'max 0'), (2, 'memory.events', 'oom_kill 0'),
                                  (0, 'memory.max', 'max'), (1, 'pids.max', 'max'),
                                  (2, 'memory.swap.max', 'max'), (2, 'membership', '/other')]:
            frames = self.frames()
            frames[index]['facts'][key] = value
            self.assertEqual(self.evaluate(frames)['status'], 'FAIL')
        self.assertEqual(self.evaluate(self.frames(), absent=False)['status'], 'FAIL')
        self.assertEqual(self.evaluate(self.frames(), code=1)['status'], 'FAIL')

    def test_signal_and_actual_denial_required(self):
        for index, key, value in [(1, 'errno', 1), (1, 'children', 32), (2, 'childSignal', 15), (2, 'childSignaled', False)]:
            frames = self.frames()
            frames[index][key] = value
            self.assertEqual(self.evaluate(frames)['status'], 'FAIL')

    def test_property_parser_rejects_unknown_duplicate_oversize(self):
        self.assertEqual(probe.parse_properties('Version=255\nSystemState=running\n')['Version'], '255')
        for value in ('Environment=private', 'Version=x\nVersion=y', 'Version=' + 'x' * 70000, 'Version=\x00'):
            with self.assertRaises(ValueError):
                probe.parse_properties(value)

    def test_event_parser_rejects_duplicates_bad_counts(self):
        for value in ('max 0\nmax 1', 'max -1', 'max 1e9', 'oom_kill x', 'max 1 2'):
            with self.assertRaises(ValueError):
                probe.parse_events(value)

    def test_discovery_cannot_unlock_production(self):
        facts = {'pid1': 'systemd', 'systemdRuntime': True, 'userBusSocket': True,
                 'userManagerQueryExitCode': 0, 'userManager': {'Version': '255'}, 'controllers': ['memory', 'pids']}
        result = probe.assess(facts)
        self.assertEqual(result['discoveryStatus'], 'PASS')
        self.assertFalse(result['productionReady'])
        self.assertEqual(result['enforcementStatus'], 'NOT_RUN')
        for key in facts:
            bad = copy.deepcopy(facts)
            del bad[key]
            self.assertEqual(probe.assess(bad)['discoveryStatus'], 'FAIL')

    def test_arbitrary_metadata_path_never_opened(self):
        with patch.object(probe.os, 'open') as opened:
            with self.assertRaises(ValueError):
                probe.read_fixed('/home/user/.codex/auth.json')
            opened.assert_not_called()

    def test_write_open_denial_requires_both_exact_permission_observations(self):
        frames = self.frames()
        self.assertEqual(self.evaluate(frames)['cgroupWriteOpenDenial'], 'FAIL')
        denied = {'writeOpenAllowed': False, 'errno': 13, 'bytesWritten': 0}
        frames[0]['boundary'] = {key: dict(denied) for key in ('ownMemoryLimit', 'parentMigration')}
        self.assertEqual(self.evaluate(frames)['cgroupWriteOpenDenial'], 'PASS')
        for key, value in [('writeOpenAllowed', True), ('errno', 2), ('bytesWritten', 1)]:
            bad = copy.deepcopy(frames)
            bad[0]['boundary']['parentMigration'][key] = value
            result = self.evaluate(bad)
            self.assertEqual(result['cgroupWriteOpenDenial'], 'FAIL')
            self.assertEqual(result['hostileEscapeResistance'], 'NOT_VALIDATED')


if __name__ == '__main__':
    unittest.main()
