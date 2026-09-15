"""Offline evidence-validation tests; never enter namespaces or launch CLI."""
import copy
import errno
import importlib.util
import json
from pathlib import Path
import unittest
import sys

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location('runtime_probe', Path(__file__).parents[1] / 'subscription-runtime-probe.py')
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class EvidenceTests(unittest.TestCase):
    expected = {'namespace': 'pid:[100]', 'mountNamespace': 'mnt:[100]', 'output': {'dev': 1, 'ino': 10, 'type': 4096}}

    def test_mount_profiles_keep_legacy_default_and_exact_readonly_aliases(self):
        root = ['1', '0', '0:1', '/', '/', 'rw', '-']
        aliases = [['2', '1', '0:2', '/usr' + path, path, 'ro,nosuid,nodev', '-'] for path in ('/bin', '/lib', '/lib64')]
        probe.check_mounts([root])
        probe.check_mounts([root, *aliases], True)
        with self.assertRaisesRegex(AssertionError, 'UNEXPECTED_MOUNT'):
            probe.check_mounts([root, *aliases])
        with self.assertRaises(ValueError):
            probe.check_mounts([root], 1)

    def test_alias_mount_admission_rejects_missing_duplicate_or_writable(self):
        root = ['1', '0', '0:1', '/', '/', 'rw', '-']
        aliases = [['2', '1', '0:2', '/usr' + path, path, 'ro,nosuid,nodev', '-'] for path in ('/bin', '/lib', '/lib64')]
        bad_flags = copy.deepcopy(aliases)
        bad_flags[0][5] = 'rw,nosuid,nodev'
        for values in (aliases[:2], [*aliases, aliases[0]], bad_flags):
            with self.subTest(values=values), self.assertRaisesRegex(AssertionError, 'READONLY_RUNTIME_ALIAS_MOUNT_REQUIRED'):
                probe.check_mounts([root, *values], True)
        with self.assertRaisesRegex(AssertionError, 'UNEXPECTED_MOUNT'):
            probe.check_mounts([root, *aliases, ['3', '1', '0:3', '/', '/extra', 'ro', '-']], True)

    def test_changed_runtime_is_rejected_before_cli_execution(self):
        probe.check_runtime_identity(probe.CLI_SHA256, probe.BWRAP_SHA256)
        with self.assertRaisesRegex(ValueError, 'FIXED_RUNTIME_IDENTITY_MISMATCH'):
            probe.check_runtime_identity('0' * 64, probe.BWRAP_SHA256)
        with self.assertRaisesRegex(ValueError, 'FIXED_RUNTIME_IDENTITY_MISMATCH'):
            probe.check_runtime_identity(probe.CLI_SHA256, '0' * 64)

    def facts(self):
        return {'CapEff': '0000000000000000', 'CapBnd': '0000000000000000', 'NoNewPrivs': '1',
                'usrWrite': {'allowed': False, 'errno': errno.EROFS},
                'workWrite': {'allowed': True, 'errno': None},
                'networkConnect': {'allowed': False, 'errno': errno.ENETUNREACH},
                'parentOutputDenied': True, 'parentOutputErrno': errno.EACCES,
                'supervisorOutputIdentity': self.expected['output'], 'supervisorPidNamespace': self.expected['namespace'],
                'pidNamespace': self.expected['namespace'], 'openedOutputIdentity': None,
                'inheritedDescriptors': [], 'publicControlReadable': True,
                'privateRead': {'allowed': True, 'matches': True, 'errno': None},
                'privateAliasRead': {'allowed': True, 'matches': True, 'errno': None}}

    def checked(self, facts, work=True):
        return probe.checks({'stdout': json.dumps(facts)}, work, self.expected)

    def test_direct_valid_facts(self):
        self.assertTrue(all(self.checked(self.facts()).values()))

    def test_readonly_cli_must_deny_work_write(self):
        facts = self.facts()
        self.assertFalse(all(self.checked(facts, False).values()))
        facts['workWrite'] = {'allowed': False, 'errno': errno.EACCES}
        self.assertTrue(all(self.checked(facts, False).values()))

    def test_zero_exit_or_empty_output_is_not_sandbox_evidence(self):
        for output in ['', '{}', 'null', '[]', 'not json']:
            with self.subTest(output=output):
                self.assertFalse(all(probe.checks({'stdout': output, 'exitCode': 0}, True, self.expected).values()))

    def test_each_positive_fact_is_required(self):
        for key, value in [('CapEff', '0000000000000001'), ('CapBnd', '0000000000000001'),
                           ('NoNewPrivs', '0'), ('parentOutputDenied', False),
                           ('parentOutputErrno', errno.ENOENT)]:
            with self.subTest(key=key):
                facts = self.facts()
                facts[key] = value
                self.assertFalse(all(self.checked(facts).values()))

    def test_unrelated_os_errors_do_not_establish_denial(self):
        for key in ['usrWrite', 'networkConnect']:
            facts = copy.deepcopy(self.facts())
            facts[key] = {'allowed': False, 'errno': errno.ENOENT}
            self.assertFalse(all(self.checked(facts).values()))

    def test_nested_own_output_is_distinct_from_permission_denial(self):
        facts = self.facts()
        own = {'dev': 1, 'ino': 20, 'type': 4096}
        facts.update(pidNamespace='pid:[200]', initPidNamespace='pid:[200]', procMountpoints=['/proc', '/proc'],
                     mountNamespace='mnt:[200]', supervisorMountNamespace='mnt:[100]', procPropagationPrivate=True,
                     procUnmountProbe={'attempted': True, 'succeeded': False, 'errno': errno.EPERM},
                     ownOutputIdentity=own, openedOutputIdentity=own, inheritedDescriptors=[own],
                     parentOutputDenied=False, parentOutputErrno=None)
        self.assertEqual(probe.output_protection(facts, self.expected), 'nested-namespace-own-output')
        for key, value in [('openedOutputIdentity', self.expected['output']),
                           ('inheritedDescriptors', [self.expected['output']]),
                           ('initPidNamespace', 'pid:[100]'), ('procMountpoints', ['/proc', '/outerproc']),
                           ('supervisorPidNamespace', 'pid:[999]'), ('ownOutputIdentity', self.expected['output']),
                           ('mountNamespace', 'mnt:[100]'), ('procPropagationPrivate', False),
                           ('procUnmountProbe', {'attempted': True, 'succeeded': True, 'errno': None})]:
            with self.subTest(key=key):
                bad = copy.deepcopy(facts)
                bad[key] = value
                self.assertIsNone(probe.output_protection(bad, self.expected))

    def test_private_profile_requires_direct_and_alias_denial_with_public_control(self):
        facts = self.facts()
        self.assertFalse(all(probe.checks({'stdout': json.dumps(facts)}, True, self.expected, False).values()))
        for field in ['privateRead', 'privateAliasRead']:
            facts[field] = {'allowed': False, 'matches': None, 'errno': errno.ENOENT}
        self.assertTrue(all(probe.checks({'stdout': json.dumps(facts)}, True, self.expected, False).values()))
        facts['publicControlReadable'] = False
        self.assertFalse(all(probe.checks({'stdout': json.dumps(facts)}, True, self.expected, False).values()))


if __name__ == '__main__':
    unittest.main()
