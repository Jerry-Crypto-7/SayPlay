"""Offline deterministic tests; no socket/kernel runtime."""
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest


def load(name):
    path=Path(__file__).with_name(name)
    spec=importlib.util.spec_from_file_location(name,path); value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value

m=load('subscription-trusted-http-worker-probe.py')

def fixture():
    base=load('subscription-trusted-control-boundary-probe.py'); m.adapt(base)
    marker={'version':1,'namespaces':{'trustedPid':'pid:[10]','trustedMount':'mnt:[11]'},
        'protectedDescriptors':{name:{'dev':15,'ino':100+i,'type':4096} for i,name in enumerate(base.DESCRIPTOR_ROLES)},
        'authoredProtectedObjects':{'appServerHome':{'dev':20,'ino':200,'type':16384},'appServerSentinel':{'dev':20,'ino':201,'type':32768}},
        'trustedIngressSocket':{'dev':30,'ino':500,'type':49152},
        'trustedHttpIngress':{'address':['127.0.0.1',43210],'networkNamespace':'net:[100]',
            'listener':{'dev':30,'ino':501,'type':49152},'client':{'dev':30,'ino':502,'type':49152},'control':{'dev':30,'ino':503,'type':49152}}}
    raw=json.dumps(marker).encode()
    body={'version':1,'kind':'FIXED_TRUSTED_CONTROL_BOUNDARY_OBSERVATIONS',
        'marker':{'path':m.MARKER_PATH,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'rawHex':raw.hex(),
                  'file':{'dev':21,'ino':300,'type':32768},'readonlyMount':True,'value':marker},
        'identity':{'pid':2,'ppid':1,'pidNamespace':'pid:[20]','mountNamespace':'mnt:[21]','procInitPidNamespace':'pid:[20]','nspid':'2'},
        'status':{'NoNewPrivs':'1','Seccomp':'2','Seccomp_filters':'2','CapEff':'0000000000000000','CapBnd':'0000000000000000'},
        'cwd':'/work/exec-worker','environmentKeys':['HOME','LANG','PATH','TMPDIR'],
        'descriptors':[{'fd':i,'dev':15,'ino':400+i,'type':4096} for i in range(3)],
        'paths':{path:{'opened':False,'errno':13,'outcome':'denied','bytesRead':0,'bytesWritten':0} for path in base.PROTECTED_PATHS+base.PROC_FD_PATHS},
        'protectedBodyBytesRead':0,'bytesWrittenToProtectedObjects':0,'credentialFilesRead':False,'actualModelCalls':0,
        'networkOperations':0,'cleanupAttestedHere':False,'productionReady':False}
    result={'version':1,'kind':m.KIND,'baseReport':body,'workerNetworkBefore':'net:[200]','workerNetworkAfter':'net:[200]',
            'descriptorsAfter':copy.deepcopy(body['descriptors']),'productionReady':False,
            'connection':{'connectEx':111,'soError':None,'osError':None,'outcome':'unreachable','elapsedMs':2,
                          'socketClosed':True,'selectorClosed':True,'connectCalls':1,'stage':'complete','socketCreated':True,'socketCleanup':'CLOSED'}}
    return base,marker,result


def test_complete_strict_report():
    base,marker,result=fixture(); assert m.validate_report_with(base,result,marker)
    assert not m.validate_report_with(base,result,None)

@pytest.mark.parametrize('field,value',[('connectEx',22),('connectEx',True),('connectEx',0),('soError',111),('osError',1),
    ('elapsedMs',250),('elapsedMs',float('inf')),('elapsedMs',True),('outcome','timeout'),('socketClosed',False),('selectorClosed',False),('connectCalls',True),('connectCalls',2)])
def test_invalid_or_non_denial_connection_fails(field,value):
    base,marker,result=fixture(); result['connection'][field]=value
    assert not m.validate_report_with(base,result,marker)

@pytest.mark.parametrize('key', ['connection','descriptorsAfter','workerNetworkBefore','baseReport'])
def test_missing_evidence_fails(key):
    base,marker,result=fixture(); del result[key]; assert not m.validate_report_with(base,result,marker)

@pytest.mark.parametrize('case',['namespace','same-net-refused','fd-drift','extra-fd','raw','accepted','alias','portbool','zero-net'])
def test_binding_negatives(case):
    base,marker,result=fixture()
    if case=='namespace': result['workerNetworkAfter']='net:[201]'
    if case=='same-net-refused': result['workerNetworkBefore']=result['workerNetworkAfter']='net:[100]'
    if case=='fd-drift': result['descriptorsAfter'][1]['ino']=999
    if case=='extra-fd': result['descriptorsAfter'].append({'fd':3,'dev':30,'ino':900,'type':49152})
    if case=='raw': result['baseReport']['marker']['rawHex']='00'
    if case=='accepted': marker['trustedHttpIngress']['accepted']={'dev':30,'ino':504,'type':49152}
    if case=='alias': marker['trustedHttpIngress']['client']=marker['trustedHttpIngress']['listener']
    if case=='portbool': marker['trustedHttpIngress']['address'][1]=True
    if case=='zero-net': marker['trustedHttpIngress']['networkNamespace']='net:[0]'
    assert not m.validate_report_with(base,result,marker)

class Endpoint:
    def __init__(self,code=111): self.code=code; self.closed=False; self.calls=[]; self.soerror=111
    def setblocking(self,value): assert value is False
    def set_inheritable(self,value): assert value is False
    def connect_ex(self,address): self.calls.append(address); return self.code
    def getsockopt(self,*args): return self.soerror
    def close(self): self.closed=True

@pytest.mark.parametrize('code,outcome',[(111,'unreachable'),(101,'unreachable'),(1,'permission-denied'),(13,'permission-denied'),(22,'error'),(0,'connected')])
def test_single_fixed_connection_and_cleanup(monkeypatch,code,outcome):
    endpoint=Endpoint(code); monkeypatch.setattr(m.socket,'socket',lambda *args:endpoint)
    monkeypatch.setattr(m.time,'monotonic',lambda:0)
    result=m.connect_once(43210)
    assert result['connectEx']==code and result['outcome']==outcome and result['socketClosed']
    assert endpoint.calls==[('127.0.0.1',43210)]

@pytest.mark.parametrize('late',[False,True])
def test_async_soerror_and_delayed_selector(monkeypatch,late):
    endpoint=Endpoint(115); monkeypatch.setattr(m.socket,'socket',lambda *args:endpoint)
    clock=[0]; monkeypatch.setattr(m.time,'monotonic',lambda:clock[0])
    selector=SimpleNamespace(register=lambda *args:None,close=lambda:None)
    def wait(timeout):
        assert timeout<=.25
        if late: clock[0]=.25
        return [1]
    selector.select=wait; monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:selector)
    result=m.connect_once(43210)
    assert result['outcome']==('timeout' if late else 'unreachable')
    assert result['soError']==(None if late else 111); assert result['socketClosed'] and result['selectorClosed']


def test_selector_failure_still_closes_socket(monkeypatch):
    endpoint=Endpoint(115); monkeypatch.setattr(m.socket,'socket',lambda *args:endpoint)
    monkeypatch.setattr(m.time,'monotonic',lambda:0)
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda: (_ for _ in ()).throw(OSError(24,'mock')))
    result=m.connect_once(43210); assert result['osError']==24 and result['socketClosed']


def test_collect_retains_before_after_inventory(monkeypatch):
    base,marker,result=fixture(); monkeypatch.setattr(base,'collect',lambda:result['baseReport'])
    monkeypatch.setattr(m.os,'readlink',lambda path:'net:[200]')
    monkeypatch.setattr(m,'inventory',lambda base:result['descriptorsAfter'])
    calls=[]
    monkeypatch.setattr(m,'connect_once',lambda port:calls.append(port) or result['connection'])
    actual=m.collect_with(base); assert calls==[43210]; assert m.validate_report_with(base,actual,marker)

@pytest.mark.parametrize('case',['writable','fifo','oversize','changed','malformed'])
def test_marker_read_guards_and_all_owned_fds_closed(monkeypatch,case):
    base,marker,result=fixture(); raw=json.dumps(marker).encode(); closed=[]; opens=[]
    def opened(path,flags,**kwargs):
        opens.append((path,flags,kwargs)); return 10 if len(opens)==1 else 11
    monkeypatch.setattr(m.os,'open',opened); monkeypatch.setattr(m.os,'close',closed.append)
    count=[0]
    def metadata(fd):
        count[0]+=1
        return SimpleNamespace(st_mode=4096 if case=='fifo' else 32768,st_size=5000 if case=='oversize' else len(raw),
            st_dev=1,st_ino=3 if case=='changed' and count[0]>1 else 2,st_mtime_ns=0)
    monkeypatch.setattr(m.os,'fstat',metadata)
    monkeypatch.setattr(m.os,'fstatvfs',lambda fd:SimpleNamespace(f_flag=0 if case=='writable' else m.os.ST_RDONLY),raising=False)
    monkeypatch.setattr(m.os,'read',lambda fd,size:b'X'*len(raw) if case=='malformed' else raw)
    # Linux flag constants are absent on Windows: mock only their bit values.
    for name,value in [('O_DIRECTORY',65536),('O_NOFOLLOW',131072),('O_CLOEXEC',524288),('O_NONBLOCK',2048),('ST_RDONLY',1)]:
        monkeypatch.setattr(m.os,name,value,raising=False)
    with pytest.raises(ValueError): m.read_marker_with(base)
    assert closed==[11,10]; assert opens[1][2]=={'dir_fd':10}


def test_socket_close_error_cannot_pass(monkeypatch):
    endpoint=Endpoint(); endpoint.close=lambda: (_ for _ in ()).throw(OSError(5,'mock'))
    monkeypatch.setattr(m.socket,'socket',lambda *args:endpoint); monkeypatch.setattr(m.time,'monotonic',lambda:0)
    result=m.connect_once(43210); assert result['socketClosed'] is False


@pytest.mark.parametrize('wire_pending',[115,11,114])
def test_linux_async_wire_replay_independent_of_host_errno(wire_pending):
    base,marker,result=fixture()
    result['connection'].update(connectEx=wire_pending,soError=111)
    assert m.validate_report_with(base,result,marker)

@pytest.mark.parametrize('wire_pending,so_error',[(115,True),(115,None),(115,115),(115,0),(115,22),(112,111),(111,111)])
def test_async_ambiguous_non_denial_or_host_code_rejected(wire_pending,so_error):
    base,marker,result=fixture()
    result['connection'].update(connectEx=wire_pending,soError=so_error)
    assert not m.validate_report_with(base,result,marker)

@pytest.mark.parametrize('code,valid',[(1,True),(13,True),(22,False),(12,False)])
def test_socket_creation_stage_denial_is_not_a_connect(monkeypatch,code,valid):
    monkeypatch.setattr(m.socket,'socket',lambda *args:(_ for _ in ()).throw(OSError(code,'mock')))
    monkeypatch.setattr(m.time,'monotonic',lambda:0)
    connection=m.connect_once(43210)
    assert connection['stage']=='socket-create' and connection['socketCreated'] is False
    assert connection['socketCleanup']=='NOT_CREATED' and connection['connectCalls']==0 and connection['connectEx'] is None
    base,marker,result=fixture();result['connection']=connection
    assert m.validate_report_with(base,result,marker) is valid

@pytest.mark.parametrize('field,value',[('stage','socket-setup'),('socketCreated',True),('socketCleanup','UNKNOWN'),('socketClosed',True),
    ('connectCalls',1),('connectCalls',False),('connectEx',1),('soError',1),('osError',True),('selectorClosed',False),('outcome','permission-denied')])
def test_socket_denial_branch_rejects_ambiguous_or_claimed_connect(field,value):
    base,marker,result=fixture()
    result['connection'].update(stage='socket-create',socketCreated=False,socketCleanup='NOT_CREATED',socketClosed=False,
        connectCalls=0,connectEx=None,soError=None,osError=1,outcome='socket-permission-denied')
    result['connection'][field]=value
    assert not m.validate_report_with(base,result,marker)


def test_setup_denied_after_socket_creation_remains_failure(monkeypatch):
    endpoint=Endpoint();endpoint.setblocking=lambda value:(_ for _ in ()).throw(OSError(1,'mock'))
    monkeypatch.setattr(m.socket,'socket',lambda *args:endpoint);monkeypatch.setattr(m.time,'monotonic',lambda:0)
    connection=m.connect_once(43210)
    assert connection['stage']=='socket-setup' and connection['socketCreated'] is True and connection['socketCleanup']=='CLOSED'
    base,marker,result=fixture();result['connection']=connection
    assert not m.validate_report_with(base,result,marker)
