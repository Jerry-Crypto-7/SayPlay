"""Authored exec-server wire; no processes, sockets, allocation or observer runtime."""
import base64
import copy
import importlib.util
from pathlib import Path
import pytest

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
m=load('subscription-candidate-resource-stress-protocol')
base=load('subscription-exec-server-worker-gate')


class Gate:
    initialize_request=staticmethod(base.initialize_request)
    control_start_request=staticmethod(base.control_start_request)
    read_request=staticmethod(base.read_request)
    @staticmethod
    def stress_start_request(phase):
        v=base.control_start_request();v['params']['pipeStdin']=True
        v['params']['argv']=['/usr/bin/python3','-I','-S','/usr/bin/candidate-resource-stress-worker.py','--inside-'+phase];return v
    @staticmethod
    def stress_write_request(i,phase,action):return {'id':i,'method':'process/write','params':{'processId':'fixed-worker','chunk':base64.b64encode(m.WIRE[action]).decode(),'writeId':'stress-'+phase+'-'+action}}


def held(phase):
    return {'type':'held','phase':phase,'children':2,'workerIdentity':{'pid':10,'startTicks':'100','pidNamespace':'pid:[88]','procInitPidNamespace':'pid:[88]'},'childIdentities':[{'pid':11,'startTicks':'101'},{'pid':12,'startTicks':'102'}],**({'forkErrno':11} if phase=='tasks' else {'bytesPerAllocator':805306368})}


def terminal(phase):
    children=[]
    for i in (11,12):
        dead=phase=='memory' and i==11
        children.append({'pid':i,'kind':phase,'returncode':-9 if dead else 0,'events':[] if phase=='tasks' else ['H'] if dead else ['H','F'],'pinAcquired':True,'released':not dead,'errors':[],'identity':{'pid':i,'startTicks':str(90+i)},'commandClosed':True,'reportClosed':True,'pidfdClosed':True})
    actions=['start','release'] if phase=='tasks' else ['start','ramp','release']
    states=['await-start','held'] if phase=='tasks' else ['await-start','held','ramp-complete']
    return {'version':1,'kind':'FIXED_CANDIDATE_RESOURCE_WORKLOAD','phase':phase,'state':'released','reason':None,'releaseHistory':[{'state':s,'rawHex':m.WIRE[a].hex()} for s,a in zip(states,actions)],'normalRelease':True,'expectedWorkloadOutcome':True,'forkErrno':11 if phase=='tasks' else None,'children':children,'cleanup':{'known':True,'errors':[],'allOwnChildrenReaped':True},'resourceEnforcementValidated':False,'productionReady':False,'modelCalls':0,'credentialFilesRead':0,'elapsedMs':1000}


class Harness:
    def __init__(self,phase='tasks'):
        self.p=m.Protocol(Gate,phase);self.seq=0
        self.reply({'sessionId':'fixed-session'});self.reply({'processId':'fixed-worker'})
    def reply(self,value):
        self.p.written(len(self.p.pending));i=self.p.awaiting[0]
        self.p.receive({'id':i,'result':value})
    def read(self,chunks=None,closed=False):
        self.reply({'chunks':chunks or [],'nextSeq':self.seq+1,'exited':closed,'exitCode':0 if closed else None,'closed':closed,'failure':None,'sandboxDenied':False})
    def write(self,action):
        self.p.authorize_observer(action)
        self.read();assert self.p.pending_frames[0][1]['method']=='process/write'
        self.reply({'status':'accepted'})
    def output(self,value,split=False,notify=True,closed=False):
        raw=m.encode(value)+b'\n';blocks=[raw[:13],raw[13:]] if split else [raw];chunks=[]
        for block in blocks:
            self.seq+=1;c={'seq':self.seq,'stream':'stdout','chunk':base64.b64encode(block).decode()};chunks.append(c)
            if notify:self.p.receive({'method':'process/output','params':{'processId':'fixed-worker',**c}})
        self.read(chunks,closed)
    def prepare_release(self):
        self.write('start');self.output(held(self.p.phase),split=True)
        if self.p.phase=='memory':
            self.write('ramp');self.output({'type':'ramp-complete','phase':'memory','allocationCapPerChild':1207959552})
        self.write('release')


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_complete_finite_wire_fragmentation_dedup_and_raw(phase):
    h=Harness(phase);h.prepare_release();h.output(terminal(phase),split=True,closed=True)
    assert h.p.done and h.p.result()['complete'] and not h.p.result()['resourceEnforcementValidated']
    assert len(h.p.records)==(2 if phase=='tasks' else 3)
    assert len(h.p.raw_stdout)==sum(len(raw) for stream,raw in h.p.chunks.values())
    ids=[v['frame']['id'] for v in h.p.history if v['event']=='written' and 'id' in v['frame']]
    assert ids==list(range(1,len(ids)+1))


def test_observer_permission_not_implied_by_ack_and_progress():
    h=Harness();h.write('start');h.output(held('tasks'))
    assert h.p.pending_frames[0][1]['method']=='process/read'
    assert 'release' not in h.p.sent


@pytest.mark.parametrize('case',['missing-progress','missing-ack','wrong-phase','duplicate'])
def test_invalid_observer_transition_fails_closed(case):
    h=Harness();h.write('start')
    if case!='missing-progress':h.output(held('tasks'))
    if case=='missing-ack':h.p.accepted.remove('start')
    if case=='duplicate':h.p.authorize_observer('release')
    with pytest.raises(ValueError):h.p.authorize_observer('ramp' if case=='wrong-phase' else 'release')
    assert h.p.failed


@pytest.mark.parametrize('status',['starting','stdinClosed','unknownProcess',True])
def test_write_nonaccepted_never_retries(status):
    h=Harness();h.p.authorize_observer('start');h.read()
    with pytest.raises(ValueError,match='WRITE_NOT_ACCEPTED'):h.reply({'status':status})
    assert h.p.failed and 'start' not in h.p.accepted


def test_partial_actual_write_cannot_receive_ack():
    h=Harness();h.p.authorize_observer('start');h.read();frame=h.p.pending_frames[0][1]
    h.p.written(1)
    with pytest.raises(ValueError,match='REPLY_ORDER'):h.p.receive({'id':frame['id'],'result':{'status':'accepted'}})


def test_progress_notification_before_write_ack_does_not_release():
    h=Harness();h.p.authorize_observer('start');h.read();h.p.written(len(h.p.pending));identifier=h.p.awaiting[0]
    h.seq=1;c={'seq':1,'stream':'stdout','chunk':base64.b64encode(m.encode(held('tasks'))+b'\n').decode()}
    h.p.receive({'method':'process/output','params':{'processId':'fixed-worker',**c}})
    assert h.p.held is None and not h.p.accepted
    h.p.receive({'id':identifier,'result':{'status':'accepted'}});h.read([c])
    assert h.p.held and 'start' in h.p.accepted and 'release' not in h.p.sent


@pytest.mark.parametrize('mutation',['unknown-field','identity','bool-errno','wrong-count','duplicate-held'])
def test_invalid_actual_held_rejects(mutation):
    h=Harness();h.write('start');v=held('tasks')
    if mutation=='unknown-field':v['foreign']=1
    if mutation=='identity':v['childIdentities'][0]['startTicks']='01'
    if mutation=='bool-errno':v['forkErrno']=True
    if mutation=='wrong-count':v['children']=3
    if mutation=='duplicate-held':h.output(v)
    with pytest.raises(ValueError):h.output(v)


@pytest.mark.parametrize('mutation',['unknown-cleanup','fake-resource-credit','child-signal','child-ticks','missing-close','bool-exit','bad-release','late','missing-victim','survivor-missing-ramp'])
def test_terminal_must_match_real_worker_and_held(mutation):
    h=Harness('memory');h.prepare_release();v=terminal('memory')
    if mutation=='unknown-cleanup':v['cleanup']['known']=False
    if mutation=='fake-resource-credit':v['resourceEnforcementValidated']=True
    if mutation=='child-signal':v['children'][0]['cleanupSignals']=[9]
    if mutation=='child-ticks':v['children'][0]['identity']['startTicks']='999'
    if mutation=='missing-close':del v['children'][0]['pidfdClosed']
    if mutation=='bool-exit':v['children'][0]['returncode']=False
    if mutation=='bad-release':v['releaseHistory'][1]['rawHex']=m.WIRE['release'].hex()
    if mutation=='late':v['elapsedMs']=30000
    if mutation=='missing-victim':v['children'][0].update(returncode=0,released=True)
    if mutation=='survivor-missing-ramp':v['children'][1]['events']=['H']
    with pytest.raises(ValueError):h.output(v,closed=True)


def test_cancel_is_finite_and_never_successful_release():
    h=Harness();h.p.cancel();h.read();request=h.p.pending_frames[0][1]
    assert request['params']['writeId']=='stress-tasks-cancel'
    h.reply({'status':'accepted'})
    with pytest.raises(ValueError):h.p.authorize_observer('start')
    assert not h.p.result()['complete']


def test_eof_is_not_release_or_cleanup():
    h=Harness()
    with pytest.raises(ValueError,match='EOF'):h.p.eof()
    assert not h.p.result()['complete']


def test_notification_conflict_and_bool_sandbox_denied_reject():
    h=Harness();h.write('start')
    with pytest.raises(ValueError):h.p.receive({'method':'process/exited','params':{'processId':'fixed-worker','seq':1,'exitCode':0,'sandboxDenied':0}})


def test_result_is_detached_from_later_caller_mutations():
    h=Harness();r=h.p.result();r['history'].clear()
    assert h.p.history


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_current_real_gate_constructors_match_component_fixed_wire(phase):
    p=m.Protocol(base,phase)
    assert p.start_frame==Gate.stress_start_request(phase)
    for action in (('start','release','cancel') if phase=='tasks' else ('start','ramp','release','cancel')):
        assert base.stress_write_request(3,phase,action)==Gate.stress_write_request(3,phase,action)


def test_uncommitted_notification_bytes_cannot_disappear_at_final_close():
    h=Harness();h.prepare_release();h.output(terminal('tasks'))
    h.seq+=1
    h.p.receive({'method':'process/output','params':{'processId':'fixed-worker','seq':h.seq,'stream':'stdout','chunk':base64.b64encode(b'foreign\n').decode()}})
    with pytest.raises(ValueError,match='CLOSED_INCOMPLETE'):h.read(closed=True)


def test_same_sequence_conflicting_notification_and_read_bytes_reject():
    h=Harness();h.write('start');h.seq=1
    c={'seq':1,'stream':'stdout','chunk':base64.b64encode(b'one').decode()}
    h.p.receive({'method':'process/output','params':{'processId':'fixed-worker',**c}})
    c['chunk']=base64.b64encode(b'two').decode()
    with pytest.raises(ValueError,match='CONFLICT'):h.read([c])


def test_missing_write_id_gate_constructor_refused_before_queue():
    h=Harness();h.p.authorize_observer('start')
    class Bad(Gate):
        @staticmethod
        def stress_write_request(i,phase,action):
            v=Gate.stress_write_request(i,phase,action);del v['params']['writeId'];return v
    h.p.gate=Bad
    with pytest.raises(ValueError,match='FIXED_RELEASE_WRITE'):h.read()


def test_finite_rpc_count_stops_without_unbounded_reads():
    h=Harness();h.p.next_id=129
    with pytest.raises(ValueError,match='RPC_LIMIT'):h.read()


class RealGateHarness(Harness):
    def __init__(self,phase):
        self.actual_gate=base.Gate('pid:[1]','mnt:[2]','candidate-resource-stress-'+phase)
        self.p=m.Protocol(base,phase);self.seq=0;receive=self.p.receive
        def received(frame):self.actual_gate.receive(frame);receive(frame)
        self.p.receive=received
        self.reply({'sessionId':'fixed-session'});self.reply({'processId':'fixed-worker'})
    def reply(self,value):
        for _,frame in list(self.p.pending_frames):
            self.actual_gate.admit(copy.deepcopy(frame));self.actual_gate.written(len(self.actual_gate.pending))
        super().reply(value)


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_complete_real_gate_and_protocol_state_machines_together(phase):
    h=RealGateHarness(phase);h.prepare_release();h.output(terminal(phase),split=True,closed=True)
    assert h.p.done and not h.actual_gate.failed
