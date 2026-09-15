"""Fixed synthetic OS checks. No host paths, credentials or external requests."""
import json
import os
import errno
from pathlib import Path
import socket
import stat
import ctypes

def identity(descriptor):
    info = os.fstat(descriptor)
    return {'dev': info.st_dev, 'ino': info.st_ino, 'type': stat.S_IFMT(info.st_mode)}

status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
facts = {key: status[key].strip() for key in ['CapEff', 'CapBnd', 'NoNewPrivs']}
def private_read(path):
    try:
        matches = Path(path).read_text() == 'synthetic-private-control'
        return {'allowed': True, 'matches': matches, 'errno': None}
    except OSError as error:
        return {'allowed': False, 'matches': None, 'errno': error.errno}

facts['privateRead'] = private_read('/private/sentinel')
facts['privateAliasRead'] = private_read('/work/private-alias')
try:
    facts['publicControlReadable'] = Path('/work/public-sentinel').read_text() == 'synthetic-public-control'
except OSError:
    facts['publicControlReadable'] = False
facts['pidNamespace'] = os.readlink('/proc/self/ns/pid')
facts['mountNamespace'] = os.readlink('/proc/self/ns/mnt')
facts['supervisorMountNamespace'] = os.environ['RC_PROBE_SUPERVISOR_MOUNT_NS']
facts['supervisorPidNamespace'] = os.environ['RC_PROBE_SUPERVISOR_PID_NS']
facts['supervisorOutputIdentity'] = {'dev': int(os.environ['RC_PROBE_OUTPUT_DEV']), 'ino': int(os.environ['RC_PROBE_OUTPUT_INO']),
                                     'type': int(os.environ['RC_PROBE_OUTPUT_TYPE'])}
facts['ownOutputIdentity'] = identity(1)
try:
    facts['initPidNamespace'] = os.readlink('/proc/1/ns/pid')
except OSError:
    facts['initPidNamespace'] = None
proc_mounts = [line for line in Path('/proc/self/mountinfo').read_text().splitlines()
               if line.split(' - ', 1)[1].split()[0] == 'proc']
facts['procMountpoints'] = [line.split()[4] for line in proc_mounts]
facts['procPropagationPrivate'] = not any(field.startswith(('shared:', 'master:'))
    for line in proc_mounts for field in line.split(' - ', 1)[0].split()[6:])
facts['stackedProcMountCount'] = len(proc_mounts)
facts['inheritedDescriptors'] = []
for entry in list(Path('/proc/self/fd').iterdir()):
    try:
        facts['inheritedDescriptors'].append(identity(int(entry.name)))
    except OSError:
        pass
for name in ['usr', 'work']:
    try:
        Path('/' + name + '/synthetic-write-probe').write_text('synthetic')
    except OSError as error:
        facts[name + 'Write'] = {'allowed': False, 'errno': error.errno}
    else:
        facts[name + 'Write'] = {'allowed': True, 'errno': None}
try:
    descriptor = os.open('/proc/1/fd/1', os.O_WRONLY)
    facts['openedOutputIdentity'] = identity(descriptor)
    os.close(descriptor)
    facts['parentOutputDenied'] = False
    facts['parentOutputErrno'] = None
except OSError as error:
    facts['openedOutputIdentity'] = None
    facts['parentOutputDenied'] = error.errno in (errno.EACCES, errno.EPERM)
    facts['parentOutputErrno'] = error.errno
try:
    with socket.socket() as connection:
        connection.settimeout(0.2)
        # TEST-NET address in an isolated namespace containing only loopback.
        connection.connect(('192.0.2.1', 443))
        facts['networkConnect'] = {'allowed': True, 'errno': None}
except OSError as error:
    facts['networkConnect'] = {'allowed': False, 'errno': error.errno}
facts['procUnmountProbe'] = {'attempted': False, 'errno': None, 'succeeded': None}
if (facts['pidNamespace'] != facts['supervisorPidNamespace'] and
        facts['mountNamespace'] != facts['supervisorMountNamespace'] and facts['procPropagationPrivate']):
    libc = ctypes.CDLL(None, use_errno=True)
    result = libc.umount2(b'/proc', 2)
    facts['procUnmountProbe'] = {'attempted': True, 'succeeded': result == 0,
                                 'errno': ctypes.get_errno() if result != 0 else None}
# No further filesystem inspection after this negative test. Unexpected success
# is a failed probe; never peel a second layer or remount anything.
print(json.dumps(facts, sort_keys=True))
