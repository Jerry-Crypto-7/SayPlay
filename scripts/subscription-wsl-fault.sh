#!/bin/sh
# Offline only. Run inside unshare --user --map-root-user --mount --net --pid --fork.
# Arguments are an isolated artifact label and the Python simulator.
set -eu
work=$(realpath "$1")
simulator=$(realpath "$2")
mode=${3:-timeout}
case "$work" in /mnt/d/claude/Hackaton/scratch/subscription-wsl-fault/*) ;; *) exit 64 ;; esac
case "$simulator" in /mnt/d/claude/Hackaton/scripts/subscription-wsl-fault.py) ;; *) exit 64 ;; esac
case "$mode" in timeout) ;; wrapper-abort) exec 3>"$work/wrapper-audit.jsonl" ;; *) exit 64 ;; esac
mount --make-rprivate /
mount -t tmpfs -o nosuid,nodev tmpfs /tmp
root=$(mktemp -d /tmp/rc-sandbox.XXXXXX)
mkdir "$root/usr" "$root/proc" "$root/work" "$root/dev"
mount -t tmpfs -o nosuid,nodev tmpfs "$root/usr"
mkdir "$root/usr/bin" "$root/usr/lib" "$root/usr/lib64"
ln -s usr/bin "$root/bin"
ln -s usr/lib "$root/lib"
ln -s usr/lib64 "$root/lib64"
cp -L /usr/bin/python3 /usr/bin/timeout "$root/usr/bin/"
stdlib=$(/usr/bin/python3 -I -S -c 'import sysconfig; print(sysconfig.get_path("stdlib"))')
case "$stdlib" in /usr/lib/python3.[0-9]*) ;; *) exit 64 ;; esac
cp -R "$stdlib" "$root/usr/lib/"
# Copy only the two system executables, system Python stdlib, and linked libs.
# No host filesystem bind, user directory, environment, or network is exposed.
ldd /usr/bin/python3 /usr/bin/timeout "$stdlib"/lib-dynload/*.so |
  awk '$2 == "=>" && $3 ~ /^\// { print $3 } $1 ~ /^\// && $1 !~ /:$/ { print $1 }' | sort -u |
  while IFS= read -r library; do
    mkdir -p "$root$(dirname "$library")"
    cp -L "$library" "$root$library"
  done
mount -t tmpfs -o remount,ro,nosuid,nodev tmpfs "$root/usr"
mount -t proc -o nosuid,nodev,noexec proc "$root/proc"
cp "$simulator" "$root/runner.py"
touch "$root/dev/null"
exec /usr/sbin/chroot "$root" /usr/bin/python3 -I -S /runner.py "$mode"
