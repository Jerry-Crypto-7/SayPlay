"""Accepted endpoint noninheritance adapter; no connect attempt or auth reads."""
import json
import os
import re
import stat
import sys
import types

ROLE='trustedCliProxyEndpoint'
BASE_KEYS=('version','namespaces','protectedDescriptors','authoredProtectedObjects')


def same(a,b):return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)


def valid_endpoint(base,value):
    return (base.exact(value,('address','socket','networkNamespace','listenerClosed'))
        and type(value['address']) is list and len(value['address'])==2 and value['address'][0]=='127.0.0.1'
        and type(value['address'][1]) is int and 1<=value['address'][1]<=65535
        and base.valid_tuple(value['socket'],stat.S_IFSOCK)
        and type(value['networkNamespace']) is str and re.fullmatch(r'net:\[[1-9][0-9]{0,19}\]',value['networkNamespace']) is not None
        and value['listenerClosed'] is True)


def adapt(base):
    """Only a source-bound PRIVATE base module; no global OS patches."""
    if hasattr(base,'_cli_original_marker'):raise ValueError('PRIVATE_ADAPTER_SINGLE_USE')
    original_marker=base.validate_marker;original_report=base.validate_report
    base._cli_original_marker=original_marker
    def marker(value):
        return (type(value) is dict and set(value)==set(BASE_KEYS)|{ROLE}
            and original_marker({k:value[k] for k in BASE_KEYS}) and valid_endpoint(base,value[ROLE]))
    base.validate_marker=marker
    def validate(report,expected):
        try:
            if not base.exact(report,('version','kind','baseReport','workerNetworkNamespace')) or type(report['version']) is not int or report['version']!=1 or report['kind']!='FIXED_TRUSTED_CLI_ENDPOINT_WORKER':return False
            if not marker(expected) or not original_report(report['baseReport'],expected):return False
            net=report['workerNetworkNamespace']
            if type(net) is not str or re.fullmatch(r'net:\[[1-9][0-9]{0,19}\]',net) is None or net==expected[ROLE]['networkNamespace']:return False
            protected=base.tuple_identity(expected[ROLE]['socket'])
            records=list(report['baseReport']['descriptors'])
            records.extend(v['descriptor'] for v in report['baseReport']['paths'].values() if v['opened'])
            return all(base.tuple_identity(v)!=protected for v in records)
        except (ValueError,TypeError,KeyError,AttributeError):return False
    return validate


def collect(base):
    """Caller loads reviewed base after future fixed trampoline admission."""
    validate=adapt(base)
    report={'version':1,'kind':'FIXED_TRUSTED_CLI_ENDPOINT_WORKER','baseReport':base.collect(),
        'workerNetworkNamespace':base.os.readlink('/proc/self/ns/net')}
    if not validate(report,report['baseReport']['marker']['value']):raise ValueError('WORKER_ENDPOINT_BOUNDARY')
    return report


def main():
    if sys.platform!='linux' or sys.argv[1:]:raise ValueError('FIXED_LINUX_PROBE')
    path='/usr/bin/trusted-control-boundary-probe.py'
    fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC|os.O_NONBLOCK)
    try:
        first=os.fstat(fd)
        if not stat.S_ISREG(first.st_mode) or not 0<first.st_size<=65536 or not os.fstatvfs(fd).f_flag&os.ST_RDONLY:raise ValueError('READONLY_BASE')
        raw=os.read(fd,65537);last=os.fstat(fd)
        if len(raw)!=first.st_size or (first.st_dev,first.st_ino,first.st_mtime_ns)!=(last.st_dev,last.st_ino,last.st_mtime_ns):raise ValueError('BASE_CHANGED')
    finally:os.close(fd)
    base=types.ModuleType('private_trusted_cli_base');base.__file__=path
    exec(compile(raw,path,'exec'),base.__dict__)
    report=collect(base);raw=(json.dumps(report,separators=(',',':'),allow_nan=False)+'\n').encode()
    if len(raw)>65536:raise ValueError('PROBE_OUTPUT_BOUND')
    # The executor owns the pipe and deadline; no reads of protected bodies.
    sys.stdout.buffer.write(raw);sys.stdout.buffer.flush()
    return 0


if __name__=='__main__':raise SystemExit(main())
