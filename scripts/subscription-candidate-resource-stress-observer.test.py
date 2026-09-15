"""Mocked filesystem/process metadata only; no unit, workload or signals beyond fake pin0."""
import copy
import hashlib
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest


def load():
    spec=importlib.util.spec_from_file_location('tested_observer',Path(__file__).with_name('subscription-candidate-resource-stress-observer.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


def identity(pid,ticks='20'):
    return {'pid':pid,'startTicks':ticks,'pidNamespace':'pid:[500]','nspid':[pid+100,pid]}


def held():return {'phase':'memory','workerIdentity':{'pid':3,'startTicks':'20','pidNamespace':'pid:[500]','procInitPidNamespace':'pid:[500]'},'childIdentities':[{'pid':4,'startTicks':'20'},{'pid':5,'startTicks':'20'}]}


class Reader:
    unit='codex-cli-resource-'+'a'*32+'.service'
    def __init__(self):self.count=0;self.closed=False;self.members=[103,104,105];self.failclose=False
    def sample(self):
        self.count+=1
        return {'values':{'cgroup.procs':list(self.members),'memory.oom.group':0},'sequence':self.count}
    open=sample
    def close(self):self.closed=True;return not self.failclose


def setup(monkeypatch):
    m=load();now=[1.0];pins={};closed=[];signals=[];reader=Reader()
    monkeypatch.setattr(m.select,'poll',lambda:SimpleNamespace(register=lambda *a:None,poll=lambda timeout:[]),raising=False)
    monkeypatch.setattr(m.select,'POLLIN',1,raising=False)
    monkeypatch.setattr(m.time,'monotonic',lambda:now[0])
    monkeypatch.setattr(m.os,'pidfd_open',lambda pid:pins.setdefault(pid,pid+1000),raising=False)
    monkeypatch.setattr(m.os,'set_inheritable',lambda fd,value:None)
    monkeypatch.setattr(m.os,'close',lambda fd:closed.append(fd))
    monkeypatch.setattr(m.signal,'pidfd_send_signal',lambda fd,sig:signals.append((fd,sig)),raising=False)
    monkeypatch.setattr(m.os,'open',lambda *a,**k:pytest.fail('unmocked filesystem'))
    monkeypatch.setattr(m.subprocess,'run',lambda *a,**k:SimpleNamespace(stdout=b'OOMPolicy=continue\n'))
    manager={'managerPid':50,'managerStartTimeTicks':'7','managerCgroup':'/manager'}
    control={'unitMainPid':70,'unitMainStartTimeTicks':'9','managerPid':50}
    relay=SimpleNamespace(manager_connection=lambda p:copy.deepcopy(manager),process_start_ticks=lambda pid:'7' if pid==50 else '9',cgroup=lambda pid:'/manager',binding=lambda *a:copy.deepcopy(control),exact_readback=lambda *a:{'memoryMax':'2147483648'})
    probe=SimpleNamespace(environment=lambda:{'PATH':'/usr/bin:/bin'},leaf_path=lambda unit:'/sys/fs/cgroup/own/'+unit)
    events=SimpleNamespace(create_event_reader=lambda deadline:reader)
    obj=m.Observer(20,(events,relay,probe),{name:'a'*64 for name in m.FILES},m._TOKEN)
    obj._process=lambda pid:identity(pid-100)
    return m,obj,reader,relay,now,pins,closed,signals


def test_open_admission_rechecks_owned_members_and_returns_no_overall_credit(monkeypatch):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch)
    initial=o.open();initial['control']['managerPid']=999
    assert o.control['managerPid']==50 and not initial['releaseAdmitted']
    result=o.admit_workers(held())
    assert result['releaseAdmitted'] and not result['releaseWritten'] and not result['exhaustionValidated']
    assert set(pins)=={50,70,103,104,105} and all(sig==0 for _,sig in signals)
    result['workers'][3]['identity']['startTicks']='999'
    assert o.workers[3]['identity']['startTicks']=='20'
    assert o.close() and r.closed and set(closed)==set(pins.values())


@pytest.mark.parametrize('case',['manager','main','oom','pidfd','inheritable','deadline'])
def test_open_failures_close_all_acquired_pins_and_fence(monkeypatch,case):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch)
    if case=='manager':relay.process_start_ticks=lambda pid:'999'
    elif case=='main':relay.process_start_ticks=lambda pid:'7' if pid==50 else '999'
    elif case=='oom':monkeypatch.setattr(m.subprocess,'run',lambda *a,**k:SimpleNamespace(stdout=b'OOMPolicy=stop\n'))
    elif case=='pidfd':monkeypatch.setattr(m.os,'pidfd_open',lambda pid:(_ for _ in ()).throw(OSError()),raising=False)
    elif case=='inheritable':monkeypatch.setattr(m.os,'set_inheritable',lambda *a:(_ for _ in ()).throw(OSError()))
    elif case=='deadline':now[0]=20
    with pytest.raises((ValueError,OSError)):o.open()
    assert m._UNKNOWN and o.close() is False and r.closed
    assert set(closed)==set(pins.values())


@pytest.mark.parametrize('case',['missing','namespace','ticks','duplicate','freshproc','boolpid','extra','membership-after-pin','generation-after-pin','control-drift'])
def test_worker_admission_rejects_identity_and_generation_gaps(monkeypatch,case):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch);o.open();value=held()
    if case=='missing':r.members=[103,104]
    elif case=='namespace':o._process=lambda pid:{**identity(pid-100),'pidNamespace':'pid:[999]'}
    elif case=='ticks':value['childIdentities'][0]['startTicks']='21'
    elif case=='duplicate':value['childIdentities'][1]=value['childIdentities'][0]
    elif case=='freshproc':value['workerIdentity']['procInitPidNamespace']='pid:[999]'
    elif case=='boolpid':value['childIdentities'][0]['pid']=True
    elif case=='extra':value['hostPid']=104
    elif case=='control-drift':relay.binding=lambda *a:{'unitMainPid':999,'unitMainStartTimeTicks':'9','managerPid':50}
    elif case=='membership-after-pin':
        original=o._pin
        def pin(key,pid):
            result=original(key,pid)
            if key=='worker-5':r.members.remove(105)
            return result
        o._pin=pin
    elif case=='generation-after-pin':
        o._process=lambda pid:identity(pid-100,'21' if 'worker-'+str(pid-100) in o.pins else '20')
    with pytest.raises(ValueError):o.admit_workers(value)
    assert not o.admitted and m._UNKNOWN and o.close() is False
    assert set(closed)==set(pins.values())


@pytest.mark.parametrize('flags',[1,17])
def test_outcome_uses_retained_pin_readiness_without_signaling_or_reaping(monkeypatch,flags):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch);o.open();o.admit_workers(held())
    class Poll:
        def register(self,fd,event):self.fd=fd
        def poll(self,timeout):return [(self.fd,flags)] if self.fd==1104 else []
    monkeypatch.setattr(m.select,'poll',Poll,raising=False);monkeypatch.setattr(m.select,'POLLIN',1,raising=False)
    monkeypatch.setattr(m.select,'POLLHUP',16,raising=False)
    outcomes=o.observe_outcomes()['outcomes']
    assert [v['pidfdExitObserved'] for v in outcomes]==[False,True,False]
    assert all(v['returnCode'] is None and not v['reapedByObserver'] for v in outcomes)
    o.close()


@pytest.mark.parametrize('case',['hup-only','error','invalid','boolean','foreign','duplicate'])
def test_outcome_refuses_unknown_or_ambiguous_pidfd_events(monkeypatch,case):
    m,o,*_=setup(monkeypatch);o.open();o.admit_workers(held())
    class Poll:
        def register(self,fd,event):self.fd=fd
        def poll(self,timeout):
            if self.fd!=1104:return []
            if case=='foreign':return [(9999,17)]
            if case=='duplicate':return [(self.fd,1),(self.fd,1)]
            return [(self.fd,{'hup-only':16,'error':9,'invalid':33,'boolean':True}[case])]
    monkeypatch.setattr(m.select,'poll',Poll,raising=False)
    monkeypatch.setattr(m.select,'POLLIN',1,raising=False);monkeypatch.setattr(m.select,'POLLHUP',16,raising=False)
    with pytest.raises(ValueError,match='PIDFD_EVENT_UNKNOWN'):o.observe_outcomes()
    assert o.failed and m._UNKNOWN and o.close() is False


def test_close_failure_is_sticky_and_other_pins_still_closed(monkeypatch):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch);o.open()
    def close(fd):
        closed.append(fd)
        if fd==1050:raise OSError('unknown')
    monkeypatch.setattr(m.os,'close',close)
    assert o.close() is False and o.close() is False and set(closed)==set(pins.values()) and m._UNKNOWN
    with pytest.raises(ValueError,match='PRIOR'):m.create_observer(20,{})


def test_metadata_query_is_fixed_and_timeout_clamped(monkeypatch):
    m,o,*rest=setup(monkeypatch);rest[2][0]=19.5;calls=[]
    monkeypatch.setattr(m.subprocess,'run',lambda argv,**kw:calls.append((argv,kw)) or SimpleNamespace(stdout=b'OOMPolicy=continue\n'))
    o._query(['/usr/bin/systemctl','--user','--no-ask-password','show',o.unit,'--property=OOMPolicy'])
    assert calls[0][1]['timeout']==.5
    with pytest.raises(ValueError,match='FIXED'):o._query(['/usr/bin/systemctl','stop',o.unit])
    o.close()


def test_source_hash_mismatch_before_compile_or_process(monkeypatch):
    m=load();raw=b'raise AssertionError("must not execute")';closed=[]
    monkeypatch.setattr(m.os,'O_CLOEXEC',0,raising=False);monkeypatch.setattr(m.os,'O_NOFOLLOW',0,raising=False);monkeypatch.setattr(m.os,'O_NONBLOCK',0,raising=False)
    monkeypatch.setattr(m.os,'open',lambda *a:10);monkeypatch.setattr(m.os,'read',lambda *a:raw)
    monkeypatch.setattr(m.os,'fstat',lambda fd:SimpleNamespace(st_mode=0o100444,st_size=len(raw),st_dev=1,st_ino=2,st_mtime_ns=3))
    monkeypatch.setattr(m.os,'close',lambda fd:closed.append(fd))
    with pytest.raises(ValueError,match='SOURCE_HASH'):m.load_sources({name:'0'*64 for name in m.FILES})
    assert closed==[10]


def test_final_close_delay_stays_unknown_after_all_fds_closed(monkeypatch):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch);o.open()
    def close(fd):closed.append(fd);now[0]=20
    monkeypatch.setattr(m.os,'close',close)
    assert o.close() is False and set(closed)==set(pins.values()) and m._UNKNOWN


def test_real_process_parser_binds_only_exact_owned_leaf_and_nspid(monkeypatch):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch)
    statline='103 (owned command) '+' '.join(['S','70']+['0']*17+['20'])
    records={'stat':statline,'status':'Name:\towned\nNSpid:\t103\t3\n','cgroup':'0::/own/'+o.unit+'\n'}
    o._read=lambda pid,name:records[name]
    monkeypatch.setattr(m.os,'readlink',lambda path:'pid:[500]')
    actual=m.Observer._process(o,103)
    assert actual==identity(3)
    records['cgroup']='0::/foreign\n'
    with pytest.raises(ValueError,match='OUTSIDE_OWN_LEAF'):m.Observer._process(o,103)
    records['cgroup']='0::/own/'+o.unit+'\n';records['status']='NSpid:\t999\t3\n'
    with pytest.raises(ValueError,match='HOST_NSPID'):m.Observer._process(o,103)
    o.close()


def test_post_report_copy_deadline_cannot_admit_release(monkeypatch):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch);o.open()
    original=m.copy.deepcopy
    def delayed(value):
        result=original(value)
        if type(value) is dict and 3 in value and 'hostPid' in value[3]:now[0]=20
        return result
    monkeypatch.setattr(m,'copy',SimpleNamespace(deepcopy=delayed))
    with pytest.raises(ValueError,match='DEADLINE'):o.admit_workers(held())
    assert m._UNKNOWN and o.close() is False


@pytest.mark.parametrize('state',['Z','X','x'])
def test_matching_zombie_metadata_rejected_before_admission(monkeypatch,state):
    m,o,*rest=setup(monkeypatch)
    o._read=lambda pid,name:'103 (owned) '+' '.join([state,'70']+['0']*17+['20'])
    with pytest.raises(ValueError,match='ZOMBIE'):m.Observer._process(o,103)
    o.close()


@pytest.mark.parametrize('flags',[1,16,32])
def test_already_readable_or_error_pin_cannot_admit_release(monkeypatch,flags):
    m,o,r,relay,now,pins,closed,signals=setup(monkeypatch);o.open()
    monkeypatch.setattr(m.select,'poll',lambda:SimpleNamespace(register=lambda *a:None,poll=lambda timeout:[(1103,flags)]),raising=False)
    with pytest.raises(ValueError,match='NOT_LIVE'):o.admit_workers(held())
    assert not o.admitted and m._UNKNOWN and o.close() is False
