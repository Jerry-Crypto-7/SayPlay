"""Fixed metadata service: sample only self, then remain alive for external binding."""
import hashlib
import json
import math
import os
from pathlib import Path
import select
import stat
import sys
import time
import types

FILES = ('subscription-cgroup-common-view.py', 'subscription-cgroup-common-view-child.py')
MAX_REPORT = 512 * 1024
TOTAL_SECONDS = 20
_UNKNOWN = False


def _check(deadline):
    if not math.isfinite(deadline) or time.monotonic() >= deadline:
        raise ValueError('COMMON_VIEW_CHILD_DEADLINE')


def _json(raw):
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result: raise ValueError('COMMON_VIEW_DUPLICATE_KEY')
            result[key] = value
        return result
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(ValueError('COMMON_VIEW_NONFINITE')))


def _line(fd, deadline, limit=1024):
    result = bytearray()
    while True:
        _check(deadline)
        readable, _, _ = select.select([fd], [], [], max(0, deadline-time.monotonic()))
        _check(deadline)
        if not readable: continue
        byte = os.read(fd, 1)
        if not byte: raise ValueError('COMMON_VIEW_CONTROL_EOF')
        result.extend(byte)
        if len(result) > limit: raise ValueError('COMMON_VIEW_CONTROL_LIMIT')
        if byte == b'\n': return bytes(result)


def _write(fd, raw, deadline):
    position = 0
    while position < len(raw):
        _check(deadline)
        _, writable, _ = select.select([], [fd], [], max(0, deadline-time.monotonic()))
        _check(deadline)
        if not writable: continue
        try: count = os.write(fd, raw[position:position+4096])
        except BlockingIOError: continue
        if count <= 0: raise ValueError('COMMON_VIEW_OUTPUT_CLOSED')
        position += count
    _check(deadline)


def _sources(deadline):
    global _UNKNOWN
    folder = Path(__file__).resolve().parent
    result = {}
    for name in FILES:
        _check(deadline)
        fd = os.open(str(folder/name), os.O_RDONLY | os.O_CLOEXEC | os.O_NOFOLLOW | os.O_NONBLOCK)
        data = bytearray()
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode): raise ValueError('COMMON_VIEW_SOURCE_REGULAR')
            if not 0 < before.st_size <= 1048576: raise ValueError('COMMON_VIEW_SOURCE_SIZE')
            while True:
                _check(deadline)
                chunk = os.read(fd, min(4096, 1048577-len(data)))
                if not chunk: break
                data.extend(chunk)
                if len(data)>1048576: raise ValueError('COMMON_VIEW_SOURCE_LIMIT')
            after = os.fstat(fd)
            if (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):
                raise ValueError('COMMON_VIEW_SOURCE_CHANGED')
        finally:
            try: os.close(fd)
            except BaseException:
                _UNKNOWN = True
                raise
        _check(deadline)
        if not data: raise ValueError('COMMON_VIEW_EMPTY_SOURCE')
        result[name] = bytes(data)
    return result


def run():
    global _UNKNOWN
    if _UNKNOWN: raise ValueError('COMMON_VIEW_PRIOR_CLOSE_UNKNOWN')
    # Any incomplete attempt, including a sampler close exception, forbids
    # another attempt in this module. Only a fully completed run clears it.
    _UNKNOWN = True
    deadline = time.monotonic()+TOTAL_SECONDS
    os.set_blocking(1, False)
    admission = _json(_line(0, min(deadline, time.monotonic()+5)))
    if type(admission) is not dict or set(admission) != {'type','sourceSha256'} or admission['type'] != 'common_view_sample':
        raise ValueError('COMMON_VIEW_FIXED_ADMISSION')
    raw = _sources(deadline)
    hashes = {name: hashlib.sha256(data).hexdigest() for name,data in raw.items()}
    if admission['sourceSha256'] != hashes: raise ValueError('COMMON_VIEW_SOURCE_DRIFT')
    module = types.ModuleType('private_common_view')
    module.__file__ = str(Path(__file__).resolve().parent / FILES[0])
    exec(compile(raw[FILES[0]], module.__file__, 'exec'), module.__dict__)
    observation = module.sample_self(min(deadline,time.monotonic()+5))
    if _sources(deadline) != raw: raise ValueError('COMMON_VIEW_SOURCE_AFTER_DRIFT')
    report = {'version':1,'type':'common_view_sample','sourceSha256':hashes,
              'observation':observation,'productionReady':False,'modelCalls':0}
    encoded = (json.dumps(report,separators=(',',':'),allow_nan=False)+'\n').encode()
    if len(encoded)>MAX_REPORT: raise ValueError('COMMON_VIEW_REPORT_LIMIT')
    _write(1,encoded,deadline)
    # Pipe delivery is not external pin/manager admission. Only the owner can
    # release this fixed service after validating its live identity and report.
    if _line(0,deadline,64) != b'{"type":"common_view_release"}\n':
        raise ValueError('COMMON_VIEW_FIXED_RELEASE')
    _check(deadline)
    _UNKNOWN = False
    return 0


def main():
    if sys.argv[1:]: raise ValueError('COMMON_VIEW_NO_ARGUMENTS')
    return run()


if __name__ == '__main__': raise SystemExit(main())
