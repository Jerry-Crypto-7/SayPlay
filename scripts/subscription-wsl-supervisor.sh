#!/bin/sh
# OFFLINE ONLY. Invoke inside the validated user/mount/net/pid namespace.
set -eu
work=$(realpath "$1")
supervisor=$(realpath "$2")
case "$work" in /mnt/d/claude/Hackaton/scratch/subscription-wsl-supervisor/*) ;; *) exit 64 ;; esac
case "$supervisor" in /mnt/d/claude/Hackaton/scripts/subscription-wsl-supervisor.py) ;; *) exit 64 ;; esac
# This report descriptor is the only host write capability kept by PID 1.
exec 3>"$work/supervisor-audit.jsonl"
mount --make-rprivate /
mount -t tmpfs -o nosuid,nodev tmpfs /tmp
root=$(mktemp -d /tmp/rc-supervisor.XXXXXX)
mkdir "$root/usr" "$root/proc" "$root/work" "$root/dev"
mount -t tmpfs -o nosuid,nodev tmpfs "$root/usr"
mkdir "$root/usr/bin" "$root/usr/lib" "$root/usr/lib64"
ln -s usr/bin "$root/bin"
ln -s usr/lib "$root/lib"
ln -s usr/lib64 "$root/lib64"
cp -L /usr/bin/python3 /usr/bin/setpriv "$root/usr/bin/"
stdlib=$(/usr/bin/python3 -I -S -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')
case "$stdlib" in /usr/lib/python3.[0-9]*) ;; *) exit 64 ;; esac
cp -R "$stdlib" "$root/usr/lib/"
ldd /usr/bin/python3 /usr/bin/setpriv "$stdlib"/lib-dynload/*.so |
  awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' | sort -u |
  while IFS= read -r library; do
    mkdir -p "$root$(dirname "$library")"
    cp -L "$library" "$root$library"
  done
mount -t tmpfs -o remount,ro,nosuid,nodev tmpfs "$root/usr"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
cp "$supervisor" "$root/supervisor.py"
touch "$root/dev/null"
exec /usr/sbin/chroot "$root" /usr/bin/python3 -I -S /supervisor.py
