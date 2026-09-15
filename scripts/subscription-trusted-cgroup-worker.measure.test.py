"""Authored full replay only; no kernel, WSL or cgroup operations."""
import base64
import copy
import hashlib
import json
from pathlib import Path
from unittest.mock import patch
import importlib.util
import pytest


def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


m=load('subscription-trusted-cgroup-worker.measure')
f=load('subscription-trusted-cgroup-worker-child.test')
outer=load('subscription-trusted-control-boundary.measure.test')


def report_fixture(opened=False):
    r=outer.report_fixture();d=m.load_driver()
    h={p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in d.SOURCES}
    body=f.complete_report(opened);raw=json.dumps(body).encode()
    ready=r['frames'][0];pins=m.load(m.PINS)
    ready.update(binarySha256=pins.CLI_SHA256,bwrapSha256=pins.BWRAP_SHA256,limits=copy.deepcopy(pins.LIMITS),sandbox={**copy.deepcopy(pins.SANDBOX),'uid':1000,'gid':1000})
    ready['trustedCgroupWorkerBoundary']={'helperSha256':dict(body['helperSha256Before'])}
    r['frames'][1]['mode']=m.SCENARIO
    r['frames'][2]['data']=base64.b64encode(raw).decode()
    r['terminal'].update(mode=m.SCENARIO,outputBytes=len(raw),observedOutputSha256=hashlib.sha256(raw).hexdigest())
    r.update(scenario=m.SCENARIO,command=list(d.COMMAND),sourceSha256Before=h,sourceSha256After=dict(h))
    return r


def test_complete_actual_validator_replay_and_fixed_start():
    r=report_fixture();assert m.evaluate(r)
    s=m.start_request(r['frames'][0],r['sourceSha256Before'])
    assert set(s)=={'type','mode','helperSha256'} and s['mode']==m.SCENARIO and len(s['helperSha256'])==10
    assert len(r['sourceSha256Before'])==26
    assert r['command'][-1]=='--trusted-cgroup-worker-boundary'


def test_successful_write_open_cannot_receive_success_credit():
    assert not m.evaluate(report_fixture(opened=True))


@pytest.mark.parametrize('case',['cli','bwrap','limits','bool-limit','uid','sandbox','helpers','extra-helper','missing-worker','zero-inode','bool-inode','alias','namespace','ingress'])
def test_rejects_before_start(case):
    r=report_fixture();v=r['frames'][0]
    if case=='cli':v['binarySha256']='0'*64
    if case=='bwrap':v['bwrapSha256']='0'*64
    if case=='limits':v['limits']['maxOutputBytes']+=1
    if case=='bool-limit':v['limits']['aggregateResourcesEnforced']=0
    if case=='uid':v['sandbox']['uid']=True
    if case=='sandbox':v['sandbox']['hostHomeMounted']=True
    if case=='helpers':del v['trustedCgroupWorkerBoundary']['helperSha256'][m.NEW[0]]
    if case=='extra-helper':v['trustedCgroupWorkerBoundary']['helperSha256']['foreign']='0'*64
    if case=='missing-worker':del v['workerBoundary']
    if case=='zero-inode':v['workerBoundary']['control']['ino']=0
    if case=='bool-inode':v['workerBoundary']['control']['ino']=True
    if case=='alias':v['workerBoundary']['output']=dict(v['workerBoundary']['control'])
    if case=='namespace':v['workerBoundary']['namespace']='pid:[0]'
    if case=='ingress':v['trustedIngressFd']={}
    with pytest.raises(ValueError):m.start_request(v,r['sourceSha256Before'])
    assert not m.evaluate(r)


@pytest.mark.parametrize('case',['source','extra-source','command','duplicate-ready','early-output','foreign-frame','stderr','raw','cleanup','output-hash','bytes','partial','mode','outer-binding'])
def test_rejects_raw_source_order_and_cleanup_drift(case):
    r=report_fixture()
    if case=='source':r['sourceSha256After'][m.SELF]='0'*64
    if case=='extra-source':r['sourceSha256Before']['foreign']='0'*64
    if case=='command':r['command'].append('--foreign')
    if case=='duplicate-ready':r['frames'].insert(0,copy.deepcopy(r['frames'][0]))
    if case=='early-output':r['frames'][1],r['frames'][2]=r['frames'][2],r['frames'][1]
    if case=='foreign-frame':r['frames'].insert(2,{'type':'ingress_ownership'})
    if case=='stderr':r['frames'][2]['stream']='stderr'
    if case=='raw':r['frames'][2]['data']='?'
    if case=='cleanup':r['terminal']['cleanup']['allObservedPidfdsESRCH']=False
    if case=='output-hash':r['terminal']['observedOutputSha256']='0'*64
    if case=='bytes':r['terminal']['outputBytes']+=1
    if case=='partial':r['terminal']['streamEOF']['stdout']=False
    if case=='mode':r['terminal']['mode']='trusted-control-boundary'
    if case=='outer-binding':r['frames'][0]['workerBoundary']['namespace']='pid:[999]'
    assert not m.evaluate(r)


def test_no_arbitrary_entry_arguments():
    with patch.object(m.sys,'argv',['measure','--foreign']),patch.object(m,'load') as called:
        with pytest.raises(ValueError):m.main()
        called.assert_not_called()


def test_source_guard_precedes_execution():
    with pytest.raises(ValueError,match='SOURCE_DRIFT'):m.load(m.BASE,{m.BASE:'0'*64})
