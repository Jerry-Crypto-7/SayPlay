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


m=load('subscription-cli-proxy-refusal.measure.py')
f=load('subscription-cli-proxy-refusal-child.test.py')
b=load('__tests__/subscription-cli-supervisor-measure.test.py')


def report_fixture():
    report=b.environment_sample();driver=m.load_driver();before=driver.source_hashes();base=m.load(m.BASE,before)
    body=f.complete_report();helpers=base.expected_hashes(before,m.HELPERS)
    body.update(helperSha256Before=dict(helpers),helperSha256After=dict(helpers))
    raw=json.dumps(body).encode();ready=report['frames'][0]
    ready.update(binarySha256=base.CLI_SHA256,bwrapSha256=base.BWRAP_SHA256,limits=copy.deepcopy(base.LIMITS),sandbox={**copy.deepcopy(base.SANDBOX),'uid':1000,'gid':1000},
        cliProxyRefusalBoundary={'helperSha256':helpers},trustedHttpLoopback={'interface':'lo','namespace':body['cliIdentity']['networkNamespace'],'ownerUserNamespace':'user:[555]','beforeFlags':8,'afterFlags':73})
    report['frames'][1]['mode']=m.SCENARIO;report['frames'][2]['data']=base64.b64encode(raw).decode()
    report['terminal'].update(mode=m.SCENARIO,outputBytes=len(raw),observedOutputSha256=hashlib.sha256(raw).hexdigest())
    report.update(scenario=m.SCENARIO,command=list(m.COMMAND),sourceSha256Before=before,sourceSha256After=dict(before))
    return report


def test_full_refusal_child_parent_provenance_and_capsule_replay():
    report=report_fixture()
    assert len(report['sourceSha256Before'])==26
    assert m.child_evaluation(report) and m.evaluate(report)
    start=m.start_request(report['frames'][0],report['sourceSha256Before'])
    assert set(start)=={'type','mode','helperSha256'} and len(start['helperSha256'])==10 and 'nonce' not in start


def test_inventory_covers_every_refusal_profile_copied_repository_source():
    sh=Path('scripts/subscription-cli-supervisor.sh').read_text()
    combined=re.search(r"if \[ \"\$\{1-\}\" = '--trusted-cli-worker-boundary' \]; then\n(.*?)\nfi",sh,re.S)
    assert combined is not None
    # Remove only the other selector's block. Shared refusal/provenance copies
    # still occur in this profile's own block and must remain covered.
    sh=sh[:combined.start()]+sh[combined.end():]
    copied=set(re.findall(r'cp /mnt/d/claude/Hackaton/(scripts/[^ ]+) ',sh))
    http={'scripts/subscription-trusted-http-'+name+'.py' for name in ('ingress','capsule-factory','worker-probe','ingress-child')}
    cgroup_block=re.search(r"if \[ \"\$\{1-\}\" = '--trusted-cgroup-worker-boundary' \]; then\n(.*?)\nfi",sh,re.S)
    assert cgroup_block is not None
    cgroup=set(re.findall(r'cp /mnt/d/claude/Hackaton/(scripts/[^ ]+) ',cgroup_block.group(1)))
    assert cgroup=={'scripts/subscription-trusted-cgroup-worker-probe.py','scripts/subscription-trusted-cgroup-worker-child.py'}
    stress_block=re.search(r'--candidate-resource-stress-tasks\|--candidate-resource-stress-memory\)\n(.*?)\n    ;;',sh,re.S)
    assert stress_block is not None
    stress=set(re.findall(r'cp /mnt/d/claude/Hackaton/(scripts/[^ ]+) ',stress_block.group(1)))
    assert stress=={'scripts/subscription-candidate-resource-stress-'+name+'.py' for name in ('worker','protocol','child')}
    assert len(copied-http-cgroup-stress)==21
    assert copied-http-cgroup-stress <= set(m.load_driver().SOURCES)
    assert not (http|cgroup|stress) & set(m.load_driver().SOURCES)


@pytest.mark.parametrize('case',['oldmode','helper-missing','helper-extra','binary','bwrap','limit','network','uid-bool','loopback','loopbool','foreign-fd','foreign-http'])
def test_reject_before_start(case):
    report=report_fixture();ready=report['frames'][0];mode=m.SCENARIO
    if case=='oldmode':mode='trusted-ingress-boundary'
    if case=='helper-missing':ready['cliProxyRefusalBoundary']['helperSha256'].pop(m.HELPERS[0])
    if case=='helper-extra':ready['cliProxyRefusalBoundary']['extra']=True
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
    if case=='cleanup':body['cleanup']['observerPinClosed']=False
    if case=='tls':proxy['tlsStarted']=True
    if case=='upstream':proxy['upstreamConnections']=1
    if case=='network':report['frames'][0]['trustedHttpLoopback']['namespace']='net:[999]'
    if case=='parent':body['parentReport']['history'].pop()
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
