"""Offline cBPF policy tests. These do not claim kernel enforcement."""
import ctypes
import errno
import importlib.util
from pathlib import Path
import struct
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('worker_lockdown', Path(__file__).parents[1] / 'subscription-worker-lockdown.py')
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def evaluate(nr, arg0=0, arch=0xC000003E):
    # Independent interpreter for the emitted cBPF subset and seccomp_data ABI.
    data = struct.pack('<IIQQQQQQQ', nr & 0xFFFFFFFF, arch, 0, arg0, 0, 0, 0, 0, 0)
    program = p.build_filter()
    pc, accumulator = 0, 0
    for _ in range(4096):
        code, jt, jf, k = program[pc]
        if code == 0x20:
            accumulator = struct.unpack_from('<I', data, k)[0]
        elif code in (0x15, 0x35, 0x45):
            condition = accumulator == k if code == 0x15 else accumulator >= k if code == 0x35 else bool(accumulator & k)
            pc += jt if condition else jf
        elif code == 0x06:
            return k
        else:
            raise AssertionError('Unexpected opcode')
        pc += 1
    raise AssertionError('Nonterminating filter')


class WorkerLockdownTests(unittest.TestCase):
    def test_required_syscalls_are_denied_independent_of_pointer_arguments(self):
        for nr in (101, 155, 161, 165, 166, 272, 304, 308, 310, 311, 321,
                   425, 426, 427, 428, 429, 430, 431, 432, 433, 438, 442):
            for arg in (0, 0xFFFFFFFFFFFFFFFF):
                with self.subTest(nr=nr, arg=arg):
                    self.assertEqual(evaluate(nr, arg), 0x50001)

    def test_namespace_clone_flags_rejected_alone_and_with_thread_flags(self):
        for flag in (0x80, 0x20000, 0x2000000, 0x4000000, 0x8000000,
                     0x10000000, 0x20000000, 0x40000000):
            for ordinary in (0, 17, 0x100 | 0x200 | 0x400 | 0x800 | 0x10000):
                with self.subTest(flag=flag, ordinary=ordinary):
                    self.assertEqual(evaluate(56, flag | ordinary), 0x50001)

    def test_plain_fork_thread_clone_and_exec_allowed(self):
        for nr in (0, 1, 9, 57, 58, 59, 60, 61, 202, 231, 322):
            self.assertEqual(evaluate(nr), 0x7FFF0000)
        for flags in (17, 0x100 | 0x200 | 0x400 | 0x800 | 0x10000, 0x100000000 | 17):
            self.assertEqual(evaluate(56, flags), 0x7FFF0000)

    def test_clone3_is_enosys_including_pointer_to_uninspectable_flags(self):
        self.assertEqual(evaluate(435, 0x12345678), 0x50000 | 38)

    def test_linux_errno_encoding_is_independent_of_offline_host(self):
        before = p.build_filter()
        with patch.object(p.errno, 'ENOSYS', 40), patch.object(p.errno, 'EPERM', 999):
            self.assertEqual(p.build_filter(), before)
            self.assertEqual(evaluate(435), 0x50000 | 38)
            self.assertEqual(evaluate(272), 0x50001)

    def test_foreign_arch_int80_kills_even_allowed_syscalls(self):
        for arch in (0x40000003, 0xC00000B7, 0, 0x4000003E):
            self.assertEqual(evaluate(1, arch=arch), 0x80000000)

    def test_x32_legacy_aliases_and_negative_numbers_kill(self):
        for nr in (*range(512, 548), 0x40000000, 0x40000000 | 56, -1, 0xFFFFFFFF):
            self.assertEqual(evaluate(nr), 0x80000000)

    def test_filter_has_only_valid_forward_jumps_and_abi_loads(self):
        program = p.build_filter()
        self.assertLess(len(program), 4096)
        for index, (code, jt, jf, k) in enumerate(program):
            self.assertEqual(len(struct.pack('<HBBI', code, jt, jf, k)), 8)
            if code in (0x15, 0x35, 0x45):
                self.assertLess(index + 1 + jt, len(program))
                self.assertLess(index + 1 + jf, len(program))
            if code == 0x20:
                self.assertIn(k, (0, 4, 16))
        for nr in range(512):
            self.assertIn(evaluate(nr), (0x7FFF0000, 0x50001, 0x50000 | 38))

    def test_unsupported_runtime_rejected_before_libc(self):
        cases = [('win32', 'x86_64', 8, 'little'), ('linux', 'aarch64', 8, 'little'),
                 ('linux', 'x86_64', 4, 'little'), ('linux', 'x86_64', 8, 'big')]
        for system, machine, size, order in cases:
            with patch.object(p.sys, 'platform', system), patch.object(p.platform, 'machine', return_value=machine), patch.object(p.ctypes, 'sizeof', return_value=size), patch.object(p.sys, 'byteorder', order), patch.object(p.ctypes, 'CDLL') as libc:
                with self.assertRaisesRegex(RuntimeError, 'UNSUPPORTED_ABI'):
                    p.install_worker_lockdown()
                libc.assert_not_called()

    def test_install_failure_and_positive_tsync_tid_fail_closed(self):
        for result in (-1, 77):
            with patch.object(p, 'require_supported_abi'), patch.object(p.ctypes, 'CDLL') as factory:
                factory.return_value.prctl.return_value = 0
                factory.return_value.syscall.return_value = result
                with self.assertRaisesRegex(RuntimeError, 'FILTER_FAILED'):
                    p.install_worker_lockdown()

    def test_nnp_failure_never_installs_filter(self):
        with patch.object(p, 'require_supported_abi'), patch.object(p.ctypes, 'CDLL') as factory:
            factory.return_value.prctl.return_value = -1
            with self.assertRaises(OSError):
                p.install_worker_lockdown()
            factory.return_value.syscall.assert_not_called()

    def test_readbacks_required_and_receipt_is_deterministic(self):
        for nnp, mode in ((0, 2), (1, 0), (-1, -1), (1, 2)):
            with patch.object(p, 'require_supported_abi'), patch.object(p.ctypes, 'CDLL') as factory:
                factory.return_value.prctl.side_effect = [0, nnp, mode]
                factory.return_value.syscall.return_value = 0
                if (nnp, mode) != (1, 2):
                    with self.assertRaisesRegex(RuntimeError, 'READBACK_FAILED'):
                        p.install_worker_lockdown()
                else:
                    result = p.install_worker_lockdown()
                    self.assertEqual(result['seccompMode'], 2)
                    self.assertEqual(len(result['filterSha256']), 64)
                    self.assertTrue(result['threadSync'])
                    args = factory.return_value.syscall.call_args.args
                    self.assertEqual([arg.value for arg in args[:3]], [317, 1, 1])


if __name__ == '__main__':
    unittest.main()
