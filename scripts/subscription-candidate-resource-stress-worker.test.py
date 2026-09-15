"""Mocked kernel and allocator only. Never execute the stress entry."""
import errno
import importlib.util
from pathlib import Path
from unittest.mock import patch
import pytest

spec=importlib.util.spec_from_file_location('stress',Path(__file__).with_name('subscription-candidate-resource-stress-worker.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


class Fake:
    def __init__(self,actions,limit=3,oom=True,cleanup_known=True):
        self.actions=list(actions);self.limit=limit;self.oom=oom;self.cleanup_known=cleanup_known
        self.children=[];self.frames=[];self.spawn_calls=0;self.sent=[];self.stages=[]
    def receive(self):return self.actions.pop(0)
    def check_work(self):pass
    def emit(self,v):self.frames.append(v)
    def spawn(self,kind):
        self.spawn_calls+=1
        if kind=='tasks' and len(self.children)==self.limit:raise m.ForkDenied()
        x={'pid':100+len(self.children),'pinAcquired':True,'kind':kind,'returncode':None,'events':[],'released':False}
        self.children.append(x);return x
    def send(self,item,v):self.sent.append((item['pid'],v))
    def held_identities(self):
        return {'workerIdentity':{'pid':50,'startTicks':'100','pidNamespace':'pid:[77]','procInitPidNamespace':'pid:[77]'},
            'childIdentities':[{'pid':x['pid'],'startTicks':str(101+i)} for i,x in enumerate(self.children)]}
    def await_stage(self,stage,allow_oom=False):
        self.stages.append((stage,allow_oom))
        if stage=='F' and self.oom:self.children[0]['returncode']=-9
    def cleanup(self,normal):
        for x in self.children:
            if x['returncode'] is None:x['returncode']=0
        return {'known':self.cleanup_known,'errors':[],'allOwnChildrenReaped':self.cleanup_known}


@pytest.fixture(autouse=True)
def fence(monkeypatch):
    m.BLOCKED=False
    for name in ('pipe2','fork','pidfd_open','waitpid'):
        if not hasattr(m.os,name):monkeypatch.setattr(m.os,name,lambda *a:(_ for _ in ()).throw(AssertionError('UNMOCKED_KERNEL')),raising=False)
    for name,value in (('O_CLOEXEC',0x80000),('O_NOFOLLOW',0x20000),('WNOHANG',1)):
        if not hasattr(m.os,name):monkeypatch.setattr(m.os,name,value,raising=False)
    for name,value in (('SIGKILL',9),('ITIMER_REAL',0),('setitimer',lambda *a:None),('pidfd_send_signal',lambda *a:None)):
        if not hasattr(m.signal,name):monkeypatch.setattr(m.signal,name,value,raising=False)


def test_tasks_fixed_eagain_release_and_raw_history():
    k=Fake([m.WIRE['start'],m.WIRE['release']]);r=m.run('tasks',k)
    assert r['expectedWorkloadOutcome'] and r['resourceEnforcementValidated'] is False
    assert k.spawn_calls==4 and len(r['children'])==3 and r['forkErrno']==errno.EAGAIN
    assert [bytes.fromhex(x['rawHex']) for x in r['releaseHistory']]==[m.WIRE['start'],m.WIRE['release']]


def test_no_unbounded_forks_when_limit_not_hit():
    k=Fake([m.WIRE['start'],m.WIRE['release']],limit=100)
    assert not m.run('tasks',k)['expectedWorkloadOutcome']
    assert k.spawn_calls==64


def test_memory_exact_two_children_and_two_stages():
    k=Fake([m.WIRE['start'],m.WIRE['ramp'],m.WIRE['release']]);r=m.run('memory',k)
    assert r['expectedWorkloadOutcome'] and len(r['children'])==2
    assert k.stages==[('H',False),('F',True)] and [v for _,v in k.sent]==[b'R',b'R']
    assert m.STAGE_CHUNKS*m.CHUNK_BYTES==768*1024*1024
    assert m.MAX_CHUNKS*m.CHUNK_BYTES==1152*1024*1024


@pytest.mark.parametrize('raw',[b'',m.WIRE['cancel'],m.WIRE['ramp'],b'{"action":"start","version":1}\n',b'{"version":true,"action":"start"}\n',m.WIRE['start']+m.WIRE['release']])
def test_invalid_initial_control_never_spawns(raw):
    k=Fake([raw]);r=m.run('tasks',k)
    assert not r['expectedWorkloadOutcome'] and k.spawn_calls==0 and r['reason']


@pytest.mark.parametrize('raw',[b'',m.WIRE['cancel'],m.WIRE['start']])
def test_eof_cancel_duplicate_are_not_successful_release(raw):
    k=Fake([m.WIRE['start'],raw]);r=m.run('tasks',k)
    assert not r['normalRelease'] and not r['expectedWorkloadOutcome']


def test_no_oom_is_not_enforcement_success():
    k=Fake([m.WIRE['start'],m.WIRE['ramp'],m.WIRE['release']],oom=False)
    assert not m.run('memory',k)['expectedWorkloadOutcome']


def test_unknown_cleanup_fences_same_module_next_dispatch():
    k=Fake([m.WIRE['start'],m.WIRE['release']],cleanup_known=False)
    assert not m.run('tasks',k)['expectedWorkloadOutcome']
    other=Fake([])
    with pytest.raises(m.Stop,match='FENCE'):m.run('tasks',other)
    assert other.spawn_calls==0


def test_setup_eagain_is_not_fork_limit_evidence():
    k=Fake([m.WIRE['start']]);k.spawn=lambda kind:(_ for _ in ()).throw(OSError(errno.EAGAIN,'pin failed'))
    r=m.run('tasks',k);assert r['forkErrno'] is None and not r['expectedWorkloadOutcome']


def test_cleanup_signal_is_not_expected_oom():
    k=Fake([m.WIRE['start'],m.WIRE['ramp'],m.WIRE['release']]);original=k.cleanup
    def cleanup(normal):
        r=original(normal);k.children[0]['cleanupSignals']=[9];return r
    k.cleanup=cleanup
    assert not m.run('memory',k)['expectedWorkloadOutcome']


class SparseBlock:
    def __init__(self,size):self.size=size;self.pages={}
    def __setitem__(self,key,value):self.pages[key]=value


def test_allocation_fixed_bounds_and_every_page_touched_without_gb_allocation():
    blocks=[];m.allocate(blocks,48,1,clock=lambda:0,allocator=SparseBlock)
    assert len(blocks)==48 and all(len(b.pages)==4096 and b.size==m.CHUNK_BYTES for b in blocks)
    m.allocate(blocks,72,1,clock=lambda:0,allocator=SparseBlock)
    assert len(blocks)==72 and all(all(value>0 for value in b.pages.values()) for b in blocks)
    with pytest.raises(ValueError):m.allocate(blocks,73,1,clock=lambda:0,allocator=SparseBlock)


def test_expired_deadline_allocates_nothing():
    with patch.object(m,'bytearray',create=True) as alloc:
        with pytest.raises(m.Stop,match='DEADLINE'):m.allocate([],48,1,clock=lambda:1,allocator=alloc)
        alloc.assert_not_called()


def test_elapsed_allocator_stops_before_next_chunk():
    clock=[0]
    def alloc(size):clock[0]=2;return SparseBlock(size)
    blocks=[]
    with pytest.raises(m.Stop):m.allocate(blocks,48,1,clock=lambda:clock[0],allocator=alloc)
    assert not blocks


def test_child_private_gate_precedes_allocation():
    with patch.object(m.os,'listdir',return_value=[]),patch.object(m.signal,'setitimer'),patch.object(m.time,'monotonic',return_value=0),patch.object(m.select,'select',return_value=([10],[],[])),patch.object(m.os,'read',return_value=b''),patch.object(m,'allocate') as alloc:
        with pytest.raises(m.Stop,match='GATE'):m.child_loop('memory',10,11,22)
        alloc.assert_not_called()


def test_pin_failure_keeps_owned_child_in_cleanup_registry_and_never_releases():
    k=object.__new__(m.Kernel);k.children=[];k.work=22;k.now=lambda:0
    with patch.object(m.os,'pipe2',side_effect=[(10,11),(12,13)]),patch.object(m.os,'fork',return_value=500),patch.object(m.os,'close') as close,patch.object(m.os,'pidfd_open',side_effect=OSError(errno.EMFILE,'pin')),patch.object(k,'send') as send:
        with pytest.raises(OSError):k.spawn('tasks')
        assert k.children[0]['pid']==500 and not k.children[0]['pinAcquired']
        send.assert_not_called();assert [x.args[0] for x in close.call_args_list]==[10,13]


def test_failed_second_pipe_closes_first_pair_without_fork():
    k=object.__new__(m.Kernel);k.children=[];k.work=22;k.now=lambda:0
    with patch.object(m.os,'pipe2',side_effect=[(10,11),OSError(errno.EMFILE,'pipe')]),patch.object(m.os,'close') as close,patch.object(m.os,'fork') as fork:
        with pytest.raises(OSError):k.spawn('tasks')
        fork.assert_not_called();assert [x.args[0] for x in close.call_args_list]==[10,11]


def test_main_refuses_host_entry_before_kernel():
    with patch.object(m.sys,'argv',['worker','--inside-tasks']),patch.object(m,'Kernel') as kernel:
        with pytest.raises(m.Stop,match='PROFILE'):m.main()
        kernel.assert_not_called()


def test_real_spawn_pins_and_identity_before_release():
    k=object.__new__(m.Kernel);k.children=[];k.work=22;k.now=lambda:0;k.setup_close_unknown=False
    order=[]
    with patch.object(m.os,'pipe2',side_effect=[(10,11),(12,13)]),patch.object(m.os,'fork',return_value=500),patch.object(m.os,'close'),patch.object(m.os,'pidfd_open',side_effect=lambda *a:order.append('pin') or 20),patch.object(m.os,'set_inheritable'),patch.object(m.signal,'pidfd_send_signal',side_effect=lambda *a:order.append('live')),patch.object(k,'identity',side_effect=lambda p:order.append('identity') or {'pid':p,'startTicks':'123'}),patch.object(k,'send',side_effect=lambda *a:order.append('release')):
        item=k.spawn('memory')
    assert order==['pin','live','identity','live','release'] and item['pinAcquired']


def test_failed_setup_close_is_sticky_without_retry():
    k=object.__new__(m.Kernel);k.children=[];k.work=22;k.now=lambda:0;k.setup_close_unknown=False
    with patch.object(m.os,'pipe2',side_effect=[(10,11),OSError(errno.EMFILE,'pipe')]),patch.object(m.os,'close',side_effect=[OSError(errno.EIO,'close'),None]) as close:
        with pytest.raises(OSError):k.spawn('tasks')
    assert k.setup_close_unknown and [c.args[0] for c in close.call_args_list]==[10,11]


def test_known_wait_status_is_required_for_cleanup():
    k=object.__new__(m.Kernel);k.setup_close_unknown=False;k.total=30;k.work=22;k.now=lambda:30
    k.children=[{'pid':123,'returncode':None,'command':11,'report':12,'pidfd':20,'pinAcquired':True}]
    with patch.object(m.os,'waitpid',return_value=(0,0)),patch.object(m.os,'close'),patch.object(m.signal,'pidfd_send_signal'):
        r=k.cleanup(False)
    assert not r['known'] and not r['allOwnChildrenReaped']


def test_reaped_child_fd_close_failure_is_unknown():
    k=object.__new__(m.Kernel);k.setup_close_unknown=False;k.total=30;k.work=22;k.now=lambda:30
    k.children=[{'pid':123,'returncode':0,'command':11,'report':12,'pidfd':20,'pinAcquired':True}]
    with patch.object(m.os,'close',side_effect=[None,OSError(errno.EIO,'close'),None]):r=k.cleanup(False)
    assert not r['known'] and r['allOwnChildrenReaped']


def test_child_abnormal_exit_after_release_is_not_tasks_success():
    k=Fake([m.WIRE['start'],m.WIRE['release']]);original=k.cleanup
    def cleanup(normal):
        value=original(normal);k.children[0]['returncode']=1;return value
    k.cleanup=cleanup
    assert not m.run('tasks',k)['expectedWorkloadOutcome']


def test_coalesced_control_is_rejected_without_work():
    k=object.__new__(m.Kernel);k.partial=bytearray(m.WIRE['start']+m.WIRE['release'])
    with pytest.raises(m.Stop,match='PIPELINING'):k.receive()


def test_public_main_uses_real_run_but_mocked_kernel_only():
    k=Fake([m.WIRE['start'],m.WIRE['release']])
    with patch.object(m.sys,'argv',['worker','--inside-tasks']),patch.object(m,'admission'),patch.object(m,'Kernel',return_value=k),patch.object(m.time,'monotonic',return_value=0):
        assert m.main()==0
    assert k.frames[-1]['kind']=='FIXED_CANDIDATE_RESOURCE_WORKLOAD'


def test_late_release_clock_sample_cannot_get_normal_success():
    k=Fake([m.WIRE['start'],m.WIRE['release']]);calls=[0]
    def check_work():
        calls[0]+=1
        if calls[0]==4:raise m.Stop('WORK_DEADLINE')
    k.check_work=check_work;r=m.run('tasks',k)
    assert r['reason']=='WORK_DEADLINE' and not r['normalRelease']


def test_own_stat_close_failure_after_fork_fences_even_after_reap():
    k=object.__new__(m.Kernel);k.children=[];k.work=22;k.total=30;k.now=lambda:0;k.setup_close_unknown=False
    with patch.object(m.os,'pipe2',side_effect=[(10,11),(12,13)]),patch.object(m.os,'fork',return_value=500),patch.object(m.os,'pidfd_open',return_value=20),patch.object(m.os,'set_inheritable'),patch.object(m.signal,'pidfd_send_signal'),patch.object(m.os,'open',return_value=21),patch.object(m.os,'read',return_value=b'unparsed'),patch.object(m.os,'close',side_effect=[None,None,OSError(errno.EIO,'statclose')]),patch.object(k,'send') as send:
        with pytest.raises(OSError):k.spawn('tasks')
        send.assert_not_called()
    assert k.setup_close_unknown and k.children[0]['pid']==500
    k.children[0]['returncode']=0;k.now=lambda:30
    with patch.object(m.os,'close') as close:r=k.cleanup(False)
    assert not r['known'] and r['allOwnChildrenReaped']
    assert {c.args[0] for c in close.call_args_list}=={11,12,20}
    # Real run receives that exact cleanup outcome and fences its module.
    fake=Fake([b'']);fake.cleanup=lambda normal:r
    assert not m.run('tasks',fake)['cleanup']['known']
    with pytest.raises(m.Stop,match='FENCE'):m.run('tasks',Fake([]))


def test_output_readiness_after_total_deadline_never_writes():
    k=object.__new__(m.Kernel);k.total=30;k.output_bytes=0;clock=[29];k.now=lambda:clock[0]
    def ready(*args):clock[0]=30;return ([],[1],[])
    with patch.object(m.select,'select',side_effect=ready),patch.object(m.os,'write') as write:
        with pytest.raises(m.Stop,match='DEADLINE'):k.emit({'type':'held'})
        write.assert_not_called()


def held_kernel():
    k=object.__new__(m.Kernel);k.work=22;k.now=lambda:0;k.identity_unknown=False;k.setup_close_unknown=False
    k.children=[{'pid':101,'pidfd':20,'pinAcquired':True,'returncode':None,'identity':{'pid':101,'startTicks':'456'}}]
    return k


def test_held_actual_metadata_reads_all_live_pins_before_emission():
    k=held_kernel();events=[]
    def identity(pid):events.append(('stat',pid));return {'pid':pid,'startTicks':'123' if pid==100 else '456'}
    with patch.object(m.os,'getpid',return_value=100),patch.object(k,'identity',side_effect=identity),patch.object(m.os,'readlink',return_value='pid:[88]'),patch.object(m.signal,'pidfd_send_signal',side_effect=lambda fd,sig:events.append(('pin',fd))):
        r=k.held_identities()
    assert r=={'workerIdentity':{'pid':100,'startTicks':'123','pidNamespace':'pid:[88]','procInitPidNamespace':'pid:[88]'},'childIdentities':[{'pid':101,'startTicks':'456'}]}
    assert events==[('stat',100),('pin',20),('stat',101),('pin',20),('stat',100)]


@pytest.mark.parametrize('case',['generation','dead-pin','namespace','worker-generation','deadline','read-error'])
def test_held_identity_uncertainty_is_sticky(case):
    k=held_kernel();calls=[0]
    def identity(pid):
        calls[0]+=1
        if case=='read-error':raise OSError(errno.EIO,'stat')
        return {'pid':pid,'startTicks':('999' if case=='generation' and pid==101 or case=='worker-generation' and calls[0]==3 else '123' if pid==100 else '456')}
    def live(*args):
        if case=='dead-pin':raise ProcessLookupError()
    def work():
        if case=='deadline':raise m.Stop('WORK_DEADLINE')
    with patch.object(m.os,'getpid',return_value=100),patch.object(k,'identity',side_effect=identity),patch.object(k,'check_work',side_effect=work),patch.object(m.os,'readlink',side_effect=['pid:[88]','pid:[89]'] if case=='namespace' else lambda p:'pid:[88]'),patch.object(m.signal,'pidfd_send_signal',side_effect=live):
        with pytest.raises((m.Stop,OSError)):k.held_identities()
    assert k.identity_unknown
    # No remaining child is needed to prove this uncertainty alone blocks cleanup success.
    k.children=[];k.total=30;k.now=lambda:30
    assert not k.cleanup(False)['known']


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_both_held_frames_carry_pre_release_identities(phase):
    actions=[m.WIRE['start']]+([m.WIRE['ramp']] if phase=='memory' else [])+[m.WIRE['release']]
    k=Fake(actions);m.run(phase,k)
    h=k.frames[0]
    assert h['type']=='held' and len(h['childIdentities'])==h['children']
    assert h['workerIdentity']['pidNamespace']==h['workerIdentity']['procInitPidNamespace']


def test_identity_failure_does_not_emit_held_or_accept_release():
    k=Fake([m.WIRE['start'],m.WIRE['release']]);k.held_identities=lambda:(_ for _ in ()).throw(m.Stop('HELD_CHILD_GENERATION'))
    r=m.run('tasks',k)
    assert not k.frames and not r['normalRelease'] and r['reason']=='HELD_CHILD_GENERATION'


@pytest.mark.parametrize('case',['zombie','wrong-pid','noncanonical-ticks'])
def test_own_stat_never_reports_dead_or_mismatched_identity(case):
    k=held_kernel();fields=['S','100']+['0']*17+['123']
    if case=='zombie':fields[0]='Z'
    if case=='noncanonical-ticks':fields[19]='0123'
    raw=((('102' if case=='wrong-pid' else '101')+' (worker) '+' '.join(fields))).encode()
    with patch.object(m.os,'open',return_value=20),patch.object(m.os,'read',return_value=raw),patch.object(m.os,'close'):
        with pytest.raises(m.Stop,match='STAT'):k.identity(101)
