"""Fixed post-lockdown cgroup write-open observations; never writes a byte."""
import hashlib
import json
import os
import re
import stat
import sys
import types

BASE_PATH = '/usr/bin/trusted-control-boundary-probe.py'
PATHS = ('/sys/fs/cgroup/cgroup.procs', '/sys/fs/cgroup/memory.max',
         '/proc/1/root/sys/fs/cgroup/cgroup.procs', '/proc/1/root/sys/fs/cgroup/memory.max')
FLAGS = 'O_WRONLY|O_CLOEXEC|O_NONBLOCK|O_NOFOLLOW'


def load_base():
    fd = os.open(BASE_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        first = os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or not 0 < first.st_size <= 1024 * 1024 or not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('READONLY_BASE_REQUIRED')
        raw = os.read(fd, 1024 * 1024 + 1)
        last = os.fstat(fd)
        if len(raw) != first.st_size or (first.st_dev, first.st_ino, first.st_mtime_ns) != (last.st_dev, last.st_ino, last.st_mtime_ns):
            raise ValueError('BASE_CHANGED')
    finally: os.close(fd)
    base = types.ModuleType('private_cgroup_base'); base.__file__ = BASE_PATH
    exec(compile(raw, BASE_PATH, 'exec'), base.__dict__)
    return base, hashlib.sha256(raw).hexdigest()


def write_open_only(path):
    if path not in PATHS: raise ValueError('FIXED_CGROUP_PATH_REQUIRED')
    result = {'opened':False, 'errno':None, 'outcome':'unknown', 'descriptor':None,
              'metadataError':None, 'cleanup':'NOT_CREATED', 'bytesRead':0, 'bytesWritten':0}
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOFOLLOW)
    except OSError as failure:
        code = failure.errno
        result.update(errno=code, outcome=('denied' if code in (1,13) else 'absent' if code == 2 else 'readonly' if code == 30 else 'unknown'))
        return result
    result.update(opened=True, outcome='opened', cleanup='UNKNOWN')
    try:
        try:
            value = os.fstat(fd)
            result['descriptor'] = {'fd':fd,'dev':value.st_dev,'ino':value.st_ino,'type':stat.S_IFMT(value.st_mode)}
        except OSError as failure: result['metadataError'] = failure.errno
    finally:
        try: os.close(fd); result['cleanup'] = 'CLOSED'
        except OSError: result['cleanup'] = 'UNKNOWN'
    return result


def inventory(base):
    names = os.listdir('/proc/self/fd')
    if len(names) > 128 or any(re.fullmatch('0|[1-9][0-9]*', name) is None for name in names):
        raise ValueError('SELF_FD_INVENTORY_LIMIT')
    values = []
    for name in names:
        try: values.append(base.descriptor(int(name)))
        except OSError as failure:
            if failure.errno != 9: raise
    return sorted(values, key=lambda value:value['fd'])


def namespaces():
    return {'pidNamespace':os.readlink('/proc/self/ns/pid'), 'mountNamespace':os.readlink('/proc/self/ns/mnt'),
            'procInitPidNamespace':os.readlink('/proc/1/ns/pid')}


def collect_with(base, base_sha256):
    base_report = base.collect()
    before = inventory(base)
    before_namespaces = namespaces()
    paths = {path:write_open_only(path) for path in PATHS}
    after = inventory(base)
    return {'version':1, 'kind':'FIXED_CGROUP_WRITE_OPEN_OBSERVATIONS', 'baseSha256':base_sha256,
            'baseReport':base_report, 'flags':FLAGS, 'paths':paths, 'descriptorsBefore':before,
            'descriptorsAfter':after, 'namespacesBefore':before_namespaces, 'namespacesAfter':namespaces(),
            'bytesReadFromCgroup':0, 'bytesWrittenToCgroup':0, 'migrationAttempted':False,
            'mountAttempted':False, 'productionReady':False, 'cleanupAttestedHere':False}


def validate_report_with(base, report, expected_marker, expected_base_sha256):
    try:
        def same(a,b): return json.dumps(a,sort_keys=True,allow_nan=False) == json.dumps(b,sort_keys=True,allow_nan=False)
        keys = {'version','kind','baseSha256','baseReport','flags','paths','descriptorsBefore','descriptorsAfter','namespacesBefore','namespacesAfter','bytesReadFromCgroup','bytesWrittenToCgroup','migrationAttempted','mountAttempted','productionReady','cleanupAttestedHere'}
        if type(report) is not dict or set(report) != keys or type(report['version']) is not int or report['version'] != 1 or report['kind'] != 'FIXED_CGROUP_WRITE_OPEN_OBSERVATIONS': return False
        if type(expected_base_sha256) is not str or re.fullmatch('[a-f0-9]{64}',expected_base_sha256) is None or report['baseSha256'] != expected_base_sha256: return False
        if not base.validate_report(report['baseReport'],expected_marker) or report['flags'] != FLAGS: return False
        if any(type(report[k]) is not int or report[k] != 0 for k in ('bytesReadFromCgroup','bytesWrittenToCgroup')) or any(report[k] is not False for k in ('migrationAttempted','mountAttempted','productionReady','cleanupAttestedHere')): return False
        descriptors = report['baseReport']['descriptors']
        if not same(descriptors,report['descriptorsBefore']) or not same(descriptors,report['descriptorsAfter']): return False
        identity = report['baseReport']['identity']
        ns = {key:identity[key] for key in ('pidNamespace','mountNamespace','procInitPidNamespace')}
        if not same(ns,report['namespacesBefore']) or not same(ns,report['namespacesAfter']): return False
        if type(report['paths']) is not dict or set(report['paths']) != set(PATHS): return False
        for item in report['paths'].values():
            if type(item) is not dict or set(item) != {'opened','errno','outcome','descriptor','metadataError','cleanup','bytesRead','bytesWritten'}: return False
            if item['opened'] is not False or item['descriptor'] is not None or item['metadataError'] is not None or item['cleanup'] != 'NOT_CREATED': return False
            if type(item['errno']) is not int or item['errno'] not in (1,2,13,30): return False
            if item['outcome'] != ({1:'denied',13:'denied',2:'absent',30:'readonly'}[item['errno']]): return False
            if any(type(item[k]) is not int or item[k] != 0 for k in ('bytesRead','bytesWritten')): return False
        return True
    except (ValueError,TypeError,KeyError,AttributeError,IndexError): return False


if __name__ == '__main__':
    if sys.platform != 'linux' or sys.argv[1:] or os.uname().machine != 'x86_64':
        raise SystemExit('FIXED_LOCKDOWN_WORKER_REQUIRED')
    fixed_base, source_hash = load_base()
    print(json.dumps(collect_with(fixed_base,source_hash),separators=(',',':'),allow_nan=False),flush=True)
