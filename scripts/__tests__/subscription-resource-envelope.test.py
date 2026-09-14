"""Pure offline tests; no CLI execution, cgroup writes or credentials."""
import importlib.util
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('resource_envelope', Path(__file__).parents[1] / 'subscription-resource-envelope.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

MOUNT = '30 20 0:28 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n'
ACCESS = dict(directory=True, procs=True, subtreeControl=True)


class ResourcesTests(unittest.TestCase):
    def raw(self):
        return {'cgroup.controllers': 'memory pids cpu\n', 'cgroup.subtree_control': 'memory pids\n',
                'cgroup.type': 'domain\n', 'cgroup.procs': '', 'cgroup.events': 'populated 0\nfrozen 0\n',
                'memory.max': 'max\n', 'memory.swap.max': 'max\n', 'pids.max': 'max\n',
                'memory.current': '0\n', 'pids.current': '0\n'}

    def assess(self, raw=None, mount=MOUNT, member='0::/user.slice/test.scope\n', access=None):
        return probe.assess(self.raw() if raw is None else raw, mount, member, ACCESS if access is None else access)

    def test_discovery_never_grants_enforcement_or_production_credit(self):
        result = self.assess()
        self.assertEqual(result['discoveryStatus'], 'PASS')
        self.assertFalse(result['productionReady'])
        self.assertEqual(result['enforcementStatus'], 'NOT_RUN')
        self.assertEqual(result['delegationStatus'], 'NOT_VERIFIED')
        self.assertIsNone(result['facts']['memory.max'])

    def test_each_required_metadata_file_is_required(self):
        for key in probe.FILES:
            raw = self.raw()
            del raw[key]
            self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL', key)

    def test_extra_files_rejected(self):
        raw = self.raw()
        raw['auth.json'] = 'never read'
        self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL')

    def test_missing_controller_activation_and_access_rejected(self):
        for key in ('cgroup.controllers', 'cgroup.subtree_control'):
            raw = self.raw()
            raw[key] = 'memory'
            self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL')
        for key in ACCESS:
            self.assertEqual(self.assess(access={**ACCESS, key: False})['discoveryStatus'], 'FAIL')
        self.assertEqual(self.assess(access={**ACCESS, 'procs': 1})['discoveryStatus'], 'FAIL')

    def test_internal_process_and_threaded_parent_rejected(self):
        for key, value in [('cgroup.procs', '123\n'), ('cgroup.type', 'threaded')]:
            raw = self.raw()
            raw[key] = value
            self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL')

    def test_nonunified_ambiguous_partial_and_readonly_mount_rejected(self):
        for mount in (MOUNT.replace('cgroup2', 'tmpfs'), MOUNT + MOUNT,
                      MOUNT.replace(' / /sys', ' /delegated /sys'),
                      MOUNT.replace(' rw,nosuid', ' ro,nosuid'),
                      MOUNT.replace(' cgroup rw', ' cgroup ro'), 'bad\n'):
            self.assertEqual(self.assess(mount=mount)['discoveryStatus'], 'FAIL')

    def test_membership_traversal_and_hybrid_rejected(self):
        for member in ('0::/../private\n', '0::/a/./b', '0::/ok\n1:cpu:/x\n', '0::/bad\\path', '0::/x\x00'):
            self.assertEqual(self.assess(member=member)['discoveryStatus'], 'FAIL')

    def test_limits_strict_and_bounded(self):
        for value in ('-1', '+2', '01', '1e6', '9223372036854775808', '9' * 70000, True, None):
            raw = self.raw()
            raw['memory.max'] = value
            self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL', repr(value)[:30])
        for field in ('memory.max', 'memory.swap.max', 'pids.max'):
            raw = self.raw()
            raw[field] = '1024\n'
            self.assertEqual(self.assess(raw)['facts'][field], 1024)

    def test_events_duplicates_missing_and_unknown_rejected(self):
        for value in ('', 'populated 0\npopulated 1', 'populated 2', 'other 0', 'populated 0 1'):
            raw = self.raw()
            raw['cgroup.events'] = value
            self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL')

    def test_line_and_controller_bounds(self):
        for value in ('pids pids memory', 'memory +pids', 'memory\n' * 513):
            raw = self.raw()
            raw['cgroup.controllers'] = value
            self.assertEqual(self.assess(raw)['discoveryStatus'], 'FAIL')

    def test_reader_rejects_overflow_and_handles_partial_reads(self):
        with patch.object(probe.os, 'read', side_effect=[b'abc', b'def', b'']):
            self.assertEqual(probe.read_fd(7), 'abcdef')
        with patch.object(probe.os, 'read', return_value=b'x' * 8192):
            with self.assertRaisesRegex(ValueError, 'METADATA_SIZE'):
                probe.read_fd(7)

    def test_proc_reader_rejects_arbitrary_path_before_open(self):
        with patch.object(probe.os, 'open') as opened:
            with self.assertRaisesRegex(ValueError, 'FIXED_PROC_ONLY'):
                probe.fixed_proc('../../home/auth.json')
            opened.assert_not_called()

    def test_fstatfs_checks_actual_filesystem_magic_and_errors(self):
        class Libc:
            magic = 0x63677270
            result = 0

            def fstatfs(self, fd, pointer):
                pointer._obj[0] = self.magic
                return self.result

        libc = Libc()
        with patch.object(probe.ctypes, 'CDLL', return_value=libc):
            probe.require_cgroup2(7)
            libc.magic = 0x01021994  # tmpfs is not resource enforcement.
            with self.assertRaisesRegex(ValueError, 'CGROUP2_FILESYSTEM_REQUIRED'):
                probe.require_cgroup2(7)
            libc.result = -1
            with self.assertRaises(OSError):
                probe.require_cgroup2(7)


if __name__ == '__main__':
    unittest.main()
