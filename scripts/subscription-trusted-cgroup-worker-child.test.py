"""Authored full wire replay; no actual worker/cgroup operations."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest


def load(name):
    spec=importlib.util.spec_from_file_location(name.replace('-','_'),Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


m=load('subscription-trusted-cgroup-worker-child')
parent_fixture=load('subscription-trusted-control-boundary-parent.test')
probe_fixture=load('subscription-trusted-cgroup-worker-probe.test')


def dependencies():
    parent=load('subscription-trusted-control-boundary-parent')
    gate=load('subscription-exec-server-worker-gate')
    return parent,parent_fixture.policy,gate,probe_fixture.fixture.m,probe_fixture.m


def ready():return parent_fixture.ready()


def complete_report(opened=False):
    deps=dependencies();parent,policy,gate,base,cgroup=deps
    h={name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest() for name in m.HELPERS}
    body=probe_fixture.complete_report()
    body['baseSha256']=h['subscription-trusted-control-boundary-probe.py']
    pr=parent_fixture.complete_report()
    for key in ('rawHex','bytes','sha256'):
        body['baseReport']['marker'][key]=pr['marker'][key]
    if opened:
        body['paths'][cgroup.PATHS[0]].update(opened=True,errno=None,outcome='opened',cleanup='CLOSED',descriptor={'fd':3,'dev':1,'ino':900,'type':0o100000})
    view,probe,captured=m.compose(parent,gate,base,cgroup,body['baseSha256'])
    worker=parent.WorkerProtocol(view,probe,pr['marker']['value'])
    parent_fixture.drain(worker)
    worker.receive({'id':1,'result':{'sessionId':'fixed-session'}})
    parent_fixture.drain(worker)
    worker.receive({'id':2,'result':{'processId':'fixed-worker'}})
    parent_fixture.drain(worker)
    raw=json.dumps(body).encode()+b'\n'
    frame={'id':3,'result':{'chunks':[{'seq':1,'stream':'stdout','chunk':base64.b64encode(raw).decode()}],'nextSeq':2,'exited':True,'exitCode':0,'closed':True,'failure':None,'sandboxDenied':False}}
    if opened:
        with pytest.raises(ValueError,match='WORKER_BOUNDARY_PROBE_FAILED'):worker.receive(frame)
    else:worker.receive(frame)
    pr['sessions']['executor']=parent_fixture.session_report(worker,8,m.GATE_ARGV)
    for field in ('helperSha256Before','helperSha256After'):pr[field]={name:h[name] for name in parent.HELPER_FILES}
    return {'version':1,'profile':'fixed-trusted-cgroup-worker-child','success':not opened,'error':'WORKER_BOUNDARY_PROBE_FAILED' if opened else None,'parentReport':pr,'cgroupReport':captured[0],'helperSha256Before':h,'helperSha256After':dict(h),'elapsedMs':1100}


def test_complete_cgroup_raw_and_original_parent_replay():
    r=complete_report();assert m.validate_report(r,dependencies(),ready())
    assert 'marker' not in r['cgroupReport']
    assert set(r['cgroupReport']['paths'])==set(probe_fixture.m.PATHS)


def test_actual_parent_queued_frames_admit_through_actual_cgroup_gate():
    parent,policy,gate,base,cgroup=dependencies()
    view,probe,_=m.compose(parent,gate,base,cgroup,probe_fixture.BASE_HASH)
    worker=parent.WorkerProtocol(view,probe,probe_fixture.fixture.marker())
    actual_gate=gate.Gate('pid:[10]','mnt:[11]','trusted-cgroup-worker-boundary')
    initial=gate.strict_json(bytes(worker.pending));actual_gate.admit(initial)
    actual_gate.written(len(actual_gate.pending));parent_fixture.drain(worker)
    reply={'id':1,'result':{'sessionId':'fixed-session'}}
    actual_gate.receive(reply);worker.receive(reply)
    queued=[gate.strict_json(line) for line in bytes(worker.pending).splitlines()]
    assert [frame['method'] for frame in queued]==['initialized','process/start']
    forwarded=[]
    for frame in queued:
        actual_gate.admit(frame)
        forwarded.append(gate.strict_json(bytes(actual_gate.pending)))
        actual_gate.written(len(actual_gate.pending))
    assert queued[-1]==gate.cgroup_start_request()
    assert forwarded[-1]['params']['argv']==gate.CGROUP_TRAMPOLINE_ARGV
    assert forwarded[-1]['params']['sandbox']==gate.control_start_request()['params']['sandbox']
    assert forwarded[-1]['params']['env']==actual_gate.worker_env


def test_successful_write_open_is_preserved_as_failure_not_normalized():
    r=complete_report(opened=True)
    assert r['cgroupReport']['paths'][probe_fixture.m.PATHS[0]]['opened'] is True
    assert not m.validate_report(r,dependencies(),ready())


@pytest.mark.parametrize('case',['body-tamper','raw-tamper','marker','source','cleanup','before-dead','fd-leak','missing-open','bool-errno','unknown-close','namespace','elapsed','old-profile','false-tool-credit'])
def test_material_full_replay_negatives(case):
    r=copy.deepcopy(complete_report());pr=r['parentReport']
    if case=='body-tamper':r['cgroupReport']['paths'][probe_fixture.m.PATHS[0]]['outcome']='absent'
    elif case=='raw-tamper':pr['sessions']['executor']['stdoutBase64']=''
    elif case=='marker':pr['marker']['value']['protectedDescriptors']['appServerControl']['ino']+=1
    elif case=='source':r['helperSha256After']['subscription-trusted-cgroup-worker-probe.py']='0'*64
    elif case=='cleanup':pr['sessions']['executor']['reaped']=False
    elif case=='before-dead':pr['beforeWorker']['alive']=False
    elif case=='fd-leak':r['cgroupReport']['descriptorsAfter'].append({'fd':9,'dev':1,'ino':10,'type':0o100000})
    elif case=='missing-open':r['cgroupReport']['paths'].pop(probe_fixture.m.PATHS[0])
    elif case=='bool-errno':r['cgroupReport']['paths'][probe_fixture.m.PATHS[0]]['errno']=True
    elif case=='unknown-close':r['cgroupReport']['paths'][probe_fixture.m.PATHS[0]]['cleanup']='UNKNOWN'
    elif case=='namespace':r['cgroupReport']['namespacesAfter']['pidNamespace']='pid:[10]'
    elif case=='elapsed':r['elapsedMs']=30000
    elif case=='old-profile':pr['sessions']['executor']['argv'][-1]='--trusted-control-boundary'
    elif case=='false-tool-credit':pr['appServerToolInvocation']=True
    assert not m.validate_report(r,dependencies(),ready())


def test_gate_missing_or_arbitrary_profile_fails_before_run():
    parent,policy,gate,base,cgroup=dependencies()
    del gate.cgroup_start_request
    with pytest.raises(ValueError,match='CGROUP_GATE_NOT_INTEGRATED'):m.compose(parent,gate,base,cgroup,'a'*64)
    gate.cgroup_start_request=lambda:{'method':'process/start','params':{'argv':['/bin/sh']}}
    with pytest.raises(ValueError,match='FIXED_CGROUP_ENTRY_REQUIRED'):m.compose(parent,gate,base,cgroup,'a'*64)


@pytest.mark.parametrize('delay',['hash','replay'])
def test_final_hash_replay_in_original_total_budget(monkeypatch,delay):
    r=complete_report();now=[2.0]
    monkeypatch.setattr(m.time,'monotonic',lambda:now[0])
    def hashes():
        if delay=='hash':now[0]=30
        return r['helperSha256Before']
    monkeypatch.setattr(m,'hashes',hashes)
    original=m.validate_report
    def replay(*args):
        value=original(*args)
        if delay=='replay':now[0]=30
        return value
    monkeypatch.setattr(m,'validate_report',replay)
    m.seal_report(r,dependencies(),SimpleNamespace(began=0),ready())
    assert not r['success'] and r['error']=='CGROUP_CHILD_TOTAL_DEADLINE'
