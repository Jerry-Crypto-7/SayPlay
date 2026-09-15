"""Offline full HTTP/physical resource replay, without synthetic basic ownership."""
import base64
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import patch
import pytest


def load(file):
    spec=importlib.util.spec_from_file_location(file,Path(__file__).with_name(file))
    module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module); return module


m=load('subscription-trusted-http-ingress-systemd.measure.py')
old=load('subscription-trusted-ingress-systemd.measure.test.py')
http=load('subscription-trusted-http-ingress-capsule.measure.test.py')


def report_fixture():
    report=old.report_fixture(); child=http.complete_report()
    basic,resource,driver=m.stack(); before=driver.source_hashes()
    ready=report['frames'][3]; http_ready=child['frames'][1]
    for key in ('trustedHttpIngressBoundary','trustedHttpLoopback','workerBoundary','trustedIngressFd'):
        ready[key]=copy.deepcopy(http_ready[key])
    ready['trustedHttpIngressBoundary']['helperSha256']=basic.expected_hashes(before,(*basic.HELPERS,*http.m.HTTP_HELPERS))
    ready['trustedIngressBoundary']['helperSha256']=basic.expected_hashes(before,basic.HELPERS)
    owner=report['frames'][1]['ownership']; handoff=report['frames'][2]['handoff']
    physical=m.load(m.PHYSICAL,before)
    owner['sourceSha256']=basic.expected_hashes(before,physical.load(physical.RENDEZVOUS,before).SOURCES)
    ingress=http.child_fixture.ingress(); owner['nonce']=ingress['nonce']; handoff.update(nonce=ingress['nonce'],socket=copy.deepcopy(ingress['socket']))
    handoff['receiverAck'].update(nonce=ingress['nonce'],socket=copy.deepcopy(ingress['socket']))
    ready['systemdIngressBoundary']={'nonce':ingress['nonce'],'ownership':copy.deepcopy(owner),'handoff':copy.deepcopy(handoff)}
    report['frames'][-1]['result']['nonce']=ingress['nonce']
    body=json.loads(base64.b64decode(child['frames'][3]['data'])); hashes=ready['trustedHttpIngressBoundary']['helperSha256']
    for item in (body,body['parentReport']): item.update(helperSha256Before=dict(hashes),helperSha256After=dict(hashes))
    raw=json.dumps(body).encode(); report['frames'][5]['data']=base64.b64encode(raw).decode()
    report['frames'][4]['mode']=m.SCENARIO
    report['terminal'].update(mode=m.SCENARIO,outputBytes=len(raw),observedOutputSha256=hashlib.sha256(raw).hexdigest())
    report.update(scenario=m.SCENARIO,command=list(m.COMMAND),sourceSha256Before=before,sourceSha256After=dict(before))
    return report


def test_full_replay_all_thirty_seven_sources_and_actual_physical_shape():
    report=report_fixture()
    assert len(report['sourceSha256Before'])==37
    assert not any(f['type'] in ('ingress_ownership','ingress_terminal') for f in report['frames'])
    assert m.child_evaluation(report) and m.evaluate(report)
    start=m.start_request(report['frames'][:4],report['frames'][3],report['sourceSha256Before'])
    assert start['mode']==m.SCENARIO and len(start['helperSha256'])==14


@pytest.mark.parametrize('case',['oldmode','missing14','extra14','loopback','loopbool','namespace','owner-null','handoff-null','nohandoff','ack',
    'readback','pid-generation','fd','worker-alias','binary'])
def test_prestart_rejection(case):
    report=report_fixture(); frames=report['frames'][:4]; ready=frames[-1]; requested=m.SCENARIO
    if case=='oldmode': requested='trusted-ingress-boundary'
    if case=='missing14': ready.pop('trustedHttpIngressBoundary')
    if case=='extra14': ready['trustedHttpIngressBoundary']['helperSha256']['foreign']='a'*64
    if case=='loopback': ready['trustedHttpLoopback']['afterFlags']=8
    if case=='loopbool': ready['trustedHttpLoopback']['beforeFlags']=True
    if case=='namespace': ready['trustedHttpLoopback']['namespace']='net:[0]'
    if case=='owner-null': frames[1]['ownership']=None
    if case=='handoff-null': frames[2]['handoff']=None
    if case=='nohandoff': frames.pop(2)
    if case=='ack': frames[2]['handoff']['receiverAck']['fd']=197
    if case=='readback': ready['systemdFixtureBoundary']['readback']['pidsMax']='65'
    if case=='pid-generation': frames[2]['handoff']['control']['unitMainStartTimeTicks']='999999'
    if case=='fd': ready['trustedIngressFd']['socket']['ino']=999
    if case=='worker-alias': ready['workerBoundary']['control']=copy.deepcopy(ready['workerBoundary']['output'])
    if case=='binary': ready['binarySha256']='0'*64
    with pytest.raises(ValueError):m.start_request(frames,ready,report['sourceSha256Before'],requested)


@pytest.mark.parametrize('case',['child-missing','listener','inner-thread','netbinding','unit','leaf','namespace','prestart','peer','path','counter','order','source','command'])
def test_independent_domains_fail_closed(case):
    report=report_fixture(); terminal=report['terminal']; end=report['frames'][-1]['result']
    if case=='child-missing': report['frames'][5]['data']='e30='
    if case in ('listener','inner-thread'):
        body=json.loads(base64.b64decode(report['frames'][5]['data']))
        if case=='listener': body['httpRoute']['observations'][1]['listening']=False
        else: body['httpRoute']['threadJoined']=False
        raw=json.dumps(body).encode(); report['frames'][5]['data']=base64.b64encode(raw).decode()
        terminal.update(outputBytes=len(raw),observedOutputSha256=hashlib.sha256(raw).hexdigest())
    if case=='netbinding': report['frames'][3]['trustedHttpLoopback']['namespace']='net:[999999]'
    if case=='unit': terminal['systemdFixtureBoundary']['cleanup']['unitAbsent']=False
    if case=='leaf': terminal['systemdFixtureBoundary']['cleanup']['leafAbsent']=False
    if case=='namespace': terminal['cleanup']['namespaceEmpty']=False
    if case=='prestart': terminal['systemdFixtureBoundary']['preStartReadback']['memoryMax']='1'
    if case=='peer': end['peersClosed']=False
    if case=='path': end['pathCleanup']['socketRemoved']=False
    if case=='counter': end['broker']['observedBytes']['ingress']+=30
    if case=='order': report['frames'][1],report['frames'][2]=report['frames'][2],report['frames'][1]
    if case=='source': report['sourceSha256After'][m.HTTP]='a'*64
    if case=='command': report['command'][-1]='--trusted-ingress-boundary'
    assert not m.evaluate(report)


def test_no_arguments_before_composition():
    with patch.object(m.sys,'argv',['measure','--caller']),patch.object(m,'load') as loader:
        with pytest.raises(ValueError):m.main()
        loader.assert_not_called()
