"""Fixed readonly-marker worker loopback probe. No standalone capsule credit."""
import errno
import hashlib
import json
import math
import os
import re
import selectors
import socket
import stat
import sys
import time

MARKER_PATH = '/work/trusted-http-ingress-boundary.json'
BASE_PATH = '/usr/bin/trusted-control-boundary-probe.py'
KIND = 'FIXED_TRUSTED_HTTP_INGRESS_WORKER'
CONNECT_SECONDS = 0.25
# Linux x86_64 wire values, independent of the offline validator host.
LINUX_CONNECT_PENDING = (115, 11, 114)
MAX_MARKER_BYTES = 4096
BASE_KEYS = {'version', 'namespaces', 'protectedDescriptors', 'authoredProtectedObjects'}


def load_base():
    # Parent/outer helper hashes bind these exact readonly image bytes separately.
    fd = os.open(BASE_PATH, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= 65536 or not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('READONLY_BASE_REQUIRED')
        raw = os.read(fd, 65537); after = os.fstat(fd)
        if len(raw) != before.st_size or (before.st_dev,before.st_ino,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_mtime_ns):
            raise ValueError('BASE_CHANGED')
    finally: os.close(fd)
    import types
    base = types.ModuleType('private_http_base'); base.__file__ = BASE_PATH
    exec(compile(raw, BASE_PATH, 'exec'), base.__dict__)
    return base


def net(value):
    return type(value) is str and re.fullmatch(r'net:\[[1-9][0-9]{0,19}\]', value) is not None


def validate_marker_with(base, marker):
    original = getattr(base, '_http_marker', base.validate_marker)
    if type(marker) is not dict or set(marker) != BASE_KEYS | {'trustedIngressSocket','trustedHttpIngress'}:
        return False
    if not original({key: marker[key] for key in BASE_KEYS}): return False
    http = marker['trustedHttpIngress']
    if not base.exact(http, ('address','networkNamespace','listener','client','control')): return False
    if (type(http['address']) is not list or len(http['address']) != 2 or http['address'][0] != '127.0.0.1'
            or type(http['address'][1]) is not int or not 1 <= http['address'][1] <= 65535 or not net(http['networkNamespace'])):
        return False
    tuples = [marker['trustedIngressSocket'], *(http[key] for key in ('listener','client','control'))]
    if not all(base.valid_tuple(value, stat.S_IFSOCK) for value in tuples): return False
    identities = [base.tuple_identity(value) for value in tuples] + [base.tuple_identity(value) for value in marker['protectedDescriptors'].values()]
    return len(set(identities)) == len(identities)


def read_marker_with(base):
    directory = os.open('/work', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    fd = None
    try:
        fd = os.open('trusted-http-ingress-boundary.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=directory)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0 < before.st_size <= MAX_MARKER_BYTES or not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('READONLY_MARKER_REQUIRED')
        raw = os.read(fd, MAX_MARKER_BYTES + 1); after = os.fstat(fd)
        if len(raw) != before.st_size or (before.st_dev,before.st_ino,before.st_size,before.st_mtime_ns) != (after.st_dev,after.st_ino,after.st_size,after.st_mtime_ns):
            raise ValueError('MARKER_CHANGED')
        value = base.strict_json(raw)
        if not validate_marker_with(base,value): raise ValueError('MARKER_SCHEMA')
        return {'path':MARKER_PATH,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'rawHex':raw.hex(),
                'file':base.stat_identity(before),'readonlyMount':True,'value':value}
    finally:
        if fd is not None: os.close(fd)
        os.close(directory)


def adapt(base):
    if not hasattr(base,'_http_marker'):
        base._http_marker = base.validate_marker; base._http_report = base.validate_report
        base.MARKER_PATH = MARKER_PATH
        base.PROC_FD_PATHS = (*base.PROC_FD_PATHS, '/proc/1/fd/198')
        base.validate_marker = lambda marker: validate_marker_with(base,marker)
        base.read_marker = lambda: read_marker_with(base)
    return base


def inventory(base):
    result = []
    for name in os.listdir('/proc/self/fd'):
        if not name.isdecimal(): raise ValueError('FD_NAME')
        try: result.append(base.descriptor(int(name)))
        except OSError as error:
            if error.errno != errno.EBADF: raise
    return sorted(result,key=lambda value:value['fd'])


def connect_once(port):
    if type(port) is not int or not 1 <= port <= 65535: raise ValueError('FIXED_PORT_REQUIRED')
    began = time.monotonic(); endpoint = selector = None
    report = {'connectEx':None,'soError':None,'osError':None,'outcome':'error','elapsedMs':None,
              'socketClosed':False,'selectorClosed':True,'connectCalls':0,'stage':'socket-create','socketCreated':False,'socketCleanup':'NOT_CREATED'}
    try:
        endpoint = socket.socket(socket.AF_INET,socket.SOCK_STREAM)
        report.update(socketCreated=True,socketCleanup='UNKNOWN',stage='socket-setup')
        endpoint.setblocking(False); endpoint.set_inheritable(False)
        if time.monotonic()-began >= CONNECT_SECONDS: report['outcome']='timeout'; return report
        report['stage']='connect'
        report['connectCalls']=1
        code = endpoint.connect_ex(('127.0.0.1',port)); report['connectEx']=code
        if time.monotonic()-began >= CONNECT_SECONDS: report['outcome']='timeout'; return report
        if code in LINUX_CONNECT_PENDING:
            report['stage']='wait'
            selector=selectors.DefaultSelector(); report['selectorClosed']=False
            selector.register(endpoint,selectors.EVENT_WRITE)
            remaining=CONNECT_SECONDS-(time.monotonic()-began)
            if remaining <= 0 or not selector.select(remaining) or time.monotonic()-began >= CONNECT_SECONDS:
                report['outcome']='timeout'; return report
            report['stage']='so-error'
            code=endpoint.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR); report['soError']=code
        if time.monotonic()-began >= CONNECT_SECONDS: report['outcome']='timeout'; return report
        report['stage']='complete'
        report['outcome']='connected' if code==0 else 'permission-denied' if code in (1,13) else 'unreachable' if code in (101,111,113) else 'error'
    except OSError as error:
        report['osError']=error.errno
        if report['stage']=='socket-create' and endpoint is None and error.errno in (1,13): report['outcome']='socket-permission-denied'
    finally:
        if endpoint is not None:
            try: endpoint.close(); report['socketClosed']=True; report['socketCleanup']='CLOSED'
            except OSError: pass
        if selector is not None:
            try: selector.close(); report['selectorClosed']=True
            except OSError: pass
        report['elapsedMs']=(time.monotonic()-began)*1000
    return report


def collect_with(base):
    base=adapt(base); body=base.collect()
    before=os.readlink('/proc/self/ns/net')
    connection=connect_once(body['marker']['value']['trustedHttpIngress']['address'][1])
    after=os.readlink('/proc/self/ns/net')
    return {'version':1,'kind':KIND,'baseReport':body,'workerNetworkBefore':before,'workerNetworkAfter':after,
            'descriptorsAfter':inventory(base),'connection':connection,'productionReady':False}


def validate_report_with(base, report, expected_marker):
    try:
        base=adapt(base)
        if not base.exact(report,('version','kind','baseReport','workerNetworkBefore','workerNetworkAfter','descriptorsAfter','connection','productionReady')):
            return False
        if type(report['version']) is not int or report['version'] != 1 or report['kind'] != KIND or report['productionReady'] is not False:
            return False
        if not validate_marker_with(base,expected_marker) or not base._http_report(report['baseReport'],expected_marker): return False
        if not net(report['workerNetworkBefore']) or report['workerNetworkBefore'] != report['workerNetworkAfter']: return False
        if json.dumps(report['descriptorsAfter'],sort_keys=True) != json.dumps(report['baseReport']['descriptors'],sort_keys=True): return False
        http=expected_marker['trustedHttpIngress']
        protected={base.tuple_identity(expected_marker['trustedIngressSocket']),*(base.tuple_identity(http[key]) for key in ('listener','client','control'))}
        observed=report['descriptorsAfter']+[value['descriptor'] for value in report['baseReport']['paths'].values() if value['opened']]
        if any(base.tuple_identity(value) in protected for value in observed): return False
        value=report['connection']
        if not base.exact(value,('connectEx','soError','osError','outcome','elapsedMs','socketClosed','selectorClosed','connectCalls','stage','socketCreated','socketCleanup')): return False
        if (type(value['elapsedMs']) not in (int,float) or not math.isfinite(value['elapsedMs']) or not 0<=value['elapsedMs']<CONNECT_SECONDS*1000): return False
        if value['stage']=='socket-create':
            return (value['socketCreated'] is False and value['socketCleanup']=='NOT_CREATED' and value['socketClosed'] is False
                and value['selectorClosed'] is True and type(value['connectCalls']) is int and value['connectCalls']==0
                and value['connectEx'] is None and value['soError'] is None and type(value['osError']) is int and value['osError'] in (1,13)
                and value['outcome']=='socket-permission-denied' and report['workerNetworkBefore']!=http['networkNamespace'])
        if value['stage']!='complete' or value['socketCreated'] is not True or value['socketCleanup']!='CLOSED': return False
        if (value['socketClosed'] is not True or value['selectorClosed'] is not True or type(value['connectCalls']) is not int or value['connectCalls'] != 1
                or value['osError'] is not None or type(value['elapsedMs']) not in (int,float) or not math.isfinite(value['elapsedMs'])
                or not 0 <= value['elapsedMs'] < CONNECT_SECONDS*1000 or type(value['connectEx']) is not int): return False
        code=value['connectEx']
        if code in LINUX_CONNECT_PENDING:
            if type(value['soError']) is not int: return False
            code=value['soError']
        elif value['soError'] is not None: return False
        if code in (1,13): return value['outcome']=='permission-denied'
        return code in (101,111,113) and value['outcome']=='unreachable' and report['workerNetworkBefore'] != http['networkNamespace']
    except (ValueError,TypeError,KeyError,AttributeError,RecursionError): return False


if __name__ == '__main__':
    if sys.argv[1:]: raise ValueError('FIXED_NOARGS_PROBE_REQUIRED')
    print(json.dumps(collect_with(load_base()),separators=(',',':'),allow_nan=False),flush=True)


