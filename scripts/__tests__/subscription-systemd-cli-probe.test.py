"""Offline candidate-envelope validation; no WSL or process execution."""
import copy
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('systemd_cli', Path(__file__).parents[1] / 'subscription-systemd-cli-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class CandidateTests(unittest.TestCase):
    unit = 'codex-cli-resource-' + 'a' * 32 + '.service'

    def setUp(self):
        self.uid = patch.object(probe.os, 'getuid', return_value=1000, create=True)
        self.uid.start()
        self.addCleanup(self.uid.stop)

    def samples(self):
        return [{'phase': 'ready-before-start', 'facts': {'leaf': probe.leaf_path(self.unit),
                 'memory.max': '2147483648', 'memory.swap.max': '0', 'pids.max': '64'}}]

    def test_exact_readback_and_removal_pass(self):
        self.assertEqual(probe.evaluate_resources(self.samples(), True, self.unit)['status'], 'PASS')

    def test_candidate_capsule_has_own_uts_and_unchanged_timeout(self):
        self.assertEqual(probe.CAPSULE.count('--uts'), 1)
        self.assertLess(probe.CAPSULE.index('/usr/bin/unshare'), probe.CAPSULE.index('--uts'))
        self.assertLess(probe.CAPSULE.index('--uts'), probe.CAPSULE.index('/bin/sh'))
        for flag in ('--user', '--map-current-user', '--mount', '--net', '--pid'):
            self.assertIn(flag, probe.CAPSULE)
        timeout = probe.CAPSULE.index('/usr/bin/timeout')
        self.assertEqual(probe.CAPSULE[timeout + 1:timeout + 4], ['--signal=TERM', '--kill-after=5', '200'])

    def test_empty_unknown_cleanup_and_wrong_phase_fail(self):
        self.assertEqual(probe.evaluate_resources([], True, self.unit)['status'], 'FAIL')
        for absent in (False, None, 1, 'true'):
            self.assertEqual(probe.evaluate_resources(self.samples(), absent, self.unit)['status'], 'FAIL')
        samples = self.samples()
        samples[0]['phase'] = 'after-start'
        self.assertEqual(probe.evaluate_resources(samples, True, self.unit)['status'], 'FAIL')

    def test_wrong_or_missing_limits_and_leaf_fail(self):
        for key, value in [('memory.max', 'max'), ('memory.swap.max', 'max'), ('pids.max', '128'), ('leaf', '/another')]:
            samples = self.samples()
            samples[0]['facts'][key] = value
            self.assertEqual(probe.evaluate_resources(samples, True, self.unit)['status'], 'FAIL')
            del samples[0]['facts'][key]
            self.assertEqual(probe.evaluate_resources(samples, True, self.unit)['status'], 'FAIL')

    def test_every_sample_must_match(self):
        samples = self.samples() * 1
        samples.append(copy.deepcopy(samples[0]))
        samples[1]['facts']['memory.max'] = 'max'
        self.assertEqual(probe.evaluate_resources(samples, True, self.unit)['status'], 'FAIL')

    def test_arbitrary_unit_never_resolves(self):
        for unit in ('ssh.service', '../user.slice', 'codex-cli-resource-' + 'a' * 32 + '/service', ''):
            with self.assertRaisesRegex(ValueError, 'OWN_UNIQUE_UNIT_REQUIRED'):
                probe.leaf_path(unit)

    def test_control_environment_is_explicit(self):
        with patch.dict(probe.os.environ, {'CODEX_API_KEY': 'sentinel', 'HOME': '/private', 'PATH': '/untrusted'}, clear=True):
            env = probe.environment()
        self.assertNotIn('CODEX_API_KEY', env)
        self.assertNotIn('HOME', env)
        self.assertEqual(env['PATH'], '/usr/bin:/bin')
        self.assertEqual(env['DBUS_SESSION_BUS_ADDRESS'], 'unix:path=/run/user/1000/bus')

    def test_readable_wrong_limits_or_leaf_never_dispatch(self):
        for key, value in [('memory.max', 'max'), ('memory.max', '2147483647'),
                           ('memory.swap.max', '1'), ('pids.max', '65'), ('leaf', '/another')]:
            facts = self.samples()[0]['facts']
            facts[key] = value
            frames = []
            with self.assertRaisesRegex(ValueError, 'PRE_DISPATCH_RESOURCE_READBACK_MISMATCH'):
                probe.dispatch_after_readback(self.unit, facts, 'version', frames.append)
            self.assertEqual(frames, [])

    def test_missing_readback_never_dispatches(self):
        for key in self.samples()[0]['facts']:
            facts = self.samples()[0]['facts']
            del facts[key]
            frames = []
            with self.assertRaisesRegex(ValueError, 'PRE_DISPATCH_RESOURCE_READBACK_MISMATCH'):
                probe.dispatch_after_readback(self.unit, facts, 'version', frames.append)
            self.assertEqual(frames, [])

    def test_exact_current_readback_dispatches_single_fixed_start(self):
        frames = []
        probe.dispatch_after_readback(self.unit, self.samples()[0]['facts'], 'version', frames.append)
        self.assertEqual(frames, [{'type': 'start', 'mode': 'version'}])

    def test_worker_dispatch_requires_image_bound_frame_and_limits(self):
        frames = []
        with self.assertRaisesRegex(ValueError, 'WORKER_IMAGE_BOUND_START_REQUIRED'):
            probe.dispatch_after_readback(self.unit, self.samples()[0]['facts'], 'worker-boundary', frames.append)
        self.assertEqual(frames, [])
        bound = {'type': 'start', 'mode': 'worker-boundary', 'helperSha256': {'worker': 'a' * 64}}
        facts = self.samples()[0]['facts']
        facts['pids.max'] = 'max'
        with self.assertRaisesRegex(ValueError, 'PRE_DISPATCH_RESOURCE_READBACK_MISMATCH'):
            probe.dispatch_after_readback(self.unit, facts, 'worker-boundary', frames.append, bound)
        self.assertEqual(frames, [])
        probe.dispatch_after_readback(self.unit, self.samples()[0]['facts'], 'worker-boundary', frames.append, bound)
        self.assertEqual(frames, [bound])


if __name__ == '__main__':
    unittest.main()
