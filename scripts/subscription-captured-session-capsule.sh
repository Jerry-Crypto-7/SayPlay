#!/bin/sh
# Fixed authored-client / real-worker capsule. No auth, login or inference.
set -eu
[ "$#" -eq 0 ] || exit 64
# Verify that this UTS namespace belongs to the launcher's newly mapped user
# namespace before changing its hostname. No /proc/1 access or host hostname read.
/usr/bin/python3 -I -S - <<'UTS_PY'
import ctypes
import fcntl
import os
from pathlib import Path

mapping = [line.split() for line in Path('/proc/self/uid_map').read_text().splitlines()]
if len(mapping) != 1 or len(mapping[0]) != 3 or not all(value.isdecimal() for value in mapping[0]):
    raise SystemExit('CAPSULE_USER_NAMESPACE_MAPPING_REQUIRED')
inside, outside, count = map(int, mapping[0])
if count != 1 or inside != os.geteuid() or inside != outside:
    raise SystemExit('CAPSULE_MAP_CURRENT_USER_REQUIRED')
fds = []
try:
    uts = os.open('/proc/self/ns/uts', os.O_RDONLY | os.O_CLOEXEC)
    fds.append(uts)
    user = os.open('/proc/self/ns/user', os.O_RDONLY | os.O_CLOEXEC)
    fds.append(user)
    owner = fcntl.ioctl(uts, 0xb701)  # NS_GET_USERNS, returns an owned namespace fd.
    fds.append(owner)
    own_stat, owner_stat = os.fstat(user), os.fstat(owner)
    if (own_stat.st_dev, own_stat.st_ino) != (owner_stat.st_dev, owner_stat.st_ino):
        raise SystemExit('CAPSULE_UTS_OWNER_MISMATCH')
    hostname = b'reality-compiler-probe'
    libc = ctypes.CDLL(None, use_errno=True)
    libc.sethostname.argtypes = [ctypes.c_char_p, ctypes.c_size_t]
    libc.sethostname.restype = ctypes.c_int
    if libc.sethostname(hostname, len(hostname)) != 0:
        raise OSError(ctypes.get_errno(), 'CAPSULE_SETHOSTNAME_FAILED')
    if os.uname().nodename != hostname.decode('ascii'):
        raise SystemExit('CAPSULE_HOSTNAME_READBACK_MISMATCH')
finally:
    for fd in reversed(fds):
        os.close(fd)
UTS_PY
# Home from passwd, not $HOME: the probes launch this capsule under `env -i`.
home=$(getent passwd "$(id -u)" | cut -d: -f6)
cli="$home"/.codex/packages/standalone/releases/0.145.0-x86_64-unknown-linux-musl/bin/codex
[ -f "$cli" ] && [ ! -L "$cli" ] || exit 65
mount --make-rprivate /
mount -t tmpfs -o nosuid,nodev,size=64m tmpfs /tmp
root=$(mktemp -d /tmp/rc-runtime.XXXXXX)
mount --bind "$root" "$root"
mkdir "$root/usr" "$root/proc" "$root/work" "$root/dev" "$root/tmp"
mount -t tmpfs -o nosuid,nodev,size=768m tmpfs "$root/usr"
mkdir "$root/usr/bin" "$root/usr/lib" "$root/usr/lib64"
mkdir "$root/bin" "$root/lib" "$root/lib64"
cp -L /usr/bin/python3 /usr/bin/setpriv "$root/usr/bin/"
cp "$cli" "$root/usr/bin/codex"
cp "$home"/.codex/packages/standalone/releases/0.145.0-x86_64-unknown-linux-musl/codex-resources/bwrap "$root/usr/bin/bwrap"
stdlib=$(/usr/bin/python3 -I -S -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')
case "$stdlib" in /usr/lib/python3.[0-9]*) ;; *) exit 64 ;; esac
cp -R "$stdlib" "$root/usr/lib/"
ldd /usr/bin/python3 /usr/bin/setpriv "$stdlib"/lib-dynload/*.so |
  awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' | sort -u |
  while IFS= read -r library; do
    # Preserve standard runtime roots as real mountpoints. Stock sandbox
    # canonicalization otherwise loses top-level aliases, including PT_INTERP.
    case "$library" in
      /lib/*|/lib64/*) library_target="$root/usr$library" ;;
      *) library_target="$root$library" ;;
    esac
    mkdir -p "$(dirname "$library_target")"
    cp -L "$library" "$library_target"
  done
cp /mnt/d/claude/Hackaton/scripts/subscription-cli-supervisor.py "$root/usr/bin/supervisor.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-runtime-probe.py "$root/usr/bin/runtime_probe.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-tool-capture-runner.py "$root/usr/bin/tool-capture-runner.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-tool-capture-harness.py "$root/usr/bin/tool-capture-harness.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-tool-capture-http.py "$root/usr/bin/tool-capture-http.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-exec-request-capture.py "$root/usr/bin/exec-request-capture.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-text-model-catalog.json "$root/usr/bin/text-model-catalog.json"
cp /mnt/d/claude/Hackaton/scripts/subscription-captured-session-runner.py "$root/usr/bin/captured-session-runner.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-captured-session.py "$root/usr/bin/captured-session.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-captured-worker-transport.py "$root/usr/bin/captured-worker-transport.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-captured-start-adapter.py "$root/usr/bin/captured-start-adapter.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-captured-start.fixture.json "$root/usr/bin/captured-start.fixture.json"
cp /mnt/d/claude/Hackaton/scripts/subscription-appserver-noenv.py "$root/usr/bin/appserver-noenv.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-exec-server-worker-gate.py "$root/usr/bin/exec-server-worker-gate.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-exec-server-worker-trampoline.py "$root/usr/bin/exec-server-worker-trampoline.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-worker-lockdown.py "$root/usr/bin/worker-lockdown.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-exec-worker-probe.py "$root/usr/bin/exec-worker-probe.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-trusted-control-boundary-probe.py "$root/usr/bin/trusted-control-boundary-probe.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-trusted-cli-worker-probe.py "$root/usr/bin/trusted-cli-worker-probe.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-trusted-control-boundary-parent.py "$root/usr/bin/trusted-control-boundary-parent.py"
mount -t tmpfs -o remount,ro,nosuid,nodev,size=768m tmpfs "$root/usr"
for runtime_alias in bin lib lib64; do
  mount --bind "$root/usr/$runtime_alias" "$root/$runtime_alias"
  mount -o remount,bind,ro,nosuid,nodev "$root/$runtime_alias"
done
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
for device in null zero full random urandom; do
  touch "$root/dev/$device"
  mount --bind "/dev/$device" "$root/dev/$device"
done
# bwrap requires this pathname. A null device deliberately provides no access
# to the host controlling terminal; this capsule cannot perform TTY login.
touch "$root/dev/tty"
mount --bind /dev/null "$root/dev/tty"
exec /usr/bin/python3 -I -S "$root/usr/bin/captured-session-runner.py" "$root"
