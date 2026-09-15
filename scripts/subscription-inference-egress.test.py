"""Deterministic syscall mocks only; no socket/DNS/Popen runtime allowed."""
import importlib.util
import json
from pathlib import Path
from types import SimpleNamespace
import pytest


def module():
    spec=importlib.util.spec_from_file_location('tested_egress',Path(__file__).with_name('subscription-inference-egress.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value


m=module()


@pytest.fixture(autouse=True)
def safe(monkeypatch):
    monkeypatch.setattr(m,'_FENCED',False)
    monkeypatch.setattr(m.socket,'AF_UNIX',1,raising=False)
    monkeypatch.setattr(m.signal,'SIGKILL',9,raising=False)
    monkeypatch.setattr(m.socket,'socket',lambda *a,**k:pytest.fail('unmocked network socket'))
    monkeypatch.setattr(m.socket,'socketpair',lambda *a,**k:pytest.fail('unmocked socketpair'))
    monkeypatch.setattr(m.socket,'getaddrinfo',lambda *a,**k:pytest.fail('unmocked DNS'))
    monkeypatch.setattr(m.subprocess,'Popen',lambda *a,**k:pytest.fail('unmocked child process'))


def candidate(address,family=None):return {'family':family or (6 if ':' in address else 4),'address':address,'port':443}
def dns(*addresses):return json.dumps({'version':1,'host':'chatgpt.com','port':443,'candidates':[candidate(a) for a in addresses]}).encode()


@pytest.mark.parametrize('address',['1.1.1.1','8.8.8.8','2606:4700:4700::1111'])
def test_public_native_numeric_selection(address):
    family,sockaddr=m.select_address(dns(address))
    assert sockaddr[0]==address and sockaddr[1]==443


@pytest.mark.parametrize('address',[
    '0.0.0.0','10.0.0.1','100.64.0.1','127.0.0.1','169.254.1.1','172.16.0.1','192.0.0.9','192.0.0.10','192.0.2.1',
    '192.31.196.1','192.52.193.1','192.88.99.1','192.168.0.1','192.175.48.1','198.18.0.1','198.51.100.1','203.0.113.1',
    '224.0.0.1','239.255.255.255','240.0.0.1','255.255.255.255','::','::1','::ffff:1.1.1.1','::1.1.1.1',
    '64:ff9b::101:101','64:ff9b:1::101:101','fe80::1','fc00::1','ff02::1','2001::1','2001:db8::1',
    '2001:20::1','2001:3::1','2002:101:101::1','2620:4f:8000::1','3fff::1','3ffe::1','2606:4700:4700::1111%1','2606:4700:4700::1111%eth0',
    '1.1.1.01','0x01010101','2606:4700:4700:0:0:0:0:1111','2606:4700:4700::ABCD'])
def test_rejects_special_translated_scoped_and_noncanonical(address):
    with pytest.raises(ValueError):m.select_address(dns(address))


@pytest.mark.parametrize('case',['wrong-host','wrong-port','bool-port','bool-version','extra','duplicate','private-second','bad-family','extra-scope','duplicate-json'])
def test_dns_envelope_and_every_candidate_admitted(case):
    value=json.loads(dns('1.1.1.1'))
    if case=='wrong-host':value['host']='api.openai.com'
    elif case=='wrong-port':value['port']=80
    elif case=='bool-port':value['candidates'][0]['port']=True
    elif case=='bool-version':value['version']=True
    elif case=='extra':value['extra']='ignored?'
    elif case=='duplicate':value['candidates']*=2
    elif case=='private-second':value['candidates'].append(candidate('127.0.0.1'))
    elif case=='bad-family':value['candidates'][0]['family']=6
    elif case=='extra-scope':value['candidates'][0]['scope']=0
    raw=json.dumps(value).encode()
    if case=='duplicate-json':raw=raw.replace(b'"version": 1',b'"version": 1, "version": 1')
    with pytest.raises(ValueError):m.select_address(raw)


class Endpoint:
    def __init__(self,chunks=()):
        self.chunks=list(chunks);self.sent=bytearray();self.closed=False;self.close_error=False;self.limit=None
        self.connect_code=115;self.error=0;self.target=None;self.shutdowns=[]
    def setblocking(self,value):pass
    def set_inheritable(self,value):pass
    def close(self):
        self.closed=True
        if self.close_error:raise OSError('close')
    def recv(self,size):
        if not self.chunks:raise BlockingIOError()
        raw=self.chunks.pop(0)
        if len(raw)>size:self.chunks.insert(0,raw[size:]);raw=raw[:size]
        return raw
    def send(self,value):
        if self.limit==0:raise BlockingIOError()
        count=min(len(value),self.limit or len(value));self.sent.extend(value[:count]);return count
    def connect_ex(self,target):self.target=target;return self.connect_code
    def getsockopt(self,*a):return self.error
    def getpeername(self):return self.target
    def getsockname(self):return ('192.0.2.2',12345)
    def shutdown(self,how):self.shutdowns.append(how)


class Selector:
    def __init__(self,batches,clock=None):self.mapping={};self.batches=list(batches);self.closed=False;self.clock=clock
    def register(self,obj,events,data):self.mapping[obj]=SimpleNamespace(fileobj=obj,data=data)
    def get_key(self,obj):return self.mapping[obj]
    def unregister(self,obj):del self.mapping[obj]
    def modify(self,obj,events,data):self.register(obj,events,data)
    def select(self,timeout):
        if self.clock:self.clock()
        if not self.batches:raise ValueError('MOCK_EVENTS_EXHAUSTED')
        return [(self.mapping[obj],mask) for obj,mask in self.batches.pop(0)]
    def close(self):self.closed=True


def setup(monkeypatch,ingress_chunks=(),upstream_chunks=()):
    now=[0.0];monkeypatch.setattr(m.time,'monotonic',lambda:now[0])
    ingress=Endpoint(ingress_chunks);control=Endpoint();upstream=Endpoint(upstream_chunks)
    monkeypatch.setattr(m.socket,'socket',lambda *a:upstream)
    class Resolved:
        def __init__(self):
            self.eof={'stdout':True,'stderr':True};self.stdout=dns('1.1.1.1');self.stderr_bytes=0
            self.process=SimpleNamespace(pid=123,returncode=0,poll=lambda:0);self.source={'sha256':'a'*64}
            self.pinned=True;self.reaped=True;self.cleanup_method='already-exited';self.cutoff=2
        def start(self,selector,deadline):pass
        def close(self,deadline):return True
    monkeypatch.setattr(m,'ResolverTask',Resolved)
    session=m.Session(ingress,control,0,10,m._TOKEN)
    return session,ingress,control,upstream,now


def run(monkeypatch,ctx,batches,clock=None):
    selector=Selector(batches,clock);monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:selector)
    report=ctx[0].run()
    assert selector.closed and ctx[1].closed and ctx[2].closed
    return report


def test_actual_counted_opaque_relay_and_halfclose(monkeypatch):
    ctx=setup(monkeypatch,[m.REQUEST,b'opaque-client',b''],[b'opaque-server',b''])
    s,i,c,u,_=ctx
    r=run(monkeypatch,ctx,[[(i,1)],[(u,2)],[(i,2)],[(i,1),(u,1)],[(i,2),(u,2)],[(i,1),(u,1)]])
    assert r['success'] and r['reason']=='EOF' and r['connectCalls']==1
    assert i.sent==m.RESPONSE+b'opaque-server' and u.sent==b'opaque-client'
    assert r['observedBytes']=={'ingress':len(m.REQUEST)+13,'upstream':13}
    assert r['responseBytesWritten']==len(m.RESPONSE) and u.shutdowns==[m.socket.SHUT_WR]
    assert r['payloadLogged'] is False and r['tlsDecrypted'] is False


@pytest.mark.parametrize('case',['error','peer','bool-soerror','connect-fail','bool-connect'])
def test_never_200_before_verified_selected_connection(monkeypatch,case):
    ctx=setup(monkeypatch,[m.REQUEST]);s,i,c,u,_=ctx
    if case=='error':u.error=111
    elif case=='peer':u.getpeername=lambda:('8.8.8.8',443)
    elif case=='bool-soerror':u.error=False
    elif case=='connect-fail':u.connect_code=111
    elif case=='bool-connect':u.connect_code=False
    r=run(monkeypatch,ctx,[[(i,1)],[(u,2)]])
    assert not r['success'] and not i.sent and r['connectCalls']==1


@pytest.mark.parametrize('raw',[m.REQUEST.replace(b'chatgpt.com',b'api.openai.com'),m.REQUEST+b'early',m.REQUEST.replace(b'\r\n\r\n',b'\r\nAuthorization: secret\r\n\r\n')])
def test_fixed_header_no_provider_fallback_or_early_body(monkeypatch,raw):
    ctx=setup(monkeypatch,[raw]);_,i,_,_,_=ctx
    r=run(monkeypatch,ctx,[[(i,1)]])
    assert r['reason']=='CONNECT_HEADER_REFUSED' and not i.sent and r['connectCalls']==0


def test_control_wins_simultaneous_connect_and_no_200(monkeypatch):
    ctx=setup(monkeypatch,[m.REQUEST]);_,i,c,u,_=ctx;c.chunks=[b'C']
    r=run(monkeypatch,ctx,[[(i,1)],[(u,2),(c,1)]])
    assert r['reason']=='CANCELLED' and not i.sent


def test_crossing_byte_counted_not_forwarded(monkeypatch):
    monkeypatch.setattr(m,'BYTE_LIMIT',len(m.REQUEST)+3)
    ctx=setup(monkeypatch,[m.REQUEST,b'abcd']);_,i,c,u,_=ctx
    r=run(monkeypatch,ctx,[[(i,1)],[(u,2)],[(i,2)],[(i,1)]])
    assert r['reason']=='ENCRYPTED_BYTE_LIMIT' and sum(r['observedBytes'].values())==m.BYTE_LIMIT+1
    assert not u.sent and r['retainedBytes']['upstream']==0


def test_cancel_backpressure_and_unknown_close_fences(monkeypatch):
    ctx=setup(monkeypatch,[m.REQUEST,b'opaque']);s,i,c,u,_=ctx;u.limit=0;u.close_error=True;c.chunks=[b'C']
    r=run(monkeypatch,ctx,[[(i,1)],[(u,2)],[(i,2)],[(i,1)],[(u,2)],[(c,1)]])
    assert r['reason']=='CANCELLED' and r['retainedBytes']['upstream']==6 and not r['cleanupKnown']
    assert m._FENCED and s.close() is False
    with pytest.raises(ValueError,match='PRIOR_CLEANUP_UNKNOWN'):m.create_session(10)


def test_late_selector_and_late_cleanup_cannot_seal_success(monkeypatch):
    ctx=setup(monkeypatch,[m.REQUEST]);_,i,_,_,now=ctx
    r=run(monkeypatch,ctx,[[(i,1)]],lambda:now.__setitem__(0,10))
    assert r['reason']=='ABSOLUTE_DEADLINE' and not i.sent


def test_factory_partial_setup_cleanup_and_no_fd_adoption(monkeypatch):
    now=[0];monkeypatch.setattr(m.time,'monotonic',lambda:now[0]);first=Endpoint();peer=Endpoint();calls=[]
    def pair(*args):
        calls.append(args)
        if len(calls)==1:return first,peer
        raise OSError('second pair')
    monkeypatch.setattr(m.socket,'socketpair',pair)
    with pytest.raises(OSError):m.create_session(10)
    assert first.closed and peer.closed
    with pytest.raises(ValueError,match='FACTORY_ONLY'):m.Session(first,peer,0,10,object())


class Pipe:
    def __init__(self,fd):self.fd=fd;self.closed=False
    def fileno(self):return self.fd
    def close(self):self.closed=True


def resolver_setup(monkeypatch):
    now=[0.0];monkeypatch.setattr(m.time,'monotonic',lambda:now[0])
    process=SimpleNamespace(pid=123,returncode=None,stdout=Pipe(11),stderr=Pipe(12))
    calls=[]
    process.poll=lambda:process.returncode
    def wait(timeout):calls.append(('wait',timeout));process.returncode=-9;return -9
    process.wait=wait;process.kill=lambda:calls.append(('kill-popen',))
    def signal_pin(fd,sig):
        calls.append(('signal',fd,sig))
        if process.returncode is not None:raise ProcessLookupError()
    monkeypatch.setattr(m.signal,'pidfd_send_signal',signal_pin,raising=False)
    monkeypatch.setattr(m.os,'pidfd_open',lambda pid:77,raising=False)
    monkeypatch.setattr(m.os,'set_inheritable',lambda *a:None)
    monkeypatch.setattr(m.os,'set_blocking',lambda *a:None)
    monkeypatch.setattr(m.os,'close',lambda fd:calls.append(('close',fd)))
    monkeypatch.setattr(m,'resolver_identity',lambda:{'sha256':'a'*64,'dev':1,'ino':2,'bytes':100})
    def popen(argv,**kwargs):
        calls.append(('popen',argv,kwargs));return process
    monkeypatch.setattr(m.subprocess,'Popen',popen)
    return process,calls,now


@pytest.mark.parametrize('failure',['pidfd','inheritable','register','none'])
def test_post_popen_failures_always_owned_cleanup(monkeypatch,failure):
    process,calls,now=resolver_setup(monkeypatch);task=m.ResolverTask();selector=Selector([])
    if failure=='pidfd':monkeypatch.setattr(m.os,'pidfd_open',lambda pid:(_ for _ in ()).throw(OSError()),raising=False)
    elif failure=='inheritable':monkeypatch.setattr(m.os,'set_inheritable',lambda *a:(_ for _ in ()).throw(OSError()))
    elif failure=='register':selector.register=lambda *a:(_ for _ in ()).throw(OSError())
    if failure=='none':task.start(selector,10)
    else:
        with pytest.raises(OSError):task.start(selector,10)
    assert task.process is process and task.close(10) is True and task.reaped
    assert process.stdout.closed and process.stderr.closed
    assert ('kill-popen',) in calls if failure=='pidfd' else ('signal',77,m.signal.SIGKILL) in calls
    assert task.pinned is (failure!='pidfd')
    p=next(x for x in calls if x[0]=='popen')
    assert p[1]==m.RESOLVER_ARGV and p[2]['env']==m.RESOLVER_ENV and p[2]['close_fds'] is True


@pytest.mark.parametrize('failure',['kill','timeout','already-exited','expired'])
def test_resolver_cleanup_outcomes_no_signal_after_reap(monkeypatch,failure):
    process,calls,now=resolver_setup(monkeypatch);task=m.ResolverTask();task.start(Selector([]),10)
    if failure=='kill':
        def signal_pin(fd,sig):
            if process.returncode is not None:raise ProcessLookupError()
            raise OSError('kill failed')
        monkeypatch.setattr(m.signal,'pidfd_send_signal',signal_pin)
    elif failure=='timeout':process.wait=lambda timeout:(_ for _ in ()).throw(m.subprocess.TimeoutExpired('fixed',timeout))
    elif failure=='already-exited':process.returncode=0
    elif failure=='expired':now[0]=10
    result=task.close(10)
    assert result is (failure=='already-exited')
    if failure=='kill':assert any(x[0]=='wait' for x in calls)
    if failure=='already-exited':assert not any(x[0]=='signal' and x[2]==m.signal.SIGKILL for x in calls)
    if not result:assert m._FENCED and task.close(10) is False


def test_resolver_small_remaining_budget_refuses_before_spawn(monkeypatch):
    process,calls,now=resolver_setup(monkeypatch);task=m.ResolverTask()
    with pytest.raises(ValueError,match='DNS_CLEANUP_RESERVE'):task.start(Selector([]),1)
    assert not calls and task.process is None and task.close(1)


def test_selector_constructor_failure_closes_factory_owned_endpoints(monkeypatch):
    ctx=setup(monkeypatch)
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:(_ for _ in ()).throw(OSError('selector')))
    report=ctx[0].run()
    assert report['reason']=='LOCAL_IO_FAILURE' and report['cleanupKnown']
    assert ctx[1].closed and ctx[2].closed


def test_exact_cap_requires_actual_eof_and_partial_response_counts(monkeypatch):
    monkeypatch.setattr(m,'BYTE_LIMIT',len(m.REQUEST)+3)
    ctx=setup(monkeypatch,[m.REQUEST,b'abc',b''],[b'']);_,i,c,u,_=ctx;i.limit=13
    report=run(monkeypatch,ctx,[[(i,1)],[(u,2)],[(i,2)],[(i,2)],[(i,2)],[(i,1)],[(u,2)],[(i,1)],[(u,1)]])
    assert report['success'] and report['streamEOF']=={'ingress':True,'upstream':True}
    assert sum(report['observedBytes'].values())==m.BYTE_LIMIT
    assert report['responseBytesWritten']==len(m.RESPONSE) and bytes(u.sent)==b'abc'


def test_poll_observation_failure_still_attempts_owned_reap(monkeypatch):
    process,calls,now=resolver_setup(monkeypatch);task=m.ResolverTask();task.start(Selector([]),10)
    def poll():
        if process.returncode is None:raise OSError('poll observation')
        return process.returncode
    process.poll=poll
    assert task.close(10) is False and task.reaped and m._FENCED
    assert ('signal',77,m.signal.SIGKILL) in calls and any(c[0]=='wait' for c in calls)


@pytest.mark.parametrize('stream',['stdout','stderr'])
def test_dns_output_limit_is_bounded_without_partial_admission(stream):
    task=m.ResolverTask();task.feed(stream,b'x'*4096)
    with pytest.raises(ValueError,match='DNS_.*LIMIT'):task.feed(stream,b'x')
    assert len(task.stdout)<=4096


@pytest.mark.parametrize('post_spawn',[False,True])
def test_source_fd_close_unknown_propagates_through_session(monkeypatch,post_spawn):
    process,calls,now=resolver_setup(monkeypatch)
    real_identity=module().resolver_identity
    # Execute actual source-FD admission with mocked readonly regular metadata.
    real_identity.__globals__.update({'os':m.os,'_FENCED':False})
    info=SimpleNamespace(st_mode=0o100444,st_size=1,st_dev=1,st_ino=2,st_mtime_ns=3)
    monkeypatch.setattr(m.os,'O_CLOEXEC',0,raising=False)
    monkeypatch.setattr(m.os,'O_NOFOLLOW',0,raising=False)
    monkeypatch.setattr(m.os,'O_NONBLOCK',0,raising=False)
    monkeypatch.setattr(m.os,'ST_RDONLY',1,raising=False)
    monkeypatch.setattr(m.os,'open',lambda *a:88)
    monkeypatch.setattr(m.os,'fstat',lambda fd:info)
    monkeypatch.setattr(m.os,'fstatvfs',lambda fd:SimpleNamespace(f_flag=1),raising=False)
    monkeypatch.setattr(m.os,'read',lambda fd,size:b'x')
    closes=[]
    def close(fd):
        closes.append(fd)
        if fd==88 and closes.count(88)==(2 if post_spawn else 1):raise OSError('source close unknown')
    monkeypatch.setattr(m.os,'close',close)
    # Use the current module globals so the actual close failure fences its session.
    identity=type(real_identity)(real_identity.__code__,m.__dict__)
    monkeypatch.setattr(m,'resolver_identity',identity)
    i=Endpoint([m.REQUEST]);c=Endpoint();selector=Selector([[(i,1)]])
    monkeypatch.setattr(m.selectors,'DefaultSelector',lambda:selector)
    session=m.Session(i,c,0,10,m._TOKEN);report=session.run()
    assert report['reason']=='LOCAL_IO_FAILURE' and not report['cleanupKnown'] and m._FENCED
    assert i.closed and c.closed and selector.closed
    assert session.resolver.process is (process if post_spawn else None)
    if post_spawn:assert process.stdout.closed and process.stderr.closed and session.resolver.reaped
    with pytest.raises(ValueError,match='PRIOR_CLEANUP_UNKNOWN'):m.create_session(10)
