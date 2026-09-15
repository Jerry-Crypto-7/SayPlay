"""Fixed driver sequencing; OS processes and resource workloads are not run."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from unittest.mock import Mock
import subprocess
import pytest
import hashlib
import io
import queue
import threading

spec=importlib.util.spec_from_file_location('stress_measure_tests',Path(__file__).with_name('subscription-candidate-resource-stress.measure.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


def fixture(phase):
    modules={m.BASE:SimpleNamespace(validate_uts_ready=lambda _:True),
        m.RESOURCE:SimpleNamespace(validate_ownership=lambda *_:True,validate_ready=lambda *_:True),
        m.CHILD:SimpleNamespace(HELPERS={'subscription-fixed.py':'/usr/bin/fixed.py'})}
    hashes={'scripts/'+n:'a'*64 for n in (*m.OBSERVER_FILES,'subscription-fixed.py')}
    with patch.object(m,'load',side_effect=lambda p,r:modules[p]):wire=m.Wire(phase,dict.fromkeys(modules,b'fixture'),hashes)
    unit='codex-cli-resource-'+'a'*32+'.service'
    owner={'version':1,'type':'systemd_ownership','ownership':{'unit':unit}}
    ready={'version':1,'type':'ready','candidateResourceStressBoundary':{'phase':phase,'helperSha256':{'subscription-fixed.py':'a'*64}},
        'limits':{'jobMs':180000,'commandMs':200000,'termGraceMs':5000,'maxOutputBytes':8388608,'commandBudgetEnforcedHere':False,'aggregateResourcesEnforced':False}}
    def observed(stage,evidence=None):return {'version':1,'type':'candidate_stress_observation','phase':phase,'unit':unit,'stage':stage,'evidence':evidence or {},'exhaustionValidated':False}
    return wire,owner,ready,observed


def common_fixture():
    helper=m.load('scripts/subscription-cgroup-evidence-validation.test.py',
        Path('scripts/subscription-cgroup-evidence-validation.test.py').read_bytes())
    documents,unit,_,_=helper.complete_documents()
    raw,hashes=m.capture_sources(True)
    wire,owner,ready,observed=fixture('tasks')
    actual=m.Wire('tasks',raw,hashes,True)
    # Only outer OS ownership/capsule readiness are fixtures; all metadata
    # documents use the actual pure source-bound validators.
    actual.resource=wire.resource;actual.base=wire.base;actual.child=wire.child
    actual.hashes['scripts/subscription-fixed.py']='a'*64
    assert owner['ownership']['unit']==unit
    return actual,owner,ready,observed,documents


def common_service(wire,owner,documents):
    wire.receive(owner)
    frames=list(wire.codec.encode_document(owner['ownership']['unit'],'service',documents['service']))
    for frame in frames:assert wire.receive(m.strict(frame))==[]
    raw=documents['service']
    names=(wire.service.FILES[0],wire.service.FILES[1],
        'subscription-cgroup-evidence-stream.py','subscription-candidate-resource-events.py')
    receipt=dict(version=1,type='common_view_preflight',targetUnit=owner['ownership']['unit'],
        sourceSha256={n:wire.hashes['scripts/'+n] for n in wire.service.FILES},
        dependencySha256={n:wire.hashes['scripts/'+n] for n in names},
        documentSha256=hashlib.sha256(raw).hexdigest(),documentBytes=len(raw),
        framesEnqueued=len(frames),framesPolled=len(frames),wireBytesPolled=sum(map(len,frames)),
        maxQueueBytes=max(map(len,frames)),workerFinished=True,queueDocumentDrained=True,
        localHandlesKnown=True,closeKnown=True,cancelled=False,error=None,
        releaseAdmitted=False,productionReady=False)
    ready=dict(version=1,type='common_view_ready',unit=owner['ownership']['unit'],
        sha256=receipt['documentSha256'],bytes=len(raw))
    return receipt,ready


def test_common_real_service_and_target_validators_admit_only_complete_documents():
    wire,owner,ready,observed,docs=common_fixture()
    receipt,common_ready=common_service(wire,owner,docs)
    assert wire.receive(receipt)==[]
    assert wire.receive(common_ready)==[dict(type='common_view_admission',unit=owner['ownership']['unit'],sha256=receipt['documentSha256'])]
    wire.receive(observed('before-unit-capacity'));wire.receive(ready)
    wire.receive(dict(version=1,type='started',mode='candidate-resource-stress-tasks'))
    for label in ('capacity-before-open','capacity-after-open','target-ancestry'):
        for frame in wire.codec.encode_document(owner['ownership']['unit'],label,docs[label]):
            assert wire.receive(m.strict(frame))==[]
    assert wire.receive(observed('baseline'))==[dict(type='stress_action',action='start')]


@pytest.mark.parametrize('field,value',[
    ('closeKnown',False),('workerFinished',False),('cancelled',True),('error','FAIL'),
    ('framesPolled',1),('documentBytes',True),('documentSha256','0'*64),('maxQueueBytes',262145)],
    ids=['close','worker','cancel','error','frames','typed-bytes','digest','queue'])
def test_common_preflight_rejection_never_admits(field,value):
    wire,owner,_,_,docs=common_fixture();receipt,ready=common_service(wire,owner,docs)
    receipt[field]=value
    with pytest.raises(ValueError):wire.receive(receipt)
    assert wire.common_ready is None and wire.actions==[]


def test_common_service_ready_cannot_precede_validated_receipt():
    wire,owner,_,_,docs=common_fixture();_,ready=common_service(wire,owner,docs)
    with pytest.raises(ValueError,match='COMMON_ADMISSION'):wire.receive(ready)


@pytest.mark.parametrize('value',[False,0])
def test_common_service_contradictory_success_flag_blocks_early_admission(value):
    wire,owner,_,_,docs=common_fixture()
    body=m.strict(docs['service']);body['commonViewValidated']=value;docs['service']=m.encode(body)
    receipt,_=common_service(wire,owner,docs)
    with pytest.raises(ValueError,match='PREFLIGHT_SERVICE'):wire.receive(receipt)
    assert wire.preflight is None and wire.common_ready is None


def test_common_capture_is_exact_legacy_plus_seven_and_selector_explicit():
    legacy,_=m.capture_sources();common,_=m.capture_sources(True)
    assert len(legacy)==32 and len(common)==39
    assert set(common)-set(legacy)=={'scripts/'+n for n in m.COMMON_FILES}
    assert m.command('tasks')[-1]=='--candidate-resource-stress-tasks'
    assert m.command('tasks',True)[-1]=='--candidate-common-view-stress-tasks'


def test_actual_reader_rejects_noncanonical_evidence_before_dispatch_but_preserves_bytes():
    frame=b'{"version":1, "type":"cgroup_evidence"}\n'
    captured=bytearray();done=threading.Event();incoming=queue.Queue();errors=[];evidence={}
    m.drain_reader(io.BytesIO(frame),captured,65536,done,incoming,errors,evidence,True)
    assert bytes(captured)==frame and incoming.empty() and evidence['eofObserved'] is True
    assert evidence['parseFailed'] is True and errors==['DRIVER_READ_FAILED']


@pytest.mark.parametrize('phase',['tasks','memory'])
@pytest.mark.parametrize('baseline_first',[True,False])
def test_actual_started_and_observer_baseline_both_required_before_work(phase,baseline_first):
    wire,owner,ready,observed=fixture(phase)
    wire.receive(owner);wire.receive(observed('before-unit-capacity'))
    assert wire.receive(ready)[0]['type']=='start'
    started={'version':1,'type':'started','mode':'candidate-resource-stress-'+phase,'pid':123}
    pair=[observed('baseline'),started] if baseline_first else [started,observed('baseline')]
    assert wire.receive(pair[0])==[]
    assert wire.receive(pair[1])==[{'type':'stress_action','action':'start'}]
    wire.receive(observed('before-work-capacity'))
    assert wire.receive(observed('workers-held'))==([{'type':'stress_action','action':'ramp'}] if phase=='memory' else [])
    assert wire.receive(observed('release-observation',{'releaseAdmitted':False}))==[]
    assert wire.receive(observed('release-observation',{'releaseAdmitted':True}))==[{'type':'stress_action','action':'release'}]
    assert wire.receive(observed('release-observation',{'releaseAdmitted':True}))==[]


def test_foreign_preownership_unit_cannot_be_adopted():
    wire,owner,ready,observed=fixture('tasks')
    wire.receive(observed('before-unit-capacity'))
    owner['ownership']['unit']='codex-cli-resource-'+'b'*32+'.service'
    with pytest.raises(ValueError,match='OBSERVER_UNIT'):wire.receive(owner)


@pytest.mark.parametrize('stage',['workers-held','release-observation','before-work-capacity','baseline'])
def test_early_evidence_does_not_release_work(stage):
    wire,owner,ready,observed=fixture('tasks')
    with pytest.raises(ValueError):wire.receive(observed(stage,{'releaseAdmitted':True}))
    assert not wire.actions


@pytest.mark.parametrize('change',[{'helperSha256':{}},{'phase':'memory'}])
def test_ready_cannot_override_phase_or_source_identity(change):
    wire,owner,ready,observed=fixture('tasks')
    wire.receive(owner);wire.receive(observed('before-unit-capacity'))
    ready['candidateResourceStressBoundary'].update(change)
    with pytest.raises(ValueError,match='HELPER_IDENTITY'):wire.receive(ready)


def test_limits_not_broadened_and_failure_is_not_terminal_success():
    wire,owner,ready,observed=fixture('tasks')
    wire.receive(owner);wire.receive(observed('before-unit-capacity'))
    ready['limits']['jobMs']=180001
    with pytest.raises(ValueError,match='CAPSULE_LIMITS'):wire.receive(ready)
    with pytest.raises(ValueError):wire.receive({'version':1,'type':'systemd_failure'})


def test_prelude_has_only_exact_fixed_five_sources_and_no_unit():
    wire,*_=fixture('tasks')
    assert set(wire.prelude())=={'type','sourceSha256'}
    assert set(wire.prelude()['sourceSha256'])==set(m.OBSERVER_FILES)
    assert len(m.OBSERVER_FILES)==5


def test_main_refuses_phase_override_and_unvalidated_empty_evidence():
    with patch.object(m.sys,'argv',['fixed','--memory']),patch.object(m,'measure') as launch:
        with pytest.raises(ValueError,match='NO_ARGUMENTS'):m.main()
        launch.assert_not_called()
    assert m.evaluate({}, {}) is False


@pytest.mark.parametrize('tasks_ok',[True,False])
def test_actual_main_composition_runs_memory_only_after_validated_tasks(tasks_ok):
    expected={'fixed':'a'*64}
    with patch.object(m.sys,'argv',['fixed']),patch.object(m,'_UNKNOWN',False), \
         patch.object(m,'capture_sources',return_value=({},expected)),patch.object(m,'measure',side_effect=[tasks_ok,True]) as launch:
        assert m.main()==(0 if tasks_ok else 1)
        assert launch.call_args_list[0].args==('tasks',expected)
        assert launch.call_count==(2 if tasks_ok else 1)
        if tasks_ok:assert launch.call_args_list[1].args==('memory',expected)


def test_same_instance_unknown_fence_blocks_next_phase_and_next_main():
    def tasks(*_):m._UNKNOWN=True;return True
    with patch.object(m.sys,'argv',['fixed']),patch.object(m,'_UNKNOWN',False), \
         patch.object(m,'capture_sources',return_value=({},{})),patch.object(m,'measure',side_effect=tasks) as launch:
        with pytest.raises(ValueError,match='TASKS_CLEANUP_UNKNOWN'):m.main()
        with pytest.raises(ValueError,match='PRIOR_STRESS'):m.main()
        assert launch.call_count==1


def test_kill_failure_does_not_skip_reap_join_or_other_pipe_closures():
    process=Mock(poll=Mock(side_effect=[None,0]),wait=Mock(side_effect=[subprocess.TimeoutExpired('owned',12),0]),kill=Mock(side_effect=OSError('denied')))
    writer=Mock(join=Mock(side_effect=RuntimeError('join failed')),is_alive=Mock(return_value=False))
    out=Mock(is_alive=Mock(return_value=False));err=Mock(is_alive=Mock(return_value=False))
    errors=[]
    assert m.cleanup_driver(process,[writer,out,err],[writer,out,err],[],Mock(),errors) is True
    assert process.wait.call_count==2
    process.kill.assert_called_once()
    out.join.assert_called_once_with(timeout=1);err.join.assert_called_once_with(timeout=1)
    process.stdout.close.assert_called_once();process.stderr.close.assert_called_once()
    process.stdin.close.assert_not_called()  # Writer owns this close; no unsafe retry.
    assert any(e.startswith('WINDOWS_CLIENT_KILL_UNKNOWN') for e in errors)
    assert any(e.startswith('DRIVER_JOIN_UNKNOWN') for e in errors)


def test_active_reader_handles_are_not_closed_under_running_threads():
    process=Mock(poll=Mock(return_value=0))
    threads=[Mock(is_alive=Mock(return_value=True)) for _ in range(3)]
    errors=[]
    m.cleanup_driver(process,threads,threads,[],Mock(),errors)
    process.stdout.close.assert_not_called();process.stderr.close.assert_not_called()
    assert 'DRIVER_THREADS_UNKNOWN' in errors and 'DRIVER_STDOUT_HANDLE_IN_USE' in errors


def test_source_after_failure_does_not_skip_other_hashes_or_become_empty_evidence():
    errors=[]
    with patch.object(m.Path,'read_bytes',side_effect=[OSError('gone'),b'known']):
        actual=m.after_hashes(['scripts/first.py','scripts/second.py'],errors)
    assert actual['scripts/first.py'] is None
    assert actual['scripts/second.py']==m.hashlib.sha256(b'known').hexdigest()
    assert errors==['SOURCE_AFTER_UNKNOWN:OSError']


def load_fixture(name):
    path=Path(__file__).with_name(name)
    spec=importlib.util.spec_from_file_location(name,path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
    return module


def complete_measure_report(phase):
    """Real child, resource and raw-evidence validators; no patched acceptance."""
    ef=load_fixture('subscription-candidate-resource-stress-evidence.test.py')
    rf=load_fixture('subscription-trusted-cgroup-worker-systemd.measure.test.py')
    raw,before=m.capture_sources();old=rf.report_fixture()
    owner,ready=copy.deepcopy(old['frames'][:2])
    ready['version']=1
    for value in (owner['ownership'],ready['systemdFixtureBoundary']):
        value['relaySha256']=before[m.RELAY]
        value['probeSha256']=before['scripts/subscription-systemd-cli-probe.py']
    ready.pop('trustedCgroupWorkerBoundary',None)
    ready['systemdFixtureBoundary']['readback']=dict(m.READBACK)
    helpers={n:before['scripts/'+n] for n in ef.child.m.HELPERS}
    ready['candidateResourceStressBoundary']={'phase':phase,'helperSha256':helpers}
    source5={n:before['scripts/'+n] for n in m.OBSERVER_FILES}
    evidence,child=ef.complete_observations(phase,source5,ready['systemdFixtureBoundary'])
    child['helperSha256Before']=dict(helpers);child['helperSha256After']=dict(helpers)
    def output(value):return {'version':1,'type':'child_output','stream':'stdout','encoding':'base64','data':m.base64.b64encode(m.encode(value)).decode()}
    def ack(action):return {'version':1,'type':'stress_action_delivered','action':action,'workerAcknowledged':False,'observerAdmissionAttestedHere':False}
    frames=[evidence[0],owner,ready,{'version':1,'type':'started','mode':'candidate-resource-stress-'+phase,'pid':456},
        evidence[2],evidence[3],ack('start'),output(child['progress'][0]),evidence[4]]
    if phase=='memory':frames.extend([ack('ramp'),output(child['progress'][1])])
    frames.extend([evidence[5],ack('release'),output(child)])
    terminal=copy.deepcopy(old['terminal'])
    terminal.update(version=1,mode='candidate-resource-stress-'+phase,reason='EXITED',exitCode=0,productionAuth='NOT_RUN',productionNetwork='NOT_RUN')
    terminal['cleanup']['ownedControlCloseKnown']=True
    terminal['systemdFixtureBoundary']={**copy.deepcopy(ready['systemdFixtureBoundary']),
        'preStartReadback':dict(m.READBACK),'cleanup':{'unitAbsent':True,'leafAbsent':True,'systemdRunClosed':True},'relayErrors':[]}
    terminal['candidateStressObserver']=evidence[-1]['candidateStressObserver']
    stream=b''.join(m.base64.b64decode(f['data']) for f in frames if f['type']=='child_output')
    terminal.update(outputBytes=len(stream),observedOutputSha256=m.hashlib.sha256(stream).hexdigest(),outputComplete=True,streamEOF={'stdout':True,'stderr':True})
    frames.append(terminal);ef.rehash(frames)
    wire=m.Wire(phase,raw,before);requests=[wire.prelude()]
    for frame in frames:
        assert frame.get('version')==1,(frame.get('type'),frame.get('version'))
        requests.extend(wire.receive(frame))
    received=b''.join(m.encode(f) for f in frames)
    report={'version':1,'state':'FINISHED','phase':phase,'sourceSha256Before':before,'sourceSha256After':dict(before),
        'command':m.command(phase),'errors':[],'driverTimeout':False,'exitCode':0,'diagnosticsHex':'',
        'readerEvidence':{name:{'eofObserved':True,'captureTruncated':False,'parseFailed':False} for name in ('stdout','stderr')},
        'systemdFailure':None,
        'productionReady':False,'modelCalls':0,'productionAuth':'NOT_RUN','productionNetwork':'NOT_RUN','elapsedMs':10000,
        'rawOutputHex':received.hex(),'rawOutputSha256':m.hashlib.sha256(received).hexdigest(),'frames':frames,
        'control':[{'rawHex':m.encode(f).hex(),'elapsedMs':i+1} for i,f in enumerate(requests)]}
    return report,raw


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_full_raw_source_bound_child_and_observer_evaluator(phase):
    report,raw=complete_measure_report(phase)
    assert m.evaluate(report,raw)


def complete_common_measure_report(phase):
    ef=load_fixture('subscription-candidate-resource-stress-evidence.test.py')
    report,_=complete_measure_report(phase)
    raw,before=m.capture_sources(True)
    common,child,_,_=ef.complete_common_observations(phase)
    oldready=next(f for f in report['frames'] if f['type']=='ready')
    ready=next(f for f in common if f['type']=='ready')
    boundary=ready['systemdFixtureBoundary']
    for key,value in oldready['systemdFixtureBoundary'].items():
        if key not in boundary:boundary[key]=copy.deepcopy(value)
    boundary['relaySha256']=before[m.RELAY]
    boundary['probeSha256']=before['scripts/subscription-systemd-cli-probe.py']
    for key,value in oldready.items():
        if key not in ready:ready[key]=copy.deepcopy(value)
    owner=dict(version=1,type='systemd_ownership',ownership={
        k:boundary[k] for k in ('unit','uid','leaf','relaySha256','probeSha256')})
    owner['ownership']['driverPid']=boundary['control']['driverPid']
    helpers={n:before['scripts/'+n] for n in ef.child.m.HELPERS}
    ready['candidateResourceStressBoundary']={'phase':phase,'helperSha256':helpers}
    child['helperSha256Before']=dict(helpers);child['helperSha256After']=dict(helpers)
    def output(value):return dict(version=1,type='child_output',stream='stdout',encoding='base64',data=m.base64.b64encode(m.encode(value)).decode())
    def ack(action):return dict(version=1,type='stress_action_delivered',action=action,workerAcknowledged=False,observerAdmissionAttestedHere=False)
    frames=[owner]
    for frame in common[:-1]:
        frames.append(frame)
        if frame['type']=='ready':frames.append(dict(version=1,type='started',mode='candidate-resource-stress-'+phase,pid=456))
        if frame['type']=='candidate_stress_observation':
            stage=frame['stage']
            if stage=='before-work-capacity':frames.extend([ack('start'),output(child['progress'][0])])
            if stage=='workers-held' and phase=='memory':frames.extend([ack('ramp'),output(child['progress'][1])])
            if stage=='release-observation':frames.extend([ack('release'),output(child)])
    terminal=copy.deepcopy(report['frames'][-1])
    terminal['candidateStressObserver']=common[-1]['candidateStressObserver']
    terminal['systemdFixtureBoundary']={**copy.deepcopy(boundary),'preStartReadback':dict(m.READBACK),
        'cleanup':{'unitAbsent':True,'leafAbsent':True,'systemdRunClosed':True},'relayErrors':[]}
    stream=b''.join(m.base64.b64decode(f['data']) for f in frames if f['type']=='child_output')
    terminal.update(outputBytes=len(stream),observedOutputSha256=hashlib.sha256(stream).hexdigest())
    frames.append(terminal);ef.rehash(frames)
    wire=m.Wire(phase,raw,before,True);requests=[wire.prelude()]
    for frame in frames:requests.extend(wire.receive(frame))
    received=b''.join(wire.codec.canonical(f) if f['type']=='cgroup_evidence' else m.encode(f) for f in frames)
    report.update(namespaceEvidenceProfile=m.COMMON_PROFILE,command=m.command(phase,True),
        sourceSha256Before=before,sourceSha256After=dict(before),frames=frames,
        rawOutputHex=received.hex(),rawOutputSha256=hashlib.sha256(received).hexdigest(),
        control=[dict(rawHex=m.encode(f).hex(),elapsedMs=i+1) for i,f in enumerate(requests)])
    return report,raw


@pytest.mark.parametrize('phase',['tasks','memory'])
def test_common_full_raw_source_bound_child_resource_and_document_evaluator(phase):
    report,raw=complete_common_measure_report(phase)
    assert m.evaluate(report,raw)


@pytest.mark.parametrize('case',['missing-admission','wrong-admission','noncanonical','profile','missing-source',
    'target-cleanup','service-cleanup','child-outcome'],ids=str)
def test_common_full_replay_rejects_independent_provenance_control_and_cleanup_failures(case):
    report,raw=complete_common_measure_report('memory')
    if case in ('missing-admission','wrong-admission'):
        index=next(i for i,v in enumerate(report['control']) if m.strict(bytes.fromhex(v['rawHex'])).get('type')=='common_view_admission')
        if case=='missing-admission':report['control'].pop(index)
        else:
            frame=m.strict(bytes.fromhex(report['control'][index]['rawHex']));frame['sha256']='0'*64
            report['control'][index]['rawHex']=m.encode(frame).hex()
    elif case=='profile':report['namespaceEvidenceProfile']='legacy'
    elif case=='missing-source':raw.pop('scripts/'+m.COMMON_FILES[-1])
    else:
        frames=report['frames']
        if case=='target-cleanup':frames[-1]['systemdFixtureBoundary']['cleanup']['leafAbsent']=False
        elif case=='service-cleanup':next(f for f in frames if f['type']=='common_view_preflight')['closeKnown']=False
        elif case=='child-outcome':frames[-1]['exitCode']=1
        codec=m.load('scripts/subscription-cgroup-evidence-stream.py',raw['scripts/subscription-cgroup-evidence-stream.py'])
        data=b''.join(codec.canonical(f) if f['type']=='cgroup_evidence' else m.encode(f) for f in frames)
        if case=='noncanonical':
            lines=data.splitlines(keepends=True)
            index=next(i for i,line in enumerate(lines) if m.strict(line)['type']=='cgroup_evidence')
            lines[index]=lines[index].replace(b':',b': ',1);data=b''.join(lines)
        report.update(rawOutputHex=data.hex(),rawOutputSha256=hashlib.sha256(data).hexdigest())
    assert m.evaluate(report,raw) is False


@pytest.mark.parametrize('tasks_ok',[True,False])
def test_common_main_fixed_sequence_preserves_unknown_fence(tasks_ok):
    expected={'fixed':'a'*64}
    with patch.object(m.sys,'argv',['fixed','--common-view']),patch.object(m,'_UNKNOWN',False), \
         patch.object(m,'capture_sources',return_value=({},expected)) as capture, \
         patch.object(m,'measure',side_effect=[tasks_ok,True]) as launch:
        assert m.main()==(0 if tasks_ok else 1)
        capture.assert_called_once_with(True)
        assert launch.call_args_list[0].args==('tasks',expected,True)
        assert launch.call_count==(2 if tasks_ok else 1)


@pytest.mark.parametrize('case',['unit-cleanup','namespace','control-close','observer-close','prestart-oom','source-drift',
    'missing-control-write','missing-delivery','output-byte-count','child-history','claimed-auth','raw-after-terminal'])
def test_full_evaluator_rejects_independent_missing_or_forged_evidence(case):
    report,raw=complete_measure_report('memory');frames=report['frames'];terminal=frames[-1]
    if case=='unit-cleanup':terminal['systemdFixtureBoundary']['cleanup']['unitAbsent']=False
    if case=='namespace':terminal['cleanup']['namespaceEmpty']=False
    if case=='control-close':terminal['cleanup']['ownedControlCloseKnown']=False
    if case=='observer-close':terminal['candidateStressObserver']['localHandlesClosed']=False
    if case=='prestart-oom':terminal['systemdFixtureBoundary']['preStartReadback']['oomPolicy']='stop'
    if case=='source-drift':report['sourceSha256After'][m.CHILD]='0'*64
    if case=='missing-control-write':report['control'].pop()
    if case=='missing-delivery':frames[:]=[f for f in frames if not (f['type']=='stress_action_delivered' and f['action']=='release')]
    if case=='output-byte-count':terminal['outputBytes']+=1
    if case=='claimed-auth':terminal['productionAuth']='PASS'
    if case=='raw-after-terminal':frames.append(copy.deepcopy(frames[-2]))
    if case=='child-history':
        output=next(f for f in reversed(frames) if f['type']=='child_output')
        child=m.strict(m.base64.b64decode(output['data']));child['parentReport']['sessions']['executor']['history'].pop()
        output['data']=m.base64.b64encode(m.encode(child)).decode()
        stream=b''.join(m.base64.b64decode(f['data']) for f in frames if f['type']=='child_output')
        terminal.update(outputBytes=len(stream),observedOutputSha256=m.hashlib.sha256(stream).hexdigest())
    received=b''.join(m.encode(f) for f in frames)
    report.update(rawOutputHex=received.hex(),rawOutputSha256=m.hashlib.sha256(received).hexdigest())
    assert not m.evaluate(report,raw)


def test_measure_post_spawn_failures_preserve_fence_and_failure_artifact(monkeypatch):
    # Workspace-owned unique evidence directory; no shared temp ACL assumptions.
    directory=Path('scratch')/('stress-driver-fault-unit-'+str(m.uuid.uuid4()))
    directory.mkdir();(directory/'scratch').mkdir();monkeypatch.chdir(directory)
    before={'scripts/fixed.py':m.hashlib.sha256(b'fixed').hexdigest()}
    monkeypatch.setattr(m,'capture_sources',lambda:({'scripts/fixed.py':b'fixed'},before))
    monkeypatch.setattr(m,'Wire',lambda *_:SimpleNamespace(frames=[],failure=None,prelude=lambda:{'type':'stress_composition'}))
    process=Mock(returncode=0,poll=Mock(side_effect=[OSError('poll failed'),None,0]),
        wait=Mock(side_effect=[subprocess.TimeoutExpired('owned',12),0]),kill=Mock(side_effect=OSError('kill failed')))
    monkeypatch.setattr(m.subprocess,'Popen',lambda *_a,**_k:process)
    threads=[]
    def make_thread(**_):
        thread=Mock(is_alive=Mock(return_value=False));threads.append(thread)
        if len(threads)==1:
            thread.start.side_effect=process.stdin.close  # Models writer finally.
            thread.join.side_effect=RuntimeError('join failed')
        return thread
    monkeypatch.setattr(m.threading,'Thread',make_thread)
    monkeypatch.setattr(m.sys,'platform','win32');monkeypatch.setattr(m,'_UNKNOWN',False)
    assert m.measure('tasks',before) is False
    assert m._UNKNOWN is True
    with pytest.raises(ValueError,match='PRIOR_STRESS'):m.measure('memory',before)
    process.stdout.close.assert_called_once();process.stderr.close.assert_called_once()
    assert process.wait.call_count==2
    artifacts=list(Path('scratch').glob('session8-candidate-stress-tasks-*.json'))
    assert len(artifacts)==1
    report=m.strict(artifacts[0].read_bytes())
    assert report['state']=='FINISHED' and report['stressValidated'] is False
    assert report['sourceSha256After']=={'scripts/fixed.py':None}
    assert any(e.startswith('SOURCE_AFTER_UNKNOWN') for e in report['errors'])
    assert any(e.startswith('WINDOWS_CLIENT_KILL_UNKNOWN') for e in report['errors'])

@pytest.mark.parametrize('mutation',[None,'foreign','unknown','spawned','boolean'])
def test_structured_failure_is_preserved_but_never_success(mutation):
    wire,owner,*_=fixture('tasks');wire.receive(owner)
    frame={'version':1,'type':'systemd_failure','ownership':copy.deepcopy(owner['ownership']),
        'error':"PermissionError: protected manager namespace",'stageEvidence':None,
        'cleanup':{'unitAbsent':True,'leafAbsent':True,'systemdRunClosed':False},
        'diagnostics':{'notSpawned':True}}
    if mutation=='foreign':frame['ownership']['unit']='foreign'
    if mutation=='unknown':frame['cleanup']['leafAbsent']=None
    if mutation=='spawned':frame['diagnostics']['notSpawned']=False
    if mutation=='boolean':frame['cleanup']['unitAbsent']=1
    with pytest.raises(ValueError,match='DRIVER_SYSTEMD_FAILURE'):wire.receive(frame)
    assert wire.frames[-1]==frame and wire.terminal is None and wire.actions==[]
    assert wire.failure['classification']==('PRE_SPAWN_FAILURE_ABSENCE_REPORTED' if mutation is None else 'CLEANUP_UNKNOWN')
    assert wire.failure['remoteCleanupCredit'] is False and wire.failure['stressValidated'] is False


def test_failure_label_retains_fixed_reason_without_copying_arbitrary_text():
    assert m.failure_label(ValueError('DRIVER_SYSTEMD_FAILURE'))=='ValueError:DRIVER_SYSTEMD_FAILURE'
    assert m.failure_label(ValueError('private arbitrary text'))=='ValueError'
    assert m.failure_label(ValueError('A'*129))=='ValueError'


@pytest.mark.parametrize('raw',[b'bad\nremaining\nlast', 'Pristup byl odepren.\r\nRemaining localized text'.encode('utf-16-le')])
def test_invalid_first_line_still_drains_all_bounded_bytes(raw):
    import io,queue,threading
    captured=bytearray();evidence={};errors=[];done=threading.Event();pending=queue.Queue()
    m.drain_reader(io.BytesIO(raw),captured,65536,done,pending,errors,evidence)
    assert bytes(captured)==raw and done.is_set() and pending.empty()
    assert evidence['eofObserved'] is True and evidence['parseFailed'] is True
    assert evidence['captureTruncated'] is False and errors==['DRIVER_READ_FAILED']


def test_reader_preserves_prior_frame_but_never_dispatches_after_malformed_line():
    import io,queue,threading
    good=m.encode({'version':1,'type':'systemd_failure'})
    raw=good+b'bad\n'+good
    captured=bytearray();pending=queue.Queue();evidence={};errors=[]
    m.drain_reader(io.BytesIO(raw),captured,65536,threading.Event(),pending,errors,evidence)
    assert bytes(captured)==raw and pending.qsize()==1
    assert evidence['eofObserved'] is True


def test_failure_drain_bound_is_explicit_and_does_not_claim_eof():
    import io,queue,threading
    captured=bytearray();evidence={};errors=[]
    m.drain_reader(io.BytesIO(b'bad\n'+b'x'*100),captured,32,threading.Event(),queue.Queue(),errors,evidence)
    assert len(captured)==32 and evidence['captureTruncated'] is True
    assert evidence['eofObserved'] is False and 'DRIVER_OUTPUT_BOUND' in errors

@pytest.mark.parametrize('case',['stdout-eof','stderr-eof','truncated','parse-failed','boolean','extra','missing','failure'])
def test_full_replay_rejects_contradictory_reader_and_failure_evidence(case):
    report,raw=complete_measure_report('tasks')
    if case=='stdout-eof':report['readerEvidence']['stdout']['eofObserved']=False
    elif case=='stderr-eof':report['readerEvidence']['stderr']['eofObserved']=False
    elif case=='truncated':report['readerEvidence']['stdout']['captureTruncated']=True
    elif case=='parse-failed':report['readerEvidence']['stdout']['parseFailed']=True
    elif case=='boolean':report['readerEvidence']['stdout']['eofObserved']=1
    elif case=='extra':report['readerEvidence']['stderr']['failure']='KNOWN_ERROR'
    elif case=='missing':del report['readerEvidence']
    else:report['systemdFailure']={'classification':'PRE_SPAWN_FAILURE_ABSENCE_REPORTED'}
    assert m.evaluate(report,raw) is False
