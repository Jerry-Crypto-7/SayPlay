"""Fixed post-bwrap worker entry; not a generic command launcher."""
import importlib.util
import errno
import os
import re
import sys

WORK = '/work/exec-worker'
ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/exec-worker-probe.py']

CONTROL_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-control-boundary-probe.py']
CGROUP_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-cgroup-worker-probe.py']
TRUSTED_CLI_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-cli-worker-probe.py']
STRESS_ARGV = {phase: ['/usr/bin/python3', '-I', '-S', '/usr/bin/candidate-resource-stress-worker.py', '--inside-' + phase]
               for phase in ('tasks', 'memory')}
INGRESS_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-ingress-worker-probe.py']
HTTP_INGRESS_ARGV = ['/usr/bin/python3', '-I', '-S', '/usr/bin/trusted-http-worker-probe.py']


def main():
    selectors = {(): ARGV, ('--trusted-control-boundary',): CONTROL_ARGV,
                 ('--trusted-ingress-boundary',): INGRESS_ARGV,
                 ('--trusted-http-ingress-boundary',): HTTP_INGRESS_ARGV,
                 ('--trusted-cgroup-worker-boundary',): CGROUP_ARGV,
                 ('--trusted-cli-worker-boundary',): TRUSTED_CLI_ARGV,
                 ('--candidate-resource-stress-tasks',): STRESS_ARGV['tasks'],
                 ('--candidate-resource-stress-memory',): STRESS_ARGV['memory']}
    if sys.platform != 'linux' or tuple(sys.argv[1:]) not in selectors: raise ValueError('FIXED_WORKER_ENTRY_REQUIRED')
    argv = selectors[tuple(sys.argv[1:])]
    namespaces = {}
    for kind, key in (('pid', 'RC_EXEC_OUTER_PID_NS'), ('mnt', 'RC_EXEC_OUTER_MOUNT_NS')):
        expected = os.environ.get(key, '')
        current = os.readlink('/proc/self/ns/' + kind)
        if not re.fullmatch(kind + r':\[[0-9]+\]', expected) or not re.fullmatch(kind + r':\[[0-9]+\]', current) or current == expected:
            raise ValueError('POST_SANDBOX_NAMESPACE_REQUIRED')
        namespaces[kind] = current
    # A new PID namespace alone does not exclude bwrap's inherited-proc fallback.
    # PID 1 visible through this proc mount must belong to our new PID namespace.
    if os.readlink('/proc/1/ns/pid') != namespaces['pid']:
        raise ValueError('PRIVATE_PROC_VIEW_REQUIRED')
    if not os.statvfs('/usr/bin').f_flag & os.ST_RDONLY: raise ValueError('READONLY_WORKER_IMAGE_REQUIRED')
    spec = importlib.util.spec_from_file_location('fixed_executor_lockdown', '/usr/bin/worker-lockdown.py')
    if spec is None or spec.loader is None: raise ValueError('READONLY_LOCKDOWN_REQUIRED')
    lockdown = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(lockdown)
    lockdown.install_worker_lockdown()
    # Close every nonstandard descriptor observed in this already-private /proc.
    for entry in os.listdir('/proc/self/fd'):
        if entry.isdecimal() and int(entry) > 2:
            try: os.close(int(entry))
            except OSError as error:
                if error.errno != errno.EBADF: raise
    os.chdir(WORK)
    os.execve(argv[0], argv, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': WORK, 'TMPDIR': WORK + '/tmp'})


if __name__ == '__main__':
    main()
