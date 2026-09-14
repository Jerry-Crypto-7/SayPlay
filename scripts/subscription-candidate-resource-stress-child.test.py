"""Authored protocol / fake kernel only. Never spawn stress or allocate memory."""
import base64
import copy
import importlib.util
from pathlib import Path
import types
import pytest

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('subscription-candidate-resource-stress-child')
pf=load('subscription-candidate-resource-stress-protocol.test')
old=load('subscription-trusted-control-boundary-parent.test')

def deps():return tuple(load('subscription-'+name.removesuffix('.py')) for name in m.DEPS)
def ready():return old.ready()

def complete_report(phase='tasks',task_children=2):
    pr=old.complete_report();pr['profile']='fixed-candidate-resource-stress-parent';pr['startupPacket']['eofObserved']=False
    pr.pop('helperSha256Before');pr.pop('helperSha256After')
    h=pf.Harness(phase)
    if phase=='tasks' and task_children!=2:
        held=pf.held(phase);held['children']=task_children
        held['childIdentities']=[{'pid':i,'startTicks':str(i+90)} for i in range(11,11+task_children)]
        terminal=pf.terminal(phase);prototype=terminal['children'][0]
        terminal['children']=[{**copy.deepcopy(prototype),'pid':v['pid'],'identity':copy.deepcopy(v)} for v in held['childIdentities']]
        h.write('start');h.output(held,split=True);h.write('release');h.output(terminal,split=True,closed=True)
    else:h.prepare_release();h.output(pf.terminal(phase),split=True,closed=True)
    p=h.p;session=pr['sessions']['executor'];session['argv']=list(m.argv(phase));session['history']=copy.deepcopy(p.history)
    session['controlBytesQueued']=session['controlBytesWritten']=p.queued_bytes
    raw=b''.join(m.encode(e['frame'])+b'\n' for e in p.history if e['event']=='received')
    session['stdoutBase64']=base64.b64encode(raw).decode();session['observedBytes']=len(raw)
    auth=[(i,e) for i,e in enumerate(p.history) if e['event']=='trusted-caller-observer-authorization']
    control={'received':[{'action':e['action'],'rawHex':pf.m.WIRE[e['action']].hex(),'elapsedMs':110+j*30} for j,(i,e) in enumerate(auth)],
             'applied':[{'action':e['action'],'historyIndex':i,'elapsedMs':111+j*30,'observerAdmissionAttestedHere':False} for j,(i,e) in enumerate(auth)],
             'bytes':sum(len(pf.m.WIRE[e['action']]) for i,e in auth),'partialHex':'','eofObserved':False,'failure':None,'cleanupErrors':[]}
    lines=bytes(p.raw_stdout).splitlines(keepends=True)
    progress=[{'version':1,'type':'candidate_stress_progress','phase':phase,'record':r,'rawHex':lines[i].hex()} for i,r in enumerate(p.records) if r.get('type') in ('held','ramp-complete')]
    hashes={n:'a'*64 for n in m.HELPERS};hashes['subscription-text-model-catalog.json']=m.CATALOG_SHA256
    return {'version':1,'profile':'fixed-candidate-resource-stress-child','phase':phase,'success':True,'error':None,'parentReport':pr,
            'control':control,'progress':progress,'protocol':p.result(),'helperSha256Before':hashes,'helperSha256After':copy.deepcopy(hashes),
            'elapsedMs':1100,'resourceEnforcementValidated':False}

@pytest.mark.parametrize('phase',['tasks','memory'])
def test_actual_dependency_full_replay_positive(phase):
    assert m.validate_report(complete_report(phase),deps(),ready())

@pytest.mark.parametrize('count',[50,64])
def test_representative_task_report_lossless_serialization_is_not_capture_budget(count):
    report=complete_report('tasks',count)
    assert m.validate_report(report,deps(),ready())
    final=m.encode(report)+b'\n';aggregate=b''.join(m.encode(v)+b'\n' for v in report['progress'])+final
    assert 131072<len(aggregate)<3*1024*1024 and len(final)<2*1024*1024
    assert sum(v['observedBytes'] for v in report['parentReport']['sessions'].values())+sum(len(m.encode(v))+1 for v in report['progress'])<131072

@pytest.mark.parametrize('case',['false-eof','source','resource-credit','progress-raw','control-raw','observer-credit','history-index','unreaped','stderr-count','partial','identity','elapsed','work','early-cleanup','missing-ramp'])
def test_replay_rejects_raw_identity_controls_cleanup_and_limits(case):
    r=complete_report('memory');pr=r['parentReport']
    if case=='false-eof':pr['startupPacket']['eofObserved']=True
    if case=='source':r['helperSha256After']['subscription-candidate-resource-stress-child.py']='b'*64
    if case=='resource-credit':r['resourceEnforcementValidated']=True
    if case=='progress-raw':r['progress'][0]['rawHex']='7b7d0a'
    if case=='control-raw':r['control']['received'][0]['rawHex']=pf.m.WIRE['release'].hex()
    if case=='observer-credit':r['control']['applied'][0]['observerAdmissionAttestedHere']=True
    if case=='history-index':r['control']['applied'][0]['historyIndex']+=1
    if case=='unreaped':pr['sessions']['executor']['reaped']=False
    if case=='stderr-count':pr['sessions']['executor']['stderrBase64']='eA=='
    if case=='partial':pr['sessions']['executor']['partialBytes']=1
    if case=='identity':pr['beforeWorker']['pipes']['appServerControl']['ino']+=100
    if case=='elapsed':r['elapsedMs']=30000
    if case=='work':pr['completedMs']=22000
    if case=='early-cleanup':pr['sessions']['executor']['cleanupHistory'][0]['elapsedMs']=1
    if case=='missing-ramp':r['protocol']['records'][1]['allocationCapPerChild']=1
    assert not m.validate_report(r,deps(),ready())

class Budget:
    began=0
    def require_remaining(self):return 30

def test_control_waits_start_actual_reply_but_not_preauthorized_release(monkeypatch):
    monkeypatch.setattr(m.time,'monotonic',lambda:0.1)
    c=m.Control(Budget(),pf.m);c.feed(pf.m.WIRE['start']);assert not c.applied
    h=pf.Harness();c.protocol=h.p;c.apply();assert len(c.applied)==1
    with pytest.raises(ValueError,match='PROGRESS'):c.feed(pf.m.WIRE['release'])

@pytest.mark.parametrize('raw',[b'',b'{"action":"start","version":1}\n',pf.m.WIRE['ramp'],pf.m.WIRE['start']*2,b'x'*257])
def test_control_eof_noncanonical_early_duplicate_and_bound(raw,monkeypatch):
    monkeypatch.setattr(m.time,'monotonic',lambda:0.1);c=m.Control(Budget(),pf.m)
    with pytest.raises(ValueError):c.feed(raw)

def test_control_partial_does_not_authorize_and_deadline(monkeypatch):
    monkeypatch.setattr(m.time,'monotonic',lambda:0.1);c=m.Control(Budget(),pf.m)
    c.feed(pf.m.WIRE['start'][:-1]);assert not c.received
    monkeypatch.setattr(m.time,'monotonic',lambda:22)
    with pytest.raises(ValueError,match='DEADLINE'):c.feed(b'\n')

class FakeSelector:
    def __init__(self):self.items={};self.events=[];self.closed=False
    def register(self,obj,mask,data=None):self.items[obj]=types.SimpleNamespace(fileobj=obj,data=data);return self.items[obj]
    def unregister(self,obj):return self.items.pop(obj)
    def get_key(self,obj):
        if obj not in self.items:raise KeyError(obj)
        return self.items[obj]
    def select(self,timeout=None):return self.events.pop(0) if self.events else []
    def close(self):self.closed=True

def test_composed_real_parent_selector_does_not_expose_control_to_session_unpack(monkeypatch):
    parent,policy,gate,base,component=deps();inner=FakeSelector();parent.selectors=types.SimpleNamespace(DefaultSelector=lambda:inner,EVENT_READ=1,EVENT_WRITE=2)
    monkeypatch.setattr(m.time,'monotonic',lambda:.1)
    c=m.Control(Budget(),component);output=types.SimpleNamespace(bytes=0,records=[],send=lambda x:None)
    m.compose(parent,gate,component,'tasks',c,output);selector=parent.selectors.DefaultSelector()
    sessionkey=types.SimpleNamespace(data=('owned-session','stdout'))
    inner.events=[[(inner.items[0],1),(sessionkey,1)]]
    monkeypatch.setattr(m.os,'read',lambda fd,n:component.WIRE['start'])
    assert selector.select(.02)==[(sessionkey,1)] and c.received[0]['action']=='start'
    inner.events=[[(inner.items[0],1)]];monkeypatch.setattr(m.os,'read',lambda fd,n:b'')
    with pytest.raises(ValueError,match='EOF'):selector.select(.02)
    assert 'EOF' in c.failure
    selector.close();assert inner.closed

def test_composed_protocol_progress_exact_worker_bytes_and_session_accounting(monkeypatch):
    parent,policy,gate,base,component=deps();monkeypatch.setattr(m.time,'monotonic',lambda:.1)
    c=m.Control(Budget(),component);sent=[];out=types.SimpleNamespace(bytes=0,send=sent.append)
    m.compose(parent,gate,component,'tasks',c,out);p=parent.WorkerProtocol(gate,base,{})
    h=pf.Harness.__new__(pf.Harness);h.p=p;h.seq=0
    h.reply({'sessionId':'fixed-session'});h.reply({'processId':'fixed-worker'})
    h.write('start');h.output(pf.held('tasks'),split=True)
    assert len(sent)==1 and bytes.fromhex(sent[0]['rawHex'])==bytes(p.raw_stdout)
    assert sent[0]['record']==pf.held('tasks') and p.control_written==p.queued_bytes-len(p.pending)

def test_startup_reads_first_line_without_eof_and_preserves_followup(monkeypatch):
    parent,policy,gate,base,component=deps();c=m.Control(Budget(),component);sel=FakeSelector()
    sel.select=lambda t:[(None,1)]
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:sel);monkeypatch.setattr(m.os,'set_blocking',lambda *a:None)
    packet=old.packet();raw=m.encode(packet)+b'\n'
    monkeypatch.setattr(m.os,'read',lambda fd,n:raw+component.WIRE['start'])
    monkeypatch.setattr(m.os,'readlink',lambda path:packet['namespaces']['trustedPid' if path.endswith('/pid') else 'trustedMount'])
    monkeypatch.setattr(m.time,'monotonic',lambda:.1)
    result=m.read_startup(parent,base,Budget(),c)
    assert result['rawHex']==raw.hex() and result['eofObserved'] is False and c.received[0]['action']=='start' and sel.closed

def test_output_post_select_deadline_prevents_write(monkeypatch):
    sel=FakeSelector();now=[21.9]
    def select(t):now[0]=22.1;return [(None,1)]
    sel.select=select;monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:sel)
    monkeypatch.setattr(m.time,'monotonic',lambda:now[0]);monkeypatch.setattr(m.os,'set_blocking',lambda *a:None)
    monkeypatch.setattr(m.os,'write',lambda *a:pytest.fail('late write'))
    with pytest.raises(ValueError,match='DEADLINE'):m.Output(Budget()).send({'version':1})
    assert sel.closed

def test_main_rejects_argv_before_any_loading(monkeypatch):
    monkeypatch.setattr(m.sys,'platform','linux');monkeypatch.setattr(m.sys,'argv',['fixed','--inside-memory','--count=4'])
    monkeypatch.setattr(m,'run',lambda *a:pytest.fail('must not dispatch'))
    with pytest.raises(ValueError):m.main()

def test_composed_session_close_unknown_sticky_and_attempts_all_handles(monkeypatch):
    parent,policy,gate,base,component=deps();c=m.Control(Budget(),component)
    m.compose(parent,gate,component,'tasks',c,types.SimpleNamespace(bytes=0))
    closed=[]
    def close(name):
        closed.append(name)
        if name=='stdin':raise OSError('unknown')
    s=parent.Session.__new__(parent.Session);s.name='executor';s.pin=40
    s.process=types.SimpleNamespace(**{name:types.SimpleNamespace(close=lambda n=name:close(n)) for name in ('stdin','stdout','stderr')})
    monkeypatch.setattr(m,'BLOCKED',False);monkeypatch.setattr(m.os,'close',lambda fd:closed.append(fd))
    s.close();assert closed==['stdin','stdout','stderr',40] and m.BLOCKED and c.cleanup_errors
    monkeypatch.setattr(m,'sources',lambda:pytest.fail('fence must precede source I/O'))
    with pytest.raises(ValueError,match='UNKNOWN'):m.run('tasks')

@pytest.mark.parametrize('close_failure',[False,True])
def test_composed_selector_register_failure_closes_allocated_selector(monkeypatch,close_failure):
    parent,policy,gate,base,component=deps();inner=FakeSelector();closed=[]
    def register(*a):raise OSError('register-original')
    def close():
        closed.append(True)
        if close_failure:raise OSError('close-unknown')
    inner.register=register;inner.close=close;parent.selectors=types.SimpleNamespace(DefaultSelector=lambda:inner,EVENT_READ=1,EVENT_WRITE=2)
    c=m.Control(Budget(),component);monkeypatch.setattr(m,'BLOCKED',False)
    m.compose(parent,gate,component,'tasks',c,types.SimpleNamespace(bytes=0))
    with pytest.raises(OSError,match='register-original'):parent.selectors.DefaultSelector()
    assert closed==[True] and m.BLOCKED is close_failure and bool(c.cleanup_errors) is close_failure

@pytest.mark.parametrize('failure',[None,'control-eof'])
def test_actual_parent_run_loop_composition_keeps_app_owned_during_worker(monkeypatch,failure):
    parent,policy,gate,base,component=deps();fixture=complete_report()['parentReport'];events=[];created=[];clock=[0.1]
    inner=FakeSelector()
    def select(timeout):
        clock[0]+=.01
        if failure and len(created)==2 and not created[0].cleanup:return [(inner.items[0],1)]
        return []
    inner.select=select
    parent.selectors=types.SimpleNamespace(DefaultSelector=lambda:inner,EVENT_READ=1,EVENT_WRITE=2)
    monkeypatch.setattr(m.time,'monotonic',lambda:clock[0]);monkeypatch.setattr(m.os,'read',lambda *a:b'')
    class Handle:
        closed=False
        def close(self):self.closed=True
    class FakeSession:
        def __init__(self,name,command,env,protocol,policy,selector,budget):
            self.name=name;self.error=None;self.cleanup=None;self.pin=None
            if name=='executor':assert 'before' in events and not created[0].cleanup
            self.protocol=types.SimpleNamespace(pending=b'',initialized_complete=True,done=name=='executor' and failure is None)
            self.capture=types.SimpleNamespace(eof={'stdout':True,'stderr':True},observed_bytes=0)
            self.process=types.SimpleNamespace(pid=7 if name=='appserver' else 8)
            for stream in ('stdin','stdout','stderr'):
                setattr(self.process,stream,Handle())
            self.process.poll=lambda:0 if self.cleanup else None
            created.append(self);events.append('spawn-'+name)
        def begin_cleanup(self,*args):self.cleanup=True;self.process.stdin.close();events.append('cleanup-'+self.name)
        def advance_cleanup(self,*args):pass
        def report(self):return fixture['sessions'][self.name]
    parent.Session=FakeSession
    monkeypatch.setattr(parent,'prepare_home',lambda:({},fixture['marker']['value']['authoredProtectedObjects']))
    monkeypatch.setattr(parent,'capture_appserver_pipes',lambda _:fixture['beforeWorker']['pipes'])
    monkeypatch.setattr(parent,'publish_marker',lambda *a:fixture['marker'])
    def observe(*a):
        assert not created[0].cleanup
        which='before' if 'before' not in events else 'after';events.append(which)
        return fixture['beforeWorker' if which=='before' else 'afterWorker']
    monkeypatch.setattr(parent,'trusted_observation',observe)
    c=m.Control(Budget(),component);m.compose(parent,gate,component,'tasks',c,types.SimpleNamespace(bytes=0))
    result=parent.run_parent(policy,gate,base,Budget(),fixture['startupPacket'])
    assert len(created)==2 and all(s.cleanup and s.process.stdout.closed for s in created)
    if failure:assert 'CONTROL_EOF' in result['error'] and result['completedMs'] is None
    else:assert result['error'] is None and events.index('after')<events.index('cleanup-appserver')
