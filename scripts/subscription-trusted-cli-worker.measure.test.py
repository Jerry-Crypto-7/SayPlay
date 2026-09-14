"""Offline strict stock CONNECT refusal child and capsule replay."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import re
from unittest.mock import patch
import pytest


def load(file):
    path=Path(__file__).parent/file
    spec=importlib.util.spec_from_file_location(file,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module


m=load('subscription-trusted-cli-worker.measure.py')
f=load('subscription-trusted-cli-worker-child.test.py')
b=load('__tests__/subscription-cli-supervisor-measure.test.py')


def report_fixture():
    report=b.environment_sample();driver=m.load_driver();before=driver.source_hashes();base=m.load(m.BASE,before)
    body,source_raw,worker=f.complete_report();helpers=base.expected_hashes(before,m.HELPERS)
    body.update(helperSha256Before=dict(helpers),helperSha256After=dict(helpers))
    raw=json.dumps(body).encode();ready=report['frames'][0]
    ready.update(workerBoundary=worker,binarySha256=base.CLI_SHA256,bwrapSha256=base.BWRAP_SHA256,limits=copy.deepcopy(base.LIMITS),sandbox={**copy.deepcopy(base.SANDBOX),'uid':1000,'gid':1000},
        trustedCliWorkerBoundary={'helperSha256':helpers},trustedHttpLoopback={'interface':'lo','namespace':body['cliIdentity']['networkNamespace'],'ownerUserNamespace':'user:[555]','beforeFlags':8,'afterFlags':73})
    report['frames'][1]['mode']=m.SCENARIO;report['frames'][2]['data']=base64.b64encode(raw).decode()
    report['terminal'].update(mode=m.SCENARIO,outputBytes=len(raw),observedOutputSha256=hashlib.sha256(raw).hexdigest())
    report.update(scenario=m.SCENARIO,command=list(m.COMMAND),sourceSha256Before=before,sourceSha256After=dict(before))
    return report


def test_full_refusal_child_parent_provenance_and_capsule_replay():
    report=report_fixture()
    assert len(report['sourceSha256Before'])==27
    assert m.child_evaluation(report) and m.evaluate(report)
    start=m.start_request(report['frames'][0],report['sourceSha256Before'])
    assert set(start)=={'type','mode','helperSha256'} and len(start['helperSha256'])==12 and 'nonce' not in start


def test_inventory_is_fixed_and_contains_all_twelve_helpers():
    sources=m.load_driver().SOURCES
    assert len(sources)==27 and len(set(sources))==27
    assert {'scripts/'+n for n in m.HELPERS} <= set(sources)
    assert not any('rendezvous' in n or 'systemd' in n for n in sources)


@pytest.mark.parametrize('case',['oldmode','helper-missing','helper-extra','binary','bwrap','limit','network','uid-bool','loopback','loopbool','foreign-fd','foreign-http'])
def test_reject_before_start(case):
    report=report_fixture();ready=report['frames'][0];mode=m.SCENARIO
    if case=='oldmode':mode='trusted-ingress-boundary'
    if case=='helper-missing':ready['trustedCliWorkerBoundary']['helperSha256'].pop(m.HELPERS[0])
    if case=='helper-extra':ready['trustedCliWorkerBoundary']['extra']=True
    if case=='binary':ready['binarySha256']='0'*64
    if case=='bwrap':ready['bwrapSha256']='0'*64
    if case=='limit':ready['limits']['maxOutputBytes']+=1
    if case=='network':ready['sandbox']['networkInterfaces']=['lo','eth0']
    if case=='uid-bool':ready['sandbox']['uid']=True
    if case=='loopback':ready['trustedHttpLoopback']['afterFlags']=8
    if case=='loopbool':ready['trustedHttpLoopback']['beforeFlags']=True
    if case=='foreign-fd':ready['trustedIngressFd']={'fd':198}
    if case=='foreign-http':ready['trustedHttpIngressBoundary']={}
    with pytest.raises(ValueError):m.start_request(ready,report['sourceSha256Before'],mode)


@pytest.mark.parametrize('case',['pid','generation','callback','header','phase','cleanup','tls','upstream','network','parent'])
def test_full_child_boundaries_are_required(case):
    report=report_fixture();body=json.loads(base64.b64decode(report['frames'][2]['data']));proxy=body['proxyReport']
    if case=='pid':body['cliIdentity']['pid']+=1
    if case=='generation':body['cliIdentity']['startTicks']='901'
    if case=='callback':proxy['provenanceObservations'][0]['record']=True
    if case=='header':proxy['requestRawBase64']='e30='
    if case=='phase':proxy['provenanceObservations'].reverse()
    if case=='cleanup':body['cleanup']['ownedHandlesKnown']=False
    if case=='tls':proxy['tlsStarted']=True
    if case=='upstream':proxy['upstreamConnections']=1
    if case=='network':report['frames'][0]['trustedHttpLoopback']['namespace']='net:[999]'
    if case=='parent':body['parentReport']['sessions']['appserver']['history'].pop()
    raw=json.dumps(body).encode();report['frames'][2]['data']=base64.b64encode(raw).decode()
    report['terminal'].update(outputBytes=len(raw),observedOutputSha256=hashlib.sha256(raw).hexdigest())
    assert not m.child_evaluation(report) and not m.evaluate(report)


@pytest.mark.parametrize('case',['late','owner','duplicate-ready','capsule','count','source','command'])
def test_outer_evidence_never_implied_by_inner_refusal(case):
    report=report_fixture()
    if case=='late':report['frames'].append(copy.deepcopy(report['frames'][2]))
    if case=='owner':report['frames'].insert(0,{'type':'ingress_ownership'})
    if case=='duplicate-ready':report['frames'].insert(0,copy.deepcopy(report['frames'][0]))
    if case=='capsule':report['terminal']['cleanup']['namespaceEmpty']=False
    if case=='count':report['terminal']['outputBytes']+=1
    if case=='source':report['sourceSha256After'][m.SELF]='0'*64
    if case=='command':report['command'][-1]='--trusted-ingress-fd'
    assert not m.evaluate(report)


def test_no_arguments_before_import():
    with patch.object(m.sys,'argv',['measure','--caller']),patch.object(m,'load') as loader:
        with pytest.raises(ValueError):m.main()
        loader.assert_not_called()


@pytest.mark.parametrize('case',['zero-ns','leading-ns','zero-inode','alias','bool-inode','missing-worker'])
def test_worker_identity_rejected_before_start(case):
    report=report_fixture();ready=report['frames'][0];worker=ready['workerBoundary']
    if case=='zero-ns':worker['namespace']='pid:[0]'
    if case=='leading-ns':worker['namespace']='pid:[01]'
    if case=='zero-inode':worker['control']['ino']=0
    if case=='alias':worker['output']=copy.deepcopy(worker['control'])
    if case=='bool-inode':worker['control']['ino']=True
    if case=='missing-worker':ready.pop('workerBoundary')
    with pytest.raises(ValueError):m.start_request(ready,report['sourceSha256Before'])


def test_real_ingress_main_composition_records_wire_start_evaluation_and_receipt(monkeypatch):
    import types,uuid
    report=report_fixture();original=m.load;observations=[]
    identifier=str(uuid.uuid4())
    mockroot=Path('scratch')/('MOCK-trusted-cli-main-'+identifier)
    mockroot.mkdir(exist_ok=False)
    (mockroot/'inventory.json').write_text(json.dumps({'execution':'MOCK','runtimeLaunched':False,
        'scope':'Real ingress.main; only driver.measure replaced with authored frames'}))
    def loader(path,before=None):
        value=original(path,before)
        if path==m.BASE and before is None:
            # Keep the real main function, but isolate every artifact pathname.
            value.Path=lambda path:mockroot if path=='scratch' else Path(path)
            value.uuid=types.SimpleNamespace(uuid4=lambda:identifier)
        if path==m.DRIVER:
            def measure(scenario):
                driver=value;hashes=driver.source_hashes()
                assert len(hashes)==27 and driver.COMMAND==m.COMMAND
                ready=driver.json.loads(json.dumps(report['frames'][0]).encode()+b'\n')
                start=driver.environment_start(ready,hashes,scenario)
                assert start==m.start_request(ready,hashes)
                for frame in report['frames'][1:]:driver.json.loads(json.dumps(frame).encode()+b'\n')
                assert driver.evaluate(scenario,report)
                observations.append(start)
                artifact=mockroot/('session8-cli-'+m.SCENARIO+'-measure-'+identifier+'.json')
                artifact.write_text(json.dumps({**report,'execution':'MOCK'}))
                return True
            value.measure=measure
        return value
    monkeypatch.setattr(m,'load',loader);monkeypatch.setattr(m,'_UNKNOWN',False)
    with patch.object(m.sys,'argv',['measure']):assert m.main()==0
    assert len(observations)==1 and m._UNKNOWN is False
    directory=mockroot/('session8-trusted-ingress-'+identifier)
    receipt=json.loads((directory/'receipt.json').read_bytes())
    wire=(directory/'candidate-frames.jsonl').read_bytes()
    assert receipt['state']=='FINISHED' and receipt['scenarioPassed'] is True
    assert receipt['candidateFrameBytes']==len(wire)
    assert receipt['candidateFrameSha256']==hashlib.sha256(wire).hexdigest()
    assert [json.loads(line) for line in wire.splitlines()]==report['frames']
    expected=base64.b64decode(report['frames'][2]['data'])
    assert (directory/'child-stdout.bin').read_bytes()==expected
    assert receipt['childStdoutComplete'] is True


def test_failed_main_keeps_sticky_dispatch_fence(monkeypatch):
    original=m.load
    def loader(path,before=None):
        value=original(path,before)
        if path==m.BASE and before is None:value.main=lambda:1
        return value
    monkeypatch.setattr(m,'load',loader);monkeypatch.setattr(m,'_UNKNOWN',False)
    with patch.object(m.sys,'argv',['measure']):
        assert m.main()==1 and m._UNKNOWN
        with pytest.raises(ValueError,match='PRIOR'):m.main()


def test_source_drift_refuses_before_start():
    report=report_fixture();before=report['sourceSha256Before'];before[m.BASE]='0'*64
    with pytest.raises(ValueError,match='SOURCE_DRIFT'):m.start_request(report['frames'][0],before)


@pytest.mark.parametrize('case',['partial','stderr','error','timeout','eof','exit-bool'])
def test_raw_failure_and_cleanup_cannot_gain_success(case):
    report=report_fixture()
    if case=='partial':report['frames'][2]['data']=base64.b64encode(b'{').decode()
    if case=='stderr':report['frames'][2]['stream']='stderr'
    if case=='error':report['errors']=['READER_FAILURE']
    if case=='timeout':report['driverTimeout']=True
    if case=='eof':report['terminal']['streamEOF']['stdout']=False
    if case=='exit-bool':report['exitCode']=False
    assert not m.evaluate(report)
