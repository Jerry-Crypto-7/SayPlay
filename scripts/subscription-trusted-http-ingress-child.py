"""Fixed HTTP capsule child: live listener before separate worker, then authored traffic."""
import errno
import hashlib
import json
import math
import os
from pathlib import Path
import re
import select
import socket
import stat
import sys
import threading
import time
import types

FD=198
MARKER_PATH='/work/trusted-http-ingress-boundary.json'
GATE_ARGV=('/usr/bin/python3','-I','-S','/usr/bin/exec-server-worker-gate.py','--trusted-http-ingress-boundary')
HELPERS={
 'subscription-exec-server-worker-gate.py':'/usr/bin/exec-server-worker-gate.py',
 'subscription-exec-server-worker-trampoline.py':'/usr/bin/exec-server-worker-trampoline.py',
 'subscription-exec-worker-probe.py':'/usr/bin/exec-worker-probe.py',
 'subscription-trusted-control-boundary-probe.py':'/usr/bin/trusted-control-boundary-probe.py',
 'subscription-worker-lockdown.py':'/usr/bin/worker-lockdown.py',
 'subscription-appserver-noenv.py':'/usr/bin/appserver-noenv.py',
 'subscription-text-model-catalog.json':'/usr/bin/text-model-catalog.json',
 'subscription-trusted-control-boundary-parent.py':'/usr/bin/trusted-control-boundary-parent.py',
 'subscription-trusted-ingress-child.py':'/usr/bin/trusted-ingress-child.py',
 'subscription-trusted-ingress-worker-probe.py':'/usr/bin/trusted-ingress-worker-probe.py',
 'subscription-trusted-http-ingress.py':'/usr/bin/trusted-http-ingress.py',
 'subscription-trusted-http-capsule-factory.py':'/usr/bin/trusted-http-capsule-factory.py',
 'subscription-trusted-http-worker-probe.py':'/usr/bin/trusted-http-worker-probe.py',
 'subscription-trusted-http-ingress-child.py':'/usr/bin/trusted-http-ingress-child.py'}
CATALOG_SHA256='59d22b4ae6532d4f869d776e56faaf2ae169f36038375597f4f1e581459b8791'


def fixed_bytes(name):
    path=HELPERS[name]; fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_CLOEXEC)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=1024*1024 or not os.fstatvfs(fd).f_flag & os.ST_RDONLY:
            raise ValueError('READONLY_HELPER_REQUIRED')
        raw=os.read(fd,1024*1024+1); after=os.fstat(fd)
        if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_mtime_ns): raise ValueError('HELPER_CHANGED')
        return raw
    finally: os.close(fd)


def load_fixed(name):
    module=types.ModuleType('private_http_'+name.replace('-','_')); module.__file__=HELPERS[name]
    exec(compile(fixed_bytes(name),HELPERS[name],'exec'),module.__dict__); return module


def hashes():
    result={name:hashlib.sha256(fixed_bytes(name)).hexdigest() for name in HELPERS}
    if result['subscription-text-model-catalog.json']!=CATALOG_SHA256: raise ValueError('CATALOG_HASH')
    return result


def same(a,b): return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)
def finite(value): return type(value) in (int,float) and math.isfinite(value) and value>=0

def valid_ingress(value):
    if type(value) is not dict or set(value)!={'fd','nonce','socket'} or type(value['fd']) is not int or value['fd']!=FD or type(value['nonce']) is not str or not re.fullmatch('[a-f0-9]{32}',value['nonce']): return False
    info=value['socket']
    return (type(info) is dict and set(info)=={'dev','ino','type','family','socketType'} and all(type(v) is int and 0<=v<=9007199254740991 for v in info.values())
        and info['ino']>0 and info['type']==49152 and info['family']==1 and info['socketType']==1)


def close_original(expected):
    """Close only still-bound original198, never a subsequently reused number."""
    value=os.fstat(FD)
    if {'dev':value.st_dev,'ino':value.st_ino,'type':stat.S_IFMT(value.st_mode)}!={key:expected[key] for key in ('dev','ino','type')} or os.get_inheritable(FD):
        raise ValueError('ORIGINAL_INGRESS_CHANGED')
    os.close(FD)
    try: os.fstat(FD)
    except OSError as error:
        if error.errno==errno.EBADF: return True
        raise
    raise ValueError('ORIGINAL_FD_CLOSE_UNCERTAIN')


def steps(nonce,core):
    return [('CONNECT','sent',core.PINNED_WSS_REQUEST),('CONNECT','received',core.RESPONSE),
        ('BEFORE','sent',('BEFORE '+nonce+'\n').encode()),('BEFORE','received',('ACK BEFORE '+nonce+'\n').encode()),
        ('AFTER','sent',('AFTER '+nonce+'\n').encode()),('AFTER','received',('ACK AFTER '+nonce+'\n').encode()),('EOF','received',b'')]


def step_record(phase,direction,raw):
    return {'phase':phase,'direction':direction,'bytes':len(raw),'sha256':hashlib.sha256(raw).hexdigest(),'rawHex':raw.hex()}


class HttpRoute:
    def __init__(self,factory,core,ingress,budget):
        self.factory,self.core,self.ingress,self.budget=factory,core,ingress,budget
        self.session=self.client=self.control=self.thread=None
        self.adapter=None; self.error=None; self.original_closed=False; self.closed=False
        self.observations=[]; self.exchange=[]; self.peer_cleanup=None; self.thread_joined=False
        self.completed=None; self.listener_metadata=None; self.session_cleanup=None

    def prepare(self):
        deadline=min(self.budget.began+22,self.budget.began+30)
        self.session,self.client,self.control=self.factory.create_fixed_session(self.ingress['socket'],deadline)
        self.original_closed=close_original(self.ingress['socket'])
        owner=self.session.ownership
        self.listener_metadata={key:owner[key] for key in ('address','networkNamespace','listener','client','control')}
        return self.listener_metadata

    def check_live(self,phase):
        if self.session is None or not self.original_closed or self.thread is not None: raise ValueError('LISTENER_BEFORE_ACCEPT_REQUIRED')
        owner=self.session.ownership
        actual={'address':list(self.session.listener.getsockname()),'networkNamespace':os.readlink('/proc/self/ns/net'),
                'listener':self.core.identity(self.session.listener),'client':self.core.identity(self.client),'control':self.core.identity(self.session.control)}
        if (not same(actual,self.listener_metadata) or self.session.listener.getsockopt(socket.SOL_SOCKET,socket.SO_ACCEPTCONN)!=1
            or self.client.getpeername()!=tuple(owner['address']) or self.client.getsockname()!=tuple(owner['expectedClient'])): raise ValueError('LIVE_LISTENER_CHANGED')
        if any(os.get_inheritable(e.fileno()) for e in (self.session.listener,self.client,self.session.control,self.session.ingress)): raise ValueError('HTTP_FD_INHERITABLE')
        elapsed=(time.monotonic()-self.budget.began)*1000
        if elapsed>=22000 or time.monotonic()-self.session.began>=self.session.ownership['effectiveNegotiationSeconds']: raise ValueError('HTTP_PREACCEPT_DEADLINE')
        observation={'phase':phase,'listener':actual,'listening':True,'clientConnected':True,'originalFdClosed':True,'elapsedMs':elapsed}
        self.observations.append(observation)

    def remaining(self):
        value=min(self.budget.began+22,self.session.began+self.session.ownership['effectiveSessionSeconds'])-time.monotonic()
        if value<=0: raise ValueError('HTTP_ROUTE_DEADLINE')
        return value

    def transfer(self):
        if len(self.observations)!=2 or self.thread is not None: raise ValueError('HTTP_OBSERVATION_ORDER')
        def run():
            try: self.adapter=self.session.run()
            except BaseException as error: self.error='ADAPTER:'+type(error).__name__
        self.thread=threading.Thread(target=run,daemon=True)
        self.thread.start()
        for phase,direction,raw in steps(self.ingress['nonce'],self.core):
            offset=0
            if phase=='EOF': self.client.shutdown(socket.SHUT_WR)
            while True:
                timeout=self.remaining()
                ready=select.select([self.client] if direction=='received' else [],[self.client] if direction=='sent' else [],[],timeout)
                self.remaining()
                if not ready[0] and not ready[1]: raise ValueError('HTTP_ROUTE_DEADLINE')
                try:
                    if direction=='sent':
                        count=self.client.send(raw[offset:])
                        if count<=0: raise ValueError('HTTP_WRITE_ZERO')
                        offset+=count
                    else:
                        value=self.client.recv(max(1,len(raw)-offset))
                        if phase=='EOF':
                            if value: raise ValueError('HTTP_EXTRA_RESPONSE')
                            break
                        if not value or value!=raw[offset:offset+len(value)]: raise ValueError('HTTP_RESPONSE_MISMATCH')
                        offset+=len(value)
                except BlockingIOError: continue
                self.remaining()
                if offset==len(raw): break
            self.exchange.append(step_record(phase,direction,raw))
        self.thread.join(self.remaining())
        if self.thread.is_alive(): raise ValueError('HTTP_THREAD_UNKNOWN')
        self.thread_joined=True
        if self.error or not self.adapter or self.adapter.get('success') is not True: raise ValueError('HTTP_ADAPTER_FAILED')
        self.completed=(time.monotonic()-self.budget.began)*1000

    def close(self):
        if self.closed: return
        self.closed=True
        if self.thread is not None and self.thread.is_alive():
            try: self.control.send(b'C')
            except OSError: pass
            self.thread.join(max(0,min(self.budget.began+30,time.monotonic()+.3)-time.monotonic()))
        self.thread_joined=self.thread is None or not self.thread.is_alive()
        if self.session is not None and self.thread_joined:
            try:
                self.session_cleanup=self.session.close()
                if self.session_cleanup.get('known') is not True: self.error=self.error or 'SESSION_CLOSE_UNKNOWN'
            except Exception: self.error=self.error or 'SESSION_CLOSE_UNKNOWN'
        outcomes=[]
        for endpoint in (self.client,self.control):
            if endpoint is not None:
                try: endpoint.close(); outcomes.append(endpoint.fileno()==-1)
                except Exception: outcomes.append(False)
        self.peer_cleanup=all(outcomes)
        if not self.thread_joined or not self.peer_cleanup: self.error=self.error or 'HTTP_CLEANUP_UNKNOWN'

    def report(self):
        return {'observations':self.observations,'steps':self.exchange,'adapter':self.adapter,'originalFdClosed':self.original_closed,
            'threadJoined':self.thread_joined,'peerCleanupKnown':self.peer_cleanup,'sessionCleanup':self.session_cleanup,'error':self.error,'completedMs':self.completed}


def adapt(parent,gate,policy,probe,base_loader,ingress,route=None):
    old_packet=parent.validate_outer_packet
    def packet(value):
        return type(value) is dict and set(value)=={'version','sourceOfOuter','namespaces','protectedDescriptors','ingress'} and old_packet({k:v for k,v in value.items() if k!='ingress'}) and valid_ingress(value['ingress']) and same(value['ingress'],ingress)
    parent.validate_outer_packet=packet
    def matches(value,expected):
        wanted={'version':1,'sourceOfOuter':'supervisor-fixed-startup-pipe','namespaces':{'trustedPid':expected.get('namespace'),'trustedMount':expected.get('mountNamespace')},
            'protectedDescriptors':{'outerSupervisorControl':expected.get('control'),'outerSupervisorOutput':expected.get('output')}}
        return packet(value) and old_packet(wanted) and same(wanted,{k:v for k,v in value.items() if k!='ingress'})
    parent.packet_matches_ready=matches; parent.HELPER_FILES=dict(HELPERS)
    parent.MARKER_PATH=MARKER_PATH; parent.MARKER_PENDING=MARKER_PATH+'.pending'; parent.GATE_ARGV=GATE_ARGV
    proxy=types.SimpleNamespace(MAX_MARKER_BYTES=4096,strict_json=policy.strict_json,
        validate_marker=lambda marker: probe.validate_marker_with(base_loader(),marker) and same(marker['trustedIngressSocket'],{key:ingress['socket'][key] for key in ('dev','ino','type')}),
        validate_report=lambda report,marker: probe.validate_report_with(base_loader(),report,marker) and report['workerNetworkBefore']!=marker['trustedHttpIngress']['networkNamespace'])
    def marker(outer,pipes,objects,_):
        value={'version':1,'namespaces':outer['namespaces'],'protectedDescriptors':{**outer['protectedDescriptors'],**pipes},
            'authoredProtectedObjects':objects,'trustedIngressSocket':{key:ingress['socket'][key] for key in ('dev','ino','type')},'trustedHttpIngress':route.prepare()}
        if not proxy.validate_marker(value): raise ValueError('HTTP_MARKER_INVALID')
        return value
    parent.make_marker=marker
    view=types.SimpleNamespace(integer=gate.integer,initialize_request=gate.initialize_request,read_request=gate.read_request,control_start_request=gate.http_ingress_start_request)
    def entry(actual):
        if not same(actual.control_start_request(),gate.http_ingress_start_request()): raise ValueError('HTTP_FIXED_START_REQUIRED')
        return GATE_ARGV
    parent.require_fixed_worker_entry=entry
    original=parent.WorkerProtocol
    class WorkerProtocol(original):
        def receive(self,frame):
            super().receive(frame)
            if self.worker_report is not None:
                # Only parent internal marker lookup view changes. Raw output/history
                # and the report given to the probe validator remain original bytes.
                self.worker_report={**self.worker_report,'marker':self.worker_report['baseReport']['marker']}
    parent.WorkerProtocol=WorkerProtocol
    if route is not None:
        observe=parent.trusted_observation
        def observed(process,marker,budget):
            result=observe(process,marker,budget)
            route.check_live('BEFORE_WORKER' if not route.observations else 'AFTER_WORKER')
            if len(route.observations)==2:
                route.transfer()
                result=observe(process,marker,budget)
            if process.poll() is not None or time.monotonic()-budget.began>=22: raise ValueError('HTTP_TRUSTED_APP_LIFETIME')
            return result
        parent.trusted_observation=observed
    return view,proxy


def validate_route(value,marker,ingress,core,parent_body):
    try:
        if type(value) is not dict or set(value)!={'observations','steps','adapter','originalFdClosed','threadJoined','peerCleanupKnown','sessionCleanup','error','completedMs'}: return False
        if any(value[key] is not True for key in ('originalFdClosed','threadJoined','peerCleanupKnown')) or value['error'] is not None or not finite(value['completedMs']): return False
        if not same(value['steps'],[step_record(*step) for step in steps(ingress['nonce'],core)]): return False
        observed=value['observations']
        if type(observed) is not list or len(observed)!=2: return False
        previous=parent_body['beforeWorker']['elapsedMs']
        for phase,item in zip(('BEFORE_WORKER','AFTER_WORKER'),observed):
            if (type(item) is not dict or set(item)!={'phase','listener','listening','clientConnected','originalFdClosed','elapsedMs'}
                or item['phase']!=phase or any(item[key] is not True for key in ('listening','clientConnected','originalFdClosed'))
                or not same(item['listener'],marker['trustedHttpIngress']) or not finite(item['elapsedMs']) or not previous<=item['elapsedMs']<22000): return False
            previous=item['elapsedMs']
        if not previous<=value['completedMs']<=parent_body['afterWorker']['elapsedMs']<22000: return False
        adapter=value['adapter']
        if type(adapter) is not dict or set(adapter)!={'profile','normalizedHeaderBytes','productionReady','modelCalls','credentialFilesRead','ownership','reason','state','observedBytes','deliveredBytes','retainedBytes','handshakeRetainedBytes','elapsedMs','cleanup','success'} or adapter.get('success') is not True or adapter.get('reason')!='EOF' or adapter.get('state')!='RELAY': return False
        if adapter.get('profile')!='pinned-wss-shaped-fixture' or type(adapter.get('normalizedHeaderBytes')) is not int or adapter['normalizedHeaderBytes']!=30: return False
        if (not same(adapter.get('observedBytes'),{'client':176,'ingress':126}) or not same(adapter.get('deliveredBytes'),{'client':126,'ingress':146})
            or not same(adapter.get('retainedBytes'),{'client':0,'ingress':0}) or not same(adapter.get('handshakeRetainedBytes'),{'request':0,'response':0})): return False
        cleanup=adapter.get('cleanup')
        if type(cleanup) is not dict or set(cleanup)!={'closed','known','processCleanup'} or cleanup['known'] is not True or cleanup['processCleanup']!='NOT_ATTESTED' or cleanup['closed']!=[True]*5 or any(type(x) is not bool for x in cleanup['closed']): return False
        if not same(value['sessionCleanup'],cleanup): return False
        owner=adapter.get('ownership')
        if type(owner) is not dict or set(owner)!={'address','expectedClient','listener','ingress','client','control','networkNamespace','borrowedOriginalFd','callerRetainsOriginal','ownedIngressFd','coreSha256','effectiveNegotiationSeconds','effectiveSessionSeconds','accepted'} or not same({key:owner.get(key) for key in ('address','networkNamespace','listener','client','control')},marker['trustedHttpIngress']): return False
        if (type(owner['borrowedOriginalFd']) is not int or owner['borrowedOriginalFd']!=198 or owner['callerRetainsOriginal'] is not True or type(owner['ownedIngressFd']) is not int or owner['ownedIngressFd']<3 or owner['ownedIngressFd']==198
            or type(owner['expectedClient']) is not list or len(owner['expectedClient'])!=2 or owner['expectedClient'][0]!='127.0.0.1' or type(owner['expectedClient'][1]) is not int or not 1<=owner['expectedClient'][1]<=65535
            or type(owner['accepted']) is not dict or set(owner['accepted'])!={'dev','ino','type'} or any(type(v) is not int for v in owner['accepted'].values()) or owner['accepted']['dev']<0 or owner['accepted']['ino']<=0 or owner['accepted']['type']!=49152): return False
        accepted=tuple(owner['accepted'][key] for key in ('dev','ino','type'))
        protected=[owner[key] for key in ('listener','ingress','client','control')]+list(marker.get('protectedDescriptors',{}).values())
        if accepted in {tuple(item[key] for key in ('dev','ino','type')) for item in protected} or same(owner['expectedClient'],owner['address']): return False
        if not same(owner.get('ingress'),{key:ingress['socket'][key] for key in ('dev','ino','type')}) or owner.get('coreSha256')!='9abe08ec337b4de4e2f3b217023a7dc3c19d87ea890633cacc63df16dfd0fd84': return False
        if (not finite(owner.get('effectiveSessionSeconds')) or not 0<owner['effectiveSessionSeconds']<=5 or not finite(owner.get('effectiveNegotiationSeconds'))
            or not 0<owner['effectiveNegotiationSeconds']<=min(2,owner['effectiveSessionSeconds']) or not finite(adapter.get('elapsedMs'))
            or adapter['elapsedMs']>=owner['effectiveSessionSeconds']*1000): return False
        return adapter.get('productionReady') is False and type(adapter.get('modelCalls')) is int and adapter['modelCalls']==0 and type(adapter.get('credentialFilesRead')) is int and adapter['credentialFilesRead']==0
    except (ValueError,KeyError,TypeError,AttributeError): return False


def validate_report(report,deps,expected_worker_boundary,expected_ingress):
    try:
        if (type(report) is not dict or set(report)!={'version','profile','success','error','parentReport','httpRoute','helperSha256Before','helperSha256After'}
            or type(report['version']) is not int or report['version']!=1 or report['profile']!='fixed-trusted-http-ingress-child'
            or report['success'] is not True or report['error'] is not None or not valid_ingress(expected_ingress)): return False
        before=report['helperSha256Before']
        if (type(before) is not dict or set(before)!=set(HELPERS) or any(type(v) is not str or re.fullmatch('[a-f0-9]{64}',v) is None for v in before.values())
            or not same(before,report['helperSha256After']) or before['subscription-text-model-catalog.json']!=CATALOG_SHA256): return False
        parent,gate,policy,probe,base_loader=deps
        view,proxy=adapt(parent,gate,policy,probe,base_loader,expected_ingress)
        body=report['parentReport']
        if not same(body['helperSha256Before'],before) or not same(body['helperSha256After'],before) or not parent.validate_report(body,policy,view,proxy,expected_worker_boundary): return False
        # Constants only, no runtime import required during offline validation.
        core=types.SimpleNamespace(PINNED_WSS_REQUEST=b'CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nProxy-Connection: Keep-Alive\r\n\r\n',RESPONSE=b'HTTP/1.1 200 Connection Established\r\n\r\n')
        return validate_route(report['httpRoute'],body['marker']['value'],expected_ingress,core,body)
    except (ValueError,TypeError,KeyError,AttributeError,RecursionError): return False


def main():
    if sys.platform!='linux' or sys.argv[1:]: raise ValueError('FIXED_HTTP_CHILD_REQUIRED')
    began=time.monotonic(); os.set_inheritable(FD,False)
    route=None; ingress=None; report=None
    try:
        before=hashes(); parent=load_fixed('subscription-trusted-control-boundary-parent.py'); policy=load_fixed('subscription-appserver-noenv.py')
        gate=load_fixed('subscription-exec-server-worker-gate.py'); probe=load_fixed('subscription-trusted-http-worker-probe.py')
        factory=load_fixed('subscription-trusted-http-capsule-factory.py'); core=load_fixed('subscription-trusted-http-ingress.py')
        base_loader=lambda:load_fixed('subscription-trusted-control-boundary-probe.py')
        budget=parent.Budget(); budget.began=began
        old_packet=parent.validate_outer_packet
        parent.validate_outer_packet=lambda value: type(value) is dict and set(value)=={'version','sourceOfOuter','namespaces','protectedDescriptors','ingress'} and old_packet({k:v for k,v in value.items() if k!='ingress'}) and valid_ingress(value['ingress'])
        packet=parent.read_startup_packet(budget,policy); parent.validate_outer_packet=old_packet
        ingress=packet['value']['ingress']; route=HttpRoute(factory,core,ingress,budget)
        view,proxy=adapt(parent,gate,policy,probe,base_loader,ingress,route)
        body=parent.run_parent(policy,view,proxy,budget,packet)
        route.close()
        if not route.original_closed: route.original_closed=close_original(ingress['socket'])
        after=hashes(); body.update(helperSha256Before=before,helperSha256After=after,success=body['error'] is None)
        body['elapsedMs']=(time.monotonic()-began)*1000
        report={'version':1,'profile':'fixed-trusted-http-ingress-child','success':body['error'] is None and route.error is None,
                'error':body['error'] or route.error,'parentReport':body,'httpRoute':route.report(),'helperSha256Before':before,'helperSha256After':after}
        outer=packet['value']; expected={'namespace':outer['namespaces']['trustedPid'],'mountNamespace':outer['namespaces']['trustedMount'],
            'control':outer['protectedDescriptors']['outerSupervisorControl'],'output':outer['protectedDescriptors']['outerSupervisorOutput']}
        deps=(load_fixed('subscription-trusted-control-boundary-parent.py'),gate,policy,probe,base_loader)
        if not validate_report(report,deps,expected,ingress): report.update(success=False,error=report['error'] or 'HTTP_REPORT_INVALID')
        if time.monotonic()-began>=30: report.update(success=False,error=report['error'] or 'HTTP_FINAL_SHARED_DEADLINE')
        raw=json.dumps(report,separators=(',',':'),allow_nan=False)
        if len(raw.encode())>128*1024: raise ValueError('HTTP_REPORT_LIMIT')
        print(raw,flush=True)
        return 0 if report['success'] else 1
    finally:
        if route is not None: route.close()
        if ingress is not None and (route is None or not route.original_closed):
            # Verify original generation before closing; refusal never closes a
            # newly reused foreign FD198. Outer cleanup remains authoritative.
            try: close_original(ingress['socket'])
            except OSError as error:
                if error.errno!=errno.EBADF: raise


if __name__=='__main__': raise SystemExit(main())



