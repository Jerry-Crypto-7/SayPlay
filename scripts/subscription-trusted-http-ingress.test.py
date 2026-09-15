"""Deterministic mocks only: no socket/kernel or production credit."""
import importlib.util
import pathlib
from types import SimpleNamespace
import pytest

PATH = pathlib.Path(__file__).with_name('subscription-trusted-http-ingress.py')

def module():
    spec = importlib.util.spec_from_file_location('http_ingress', PATH)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value)
    return value

class Endpoint:
    def __init__(self, chunks=(), fail_close=False):
        self.chunks = list(chunks); self.sent = bytearray(); self.closed = False
        self.fail_close = fail_close; self.shutdowns = []; self.partial = None
    def recv(self, size):
        if not self.chunks: raise BlockingIOError()
        value = self.chunks.pop(0)
        if isinstance(value, Exception): raise value
        if len(value) > size: self.chunks.insert(0, value[size:]); value = value[:size]
        return value
    def send(self, value):
        if self.partial == 0: raise BlockingIOError()
        count = min(len(value), self.partial or len(value)); self.sent.extend(value[:count]); return count
    def close(self):
        if self.fail_close: raise OSError('mock close')
        self.closed = True
    def setblocking(self, value): pass
    def set_inheritable(self, value): pass
    def getsockname(self): return ('127.0.0.1', 1234)
    def shutdown(self, how): self.shutdowns.append(how)
    def accept(self): return self.accepted, ('127.0.0.1', 5678)

class Selector:
    def __init__(self, batches, clock=None): self.batches=list(batches); self.mapping={}; self.clock=clock; self.closed=False
    def register(self, endpoint, events, data): self.mapping[endpoint]=SimpleNamespace(fileobj=endpoint,data=data)
    def unregister(self, endpoint): del self.mapping[endpoint]
    def get_map(self): return self.mapping
    def select(self, timeout):
        if not self.batches: raise ValueError('TEST_EXHAUSTED')
        batch=self.batches.pop(0)
        if self.clock: self.clock()
        return [(self.mapping[endpoint], event) for endpoint,event in batch]
    def close(self): self.closed=True

def setup(monkeypatch, client_chunks=(), ingress_chunks=(), control_chunks=(), profile='authored-connect'):
    m=module(); listener=Endpoint(); client=Endpoint(client_chunks); listener.accepted=client
    ingress=Endpoint(ingress_chunks); control=Endpoint(control_chunks)
    monkeypatch.setattr(m.time,'monotonic',lambda:0)
    monkeypatch.setattr(m,'identity',lambda endpoint:{'dev':1,'ino':2,'type':49152})
    session=m.OfflineSession(listener,ingress,control,('127.0.0.1',5678),{'address':['127.0.0.1',1234]},0,m._TOKEN,profile)
    return m,session,listener,client,ingress,control

def drive(monkeypatch, context, batches):
    m,s,l,c,i,x=context; selector=Selector(batches)
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:selector)
    return s.run()

def test_constants_match_reviewed_proxy_exact_bytes():
    m=module(); path=PATH.with_name('subscription-trusted-egress-proxy.py')
    scope={}; exec(compile(path.read_text(encoding='utf-8-sig'),str(path),'exec'),scope)
    assert (m.REQUEST,m.RESPONSE)==(scope['REQUEST'],scope['RESPONSE'])

@pytest.mark.parametrize('raw',[b'GET / HTTP/1.1\r\n\r\n',b'CONNECT other:443',b'CONNECT fixture.invalid:80',b'CONNECT fixture.invalid:443 HTTP/1.0',module().REQUEST+b'x',module().REQUEST.replace(b'Host:',b'Authorization:'),b'x'*4097])
def test_exact_request_rejects_variants(raw):
    with pytest.raises(ValueError): module().fixed_prefix(bytearray(),raw,module().REQUEST)

def test_fragmented_prefix():
    m=module(); pending=bytearray()
    for byte in m.REQUEST[:-1]: assert not m.fixed_prefix(pending,bytes([byte]),m.REQUEST)
    assert m.fixed_prefix(pending,m.REQUEST[-1:],m.REQUEST)

def test_actual_response_required_and_halfclose_drains(monkeypatch):
    m=module(); ctx=setup(monkeypatch,[m.REQUEST,b'abc',b''],[m.RESPONSE,b'xyz',b'']); m,s,l,c,i,x=ctx
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(i,2)],[(i,1)],[(c,2)],[(c,1),(i,1)],[(c,2),(i,2)],[(c,1),(i,1)]])
    assert result['success']; assert bytes(c.sent)==m.RESPONSE+b'xyz'; assert bytes(i.sent)==m.REQUEST+b'abc'
    assert result['observedBytes']=={'client':len(m.REQUEST)+3,'ingress':len(m.RESPONSE)+3}
    assert result['retainedBytes']=={'client':0,'ingress':0}; assert len(c.shutdowns)==len(i.shutdowns)==1
    assert result['cleanup']['known']; assert all(e.closed for e in (l,c,i,x))
    with pytest.raises(ValueError,match='SESSION_ALREADY_USED'): s.run()

@pytest.mark.parametrize('control,reason',[(b'C','CANCELLED'),(b'','CONTROL_EOF'),(b'X','CONTROL_INVALID'),(b'CC','CONTROL_INVALID')])
def test_control_always_closes(monkeypatch,control,reason):
    ctx=setup(monkeypatch,control_chunks=[control]); m,s,l,c,i,x=ctx
    result=drive(monkeypatch,ctx,[[(x,1),(l,1)]])
    assert result['reason']==reason and result['cleanup']['known']; assert not result['success']

@pytest.mark.parametrize('phase', ['request','response','early-client','early-ingress','eof'])
def test_refusal_no_fabricated_200(monkeypatch,phase):
    m=module(); client=[b'X'] if phase=='request' else [b''] if phase=='eof' else [m.REQUEST,b'early']
    ctx=setup(monkeypatch,client,[b'bad']); m,s,l,c,i,x=ctx
    batches=[[(l,1)],[(c,1)]]
    if phase=='response': batches += [[(i,2)],[(i,1)]]
    if phase=='early-client': batches += [[(c,1)]]
    if phase=='early-ingress': batches += [[(i,1)]]
    result=drive(monkeypatch,ctx,batches)
    assert not result['success']; assert not c.sent; assert result['cleanup']['known']

def test_selector_constructor_failure_closes_all(monkeypatch):
    ctx=setup(monkeypatch); m,s,l,c,i,x=ctx
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda: (_ for _ in ()).throw(OSError()))
    assert s.run()['cleanup']['known']; assert l.closed and i.closed and x.closed

def test_close_before_run_idempotent_and_unknown_fence(monkeypatch):
    m,s,l,c,i,x=setup(monkeypatch); i.fail_close=True
    report=s.close(); assert not report['known']; assert s.close() is report; assert l.closed and x.closed
    with pytest.raises(ValueError,match='PREVIOUS_CLEANUP_UNKNOWN'): m.create_offline_session()

def test_select_deadline_before_any_accept(monkeypatch):
    ctx=setup(monkeypatch); m,s,l,c,i,x=ctx
    clock=[0]; monkeypatch.setattr(m.time,'monotonic',lambda:clock[0])
    selector=Selector([[(l,1)]],lambda:clock.__setitem__(0,2))
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:selector)
    result=s.run(); assert result['reason']=='NEGOTIATION_DEADLINE'; assert not c.closed

def test_partial_write_eagain_cancel_keeps_accounting(monkeypatch):
    m=module(); ctx=setup(monkeypatch,[m.REQUEST],control_chunks=[b'C']); m,s,l,c,i,x=ctx
    i.partial=3
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(i,2)],[(x,1),(i,2)]])
    assert result['deliveredBytes']['ingress']==3
    assert result['retainedBytes']['ingress']==len(m.REQUEST)-3
    assert result['reason']=='CANCELLED'

def test_output_crossing_real_byte_not_forwarded(monkeypatch):
    m=module(); ctx=setup(monkeypatch,[m.REQUEST,b'abc'],[m.RESPONSE]); m,s,l,c,i,x=ctx
    m.BYTE_LIMIT=len(m.REQUEST)+len(m.RESPONSE)+2
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(i,2)],[(i,1)],[(c,2)],[(c,1)]])
    assert result['reason']=='OUTPUT_LIMIT'; assert sum(result['observedBytes'].values())==m.BYTE_LIMIT+1
    assert bytes(i.sent)==m.REQUEST; assert result['retainedBytes']=={'client':0,'ingress':0}

def test_factory_setup_failure_closes_partial_handles(monkeypatch):
    m=module(); endpoint=Endpoint(); endpoint.bind=lambda address: (_ for _ in ()).throw(OSError())
    monkeypatch.setattr(m.socket,'socket',lambda *args:endpoint)
    with pytest.raises(OSError): m.create_offline_session()
    assert endpoint.closed

def test_no_arbitrary_adoption_or_production_connector():
    m=module()
    with pytest.raises(ValueError): m.OfflineSession(None,None,None,None,None,0)
    with pytest.raises(ValueError): m.production_upstream()

@pytest.mark.parametrize('failure',['accept','accepted-setup','peer','listener-close'])
def test_accept_failures_close_owned_accepted_if_created(monkeypatch,failure):
    ctx=setup(monkeypatch); m,s,l,c,i,x=ctx
    if failure=='accept': l.accept=lambda: (_ for _ in ()).throw(OSError())
    if failure=='accepted-setup': c.setblocking=lambda value: (_ for _ in ()).throw(OSError())
    if failure=='peer': l.accept=lambda:(c,('127.0.0.1',9999))
    if failure=='listener-close': l.fail_close=True
    result=drive(monkeypatch,ctx,[[(l,1)]])
    assert not result['success']; assert i.closed and x.closed
    assert result['cleanup']['known']==(failure!='listener-close')
    if failure!='accept': assert c.closed

def test_exact_cap_eof_is_not_overflow(monkeypatch):
    m=module(); ctx=setup(monkeypatch,[m.REQUEST,b''],[m.RESPONSE,b'']); m,s,l,c,i,x=ctx
    m.BYTE_LIMIT=len(m.REQUEST)+len(m.RESPONSE)
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(i,2)],[(i,1)],[(c,2)],[(c,1),(i,1)]])
    assert result['success']; assert sum(result['observedBytes'].values())==m.BYTE_LIMIT

def test_eagain_then_cancel_does_not_claim_delivery(monkeypatch):
    m=module(); ctx=setup(monkeypatch,[m.REQUEST],control_chunks=[b'C']); m,s,l,c,i,x=ctx
    i.partial=0
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(i,2)],[(x,1)]])
    assert result['reason']=='CANCELLED'; assert result['deliveredBytes']['ingress']==0

def test_factory_deadline_before_accept_closes(monkeypatch):
    ctx=setup(monkeypatch); m,s,l,c,i,x=ctx
    monkeypatch.setattr(m.time,'monotonic',lambda:5)
    result=s.run(); assert result['reason']=='SESSION_DEADLINE'; assert l.closed and i.closed and x.closed


@pytest.mark.parametrize('profile,client_wire,normalized',[
    ('authored-connect',module().REQUEST,0),
    ('pinned-wss-shaped-fixture',module().PINNED_WSS_REQUEST,30),
])
def test_fixed_profiles_fragmented_normalize_only_validated_header(monkeypatch,profile,client_wire,normalized):
    m=module(); ctx=setup(monkeypatch,[client_wire[:40],client_wire[40:],b'abc',b''],[m.RESPONSE[:10],m.RESPONSE[10:],b'xyz',b''],profile=profile)
    m,s,l,c,i,x=ctx
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(c,1)],[(i,2)],[(i,1)],[(i,1)],[(c,2)],[(c,1),(i,1)],[(c,2),(i,2)],[(c,1),(i,1)]])
    assert result['success']; assert result['profile']==profile and result['normalizedHeaderBytes']==normalized
    assert result['observedBytes']=={'client':len(client_wire)+3,'ingress':len(m.RESPONSE)+3}
    assert result['deliveredBytes']=={'client':len(m.RESPONSE)+3,'ingress':len(m.REQUEST)+3}
    assert bytes(i.sent)==m.REQUEST+b'abc'; assert bytes(c.sent)==m.RESPONSE+b'xyz'

@pytest.mark.parametrize('profile,client_wire',[
    ('authored-connect',module().PINNED_WSS_REQUEST),
    ('pinned-wss-shaped-fixture',module().REQUEST),
])
def test_profiles_cannot_accept_each_other(monkeypatch,profile,client_wire):
    ctx=setup(monkeypatch,[client_wire,b''],profile=profile); m,s,l,c,i,x=ctx
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)],[(c,1)]])
    assert not result['success']; assert not i.sent; assert result['normalizedHeaderBytes']==0

@pytest.mark.parametrize('client_wire',[
    module().PINNED_WSS_REQUEST.replace(b'Proxy-Connection',b'proxy-connection'),
    module().PINNED_WSS_REQUEST.replace(b'Keep-Alive',b'keep-alive'),
    module().PINNED_WSS_REQUEST.replace(b'Keep-Alive',b'close'),
    module().PINNED_WSS_REQUEST[:-2]+b'Proxy-Authorization: secret\r\n\r\n',
    module().PINNED_WSS_REQUEST+b'early',
])
def test_wss_fixture_refuses_every_nonfixed_header_before_forward(monkeypatch,client_wire):
    ctx=setup(monkeypatch,[client_wire],profile='pinned-wss-shaped-fixture'); m,s,l,c,i,x=ctx
    result=drive(monkeypatch,ctx,[[(l,1)],[(c,1)]])
    assert result['reason']=='HANDSHAKE_REFUSED'; assert not i.sent; assert not c.sent
    assert result['normalizedHeaderBytes']==0; assert 'secret' not in str(result)

def test_public_factories_select_only_fixed_profiles(monkeypatch):
    m=module(); selected=[]; monkeypatch.setattr(m,'_create',lambda profile:selected.append(profile))
    m.create_offline_session(); m.create_pinned_wss_fixture_session()
    assert selected==['authored-connect','pinned-wss-shaped-fixture']
    assert len(m.PINNED_WSS_REQUEST)==97 and len(m.REQUEST)==67 and len(m.RESPONSE)==39

