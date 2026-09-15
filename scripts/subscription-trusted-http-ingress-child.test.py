"""Authored offline tests; no listener, worker, capsule or model runtime."""
import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import pytest

spec=importlib.util.spec_from_file_location('http_child',Path(__file__).with_name('subscription-trusted-http-ingress-child.py'))
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
CORE=SimpleNamespace(PINNED_WSS_REQUEST=b'CONNECT fixture.invalid:443 HTTP/1.1\r\nHost: fixture.invalid:443\r\nProxy-Connection: Keep-Alive\r\n\r\n',RESPONSE=b'HTTP/1.1 200 Connection Established\r\n\r\n')

def complete_route():
    ingress={'fd':198,'nonce':'a'*32,'socket':{'dev':1,'ino':5,'type':49152,'family':1,'socketType':1}}
    http={'address':['127.0.0.1',43210],'networkNamespace':'net:[123]',
          'listener':{'dev':1,'ino':6,'type':49152},'client':{'dev':1,'ino':7,'type':49152},'control':{'dev':1,'ino':8,'type':49152}}
    marker={'trustedHttpIngress':http}
    body={'beforeWorker':{'elapsedMs':1000},'afterWorker':{'elapsedMs':1800}}
    owner={**http,'ingress':{'dev':1,'ino':5,'type':49152},'expectedClient':['127.0.0.1',43211],
           'borrowedOriginalFd':198,'callerRetainsOriginal':True,'ownedIngressFd':10,
           'coreSha256':'9abe08ec337b4de4e2f3b217023a7dc3c19d87ea890633cacc63df16dfd0fd84',
           'effectiveNegotiationSeconds':2,'effectiveSessionSeconds':5,'accepted':{'dev':1,'ino':9,'type':49152}}
    adapter={'profile':'pinned-wss-shaped-fixture','normalizedHeaderBytes':30,'productionReady':False,'modelCalls':0,'credentialFilesRead':0,
        'ownership':owner,'reason':'EOF','state':'RELAY','observedBytes':{'client':176,'ingress':126},'deliveredBytes':{'client':126,'ingress':146},
        'retainedBytes':{'client':0,'ingress':0},'handshakeRetainedBytes':{'request':0,'response':0},'elapsedMs':800,
        'cleanup':{'closed':[True]*5,'known':True,'processCleanup':'NOT_ATTESTED'},'success':True}
    route={'observations':[{'phase':phase,'listener':copy.deepcopy(http),'listening':True,'clientConnected':True,'originalFdClosed':True,'elapsedMs':elapsed}
        for phase,elapsed in [('BEFORE_WORKER',1100),('AFTER_WORKER',1500)]],
        'steps':[m.step_record(*step) for step in m.steps(ingress['nonce'],CORE)],'adapter':adapter,'originalFdClosed':True,
        'threadJoined':True,'peerCleanupKnown':True,'sessionCleanup':copy.deepcopy(adapter['cleanup']),'error':None,'completedMs':1700}
    return route,marker,ingress,body


def test_complete_route_requires_live_before_and_after_then_actual_exchange():
    route,marker,ingress,body=complete_route()
    assert m.validate_route(route,marker,ingress,CORE,body)
    assert route['steps'][0]['bytes']==97 and route['adapter']['deliveredBytes']['ingress']==146

@pytest.mark.parametrize('case',['missing-after','not-listening','changed-listener','wrong-order','late','unjoined','peers','original',
    'counter','normalization','raw','missing-eof','false-closed','bool-counter','owner-extra','accepted-missing','wrong-ingress','clocknan'])
def test_route_incomplete_mismatch_or_false_credit_rejected(case):
    route,marker,ingress,body=complete_route()
    if case=='missing-after': route['observations'].pop()
    if case=='not-listening': route['observations'][0]['listening']=False
    if case=='changed-listener': route['observations'][1]['listener']['listener']['ino']=44
    if case=='wrong-order': route['observations'][1]['elapsedMs']=100
    if case=='late': route['completedMs']=22000
    if case=='unjoined': route['threadJoined']=False
    if case=='peers': route['peerCleanupKnown']=False
    if case=='original': route['originalFdClosed']=False
    if case=='counter': route['adapter']['observedBytes']['client']=146
    if case=='normalization': route['adapter']['normalizedHeaderBytes']=0
    if case=='raw': route['steps'][2]['rawHex']='00'
    if case=='missing-eof': route['steps'].pop()
    if case=='false-closed': route['adapter']['cleanup']['closed'][0]=1
    if case=='bool-counter': route['adapter']['modelCalls']=False
    if case=='owner-extra': route['adapter']['ownership']['foreign']=1
    if case=='accepted-missing': del route['adapter']['ownership']['accepted']
    if case=='wrong-ingress': ingress['socket']['ino']=66
    if case=='clocknan': route['adapter']['elapsedMs']=float('nan')
    assert not m.validate_route(route,marker,ingress,CORE,body)

class Endpoint:
    def __init__(self,fd,address=None,peer=None,ino=6): self.fd=fd; self.address=address; self.peer=peer; self.ino=ino; self.closed=False
    def fileno(self): return -1 if self.closed else self.fd
    def getsockname(self): return self.address
    def getpeername(self): return self.peer
    def getsockopt(self,*args): return 1
    def close(self): self.closed=True
    def send(self,value): return len(value)


def fake_route(monkeypatch):
    _,_,ingress,_=complete_route(); clock=[1.0]
    monkeypatch.setattr(m.time,'monotonic',lambda:clock[0]); monkeypatch.setattr(m.os,'readlink',lambda path:'net:[123]')
    monkeypatch.setattr(m.os,'get_inheritable',lambda fd:False)
    core=SimpleNamespace(**CORE.__dict__,identity=lambda e:{'dev':1,'ino':e.ino,'type':49152})
    listener=Endpoint(10,('127.0.0.1',43210)); client=Endpoint(11,('127.0.0.1',43211),('127.0.0.1',43210),7)
    control=Endpoint(12,ino=8); ingress_socket=Endpoint(13,ino=5)
    owner={'address':['127.0.0.1',43210],'expectedClient':['127.0.0.1',43211],'networkNamespace':'net:[123]',
           'listener':core.identity(listener),'client':core.identity(client),'control':core.identity(control),'effectiveNegotiationSeconds':2,'effectiveSessionSeconds':5}
    session=SimpleNamespace(listener=listener,control=control,ingress=ingress_socket,ownership=owner,began=1,close=lambda:{'known':True})
    factory=SimpleNamespace(create_fixed_session=lambda expected,deadline:(session,client,Endpoint(14)))
    route=m.HttpRoute(factory,core,ingress,SimpleNamespace(began=0))
    monkeypatch.setattr(m,'close_original',lambda expected:True)
    return route,clock


def test_prepare_closes_original_before_observation_and_never_accepts(monkeypatch):
    route,clock=fake_route(monkeypatch); metadata=route.prepare(); route.check_live('BEFORE_WORKER')
    assert metadata==route.observations[0]['listener']; assert route.thread is None and route.original_closed
    route.close(); assert route.thread_joined and route.peer_cleanup

@pytest.mark.parametrize('case',['notclosed','thread','changed','late'])
def test_preaccept_live_gate_refuses(monkeypatch,case):
    route,clock=fake_route(monkeypatch); route.prepare()
    if case=='notclosed': route.original_closed=False
    if case=='thread': route.thread=object()
    if case=='changed': route.session.listener.ino=90
    if case=='late': clock[0]=3
    with pytest.raises(ValueError): route.check_live('BEFORE_WORKER')


def test_original_fd_identity_mismatch_never_closed(monkeypatch):
    _,_,ingress,_=complete_route(); closed=[]
    monkeypatch.setattr(m.os,'fstat',lambda fd:SimpleNamespace(st_dev=1,st_ino=999,st_mode=49152))
    monkeypatch.setattr(m.os,'close',closed.append); monkeypatch.setattr(m.os,'get_inheritable',lambda fd:False)
    with pytest.raises(ValueError,match='ORIGINAL_INGRESS_CHANGED'): m.close_original(ingress['socket'])
    assert not closed


def test_thread_start_failure_can_close_prepared_session(monkeypatch):
    route,clock=fake_route(monkeypatch); route.prepare(); route.check_live('BEFORE_WORKER'); route.check_live('AFTER_WORKER')
    thread=SimpleNamespace(start=lambda: (_ for _ in ()).throw(RuntimeError('mock')),is_alive=lambda:False)
    monkeypatch.setattr(m.threading,'Thread',lambda **kwargs:thread)
    with pytest.raises(RuntimeError): route.transfer()
    route.close(); assert route.thread_joined and route.peer_cleanup


def test_unjoined_thread_never_claims_cleanup(monkeypatch):
    route,clock=fake_route(monkeypatch); route.prepare()
    route.thread=SimpleNamespace(is_alive=lambda:True,join=lambda timeout:None)
    route.close(); assert not route.thread_joined and route.error=='HTTP_CLEANUP_UNKNOWN'


def test_fourteen_helpers_and_fixed_new_paths():
    assert len(m.HELPERS)==14 and m.MARKER_PATH=='/work/trusted-http-ingress-boundary.json'
    assert m.GATE_ARGV[-1]=='--trusted-http-ingress-boundary'


def test_fixed_exchange_happens_only_after_both_observations(monkeypatch):
    route,clock=fake_route(monkeypatch); route.prepare()
    with pytest.raises(ValueError,match='HTTP_OBSERVATION_ORDER'): route.transfer()
    route.check_live('BEFORE_WORKER'); route.check_live('AFTER_WORKER')
    incoming=bytearray(CORE.RESPONSE+('ACK BEFORE '+'a'*32+'\nACK AFTER '+'a'*32+'\n').encode())
    sent=bytearray(); route.client.send=lambda raw:sent.extend(raw) or len(raw)
    def receive(count):
        raw=bytes(incoming[:count]); del incoming[:count]; return raw
    route.client.recv=receive; route.client.shutdown=lambda how:None
    adapter=complete_route()[0]['adapter']; route.session.run=lambda:adapter
    class Thread:
        def __init__(self,target,daemon): self.target=target
        def start(self): self.target()
        def join(self,timeout): pass
        def is_alive(self): return False
    monkeypatch.setattr(m.threading,'Thread',Thread)
    monkeypatch.setattr(m.select,'select',lambda reads,writes,errors,timeout:(reads,writes,[]))
    route.transfer()
    assert bytes(sent)==CORE.PINNED_WSS_REQUEST+('BEFORE '+'a'*32+'\nAFTER '+'a'*32+'\n').encode()
    assert len(route.exchange)==7 and route.thread_joined


def test_session_close_unknown_is_not_hidden_by_closed_peers(monkeypatch):
    route,clock=fake_route(monkeypatch); route.prepare(); route.session.close=lambda:{'known':False}
    route.close(); assert route.error=='SESSION_CLOSE_UNKNOWN' and route.report()['sessionCleanup']=={'known':False}


def load(name):
    path=Path(__file__).with_name(name+'.py'); spec=importlib.util.spec_from_file_location(name,path)
    value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


def dependencies():
    return (load('subscription-trusted-control-boundary-parent'),load('subscription-exec-server-worker-gate'),
        load('subscription-appserver-noenv'),load('subscription-trusted-http-worker-probe'),lambda:load('subscription-trusted-control-boundary-probe'))


def ingress():
    return {'fd':198,'nonce':'a'*32,'socket':{'dev':30,'ino':500,'type':49152,'family':1,'socketType':1}}


def ready(): return load('subscription-trusted-control-boundary-parent.test').ready()


def complete_report():
    # Reuse authored parent protocol fixtures, but run genuine new probe/gate
    # validation and parent protocol replay; no validator-success stub.
    parent,gate,policy,probe,base_loader=dependencies()
    view,proxy=m.adapt(parent,gate,policy,probe,base_loader,ingress())
    old=load('subscription-trusted-control-boundary-parent.test')
    probe_fixture=load('subscription-trusted-http-worker-probe.test')
    _,marker,probe_report=probe_fixture.fixture()
    body=old.complete_report(); raw_marker=__import__('json').dumps(marker).encode()
    digest=__import__('hashlib').sha256(raw_marker).hexdigest()
    body['marker'].update(path=m.MARKER_PATH,value=marker,bytes=len(raw_marker),rawHex=raw_marker.hex(),sha256=digest)
    body['startupPacket']['value']['ingress']=ingress()
    raw_packet=__import__('json').dumps(body['startupPacket']['value']).encode()+b'\n'
    body['startupPacket'].update(bytes=len(raw_packet),rawHex=raw_packet.hex(),sha256=__import__('hashlib').sha256(raw_packet).hexdigest())
    for field in ('beforeWorker','afterWorker'): body[field]['marker']={'file':body['marker']['file'],'sha256':digest}
    worker=parent.WorkerProtocol(view,proxy,marker)
    old.drain(worker); worker.receive({'id':1,'result':{'sessionId':'http-session'}})
    old.drain(worker); worker.receive({'id':2,'result':{'processId':'fixed-worker'}})
    old.drain(worker)
    raw_probe=__import__('json').dumps(probe_report).encode()+b'\n'
    worker.receive(old.read_reply(3,[old.chunk(1,raw_probe)],2,closed=True))
    body['sessions']['executor']=old.session_report(worker,8,m.GATE_ARGV)
    helper_hashes=dict.fromkeys(m.HELPERS,'a'*64); helper_hashes['subscription-text-model-catalog.json']=m.CATALOG_SHA256
    body.update(helperSha256Before=dict(helper_hashes),helperSha256After=dict(helper_hashes))
    route,_,_,_=complete_route()
    route['observations'][0].update(listener=copy.deepcopy(marker['trustedHttpIngress']),elapsedMs=110)
    route['observations'][1].update(listener=copy.deepcopy(marker['trustedHttpIngress']),elapsedMs=350)
    route['completedMs']=380
    route['adapter']['ownership'].update(copy.deepcopy(marker['trustedHttpIngress']))
    route['adapter']['ownership']['ingress']=copy.deepcopy(marker['trustedIngressSocket'])
    return {'version':1,'profile':'fixed-trusted-http-ingress-child','success':True,'error':None,'parentReport':body,'httpRoute':route,
        'helperSha256Before':helper_hashes,'helperSha256After':dict(helper_hashes)}


def test_full_parent_probe_gate_replay_binds_external_nonce_and_ready():
    report=complete_report()
    assert m.validate_report(report,dependencies(),ready(),ingress())
    foreign=ingress(); foreign['nonce']='b'*32
    assert not m.validate_report(report,dependencies(),ready(),foreign)

@pytest.mark.parametrize('case',['closed-listener','raw-worker','cleanup','source','network','hash','extra'])
def test_full_replay_rejects_raw_and_outer_binding_changes(case):
    report=complete_report()
    if case=='closed-listener': report['httpRoute']['observations'][1]['listening']=False
    if case=='raw-worker': report['parentReport']['sessions']['executor']['stdoutBase64']='e30='
    if case=='cleanup': report['parentReport']['sessions']['executor']['reaped']=False
    if case=='source': report['helperSha256After']['subscription-trusted-http-ingress.py']='b'*64
    if case=='network': report['httpRoute']['observations'][0]['listener']['networkNamespace']='net:[999]'
    if case=='hash': report['parentReport']['marker']['sha256']='b'*64
    if case=='extra': report['foreign']=True
    assert not m.validate_report(report,dependencies(),ready(),ingress())

@pytest.mark.parametrize('role',['listener','ingress','client','control','outerSupervisorControl','outerSupervisorOutput','appServerControl','appServerOutput'])
def test_full_replay_rejects_accepted_alias_to_every_protected_role(role):
    report=complete_report(); owner=report['httpRoute']['adapter']['ownership']
    target=owner[role] if role in owner else report['parentReport']['marker']['value']['protectedDescriptors'][role]
    owner['accepted']=copy.deepcopy(target)
    assert not m.validate_report(report,dependencies(),ready(),ingress())


def test_full_replay_rejects_client_tuple_equal_listener():
    report=complete_report(); owner=report['httpRoute']['adapter']['ownership']; owner['expectedClient']=list(owner['address'])
    assert not m.validate_report(report,dependencies(),ready(),ingress())
