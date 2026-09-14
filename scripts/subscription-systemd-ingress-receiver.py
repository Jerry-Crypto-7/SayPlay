"""Fixed one-shot systemd pre-unshare SCM_RIGHTS receiver, Linux only."""
import array
import errno
import json
import os
from pathlib import Path
import re
import select
import signal
import socket
import stat
import struct
import sys
import time

FD = 198
SETUP_SECONDS = 5.0
COMMAND = ('/usr/bin/timeout', '--signal=TERM', '--kill-after=5', '200', '/usr/bin/unshare',
    '--user', '--map-current-user', '--keep-caps', '--mount', '--net', '--pid', '--uts', '--fork',
    '/bin/sh', '/mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.sh', '--trusted-ingress-fd')


HTTP_COMMAND = (*COMMAND[:-1], '--trusted-http-ingress-fd')


def fixed_command(expected):
    profile = expected.get('profile', 'ingress')
    if profile not in ('ingress', 'http'): raise ValueError('FIXED_RECEIVER_PROFILE_REQUIRED')
    return HTTP_COMMAND if profile == 'http' else COMMAND


def arguments(argv):
    if len(argv) != 7 or argv[0] not in ('--handoff', '--http-handoff'): raise ValueError('FIXED_RECEIVER_ARGUMENTS')
    uid, nonce, pid, ticks, dev, ino = argv[1:]
    if not re.fullmatch('[0-9a-f]{32}', uid) or not re.fullmatch('[0-9a-f]{32}', nonce): raise ValueError('FIXED_RECEIVER_IDENTITY')
    if any(not re.fullmatch('[1-9][0-9]{0,18}', value) for value in (pid, ticks, ino)) or not re.fullmatch('0|[1-9][0-9]{0,18}', dev): raise ValueError('FIXED_RECEIVER_NUMBERS')
    if not 2 <= int(pid) <= 2147483647: raise ValueError('CONTROLLER_PID_REQUIRED')
    result = {'uuid': uid, 'nonce': nonce, 'controllerPid': int(pid), 'controllerStartTicks': ticks,
        'socketDev': int(dev), 'socketIno': int(ino)}
    if argv[0] == '--http-handoff': result['profile'] = 'http'
    return result


def check_time(deadline):
    if time.monotonic() >= deadline: raise TimeoutError('RECEIVER_SETUP_DEADLINE')


def metadata(pid):
    parts = Path(f'/proc/{pid}/stat').read_text().rsplit(') ', 1)[1].split()
    groups = Path(f'/proc/{pid}/cgroup').read_text().splitlines()
    if len(parts) < 20 or len(groups) != 1 or not groups[0].startswith('0::/'): raise ValueError('PROCESS_METADATA_REQUIRED')
    return {'startTicks': parts[19], 'cgroup': groups[0][3:]}


def path_identity(expected):
    uid = os.getuid()
    directory = f'/run/user/{uid}/rc-ingress-{expected["uuid"]}'
    paths = ['/run', '/run/user', f'/run/user/{uid}', directory, directory + '/handoff.sock']
    values = []
    for index, path in enumerate(paths):
        value = os.lstat(path)
        if not (stat.S_ISSOCK(value.st_mode) if index == 4 else stat.S_ISDIR(value.st_mode)): raise ValueError('RENDEZVOUS_PATH_TYPE')
        if index >= 2 and value.st_uid != uid: raise ValueError('RENDEZVOUS_PATH_OWNER')
        if index == 3 and stat.S_IMODE(value.st_mode) != 0o700: raise ValueError('RENDEZVOUS_DIRECTORY_MODE')
        if index == 4 and stat.S_IMODE(value.st_mode) != 0o600: raise ValueError('RENDEZVOUS_SOCKET_MODE')
        values.append((value.st_dev, value.st_ino, value.st_mode, value.st_uid))
    if values[-1][:2] != (expected['socketDev'], expected['socketIno']): raise ValueError('RENDEZVOUS_SOCKET_IDENTITY')
    return paths[-1], values


def peer_identity(channel, expected, pin, initial=None):
    raw = channel.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12)
    if len(raw) != 12: raise ValueError('PEER_CREDENTIAL_SIZE')
    pid, uid, gid = struct.unpack('=3i', raw)
    if pid != expected['controllerPid'] or uid != os.getuid() or gid != os.getgid(): raise ValueError('CONTROLLER_PEER_IDENTITY')
    signal.pidfd_send_signal(pin, 0)
    current = metadata(pid)
    if current['startTicks'] != expected['controllerStartTicks'] or (initial is not None and current != initial): raise ValueError('CONTROLLER_GENERATION_CHANGED')
    own = metadata(os.getpid())
    if not own['cgroup'].endswith('/codex-cli-resource-' + expected['uuid'] + '.service'): raise ValueError('OWN_UNIT_CGROUP_REQUIRED')
    if current['cgroup'] == own['cgroup'] or current['cgroup'].startswith(own['cgroup'] + '/'): raise ValueError('CONTROLLER_INSIDE_UNIT')
    signal.pidfd_send_signal(pin, 0)
    return current


def send_frame(channel, frame, deadline):
    raw = (json.dumps(frame, separators=(',', ':'), allow_nan=False) + '\n').encode()
    if len(raw) > 1024: raise ValueError('FRAME_LIMIT')
    offset = 0
    while offset < len(raw):
        check_time(deadline)
        try: count = channel.send(raw[offset:])
        except BlockingIOError: select.select([], [channel], [], 0.01); continue
        if count <= 0: raise OSError('CHANNEL_CLOSED')
        offset += count
    check_time(deadline)


def receive_offer(channel, expected, deadline):
    raw = bytearray()
    while not raw.endswith(b'\n'):
        check_time(deadline)
        try: part = channel.recv(1)
        except BlockingIOError: select.select([channel], [], [], 0.01); continue
        if not part or len(raw) >= 1024: raise ValueError('OFFER_LIMIT_OR_EOF')
        raw.extend(part)
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('DUPLICATE_KEY')
            result[key] = value
        return result
    value = json.loads(raw, object_pairs_hook=pairs)
    if type(value) is not dict or set(value) != {'version', 'type', 'uuid', 'nonce', 'socket'} or type(value['version']) is not int or value['version'] != 1 or value['type'] != 'fd_offer' or value['uuid'] != expected['uuid'] or value['nonce'] != expected['nonce']: raise ValueError('FIXED_FD_OFFER')
    info = value['socket']
    if type(info) is not dict or set(info) != {'dev', 'ino', 'type', 'family', 'socketType'} or any(type(v) is not int for v in info.values()) or info['dev'] < 0 or info['ino'] <= 0 or (info['type'], info['family'], info['socketType']) != (49152, 1, 1): raise ValueError('FIXED_INGRESS_IDENTITY')
    check_time(deadline)
    return info


def receive_fd(channel, deadline):
    received = []
    try:
        while True:
            check_time(deadline)
            try: raw, ancillary, flags, _ = channel.recvmsg(1, socket.CMSG_SPACE(64), socket.MSG_CMSG_CLOEXEC | socket.MSG_DONTWAIT)
            except BlockingIOError: select.select([channel], [], [], 0.01); continue
            break
        malformed = False
        for level, kind, body in ancillary:
            if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
                values = array.array('i')
                count = len(body) - len(body) % values.itemsize
                values.frombytes(body[:count]); received.extend(values)
                malformed |= count != len(body)
            else: malformed = True
        if raw != b'F' or flags & (socket.MSG_TRUNC | socket.MSG_CTRUNC) or malformed or len(ancillary) != 1 or len(received) != 1: raise ValueError('EXACT_ONE_FD_REQUIRED')
        check_time(deadline)
        return received.pop()
    finally:
        close_error = None
        for fd in received:
            try: os.close(fd)
            except OSError as error: close_error = error
        if close_error is not None: raise close_error


def reserve_fd(received, expected):
    import fcntl
    if os.get_inheritable(received): raise ValueError('RECEIVED_FD_MUST_BE_CLOEXEC')
    value = os.fstat(received)
    if not stat.S_ISSOCK(value.st_mode) or (value.st_dev, value.st_ino) != (expected['dev'], expected['ino']): raise ValueError('RECEIVED_SOCKET_IDENTITY')
    wrapper = socket.socket(fileno=received)
    try:
        if wrapper.family != socket.AF_UNIX or wrapper.getsockopt(socket.SOL_SOCKET, socket.SO_TYPE) != socket.SOCK_STREAM or wrapper.getsockopt(socket.SOL_SOCKET, socket.SO_ACCEPTCONN): raise ValueError('RECEIVED_SOCKET_KIND')
        wrapper.getpeername()
    finally: wrapper.detach()
    if received == FD: return FD
    try: os.fstat(FD)
    except OSError as error:
        if error.errno != errno.EBADF: raise
    else: raise ValueError('FD198_OCCUPIED')
    actual = fcntl.fcntl(received, fcntl.F_DUPFD_CLOEXEC, FD)
    if actual != FD: os.close(actual); raise ValueError('FD198_RACED')
    return actual


def run(expected):
    command = fixed_command(expected)
    deadline = time.monotonic() + SETUP_SECONDS
    channel = None; pin = None; received = None; fixed = None
    try:
        path, identity = path_identity(expected)
        channel = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        channel.set_inheritable(False); channel.settimeout(max(0.001, deadline - time.monotonic()))
        check_time(deadline)
        channel.connect(path); check_time(deadline); channel.setblocking(False)
        if path_identity(expected) != (path, identity): raise ValueError('RENDEZVOUS_CHANGED')
        pin = os.pidfd_open(expected['controllerPid'])
        initial = peer_identity(channel, expected, pin)
        send_frame(channel, {'version': 1, 'type': 'receiver_hello', 'uuid': expected['uuid'], 'nonce': expected['nonce'],
            'pid': os.getpid(), 'startTicks': metadata(os.getpid())['startTicks']}, deadline)
        offer = receive_offer(channel, expected, deadline)
        received = receive_fd(channel, deadline)
        peer_identity(channel, expected, pin, initial)
        if path_identity(expected) != (path, identity): raise ValueError('RENDEZVOUS_CHANGED')
        fixed = reserve_fd(received, offer)
        if received != fixed: os.close(received)
        received = None
        send_frame(channel, {'version': 1, 'type': 'fd_received', 'uuid': expected['uuid'], 'nonce': expected['nonce'], 'fd': FD, 'socket': offer}, deadline)
        peer_identity(channel, expected, pin, initial); check_time(deadline)
        channel.close(); channel = None; os.close(pin); pin = None
        for name in os.listdir('/proc/self/fd'):
            if name.isdecimal() and int(name) > 2 and int(name) != FD:
                try: os.close(int(name))
                except OSError as error:
                    if error.errno != errno.EBADF: raise
        check_time(deadline)
        os.set_inheritable(FD, True)
        os.execve(command[0], command, {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8'})
        raise ValueError('FIXED_EXEC_RETURNED')
    finally:
        close_error = None
        if channel is not None:
            try: channel.close()
            except OSError as error: close_error = error
        for fd in set(value for value in (pin, received, fixed) if value is not None):
            try: os.close(fd)
            except OSError as error: close_error = error
        if close_error is not None: raise close_error


def main():
    if sys.platform != 'linux': raise ValueError('FIXED_LINUX_REQUIRED')
    run(arguments(sys.argv[1:]))


if __name__ == '__main__': main()

