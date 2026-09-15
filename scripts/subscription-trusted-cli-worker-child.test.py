"""Owned endpoint coordination mocks, no socket, process or workload launch."""
import importlib.util
import base64
import copy
import hashlib
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

m=load('subscription-trusted-cli-worker-child')

@pytest.fixture(autouse=True)
def fresh(monkeypatch):monkeypatch.setattr(m,'_BLOCKED',False)

def lifetime():
    session=SimpleNamespace(deadline=2,listener=SimpleNamespace(fileno=lambda:-1),
        connection=SimpleNamespace(fileno=lambda:5),close=Mock(return_value=True))
    observer=Mock(return_value={'actualParsed':'mock'});observer.close=Mock(return_value={'closed':True})
    return m.EndpointLifetime(session,observer,{'pid':10,'startTicks':'100','networkNamespace':'net:[2]'},22,clock=lambda:1)

OBS={'peer':['127.0.0.1',1111],'local':['127.0.0.1',2222],'socket':{'dev':1,'ino':9,'type':49152}}

def admitted():
    value=lifetime();value.observation=OBS;value.accepted.set()
    return value

def test_gate_missing_refuses_before_any_fallback():
    with pytest.raises(ValueError,match='FIXED_GATE_EXPORT'):m.require_fixed_hook(SimpleNamespace())

def test_fixed_policy_exact_zeroarg_contract():
    gate=load('subscription-exec-server-worker-gate')
    expected=gate.control_start_request();expected['params']['argv']=list(m.PROBE_ARGV)
    gate.trusted_cli_start_request=lambda:expected
    assert m.require_fixed_hook(gate)==expected
    expected['params']['sandbox']['permissions']['network']='enabled'
    with pytest.raises(ValueError,match='FIXED_GATE_POLICY'):m.require_fixed_hook(gate)

def test_main_rejects_nonlinux_without_any_runtime():
    with pytest.raises(ValueError,match='FIXED_LINUX_CHILD'):m.main()

def test_actual_accepted_metadata_marker_not_live_listener():
    value=admitted();marker=value.marker_endpoint()
    assert marker=={'address':OBS['local'],'socket':OBS['socket'],'networkNamespace':'net:[2]','listenerClosed':True}
    assert 'peer' not in marker

def test_endpoint_must_precede_worker_and_completion_has_same_cli():
    value=lifetime()
    with pytest.raises(ValueError):value.before_worker({'pid':10,'alive':True,'elapsedMs':1})
    value=admitted();value.before_worker({'pid':10,'alive':True,'elapsedMs':1})
    with pytest.raises(ValueError):value.after_worker({'pid':11,'alive':True,'elapsedMs':2})
    assert not value.worker_done.is_set()
    value.after_worker({'pid':10,'alive':True,'elapsedMs':2})
    assert value.worker_done.is_set()

def test_core_two_second_deadline_never_extended():
    value=admitted();value.clock=lambda:2
    with pytest.raises(ValueError,match='CORE_DEADLINE'):value.marker_endpoint()

def test_cancel_invalidates_endpoint_authority():
    value=admitted();value.cancelled.set()
    with pytest.raises(ValueError,match='CANCELLED'):value.marker_endpoint()

def test_closed_endpoint_cannot_be_published():
    value=admitted();value.session.connection.fileno=lambda:-1
    with pytest.raises(ValueError,match='ENDPOINT_CLOSED'):value.marker_endpoint()

def test_second_provenance_requires_worker_completion():
    value=admitted();value.records=[{}]
    with pytest.raises(ValueError,match='WORKER_MUST'):value.callback('header-complete-before-refusal',OBS)

def test_endpoint_drift_refused_before_observer():
    value=admitted();value.records=[{}]
    with pytest.raises(ValueError,match='ENDPOINT_DRIFT'):value.callback('header-complete-before-refusal',{**OBS,'local':['127.0.0.1',3333]})
    value.observer.assert_not_called()

def test_unknown_thread_retains_handles_and_fences_next_owner():
    value=lifetime();value.thread=Mock();value.thread.is_alive.return_value=True
    result=value.close()
    assert result['ownedHandlesKnown'] is False
    value.session.close.assert_not_called();value.observer.close.assert_not_called()
    with pytest.raises(ValueError,match='PRIOR_COMBINED_UNKNOWN'):lifetime()

def test_known_close_attempts_both_and_is_idempotent():
    value=lifetime();value.session.close.side_effect=OSError('unknown')
    result=value.close();assert result['ownedHandlesKnown'] is False
    value.observer.close.assert_called_once()
    assert value.close() is result
    value.session.close.assert_called_once()

def test_first_callback_holds_endpoint_until_actual_worker_hook_then_second_snapshot():
    value=lifetime()
    def worker(timeout):
        assert 0<timeout<=.01 and value.accepted.is_set()
        value.before_worker({'pid':10,'alive':True,'elapsedMs':1})
        value.after_worker({'pid':10,'alive':True,'elapsedMs':2})
    value.worker_done.wait=worker
    first=value.callback('accepted-before-read',OBS)
    second=value.callback('header-complete-before-refusal',OBS)
    assert first==second and len(value.records)==2
    assert [call.args[0] for call in value.observer.call_args_list]==['accepted-before-read','header-complete-before-refusal']

def test_listener_close_is_verified_before_worker_authority():
    value=lifetime();value.session.listener.fileno=lambda:4
    with pytest.raises(ValueError,match='LISTENER_NOT_CLOSED'):value.callback('accepted-before-read',OBS)
    assert not value.accepted.is_set()


def complete_report():
    old=load('subscription-trusted-control-boundary-parent.test')
    rf=load('subscription-cli-proxy-refusal-child.test').complete_report()
    raw={name:Path(__file__).with_name(name).read_bytes() for name in m.HELPERS}
    deps=m.dependencies(raw);parent,policy,gate,base,core,provenance,probe=deps
    body=old.complete_report();proxy=rf['proxyReport'];identity=rf['cliIdentity'];identity['pid']=7
    # Actual wire fixture identities remain consistently represented in raw stat.
    for item in proxy['provenanceObservations']:
        for field in ('identityBefore','identityAfter'):
            sample=item['record'][field];sample['pid']=7
            text=('7 (owned) '+' '.join(['S']+['0']*18+['900'])+'\n').encode()
            sample['statRawHex']=text.hex();sample['statSha256']=hashlib.sha256(text).hexdigest()
    proxy['provenanceObservations'][0]['record']['capturedMonotonic']=10
    proxy['provenanceObservations'][1]['record']['capturedMonotonic']=10.35
    marker=body['marker']['value'];marker['trustedCliProxyEndpoint']={'address':proxy['accepted']['local'],
        'socket':proxy['accepted']['socket'],'networkNamespace':identity['networkNamespace'],'listenerClosed':True}
    marker_raw=json.dumps(marker).encode()
    body['marker'].update(rawHex=marker_raw.hex(),bytes=len(marker_raw),sha256=hashlib.sha256(marker_raw).hexdigest())
    for field in ('beforeWorker','afterWorker'):body[field]['marker']['sha256']=body['marker']['sha256']
    parent,view,pv=m.compose(deps,None,proxy['ownership']['address'])
    app=parent.make_initialize_protocol(policy);old.drain(app)
    app.receive({'id':1,'result':{'userAgent':'fixed-test','codexHome':parent.HOME,'platformFamily':'unix','platformOs':'linux'}});old.drain(app)
    app.receive({'id':2,'result':{'model':'gpt-5.6-sol','modelProvider':'openai','reasoningEffort':'low','cwd':'/work',
        'approvalPolicy':'never','runtimeWorkspaceRoots':[],'sandbox':{'type':'readOnly','networkAccess':False},'thread':{'ephemeral':True,'path':None}}})
    assert app.initialized_complete
    wp=parent.WorkerProtocol(view,pv,marker);old.drain(wp)
    wp.receive({'id':1,'result':{'sessionId':'fixed-session'}});old.drain(wp)
    wp.receive({'id':2,'result':{'processId':'fixed-worker'}});old.drain(wp)
    probe_report=old.probe_fixtures.report()
    probe_report['marker'].update(value=marker,rawHex=marker_raw.hex(),bytes=len(marker_raw),sha256=body['marker']['sha256'])
    wrapper={'version':1,'kind':'FIXED_TRUSTED_CLI_ENDPOINT_WORKER','baseReport':probe_report,'workerNetworkNamespace':'net:[99]'}
    probe_raw=json.dumps(wrapper).encode()+b'\n'
    wp.receive({'id':3,'result':{'chunks':[{'seq':1,'stream':'stdout','chunk':base64.b64encode(probe_raw).decode()}],
        'nextSeq':2,'exited':True,'exitCode':0,'closed':True,'failure':None,'sandboxDenied':False}})
    body['sessions']={'appserver':old.session_report(app,7,parent.appserver_argv(policy)),
        'executor':old.session_report(wp,8,m.GATE_ARGV)}
    body['sessions']['appserver']['environment']['HTTPS_PROXY']='http://127.0.0.1:42000'
    hashes={name:hashlib.sha256(value).hexdigest() for name,value in raw.items()}
    body.update(helperSha256Before=hashes,helperSha256After=hashes)
    return {'version':1,'profile':'fixed-trusted-cli-worker-child','success':True,'error':None,'parentReport':body,
        'proxyReport':proxy,'cliIdentity':identity,'endpointBeforeWorker':copy.deepcopy(body['beforeWorker']),
        'endpointAfterWorker':{**copy.deepcopy(body['afterWorker']),'elapsedMs':300},
        'generationObservations':[{'identity':copy.deepcopy(identity),'monotonic':10.05},{'identity':copy.deepcopy(identity),'monotonic':10.25}],
        'beganMonotonic':10,'elapsedMs':1000,'helperSha256Before':hashes,'helperSha256After':hashes,
        'cleanup':{'threadJoined':True,'ownedHandlesKnown':True,'originalCliPinOwnedHere':False}},raw,old.ready()


def test_full_raw_parent_worker_provenance_replay():
    report,raw,ready=complete_report()
    assert m.validate_report(report,raw,ready)


def test_fixed_metadata_only_no_model_list_turn_or_account_queue():
    raw={name:Path(__file__).with_name(name).read_bytes() for name in m.HELPERS}
    parent,policy,*_=m.dependencies(raw)
    protocol=m.metadata_protocol(parent,policy)
    for method in ('turn/start','account/login/start','model/list'):
        with pytest.raises(ValueError):protocol._queue({'method':method,'params':{}})
    assert [x['frame']['method'] for x in protocol.history if x['event']=='queued']==['initialize']


def test_private_session_hook_preserves_fixed_popen_and_owns_original_pin(monkeypatch):
    raw={name:Path(__file__).with_name(name).read_bytes() for name in m.HELPERS}
    deps=m.dependencies(raw);parent,policy,gate,base,core,provenance,probe=deps
    process=Mock();process.pid=7
    sessions=[]
    class OriginalSession:
        def __init__(self,name,argv,environment,*args):
            self.process=process;self.pin=9;self.error=None
            sessions.append((name,list(argv),dict(environment)))
    parent.Session=OriginalSession
    fake_session=SimpleNamespace(deadline=m.time.monotonic()+2,ownership={'address':['127.0.0.1',42000]},close=Mock(return_value=True))
    core.create_refusal_session=lambda _:fake_session
    observer=Mock();observer.close.return_value={'closed':True}
    provenance.create_observer=Mock(return_value=observer)
    monkeypatch.setattr(m,'own_identity',lambda *args:{'pid':7,'startTicks':'900','networkNamespace':'net:[2]'})
    monkeypatch.setattr(m.os,'close',lambda fd:None)
    monkeypatch.setattr(m.EndpointLifetime,'start',lambda self:None)
    def loop(p,view,pv,budget,packet):
        env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':parent.HOME,'CODEX_HOME':parent.HOME,'TMPDIR':parent.HOME+'/tmp'}
        parent.Session('appserver',parent.appserver_argv(p),env,None,p,None,budget)
        parent.Session('executor',m.GATE_ARGV,env,None,p,None,budget)
        return {'error':'authored-stop'}
    parent.run_parent=loop
    result=m.run_component(deps,SimpleNamespace(began=m.time.monotonic()),{})
    assert sessions[0][2]['HTTPS_PROXY']=='http://127.0.0.1:42000'
    assert 'HTTPS_PROXY' not in sessions[1][2]
    assert sessions[1][1]==list(m.GATE_ARGV)
    provenance.create_observer.assert_called_once()
    assert provenance.create_observer.call_args.args[:2]==(process,9)
    assert result['cleanup']['ownedHandlesKnown'] and result['error']=='authored-stop'


@pytest.mark.parametrize('case',['thread-missing','proxy-env','worker-env','endpoint','generation','overlap','cleanup','source','model','raw-worker','no-second','after-objects','extra-provenance','late-total'])
def test_full_composed_negative_bindings(case):
    report,raw,ready=complete_report();body=report['parentReport']
    if case=='thread-missing':body['sessions']['appserver']['history'].pop()
    elif case=='proxy-env':body['sessions']['appserver']['environment']['HTTPS_PROXY']='http://127.0.0.1:1'
    elif case=='worker-env':body['sessions']['executor']['environment']['HTTPS_PROXY']='http://127.0.0.1:42000'
    elif case=='endpoint':report['proxyReport']['accepted']['socket']['ino']+=1
    elif case=='generation':report['generationObservations'][1]['identity']['startTicks']='901'
    elif case=='overlap':report['generationObservations'][1]['monotonic']=10.5
    elif case=='cleanup':report['cleanup']['threadJoined']=False
    elif case=='source':report['helperSha256After']={}
    elif case=='model':report['proxyReport']['modelCalls']=1
    elif case=='raw-worker':body['sessions']['executor']['stdoutBase64']=base64.b64encode(b'{}\n').decode()
    elif case=='no-second':report['proxyReport']['provenanceObservations'].pop()
    elif case=='after-objects':report['endpointAfterWorker']['pipes']={}
    elif case=='extra-provenance':report['proxyReport']['provenanceObservations'][0]['synthetic']=True
    else:report['elapsedMs']=30000
    assert not m.validate_report(report,raw,ready)


def run_real_parent_pump(monkeypatch, failure=None):
    """Real parent loop/protocols; only kernel, subprocess and proxy peers mocked."""
    import threading
    fixture,raw,ready=complete_report();deps=m.dependencies(raw)
    parent,policy,gate,base,core,provenance,probe=deps
    body=fixture['parentReport'];events=[];handles={};processes=[];accepted_trigger=threading.Event()
    responses={name:[json.loads(line) for line in base64.b64decode(value['stdoutBase64']).splitlines()]
               for name,value in body['sessions'].items()}
    class Handle:
        def __init__(self,owner,stream):
            self.owner=owner;self.stream=stream;self.closed=False;self.fd=100+len(handles);handles[self.fd]=self
        def fileno(self):return self.fd
        def close(self):
            events.append(('close',self.owner.name,self.stream));self.closed=True
            if failure=='stream' and self.owner.name=='appserver' and self.stream=='stdout':raise OSError('owned close unknown')
            if failure=='stdin' and self.owner.name=='appserver' and self.stream=='stdin':raise OSError('stdin close unknown')
    class Process:
        def __init__(self,argv,**kwargs):
            self.name='appserver' if not processes else 'executor';self.pid=7+len(processes);self.queue=[]
            assert kwargs['close_fds'] is True and 'pass_fds' not in kwargs
            for stream in ('stdin','stdout','stderr'):setattr(self,stream,Handle(self,stream))
            processes.append(self);events.append(('spawn',self.name))
        def poll(self):return 0 if self.stdin.closed else None
    class Selector:
        def __init__(self):self.keys={}
        def register(self,h,mask,data):self.keys[h.fd]=SimpleNamespace(fileobj=h,data=data)
        def unregister(self,h):return self.keys.pop(h.fd)
        def get_key(self,h):return self.keys[h.fd]
        def select(self,timeout):
            for key in list(self.keys.values()):
                h=key.fileobj
                if h.closed:continue
                if h.stream=='stdin' or (h.stream=='stdout' and h.owner.queue) or (h.stream!='stdin' and h.owner.stdin.closed):return [(key,1)]
            m.time.sleep(.001);return []
        def close(self):
            events.append(('selector-close',))
            if failure=='selector':raise OSError('selector unknown')
    def write(fd,data):
        h=handles[fd]
        for line in bytes(data).splitlines():
            request=json.loads(line);events.append(('write',h.owner.name,request['method']))
            if 'id' in request:
                reply=next(x for x in responses[h.owner.name] if x.get('id')==request['id'])
                h.owner.queue.append((json.dumps(reply)+'\n').encode())
        return len(data)
    def read(fd,count):
        h=handles[fd]
        if h.stream=='stdout' and h.owner.queue:
            value=h.owner.queue.pop(0)
            if h.owner.name=='appserver' and json.loads(value).get('id')==2:
                events.append(('thread-reply',));accepted_trigger.set()
            # The 8KiB real read bound must retain remaining fragmented bytes.
            if len(value)>count:h.owner.queue.insert(0,value[count:]);value=value[:count]
            return value
        if h.owner.stdin.closed:return b''
        raise BlockingIOError()
    parent.subprocess=SimpleNamespace(Popen=Process,PIPE=-1)
    parent.os=SimpleNamespace(**{**vars(parent.os),'set_blocking':lambda *a:None,'pidfd_open':lambda pid:pid+200,'write':write,'read':read})
    parent.selectors=SimpleNamespace(**{**vars(parent.selectors),'DefaultSelector':Selector})
    parent.prepare_home=lambda:({'PATH':'/usr/bin:/bin','LANG':'C.UTF-8','HOME':parent.HOME,'CODEX_HOME':parent.HOME,'TMPDIR':parent.HOME+'/tmp'},body['marker']['value']['authoredProtectedObjects'])
    parent.capture_appserver_pipes=lambda process:body['beforeWorker']['pipes']
    parent.make_marker=lambda *args:{k:v for k,v in body['marker']['value'].items() if k!='trustedCliProxyEndpoint'}
    parent.publish_marker=lambda value,p:copy.deepcopy(body['marker'])
    def observe(process,marker,budget):
        events.append(('trusted-observation',));return {**copy.deepcopy(body['beforeWorker']),'elapsedMs':(m.time.monotonic()-budget.began)*1000}
    parent.trusted_observation=observe
    if failure=='report':
        def failed_report(self):raise ValueError('report-before-finally-close')
        parent.Session.report=failed_report
    monkeypatch.setattr(m,'own_identity',lambda *args:copy.deepcopy(fixture['cliIdentity']))
    def close_pin(fd):
        events.append(('pin-close',fd))
        if failure=='pin' and fd==207:raise OSError('pin unknown')
    monkeypatch.setattr(m.os,'close',close_pin)
    observer=Mock(side_effect=lambda phase,observation:{'phase':phase});observer.close.return_value={'closed':True}
    provenance.create_observer=lambda *args:observer
    class Proxy:
        def __init__(self):
            self.deadline=m.time.monotonic()+2;self.ownership=fixture['proxyReport']['ownership'];self.listener=None
            self.connection=SimpleNamespace(fileno=lambda:555)
        def run(self,cancelled,callback):
            assert accepted_trigger.wait(1)
            events.append(('accepted-callback',));callback('accepted-before-read',fixture['proxyReport']['accepted'])
            events.append(('header-callback',));callback('header-complete-before-refusal',fixture['proxyReport']['accepted'])
            events.append(('actual-local-refusal',));return fixture['proxyReport']
        def close(self):events.append(('proxy-close',));return True
    core.create_refusal_session=lambda _:Proxy()
    budget=parent.Budget()
    result=m.run_component(deps,budget,body['startupPacket'])
    return result,events,deps,budget,body['startupPacket']


def test_real_parent_pump_metadata_accepted_worker_refusal_order(monkeypatch):
    result,events,*_=run_real_parent_pump(monkeypatch)
    assert result['error'] is None and result['parentReport']['error'] is None
    assert events.index(('thread-reply',))<events.index(('accepted-callback',))<events.index(('spawn','executor'))
    assert events.index(('write','executor','process/read'))<events.index(('header-callback',))<events.index(('actual-local-refusal',))
    assert len(result['generationObservations'])==2 and result['cleanup']['ownedHandlesKnown']
    assert not m._BLOCKED


@pytest.mark.parametrize('failure',['stream','pin','selector','stdin'])
def test_real_parent_cleanup_failure_attempts_remaining_and_fences(monkeypatch,failure):
    result,events,deps,budget,packet=run_real_parent_pump(monkeypatch,failure)
    assert result['error'].startswith('PARENT_HANDLES_UNKNOWN:') and m._BLOCKED
    assert ('close','executor','stderr') in events and ('pin-close',208) in events
    assert events.count(('pin-close',207))==1 and events.count(('selector-close',))==1
    assert events.count(('close','appserver','stdin'))==1
    with pytest.raises(ValueError,match='PRIOR_COMBINED_UNKNOWN'):m.run_component(deps,budget,packet)


def test_report_exception_before_parent_close_loop_still_closes_owned(monkeypatch):
    result,events,deps,budget,packet=run_real_parent_pump(monkeypatch,'report')
    assert result['error']=='ValueError:report-before-finally-close' and m._BLOCKED
    assert ('close','executor','stderr') in events and ('pin-close',207) in events and ('pin-close',208) in events
    assert events.count(('selector-close',))==1
    with pytest.raises(ValueError,match='PRIOR_COMBINED_UNKNOWN'):m.run_component(deps,budget,packet)
