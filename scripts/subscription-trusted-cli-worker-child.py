"""Combined endpoint lifetime component. Fixed gate/profile integration pending."""
import copy
import base64
import hashlib
import json
import math
import os
import re
import selectors
import signal
import stat
import sys
import threading
import time
import types

PROFILE='trusted-cli-worker-boundary'
GATE_ARGV=('/usr/bin/python3','-I','-S','/usr/bin/exec-server-worker-gate.py','--trusted-cli-worker-boundary')
PROBE_ARGV=('/usr/bin/python3','-I','-S','/usr/bin/trusted-cli-worker-probe.py')
MARKER='/work/trusted-control-boundary.json'
_BLOCKED=False
HELPERS={name:'/usr/bin/'+name.removeprefix('subscription-') for name in (
    'subscription-exec-server-worker-gate.py','subscription-exec-server-worker-trampoline.py',
    'subscription-exec-worker-probe.py','subscription-trusted-control-boundary-probe.py',
    'subscription-worker-lockdown.py','subscription-appserver-noenv.py','subscription-text-model-catalog.json',
    'subscription-trusted-control-boundary-parent.py','subscription-cli-proxy-refusal.py',
    'subscription-cli-proxy-provenance.py','subscription-trusted-cli-worker-probe.py','subscription-trusted-cli-worker-child.py')}
CATALOG='59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'


def same(a,b):return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)


def require(value,reason):
    if not value:raise ValueError(reason)


def require_fixed_hook(gate):
    """No fallback to direct/control/HTTP profile, before any process spawn."""
    hook=getattr(gate,'trusted_cli_start_request',None)
    require(callable(hook),'INTEGRATION_BLOCKED_FIXED_GATE_EXPORT')
    expected=gate.control_start_request()
    expected['params']['argv']=list(PROBE_ARGV)
    actual=hook()
    require(same(actual,expected),'INTEGRATION_BLOCKED_FIXED_GATE_POLICY')
    return actual


class EndpointLifetime:
    """Borrow CLI Popen+pin through the reviewed provenance factory.

    Accepted socket remains owned by core, never adopted/inherited here. First
    callback captures real provenance then waits for actual worker completion;
    second callback rechecks the same CLI endpoint before the real local403.
    Every wait consumes core's original absolute two-second deadline.
    """
    def __init__(self,session,observer,identity,work_deadline,clock=time.monotonic):
        global _BLOCKED
        require(not _BLOCKED,'PRIOR_COMBINED_UNKNOWN')
        require(type(work_deadline) in (int,float) and math.isfinite(work_deadline),'WORK_DEADLINE')
        self.session=session;self.observer=observer;self.identity=copy.deepcopy(identity)
        self.deadline=min(session.deadline,work_deadline);self.clock=clock
        self.cancelled=threading.Event();self.accepted=threading.Event();self.worker_done=threading.Event()
        self.finished=threading.Event();self.thread=None;self.proxy_report=None;self.error=None
        self.observation=None;self.records=[];self.worker_before=None;self.worker_after=None
        self.closed=False;self.close_result=None
        self.process=None;self.pin=None;self.generations=[]

    def check(self):
        require(not self.cancelled.is_set(),'COMBINED_CANCELLED')
        require(self.clock()<self.deadline,'COMBINED_CORE_DEADLINE')

    def callback(self,phase,observation):
        self.check()
        expected=('accepted-before-read','header-complete-before-refusal')
        require(len(self.records)<2 and phase==expected[len(self.records)],'COMBINED_PHASE_ORDER')
        if self.observation is not None:require(same(observation,self.observation),'COMBINED_ENDPOINT_DRIFT')
        record=self.observer(phase,observation)
        self.check();self.records.append(copy.deepcopy(record))
        if phase==expected[0]:
            # Core closes listener before this callback. Accepted endpoint stays
            # open; metadata marker must never claim a listening service here.
            require(self.session.listener is None or self.session.listener.fileno()==-1,'LISTENER_NOT_CLOSED')
            self.observation=copy.deepcopy(observation);self.accepted.set()
            while not self.worker_done.is_set():
                self.check();self.worker_done.wait(min(.01,max(0,self.deadline-self.clock())))
            self.check();require(self.worker_after is not None,'WORKER_COMPLETION_MISSING')
        else:
            require(self.worker_after is not None,'WORKER_MUST_PRECEDE_SECOND_PROVENANCE')
        return record

    def start(self):
        self.check();require(self.thread is None,'SINGLE_PROXY_THREAD')
        def work():
            try:
                self.proxy_report=self.session.run(self.cancelled,self.callback)
                require(self.proxy_report.get('success') is True,'LOCAL_REFUSAL_INCOMPLETE')
            except BaseException as error:self.error=type(error).__name__;self.cancelled.set()
            finally:self.finished.set()
        self.thread=threading.Thread(target=work,daemon=True,name='trusted-cli-worker-local403')
        try:self.thread.start()
        except BaseException:
            self.error='THREAD_START_UNKNOWN';self.cancelled.set();raise

    def marker_endpoint(self):
        self.check();require(self.accepted.is_set() and not self.worker_done.is_set(),'ACCEPTED_ENDPOINT_REQUIRED')
        require(self.session.connection is not None and self.session.connection.fileno()>=0,'ACCEPTED_ENDPOINT_CLOSED')
        return {'address':copy.deepcopy(self.observation['local']),'socket':copy.deepcopy(self.observation['socket']),
            'networkNamespace':self.identity['networkNamespace'],'listenerClosed':True}

    def before_worker(self,actual_trusted_observation):
        self.marker_endpoint();require(self.worker_before is None,'WORKER_SINGLE_START')
        require(actual_trusted_observation['alive'] is True and actual_trusted_observation['pid']==self.identity['pid'],'OWN_CLI_ALIVE')
        self.worker_before=copy.deepcopy(actual_trusted_observation)

    def after_worker(self,actual_trusted_observation):
        self.check();require(self.worker_before is not None and self.worker_after is None,'WORKER_COMPLETION_ORDER')
        require(actual_trusted_observation['alive'] is True and actual_trusted_observation['pid']==self.identity['pid'],'OWN_CLI_ALIVE')
        require(actual_trusted_observation['elapsedMs']>=self.worker_before['elapsedMs'],'WORKER_TIME_ORDER')
        self.worker_after=copy.deepcopy(actual_trusted_observation);self.worker_done.set()

    def close(self):
        global _BLOCKED
        if self.closed:return self.close_result
        self.closed=True;self.cancelled.set();known=True;joined=False
        try:
            if self.thread is not None:
                if self.thread.is_alive():self.thread.join(max(0,min(.1,self.deadline-self.clock())))
                joined=not self.thread.is_alive() and self.finished.is_set()
            else:joined=True
        except BaseException:joined=False
        known=joined
        # Never close a socket or observer pin still used by a live callback.
        if joined:
            for close in (self.session.close, *((self.observer.close,) if self.observer is not None else ())):
                try:
                    result=close();known=(result is True or type(result) is dict and result.get('closed') is True) and known
                except BaseException:known=False
        if not known:_BLOCKED=True
        self.close_result={'threadJoined':joined,'ownedHandlesKnown':known,'originalCliPinOwnedHere':False}
        return self.close_result


def capture_sources():
    global _BLOCKED
    require(not _BLOCKED,'PRIOR_COMBINED_UNKNOWN');raw={}
    for name,path in HELPERS.items():
        fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
        try:
            first=os.fstat(fd)
            require(stat.S_ISREG(first.st_mode) and 0<first.st_size<=1048576 and os.fstatvfs(fd).f_flag&os.ST_RDONLY,'READONLY_SOURCE')
            value=os.read(fd,1048577);last=os.fstat(fd)
            require(len(value)==first.st_size and (first.st_dev,first.st_ino,first.st_mtime_ns)==(last.st_dev,last.st_ino,last.st_mtime_ns),'SOURCE_CHANGED')
            raw[name]=value
        finally:
            try:os.close(fd)
            except BaseException:_BLOCKED=True;raise
    hashes={name:hashlib.sha256(value).hexdigest() for name,value in raw.items()}
    require(hashes['subscription-text-model-catalog.json']==CATALOG,'FIXED_CATALOG')
    return raw,hashes


def dependencies(raw):
    result=[]
    for name in ('subscription-trusted-control-boundary-parent.py','subscription-appserver-noenv.py',
        'subscription-exec-server-worker-gate.py','subscription-trusted-control-boundary-probe.py',
        'subscription-cli-proxy-refusal.py','subscription-cli-proxy-provenance.py','subscription-trusted-cli-worker-probe.py'):
        module=types.ModuleType('private_'+name.replace('-','_'));module.__file__=HELPERS[name]
        exec(compile(raw[name],module.__file__,'exec'),module.__dict__);result.append(module)
    return tuple(result)


def metadata_protocol(parent,policy,route=None):
    original=parent.make_initialize_protocol(policy).__class__
    class Metadata(original):
        def _queue(self,frame):
            method=frame['method']
            if method=='thread/start':
                frame=copy.deepcopy(frame)
                frame['params']['config'].update({'features.shell_snapshot':False,'project_doc_max_bytes':0,'project_root_markers':[]})
                return policy.Protocol._queue(self,frame)
            if method=='model/list':
                require(2 in self.responses,'THREAD_REPLY_REQUIRED');self.done=True;return
            require(method in ('initialize','initialized'),'FIXED_METADATA_RPC_ONLY')
            return super()._queue(frame)
        @property
        def initialized_complete(self):
            if route is not None:
                route.check()
                return self.done and not self.pending and route.accepted.is_set()
            return self.done and not self.pending
    return Metadata()


def own_identity(process,pin,provenance,deadline):
    global _BLOCKED
    def check():require(time.monotonic()<deadline,'OWN_IDENTITY_DEADLINE')
    check();signal.pidfd_send_signal(pin,0);check()
    fd=os.open('/proc/'+str(process.pid)+'/stat',os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC)
    try:
        check();raw=os.read(fd,4097);check();require(len(raw)<=4096,'OWN_STAT_BOUND')
        ticks=provenance.stat_identity(raw,process.pid)
    finally:
        try:os.close(fd)
        except BaseException:_BLOCKED=True;raise
    net=os.readlink('/proc/self/ns/net');check();signal.pidfd_send_signal(pin,0);check()
    return {'pid':process.pid,'startTicks':ticks,'networkNamespace':net}


def compose(deps,route=None,proxy_address=None):
    """Mutates only newly compiled private modules; raw reports stay unchanged."""
    parent,policy,gate,base,core,provenance,probe=deps
    require_fixed_hook(gate)
    start=gate.trusted_cli_start_request
    gate_view=types.SimpleNamespace(**vars(gate));gate_view.control_start_request=start
    validate_probe=probe.adapt(base)
    probe_view=types.SimpleNamespace(**vars(base));probe_view.validate_report=validate_probe
    # Preserve base marker path and actual raw extended marker, no fake role.
    parent.GATE_ARGV=GATE_ARGV;parent.HELPER_FILES=dict(HELPERS)
    parent.require_fixed_worker_entry=lambda _:require_fixed_hook(gate)
    original_protocol=parent.make_initialize_protocol
    protocol_parent=types.SimpleNamespace(make_initialize_protocol=original_protocol)
    parent.make_initialize_protocol=lambda p:metadata_protocol(protocol_parent,p,route)
    original_worker=parent.WorkerProtocol
    class Worker(original_worker):
        def receive(self,frame):
            super().receive(frame)
            if self.worker_report is not None:
                # Private convenience view only; stdout/history remain wrapper.
                self.worker_report={**self.worker_report,'marker':self.worker_report['baseReport']['marker']}
    parent.WorkerProtocol=Worker
    original_replay=parent.replay_session
    def replay(value,protocol,p,argv,environment):
        actual_env=dict(environment)
        if list(argv)==list(parent.appserver_argv(p)):
            require(proxy_address is not None,'FIXED_PROXY_ADDRESS_REQUIRED')
            actual_env['HTTPS_PROXY']='http://127.0.0.1:'+str(proxy_address[1])
        return original_replay(value,protocol,p,argv,actual_env)
    parent.replay_session=replay
    return parent,gate_view,probe_view


def run_component(deps,budget,packet):
    global _BLOCKED
    require(not _BLOCKED,'PRIOR_COMBINED_UNKNOWN')
    parent,policy,gate,base,core,provenance,probe=deps
    require_fixed_hook(gate)  # Before socket or Popen.
    session=core.create_refusal_session(min(budget.began+22,time.monotonic()+2))
    # Route exists before metadata protocol; own CLI identity is filled only
    # after original Session retained its actual Popen/pidfd.
    try:route=EndpointLifetime(session,None,{},budget.began+22)
    except BaseException:
        try:
            if session.close() is not True:_BLOCKED=True
        except BaseException:_BLOCKED=True
        raise
    body=None;error=None;close=None;owned_sessions=[];owned_selectors=[];cleanup_errors=[]
    def cleanup_unknown(label):
        global _BLOCKED
        _BLOCKED=True;cleanup_errors.append(label)
    try:
        parent,view,pv=compose(deps,route,session.ownership['address'])
        original_session=parent.Session;original_marker=parent.make_marker;original_observed=parent.trusted_observation
        class Session(original_session):
            def __init__(self,name,argv,environment,protocol,p,selector,b):
                self._closed_parts=set();owned_sessions.append(self)
                if name=='appserver':
                    environment={**environment,'HTTPS_PROXY':'http://127.0.0.1:'+str(session.ownership['address'][1])}
                super().__init__(name,argv,environment,protocol,p,selector,b)
                if name=='appserver' and self.error is None:
                    try:
                        route.identity=own_identity(self.process,self.pin,provenance,route.deadline)
                        route.process=self.process;route.pin=self.pin
                        route.observer=provenance.create_observer(self.process,self.pin,route.identity['startTicks'],route.identity['networkNamespace'],route.deadline)
                        route.start()
                    except BaseException as failure:self.error='PROXY_SETUP:'+type(failure).__name__
            def begin_cleanup(self,p,selector,b):
                if self.cleanup is not None:return
                try:selector.unregister(self.process.stdin)
                except KeyError:pass
                except BaseException as failure:cleanup_unknown('STDIN_UNREGISTER:'+type(failure).__name__)
                known=True
                if 'stdin' not in self._closed_parts:
                    self._closed_parts.add('stdin')
                    try:self.process.stdin.close()
                    except BaseException as failure:
                        known=False;cleanup_unknown('SESSION_stdin:'+type(failure).__name__)
                now=time.monotonic()
                self.cleanup_history.append({'event':'stdin-eof' if known else 'stdin-eof-unknown','elapsedMs':(now-b.began)*1000})
                self.cleanup=p.Cleanup(now)
            def close(self):
                # Never retry an ambiguous close; do attempt every independent
                # owned stream/pin even if an earlier close raises.
                if 'wait' not in self._closed_parts:
                    self._closed_parts.add('wait')
                    try:
                        if self.process.poll() is None:cleanup_unknown('SESSION_UNREAPED')
                    except BaseException as failure:cleanup_unknown('SESSION_WAIT:'+type(failure).__name__)
                for stream in ('stdin','stdout','stderr'):
                    handle=getattr(getattr(self,'process',None),stream,None)
                    if handle is None or stream in self._closed_parts:continue
                    self._closed_parts.add(stream)
                    try:handle.close()
                    except BaseException as failure:cleanup_unknown('SESSION_'+stream+':'+type(failure).__name__)
                pin=getattr(self,'pin',None)
                if pin is not None and 'pin' not in self._closed_parts:
                    self._closed_parts.add('pin')
                    try:os.close(pin)
                    except BaseException as failure:cleanup_unknown('SESSION_PIN:'+type(failure).__name__)
        parent.Session=Session
        original_selector=parent.selectors.DefaultSelector
        class Selector:
            def __init__(self):
                self.inner=original_selector();self._close_attempted=False;owned_selectors.append(self)
            def __getattr__(self,key):return getattr(self.inner,key)
            def close(self):
                if self._close_attempted:return
                self._close_attempted=True
                try:self.inner.close()
                except BaseException as failure:cleanup_unknown('SELECTOR:'+type(failure).__name__)
            def select(self,timeout=None):
                if route.error:raise ValueError('PROXY_ASYNC_FAILURE:'+route.error)
                if not route.finished.is_set():route.check()
                return self.inner.select(timeout)
        parent.selectors=types.SimpleNamespace(**{**vars(parent.selectors),'DefaultSelector':Selector})
        def marker(outer,pipes,objects,p):
            endpoint=route.marker_endpoint()
            # Original helper validates before returning; give it its original
            # base marker validator, then validate the actual extended value.
            original_base=types.SimpleNamespace(**vars(base));original_base.validate_marker=base._cli_original_marker
            result=original_marker(outer,pipes,objects,original_base)
            result['trustedCliProxyEndpoint']=endpoint
            require(p.validate_marker(result),'FIXED_EXTENDED_MARKER')
            return result
        parent.make_marker=marker
        def observed(process,marker,b):
            current=own_identity(route.process,route.pin,provenance,route.deadline)
            require(same(current,route.identity),'CLI_GENERATION_DRIFT')
            route.generations.append({'identity':current,'monotonic':time.monotonic()})
            result=original_observed(process,marker,b)
            if route.worker_before is None:route.before_worker(result)
            else:
                route.after_worker(result)
                while not route.finished.is_set():
                    route.check();route.finished.wait(min(.01,max(0,route.deadline-time.monotonic())))
                require(route.error is None and route.proxy_report is not None,'REFUSAL_FAILED')
                # Use the post-wait real observation time, never stale success.
                result=original_observed(process,marker,b)
            return result
        parent.trusted_observation=observed
        body=parent.run_parent(policy,view,pv,budget,packet)
        error=body['error'] or route.error
    except BaseException as failure:
        error=type(failure).__name__+':'+str(failure)[:120]
        cleanup_unknown('PARENT_EXCEPTION:'+type(failure).__name__)
    finally:
        # Also covers a report()/parent-finally exception before its close loop.
        for item in owned_selectors:item.close()
        for item in owned_sessions:item.close()
        if cleanup_errors:error=error or 'PARENT_HANDLES_UNKNOWN:'+','.join(cleanup_errors)[:160]
        close=route.close()
        if not close['ownedHandlesKnown']:_BLOCKED=True
    return {'version':1,'profile':'fixed-trusted-cli-worker-child','success':False,'error':error,
        'parentReport':body,'proxyReport':route.proxy_report,'cliIdentity':route.identity,
        'endpointBeforeWorker':route.worker_before,'endpointAfterWorker':route.worker_after,'cleanup':close,
        'generationObservations':route.generations,'beganMonotonic':budget.began}


def validate_report(report,raw,expected_worker_boundary):
    try:
        require(type(report) is dict and set(report)=={'version','profile','success','error','parentReport','proxyReport','cliIdentity',
            'endpointBeforeWorker','endpointAfterWorker','cleanup','helperSha256Before','helperSha256After','elapsedMs','generationObservations','beganMonotonic'},'REPORT_KEYS')
        require(type(report['version']) is int and report['version']==1 and report['profile']=='fixed-trusted-cli-worker-child'
            and report['success'] is True and report['error'] is None,'REPORT_OUTCOME')
        hashes={k:hashlib.sha256(v).hexdigest() for k,v in raw.items()}
        require(set(hashes)==set(HELPERS) and same(report['helperSha256Before'],hashes) and same(report['helperSha256After'],hashes),'SOURCE_BINDING')
        require(type(report['elapsedMs']) in (int,float) and math.isfinite(report['elapsedMs']) and 0<=report['elapsedMs']<30000,'TOTAL_DEADLINE')
        require(same(report['cleanup'],{'threadJoined':True,'ownedHandlesKnown':True,'originalCliPinOwnedHere':False}),'ROUTE_CLEANUP')
        deps=dependencies(raw);parent,policy,gate,base,core,provenance,probe=deps
        proxy=report['proxyReport'];identity=report['cliIdentity'];body=report['parentReport']
        require(type(proxy) is dict and set(proxy)=={'version','profile','reason','stage','ownership','accepted','provenanceObservations','requestBytes','requestSha256','requestRawBase64','requestRawComplete','refusalBytesWritten','elapsedMs','cleanupKnown','success','cliProvenanceValidated','productionReady','upstreamConnections','tlsStarted','modelCalls','credentialFilesRead'} and type(proxy['version']) is int and proxy['version']==1,'PROXY_KEYS')
        require(provenance.valid_observation(proxy['accepted']),'ACCEPTED_SHAPE')
        require(type(proxy['ownership']) is dict and set(proxy['ownership'])=={'address','listener'} and same(proxy['ownership']['address'],proxy['accepted']['local'])
            and base.valid_tuple(proxy['ownership']['listener'],stat.S_IFSOCK) and not same(proxy['ownership']['listener'],proxy['accepted']['socket']),'LISTENER_IDENTITY')
        parent,view,pv=compose(deps,None,proxy['ownership']['address'])
        require(parent.validate_report(body,policy,view,pv,expected_worker_boundary),'FULL_PARENT_REPLAY')
        require(body['elapsedMs']<=report['elapsedMs'] and identity['pid']==body['sessions']['appserver']['pid'],'SAME_CLI')
        require(same(report['endpointBeforeWorker'],body['beforeWorker']),'BEFORE_WORKER_BINDING')
        after=report['endpointAfterWorker']
        require(type(after) is dict and set(after)==set(body['afterWorker']) and same(
            {k:v for k,v in after.items() if k!='elapsedMs'},
            {k:v for k,v in body['afterWorker'].items() if k!='elapsedMs'}),'AFTER_OBJECT_BINDING')
        require(after['pid']==identity['pid'] and after['alive'] is True and body['beforeWorker']['elapsedMs']<=after['elapsedMs']<=body['afterWorker']['elapsedMs'],'AFTER_WORKER_BINDING')
        require(proxy['profile']=='stock-noauth-connect-local-refusal' and proxy['reason']=='LOCAL_PROXY_REFUSAL'
            and proxy['stage']=='local-refusal' and proxy['success'] is True and proxy['cleanupKnown'] is True,'REAL_REFUSAL')
        require(proxy['requestRawComplete'] is True and proxy['requestRawBase64']==base64.b64encode(core.REQUEST).decode()
            and type(proxy['requestBytes']) is int and proxy['requestBytes']==len(core.REQUEST)
            and proxy['requestSha256']==hashlib.sha256(core.REQUEST).hexdigest()
            and type(proxy['refusalBytesWritten']) is int and proxy['refusalBytesWritten']==len(core.REFUSAL),'ACTUAL_FIXED_BYTES')
        require(type(proxy['elapsedMs']) in (int,float) and math.isfinite(proxy['elapsedMs']) and 0<=proxy['elapsedMs']<2000,'CORE_DEADLINE')
        for key in ('upstreamConnections','modelCalls','credentialFilesRead'):require(type(proxy[key]) is int and proxy[key]==0,'NO_EXTERNAL')
        for key in ('tlsStarted','productionReady','cliProvenanceValidated'):require(proxy[key] is False,'NO_AUTH_CREDIT')
        records=proxy['provenanceObservations']
        require(type(records) is list and all(type(x) is dict and set(x)=={'phase','record'} for x in records),'PROVENANCE_WRAPPER')
        require(type(records) is list and len(records)==2 and [x['phase'] for x in records]==list(provenance.PHASES),'TWO_PHASES')
        require(provenance.validate_records([x['record'] for x in records],identity,proxy['accepted']),'REAL_PROVENANCE')
        generations=report['generationObservations'];began=report['beganMonotonic']
        require(type(began) in (int,float) and math.isfinite(began) and began>=0 and type(generations) is list and len(generations)==2,'GENERATION_SAMPLES')
        for value in generations:require(type(value) is dict and set(value)=={'identity','monotonic'} and same(value['identity'],identity)
            and type(value['monotonic']) in (int,float) and math.isfinite(value['monotonic']),'GENERATION_BINDING')
        timeline=[records[0]['record']['capturedMonotonic'],generations[0]['monotonic'],began+body['beforeWorker']['elapsedMs']/1000,
            generations[1]['monotonic'],began+after['elapsedMs']/1000,records[1]['record']['capturedMonotonic'],began+body['afterWorker']['elapsedMs']/1000]
        require(timeline==sorted(timeline),'ACTUAL_ENDPOINT_WORKER_OVERLAP')
        endpoint=body['marker']['value']['trustedCliProxyEndpoint']
        require(same(endpoint,{'address':proxy['accepted']['local'],'socket':proxy['accepted']['socket'],
            'networkNamespace':identity['networkNamespace'],'listenerClosed':True}),'MARKER_ENDPOINT')
        return True
    except (ValueError,TypeError,KeyError,AttributeError,IndexError,OverflowError,RecursionError):return False


def main():
    global _BLOCKED
    require(sys.platform=='linux' and sys.argv[1:]==[],'FIXED_LINUX_CHILD')
    began=time.monotonic();raw,before=capture_sources();deps=dependencies(raw)
    parent,policy,gate,base,_,_,_=deps;require_fixed_hook(gate)
    budget=parent.Budget();budget.began=began
    packet=parent.read_startup_packet(budget,base)
    report=run_component(deps,budget,packet)
    try:_,after=capture_sources()
    except BaseException as failure:
        after={};report['error']=report['error'] or 'FINAL_SOURCES:'+type(failure).__name__
    report.update(helperSha256Before=before,helperSha256After=after,
        elapsedMs=(time.monotonic()-began)*1000)
    if report['parentReport'] is not None:
        report['parentReport'].update(helperSha256Before=before,helperSha256After=after,success=report['parentReport']['error'] is None)
    report['success']=report['error'] is None and before==after
    # Parent packet independently binds supervisor-owned identity; driver must
    # compare it to actual ready, not reuse this locally derived value as proof.
    packet_value=packet['value'];expected={'namespace':packet_value['namespaces']['trustedPid'],
        'mountNamespace':packet_value['namespaces']['trustedMount'],
        'control':packet_value['protectedDescriptors']['outerSupervisorControl'],
        'output':packet_value['protectedDescriptors']['outerSupervisorOutput']}
    valid=validate_report(report,raw,expected)
    report['elapsedMs']=(time.monotonic()-began)*1000
    report['success']=valid and report['elapsedMs']<30000 and not _BLOCKED
    output=(json.dumps(report,separators=(',',':'),allow_nan=False)+'\n').encode()
    require(len(output)<=2*1024*1024,'FINAL_REPORT_BOUND')
    os.set_blocking(1,False);offset=0;cutoff=min(began+30,time.monotonic()+2)
    while offset<len(output):
        require(time.monotonic()<cutoff,'FINAL_OUTPUT_DEADLINE')
        try:
            count=os.write(1,output[offset:offset+65536]);require(count>0,'FINAL_OUTPUT_WRITE');offset+=count
        except BlockingIOError:time.sleep(.001)
    return 0 if report['success'] else 1


if __name__=='__main__':raise SystemExit(main())
