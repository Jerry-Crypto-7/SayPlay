import errno
import importlib.util
from pathlib import Path
from unittest.mock import Mock, patch
import pytest

spec = importlib.util.spec_from_file_location('exec_worker_trampoline_test', Path(__file__).with_name('subscription-exec-server-worker-trampoline.py'))
t = importlib.util.module_from_spec(spec)
spec.loader.exec_module(t)


@pytest.mark.parametrize('control', [False, True, 'ingress', 'http-ingress', 'cgroup', 'trusted-cli', 'tasks', 'memory'])
@pytest.mark.parametrize('failure', [None, 'same-pid', 'same-mount', 'inherited-proc', 'proc-denied', 'no-lockdown', 'close-denied'])
def test_lockdown_after_namespace_admission_before_fixed_exec_without_fd_or_env_leak(failure, control):
    order = []
    lockdown = Mock(install_worker_lockdown=Mock(side_effect=lambda: order.append('lockdown')))
    if failure == 'no-lockdown': lockdown.install_worker_lockdown.side_effect = OSError('denied')
    def close(fd):
        order.append('close')
        if failure == 'close-denied': raise OSError(errno.EPERM, 'denied')
    namespaces = ['pid:[1]' if failure == 'same-pid' else 'pid:[3]', 'mnt:[2]' if failure == 'same-mount' else 'mnt:[4]',
                  OSError(errno.EACCES, 'denied') if failure == 'proc-denied' else 'pid:[1]' if failure == 'inherited-proc' else 'pid:[3]']
    with patch.object(t.sys, 'platform', 'linux'), patch.object(t.sys, 'argv', ['fixed'] + (['--candidate-resource-stress-' + control] if control in ('tasks', 'memory') else ['--trusted-cli-worker-boundary'] if control == 'trusted-cli' else ['--trusted-cgroup-worker-boundary'] if control == 'cgroup' else ['--trusted-http-ingress-boundary'] if control == 'http-ingress' else ['--trusted-ingress-boundary'] if control == 'ingress' else ['--trusted-control-boundary'] if control else [])), \
         patch.dict(t.os.environ, {'RC_EXEC_OUTER_PID_NS': 'pid:[1]', 'RC_EXEC_OUTER_MOUNT_NS': 'mnt:[2]', 'UNTRUSTED_EXTRA': 'fixture'}), \
         patch.object(t.os, 'readlink', side_effect=namespaces), patch.object(t.os, 'ST_RDONLY', 1, create=True), \
         patch.object(t.os, 'statvfs', return_value=Mock(f_flag=1), create=True), \
         patch.object(t.importlib.util, 'spec_from_file_location', return_value=Mock(loader=Mock())), \
         patch.object(t.importlib.util, 'module_from_spec', return_value=lockdown), \
         patch.object(t.os, 'listdir', return_value=['0', '1', '2', '198' if control in ('ingress', 'http-ingress') else '9']), patch.object(t.os, 'close', side_effect=close), \
         patch.object(t.os, 'chdir'), patch.object(t.os, 'execve', side_effect=lambda *_: order.append('exec')) as execute:
        if failure:
            with pytest.raises((ValueError, OSError)): t.main()
            execute.assert_not_called()
            if failure in ('same-pid', 'same-mount', 'inherited-proc', 'proc-denied'):
                lockdown.install_worker_lockdown.assert_not_called()
        else:
            t.main()
            assert order == ['lockdown', 'close', 'exec']
            argv = t.STRESS_ARGV[control] if control in ('tasks', 'memory') else t.TRUSTED_CLI_ARGV if control == 'trusted-cli' else t.CGROUP_ARGV if control == 'cgroup' else t.HTTP_INGRESS_ARGV if control == 'http-ingress' else t.INGRESS_ARGV if control == 'ingress' else t.CONTROL_ARGV if control else t.ARGV
            assert execute.call_args.args == (argv[0], argv,
                {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': '/work/exec-worker', 'TMPDIR': '/work/exec-worker/tmp'})


@pytest.mark.parametrize('args', [['--unknown'], ['--trusted-cli-worker-boundary', 'extra'], ['--trusted-cli-worker-boundary', '--trusted-control-boundary'], ['--trusted-control-boundary', 'extra'],
    ['--candidate-resource-stress-tasks', 'extra'], ['--candidate-resource-stress-memory', '--candidate-resource-stress-tasks'],
    ['--candidate-resource-stress', 'tasks'], ['--inside-memory']])
def test_trampoline_rejects_nonliteral_selector_before_namespace_or_exec(args):
    with patch.object(t.sys, 'platform', 'linux'), patch.object(t.sys, 'argv', ['fixed'] + args), patch.object(t.os, 'readlink') as lookup:
        with pytest.raises(ValueError, match='FIXED_WORKER_ENTRY_REQUIRED'): t.main()
        lookup.assert_not_called()
