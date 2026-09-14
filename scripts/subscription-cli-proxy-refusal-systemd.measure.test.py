"""Offline exact resource plus stock-refusal child replay; no runtime."""
import copy
import importlib.util
from pathlib import Path
from unittest.mock import patch
import pytest


def load(file):
    spec=importlib.util.spec_from_file_location(file,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


m=load('subscription-cli-proxy-refusal-systemd.measure.py')
b=load('subscription-cli-proxy-refusal.measure.test.py')
r=load('subscription-exec-environment-systemd.measure.test.py')


def report_fixture():
    report=b.report_fixture();resource=r.report_fixture();basic,_,driver=m.stack();before=driver.source_hashes()
    owner,ready_resource=copy.deepcopy(resource['frames'][:2]);ready=report['frames'][0]
    ready['systemdFixtureBoundary']=ready_resource['systemdFixtureBoundary'];ready['sandbox']['uid']=owner['ownership']['uid']
    report['terminal']['systemdFixtureBoundary']=copy.deepcopy(resource['terminal']['systemdFixtureBoundary'])
    report['frames'].insert(0,owner)
    report.update(sourceSha256Before=before,sourceSha256After=dict(before),command=list(m.COMMAND))
    return report


def test_complete_stock_cli_refusal_and_resource_replay():
    report=report_fixture();assert len(report['sourceSha256Before'])==30
    assert all('ingress' not in f['type'] for f in report['frames'])
    assert m.evaluate(report)
    request=m.start_request(report['frames'][:2],report['frames'][1],report['sourceSha256Before'])
    assert request['mode']=='cli-proxy-refusal' and len(request['helperSha256'])==10 and set(request)=={'type','mode','helperSha256'}


@pytest.mark.parametrize('case',['missing','duplicate','owner-null','pid','generation','manager','readback','loopback','helper','fd198','oldmode'])
def test_prestart_binding(case):
    report=report_fixture();frames=report['frames'][:2];ready=frames[-1];scenario=m.SCENARIO
    if case=='missing':frames.pop(0)
    if case=='duplicate':frames.insert(0,copy.deepcopy(frames[0]))
    if case=='owner-null':frames[0]['ownership']=None
    if case=='pid':ready['systemdFixtureBoundary']['control']['driverPid']+=1
    if case=='generation':ready['systemdFixtureBoundary']['control']['unitMainStartTimeTicks']=True
    if case=='manager':ready['systemdFixtureBoundary']['control']['managerSocket']['components'].pop()
    if case=='readback':ready['systemdFixtureBoundary']['readback']['pidsMax']='65'
    if case=='loopback':ready['trustedHttpLoopback']['afterFlags']=8
    if case=='helper':ready['cliProxyRefusalBoundary']['helperSha256'].pop(b.m.HELPERS[0])
    if case=='fd198':ready['trustedIngressFd']={'fd':198}
    if case=='oldmode':scenario='trusted-ingress-boundary'
    with pytest.raises(ValueError):m.start_request(frames,ready,report['sourceSha256Before'],scenario)


@pytest.mark.parametrize('case',['unit','leaf','run','prestart','control-drift','namespace','bytes','child','output-late','ingress','source','command'])
def test_separate_cleanup_and_child_proof(case):
    report=report_fixture();terminal=report['terminal']
    if case in ('unit','leaf','run'):terminal['systemdFixtureBoundary']['cleanup'][{'unit':'unitAbsent','leaf':'leafAbsent','run':'systemdRunClosed'}[case]]=False
    if case=='prestart':terminal['systemdFixtureBoundary']['preStartReadback']['memoryMax']='1'
    if case=='control-drift':terminal['systemdFixtureBoundary']['control']['unitMainStartTimeTicks']='777'
    if case=='namespace':terminal['cleanup']['namespaceEmpty']=False
    if case=='bytes':terminal['outputBytes']+=1
    if case=='child':report['frames'][3]['data']='e30='
    if case=='output-late':report['frames'].append(copy.deepcopy(report['frames'][3]))
    if case=='ingress':report['frames'].insert(1,{'type':'systemd_ingress_ownership'})
    if case=='source':report['sourceSha256After'][m.SELF]='0'*64
    if case=='command':report['command'][-1]='--trusted-http-ingress-boundary'
    assert not m.evaluate(report)


def test_no_argument_before_import():
    with patch.object(m.sys,'argv',['measure','--caller']),patch.object(m,'stack') as loaded:
        with pytest.raises(ValueError):m.main()
        loaded.assert_not_called()
