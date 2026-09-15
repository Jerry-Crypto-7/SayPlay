"""Authored cgroup child plus resource replay; no kernel/systemd operations."""
import copy
import importlib.util
import io
import json
from pathlib import Path
from unittest.mock import patch
import pytest


def load(file):
    spec=importlib.util.spec_from_file_location(file,Path(__file__).with_name(file));m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m


m=load('subscription-trusted-cgroup-worker-systemd.measure.py')
b=load('subscription-trusted-cgroup-worker.measure.test.py')
r=load('subscription-exec-environment-systemd.measure.test.py')


def report_fixture(opened=False):
    report=b.report_fixture(opened);resource=r.report_fixture();_,_,driver=m.stack();before=driver.source_hashes()
    owner,ready_resource=copy.deepcopy(resource['frames'][:2]);ready=report['frames'][0]
    ready['systemdFixtureBoundary']=ready_resource['systemdFixtureBoundary'];ready['sandbox']['uid']=owner['ownership']['uid']
    report['terminal']['systemdFixtureBoundary']=copy.deepcopy(resource['terminal']['systemdFixtureBoundary'])
    report['frames'].insert(0,owner)
    report.update(sourceSha256Before=before,sourceSha256After=dict(before),command=list(m.COMMAND))
    return report


def test_complete_child_and_private_resource_replay():
    report=report_fixture();assert len(report['sourceSha256Before'])==30
    assert all('ingress' not in frame['type'] for frame in report['frames'])
    assert m.evaluate(report)
    start=m.start_request(report['frames'][:2],report['frames'][1],report['sourceSha256Before'])
    assert start['mode']=='trusted-cgroup-worker-boundary' and len(start['helperSha256'])==10
    assert set(start)=={'type','mode','helperSha256'}


def test_actual_successful_write_open_fixture_remains_fail():
    assert not m.evaluate(report_fixture(opened=True))


@pytest.mark.parametrize('case',['missing','duplicate','owner-null','pid','generation','manager','readback','worker','helper','fd198','oldmode','ready-null','ready-list'])
def test_prestart_admission_rejects_before_start(case):
    report=report_fixture();frames=report['frames'][:2];ready=frames[-1];scenario=m.SCENARIO
    if case=='missing':frames.pop(0)
    elif case=='duplicate':frames.insert(0,copy.deepcopy(frames[0]))
    elif case=='owner-null':frames[0]['ownership']=None
    elif case=='pid':ready['systemdFixtureBoundary']['control']['driverPid']+=1
    elif case=='generation':ready['systemdFixtureBoundary']['control']['unitMainStartTimeTicks']=True
    elif case=='manager':ready['systemdFixtureBoundary']['control']['managerSocket']['components'].pop()
    elif case=='readback':ready['systemdFixtureBoundary']['readback']['pidsMax']='65'
    elif case=='worker':ready['workerBoundary']['control']['ino']=0
    elif case=='helper':ready['trustedCgroupWorkerBoundary']['helperSha256'].pop(b.m.NEW[0])
    elif case=='fd198':ready['trustedIngressFd']={'fd':198}
    elif case=='oldmode':scenario='trusted-control-boundary'
    elif case=='ready-null':ready=None
    elif case=='ready-list':ready=[]
    with pytest.raises(ValueError):m.start_request(frames,ready,report['sourceSha256Before'],scenario)


@pytest.mark.parametrize('case',['unit','leaf','run','prestart','control-drift','namespace','bytes','child','output-late','ingress','source','command','stderr','outer-worker'])
def test_child_raw_and_independent_cleanup_required(case):
    report=report_fixture();terminal=report['terminal']
    if case in ('unit','leaf','run'):terminal['systemdFixtureBoundary']['cleanup'][{'unit':'unitAbsent','leaf':'leafAbsent','run':'systemdRunClosed'}[case]]=False
    elif case=='prestart':terminal['systemdFixtureBoundary']['preStartReadback']['memoryMax']='1'
    elif case=='control-drift':terminal['systemdFixtureBoundary']['control']['unitMainStartTimeTicks']='777'
    elif case=='namespace':terminal['cleanup']['namespaceEmpty']=False
    elif case=='bytes':terminal['outputBytes']+=1
    elif case=='child':report['frames'][3]['data']='e30='
    elif case=='output-late':report['frames'].append(copy.deepcopy(report['frames'][3]))
    elif case=='ingress':report['frames'].insert(1,{'type':'systemd_ingress_ownership'})
    elif case=='source':report['sourceSha256After'][m.SELF]='0'*64
    elif case=='command':report['command'][-1]='--trusted-ingress-boundary'
    elif case=='stderr':report['frames'][3]['stream']='stderr'
    elif case=='outer-worker':report['frames'][1]['workerBoundary']['namespace']='pid:[999]'
    assert not m.evaluate(report)


def test_source_bound_stack_rejects_wrong_dependency_hash():
    report=report_fixture();before=dict(report['sourceSha256Before']);before[m.BASIC]='0'*64
    with pytest.raises(ValueError,match='SOURCE_DRIFT'):m.stack(before)


def test_no_arguments_or_foreign_command_before_runtime():
    with patch.object(m.sys,'argv',['measure','--foreign']),patch.object(m,'stack') as loaded:
        with pytest.raises(ValueError):m.main()
        loaded.assert_not_called()
    _,resource,_=m.stack()
    with pytest.raises(ValueError):resource.fixed_command('fixture')


def test_real_main_resource_wire_admission_and_replay_without_runtime(monkeypatch):
    report=report_fixture();events=[];written={}
    class MemoryPath:
        def __init__(self,value):self.value=str(value)
        def __truediv__(self,value):return MemoryPath(self.value+'/'+str(value))
        def __str__(self):return self.value
        def mkdir(self,**kwargs):events.append('mkdir')
        def write_text(self,value,**kwargs):written[self.value]=value
        def open(self,mode):
            assert mode=='xb';events.append('wire-open');return io.BytesIO()
        def exists(self):return False
    original_stack=m.stack
    def stack(before=None):
        basic,resource,driver=original_stack(before)
        if before is not None:return basic,resource,driver
        resource.Path=MemoryPath
        def measure(scenario):
            events.append('mocked-outer-measure')
            assert scenario==m.SCENARIO
            hashes=driver.source_hashes()
            assert hashes==report['sourceSha256Before']
            # Real loaded ObservedWire observes actual candidate JSONL bytes.
            for frame in report['frames'][:2]:
                assert driver.json.loads((json.dumps(frame)+'\n').encode())==frame
            assert driver.json.frames==report['frames'][:2]
            request=driver.environment_start(report['frames'][1],hashes,scenario)
            assert request==b.m.start_request(report['frames'][1],hashes)
            wrong=dict(hashes);wrong[basic.PINS]='0'*64
            with pytest.raises(ValueError,match='SYSTEMD_CGROUP_WIRE_SOURCE_DRIFT'):
                driver.environment_start(report['frames'][1],wrong,scenario)
            assert driver.evaluate(scenario,report) is True
            return True
        driver.measure=measure
        return basic,resource,driver
    monkeypatch.setattr(m,'stack',stack)
    monkeypatch.setattr(m.sys,'argv',['measure'])
    with patch('subprocess.Popen',side_effect=AssertionError('runtime forbidden')):
        assert m.main()==0
    assert events==['mkdir','wire-open','mocked-outer-measure']
    final=json.loads(next(value for path,value in written.items() if path.endswith('/receipt.json')))
    assert final['state']=='FINISHED' and final['scenarioPassed'] is True and final['candidateFrameBytes']>0
