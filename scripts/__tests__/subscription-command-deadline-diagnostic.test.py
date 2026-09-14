"""Offline predeclared verbose diagnostic branches; no process execution."""
import base64
import copy
import importlib.util
from pathlib import Path
import sys
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('deadline_fixture', Path(__file__).with_name('subscription-command-deadline.test.py'))
fixture = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixture)
probe = fixture.probe


def chunk(signal, at):
    body = ("/usr/bin/timeout: sending signal " + signal + " to command '/usr/bin/unshare'\n").encode()
    return {'receivedAtMs': at, 'base64': base64.b64encode(body).decode(), 'byteLength': len(body)}


class DiagnosticTests(unittest.TestCase):
    def report(self, killed=False):
        report = fixture.CommandDeadlineTests().report()
        report.update(mode='command-deadline-diagnostic', managerMainPidQueryPhase='before-pidfd-SIGSTOP',
                      commandMainRevalidatedBeforeStop=copy.deepcopy(report['commandMainIdentity']), stderrChunks=[chunk('TERM', 200100)])
        if killed:
            report['manager'].update(Result='signal', ExecMainCode='2', ExecMainStatus='9', ExecMainExitTimestampMonotonic='206000000')
            report['exitCode'] = 255
            report['stderrChunks'].append(chunk('KILL', 205100))
        return report

    def test_predeclared_graceful_and_kill_branches(self):
        for killed in (False, True):
            result = probe.evaluate(self.report(killed))
            self.assertEqual(result['status'], 'PASS')
            self.assertTrue(result['commandTimeoutMeasured'])
            self.assertEqual(result['sustainedUnresponsiveKill'], 'NOT_VALIDATED')

    def test_missing_markers_wrong_order_or_receipt_times_fail(self):
        for chunks in ([], [chunk('TERM', 199999)], [chunk('KILL', 205100)],
                       [chunk('KILL', 200100), chunk('TERM', 205100)],
                       [chunk('TERM', 200100), chunk('KILL', 204999)],
                       [chunk('TERM', 200100), chunk('KILL', 210100)]):
            report = self.report(True)
            report['stderrChunks'] = chunks
            self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_outer_timeout_wrong_main_duration_and_missing_pre_stop_binding_fail(self):
        report = self.report(True)
        report['manager']['Result'] = 'timeout'
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        report = self.report(True)
        report['manager']['ExecMainExitTimestampMonotonic'] = '205999999'
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        report = self.report(True)
        del report['managerMainPidQueryPhase']
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_original_exit124_mode_is_not_reclassified(self):
        report = self.report(True)
        report['mode'] = 'command-deadline'
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')
        self.assertFalse(probe.evaluate(report)['commandTimeoutMeasured'])

    def test_revalidated_main_must_match_original_pinned_identity(self):
        report = self.report(True)
        report['commandMainRevalidatedBeforeStop']['startTicks'] += 1
        self.assertEqual(probe.evaluate(report)['status'], 'FAIL')

    def test_chunk_bounds_and_split_marker_reassembly(self):
        whole = chunk('TERM', 200100)
        body = base64.b64decode(whole['base64'])
        parts = [{'receivedAtMs': at, 'base64': base64.b64encode(part).decode(), 'byteLength': len(part)}
                 for part, at in ((body[:20], 200000), (body[20:], 200100))]
        self.assertEqual(probe.timeout_markers(parts)[0]['receivedAtMs'], 200100)
        for bad in ([{**whole, 'byteLength': 1}], [{**whole, 'receivedAtMs': float('nan')}], [whole] * 129):
            with self.assertRaises(ValueError):
                probe.timeout_markers(bad)

    def test_diagnostic_argv_mode_does_not_change_budgets(self):
        self.assertEqual(probe.fixed_budgets('command-deadline-diagnostic'), probe.fixed_budgets('command-deadline'))


if __name__ == '__main__':
    unittest.main()
