#!/bin/sh
# Fixed credential-free runtime capsule. No auth, login or inference operation.
set -eu
[ "$#" -eq 0 ] || exit 64
cli=/home/troy/.codex/packages/standalone/releases/0.145.0-x86_64-unknown-linux-musl/bin/codex
[ -f "$cli" ] && [ ! -L "$cli" ] || exit 65
mount --make-rprivate /
mount -t tmpfs -o nosuid,nodev,size=64m tmpfs /tmp
root=$(mktemp -d /tmp/rc-runtime.XXXXXX)
mount --bind "$root" "$root"
mkdir "$root/usr" "$root/proc" "$root/work" "$root/dev" "$root/tmp"
mount -t tmpfs -o nosuid,nodev,size=768m tmpfs "$root/usr"
mkdir "$root/usr/bin" "$root/usr/lib" "$root/usr/lib64"
ln -s usr/bin "$root/bin"
ln -s usr/lib "$root/lib"
ln -s usr/lib64 "$root/lib64"
cp -L /usr/bin/python3 /usr/bin/setpriv "$root/usr/bin/"
cp "$cli" "$root/usr/bin/codex"
cp /home/troy/.codex/packages/standalone/releases/0.145.0-x86_64-unknown-linux-musl/codex-resources/bwrap "$root/usr/bin/bwrap"
stdlib=$(/usr/bin/python3 -I -S -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')
case "$stdlib" in /usr/lib/python3.[0-9]*) ;; *) exit 64 ;; esac
cp -R "$stdlib" "$root/usr/lib/"
ldd /usr/bin/python3 /usr/bin/setpriv "$stdlib"/lib-dynload/*.so |
  awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' | sort -u |
  while IFS= read -r library; do
    mkdir -p "$root$(dirname "$library")"
    cp -L "$library" "$root$library"
  done
cp /mnt/d/claude/Hackaton/scripts/subscription-runtime-probe.py "$root/usr/bin/probe.py"
cp /mnt/d/claude/Hackaton/scripts/subscription-runtime-child-probe.py "$root/usr/bin/child-probe.py"
mount -t tmpfs -o remount,ro,nosuid,nodev,size=768m tmpfs "$root/usr"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
for device in null zero full random urandom; do
  touch "$root/dev/$device"
  mount --bind "/dev/$device" "$root/dev/$device"
done
# bwrap requires this pathname. A null device deliberately provides no access
# to the host controlling terminal; this capsule cannot perform TTY login.
touch "$root/dev/tty"
mount --bind /dev/null "$root/dev/tty"
exec /usr/bin/python3 -I -S "$root/usr/bin/probe.py" "$root"
