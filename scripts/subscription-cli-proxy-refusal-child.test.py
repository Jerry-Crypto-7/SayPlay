"""Offline authored full replay and private-hook tests; no actual CLI/network."""
import base64
import copy
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest


def load(name):
    path = Path(__file__).with_name(name + '.py')
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value


m = load('subscription-cli-proxy-refusal-child')
parent_fixture = load('subscription-exec-environment-metadata-parent.test')
core = load('subscription-cli-proxy-refusal')
provenance = load('subscription-cli-proxy-provenance')
deps = (parent_fixture.m, parent_fixture.policy, parent_fixture.gate, core, provenance)


def complete_report():
    parent = parent_fixture.complete_controlled_bootstrap_report()
    h = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in m.HELPERS}
    for field in ('helperSha256Before','helperSha256After'):
        parent[field] = {name:h[name] for name in parent_fixture.m.HELPER_FILES}
    pid = parent['directChild']['pid']
    identity = {'pid':pid,'startTicks':'900','networkNamespace':'net:[1234]'}
    raw = (str(pid) + ' (owned) ' + ' '.join(['S'] + ['0'] * 18 + ['900']) + '\n').encode()
    sample = {**identity,'observerNetworkNamespace':'net:[1234]','statRawHex':raw.hex(),'statSha256':hashlib.sha256(raw).hexdigest(),'pidfdAlive':True,'pollRunning':True}
    accepted = {'peer':['127.0.0.1',41000],'local':['127.0.0.1',42000],'socket':{'dev':9,'ino':777,'type':49152}}
    tcp = b' sl local_address rem_address st\n 0: 0100007F:A028 0100007F:A410 01 00000000:00000000 00:00000000 00000000 1000 0 555\n'
    records = []
    for index, phase in enumerate(provenance.PHASES):
        records.append({'phase':phase,'record':{'version':1,'phase':phase,'observation':accepted,'identityBefore':sample,'identityAfter':sample,'tcpRawHex':tcp.hex(),'tcpSha256':hashlib.sha256(tcp).hexdigest(),'clientInode':555,'holders':[4],'fdEntriesObserved':5,'capturedMonotonic':10+index/10,'deadlineMonotonic':12,'scope':'sequential-own-process-holder-not-atomic-byte-author','productionReady':False}})
    proxy = {'version':1,'profile':'stock-noauth-connect-local-refusal','reason':'LOCAL_PROXY_REFUSAL','stage':'local-refusal','ownership':{'address':accepted['local'],'listener':{'dev':9,'ino':778,'type':49152}},'accepted':accepted,'provenanceObservations':records,'requestBytes':len(core.REQUEST),'requestSha256':hashlib.sha256(core.REQUEST).hexdigest(),'requestRawBase64':base64.b64encode(core.REQUEST).decode(),'requestRawComplete':True,'refusalBytesWritten':len(core.REFUSAL),'elapsedMs':1000,'cleanupKnown':True,'success':True,'cliProvenanceValidated':False,'productionReady':False,'upstreamConnections':0,'tlsStarted':False,'modelCalls':0,'credentialFilesRead':0}
    return {'version':1,'profile':'fixed-cli-proxy-refusal-child','success':True,'error':None,'parentReport':parent,'proxyReport':proxy,'cliIdentity':identity,'cleanup':{k:True for k in ('sessionClosed','threadJoined','observerPinClosed','originalPinClosed','notificationReadClosed','notificationWriteClosed')},'helperSha256Before':h,'helperSha256After':h,'elapsedMs':3000}


def test_authored_full_parent_proxy_and_two_records_replay():
    assert m.validate_report(complete_report(), deps)


@pytest.mark.parametrize('case', ['partial','missing-record','wrong-pid','generation','tcp','holder','callback-bool','phase','helper','parent','cleanup','elapsed','bool-count','200','authority','listener-alias'])
def test_full_replay_rejects_material_tampering(case):
    r = copy.deepcopy(complete_report()); p = r['proxyReport']
    if case == 'partial': p['requestRawComplete'] = False
    elif case == 'missing-record': p['provenanceObservations'].pop()
    elif case == 'wrong-pid': r['cliIdentity']['pid'] += 1
    elif case == 'generation': r['cliIdentity']['startTicks'] = '901'
    elif case == 'tcp': p['provenanceObservations'][0]['record']['clientInode'] += 1
    elif case == 'holder': p['provenanceObservations'][0]['record']['holders'] = []
    elif case == 'callback-bool': p['provenanceObservations'][0]['record'] = True
    elif case == 'phase': p['provenanceObservations'].reverse()
    elif case == 'helper': r['helperSha256After'] = {**r['helperSha256After'],'subscription-cli-proxy-refusal.py':'0'*64}
    elif case == 'parent': r['parentReport']['history'].pop()
    elif case == 'cleanup': r['cleanup']['originalPinClosed'] = False
    elif case == 'elapsed': p['elapsedMs'] = 2000
    elif case == 'bool-count': p['modelCalls'] = False
    elif case == '200': p['reason'] = 'TUNNEL_OPEN'
    elif case == 'authority': p['requestRawBase64'] = base64.b64encode(core.REQUEST.replace(b'api.openai.com',b'fixture.invalid')).decode()
    elif case == 'listener-alias': p['ownership']['listener'] = p['accepted']['socket']
    assert not m.validate_report(r, deps)


class FakeSelector:
    def __init__(self): self.keys={}; self.closed=False
    def register(self, obj, events, data):
        self.keys[obj]=SimpleNamespace(fileobj=obj,data=data)
    def unregister(self,obj): del self.keys[obj]
    def get_key(self,obj): return self.keys[obj]
    def close(self): self.closed=True


def composition(monkeypatch, selector_factory=FakeSelector, process=None, popen_calls=None):
    parent = load('subscription-exec-environment-metadata-parent')
    policy = parent_fixture.policy; gate = parent_fixture.gate
    session = SimpleNamespace(deadline=2,ownership={'address':['127.0.0.1',42000]},close=lambda:True)
    fake_core = SimpleNamespace(create_refusal_session=lambda deadline:session)
    c = m.Composition(parent, policy, gate, fake_core, provenance, 0)
    calls = [] if popen_calls is None else popen_calls
    fake_process = process or SimpleNamespace(pid=123,poll=lambda:None)
    original_subprocess = parent.subprocess
    parent.subprocess = m.private_namespace(original_subprocess, Popen=lambda *a,**kw: calls.append((a,kw)) or fake_process)
    parent.prepare_home = lambda bootstrap: {'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':parent.HOME,'CODEX_HOME':parent.HOME,'TMPDIR':parent.HOME+'/tmp'}
    parent.selectors=m.private_namespace(parent.selectors,DefaultSelector=selector_factory)
    monkeypatch.setattr(m.os,'pipe2',lambda flags:(80,81),raising=False)
    monkeypatch.setattr(m.os,'O_NONBLOCK',2048,raising=False)
    monkeypatch.setattr(m.os,'O_CLOEXEC',524288,raising=False)
    monkeypatch.setattr(m.os,'write',lambda fd,raw: len(raw))
    monkeypatch.setattr(m.os,'pidfd_open',lambda pid: (_ for _ in ()).throw(OSError('mock pin failure')),raising=False)
    c.install()
    return c,calls,fake_process,original_subprocess


def test_spawn_pin_failure_returns_original_process_for_parent_cleanup(monkeypatch):
    c,calls,process,original = composition(monkeypatch); p=c.parent
    env=p.prepare_home(bootstrap=True)
    result=p.subprocess.Popen(p.fixed_argv(c.policy,True),cwd='/work',env=env,stdin=p.subprocess.PIPE,stdout=p.subprocess.PIPE,stderr=p.subprocess.PIPE,close_fds=True)
    assert result is process and len(calls)==1 and c.error and c.finished.is_set()
    assert env['HTTPS_PROXY']=='http://127.0.0.1:42000' and set(env)=={'PATH','LANG','HOME','CODEX_HOME','TMPDIR','HTTPS_PROXY'}
    assert original.Popen is not p.subprocess.Popen
    with pytest.raises(ValueError,match='PROXY_REFUSAL_INCOMPLETE'): p.os.read(c.read_fd,8192)


def test_foreign_spawn_rejected_before_popen(monkeypatch):
    c,calls,_,_=composition(monkeypatch)
    with pytest.raises(ValueError,match='FIXED_CLI_SPAWN_REQUIRED'):
        c.parent.subprocess.Popen(('/bin/sh',),cwd='/work',env={},stdin=-1,stdout=-1,stderr=-1,close_fds=True)
    assert not calls


def test_completion_waits_for_refusal_without_changing_metadata(monkeypatch):
    c,_,_,_=composition(monkeypatch)
    # Reinstall a fresh composition with controlled preexisting progress callback.
    parent=load('subscription-exec-environment-metadata-parent')
    parent.bootstrap_progress=lambda *a:('ready',{'actual':'unchanged'},None)
    parent.prepare_home=c.parent.prepare_home
    parent.selectors=m.private_namespace(parent.selectors,DefaultSelector=FakeSelector)
    n=m.Composition(parent,c.policy,c.gate,c.core,c.provenance,0);n.install()
    assert parent.bootstrap_progress() == ('pending',None,None)
    n.finished.set()
    assert parent.bootstrap_progress() == ('ready',{'actual':'unchanged'},None)
    n.error='PROXY_REFUSAL_INCOMPLETE'
    assert parent.bootstrap_progress()[0]=='failed'


def test_live_proxy_thread_keeps_notification_fds_unreused(monkeypatch):
    c,_,_,_=composition(monkeypatch)
    closed=[];monkeypatch.setattr(m.os,'close',lambda fd:closed.append(fd))
    c.thread=SimpleNamespace(ident=1,join=lambda timeout:None,is_alive=lambda:True)
    assert not c.close() and c.read_fd==80 and c.write_fd==81 and closed==[]
    assert not c.cleanup['threadJoined'] and not c.cleanup['notificationWriteClosed']


def test_original_pin_close_failure_stays_unknown_on_second_close(monkeypatch):
    c,_,_,_=composition(monkeypatch); c.pin=99
    def close(fd):
        if fd==99: raise OSError('mock unknown')
    monkeypatch.setattr(m.os,'close',close)
    assert not c.close() and not c.cleanup['originalPinClosed']
    assert not c.close() and not c.cleanup['originalPinClosed']


def test_actual_parent_notification_event_path_starts_eof_cleanup(monkeypatch):
    class Stream:
        def __init__(self,fd):self.fd=fd;self.closed=False
        def fileno(self):return self.fd
        def close(self):self.closed=True
    streams=[Stream(fd) for fd in (10,11,12)]
    process=SimpleNamespace(pid=123,stdin=streams[0],stdout=streams[1],stderr=streams[2],poll=lambda:0 if streams[0].closed else None)
    class Events(FakeSelector):
        def __init__(self):super().__init__();self.count=0
        def select(self,timeout):
            self.count+=1
            if self.count==1:return [(next(k for k in self.keys.values() if k.data=='proxy-failure'),1)]
            if self.count==2:return [(k,1) for k in self.keys.values() if k.data in ('stdout','stderr')]
            pytest.fail('parent did not enter bounded cleanup')
    monkeypatch.setattr(m.os,'read',lambda fd,n:b'')
    monkeypatch.setattr(m.os,'close',lambda fd:None)
    monkeypatch.setattr(m.time,'monotonic',lambda:0)
    c,calls,_,_=composition(monkeypatch,Events,process)
    # Independent parent pin succeeds; extra provenance pin deliberately failed.
    c.parent.os.pidfd_open=lambda pid:88
    c.parent.os.set_blocking=lambda *a:None
    report=c.parent.run_parent(c.policy,0,bootstrap=True,gate=c.gate,controlled=True)
    assert len(calls)==1 and report['error']=='PROXY_REFUSAL_INCOMPLETE'
    assert report['cleanupHistory']==[{'event':'stdin-eof','elapsedMs':0}]
    assert report['directChild']['reaped'] and report['directChild']['exitCode']==0
    assert report['stdoutBase64']==report['stderrBase64']==''
    assert c.selector.count==2 and all(s.closed for s in streams)


@pytest.mark.parametrize('failure',['constructor','registration'])
def test_selector_setup_failure_is_before_any_popen(monkeypatch,failure):
    calls=[]
    class Broken(FakeSelector):
        def __init__(self):
            if failure=='constructor':raise OSError('setup')
            super().__init__()
        def register(self,*a):raise OSError('register')
    # setup helper's fake Popen would append only after completed install.
    with pytest.raises(OSError):composition(monkeypatch,Broken,popen_calls=calls)
    assert calls==[]


@pytest.mark.parametrize('delay',['hash','validator'])
def test_final_hash_and_validator_time_cannot_seal_success(monkeypatch,delay):
    r=complete_report();now=[3.0]
    monkeypatch.setattr(m.time,'monotonic',lambda:now[0])
    def hashes():
        if delay=='hash':now[0]=22.0
        return r['helperSha256Before']
    monkeypatch.setattr(m,'hashes',hashes)
    original=m.validate_report
    def validator(report,dependencies):
        result=original(report,dependencies)
        if delay=='validator':now[0]=22.0
        return result
    monkeypatch.setattr(m,'validate_report',validator)
    m.seal_report(r,deps,0)
    assert not r['success'] and r['error']=='REFUSAL_CHILD_TOTAL_DEADLINE' and r['elapsedMs']==22000
