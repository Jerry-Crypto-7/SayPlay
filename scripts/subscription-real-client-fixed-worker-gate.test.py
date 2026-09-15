"""Offline protocol and actual stdio-loop tests with owned kernel doubles."""
import base64
from collections import deque
import copy
import importlib.util
import hashlib
import stat
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock
import pytest

path=Path(__file__).with_name('subscription-real-client-fixed-worker-gate.py')
spec=importlib.util.spec_from_file_location('real_client_test',path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
RAW=path.with_name('subscription-exec-server-worker-gate.py').read_bytes()
PID='pid:[1]';MOUNT='mnt:[2]'


def line(frame):return m.encode(frame)+b'\n'


def flush(p):
    result=bytes(p.pending)
    if result:p.written(len(result))
    return result


def exchanges():
    b=m.load_base(RAW)
    return [(b.environment_initialize_request(),{'id':1,'result':{'sessionId':'owned'}}),
        ({'method':'initialized','params':{}},None),
        (b.environment_info_request(2),{'id':2,'result':{'shell':{'name':'sh','path':'/bin/sh'},'cwd':'file:///work','capabilities':{'networkProxyLaunch':True}}}),
        (b.environment_bootstrap_stat_request(3,b.BOOTSTRAP_PATHS[0]),{'id':3,'error':{'code':-32004,'message':'actual mocked ENOENT'}}),
        (b.environment_bootstrap_stat_request(4,b.BOOTSTRAP_PATHS[1]),{'id':4,'error':{'code':-32004,'message':'actual mocked ENOENT'}})]


def boot():
    p=m.Protocol(RAW,PID,MOUNT)
    for request,response in exchanges():
        p.receive('client',line(request));flush(p)
        if response:p.receive('server',line(response))
    assert not p.complete
    return p


def close_response(identifier=6):
    return {'id':identifier,'result':{'chunks':[],'nextSeq':1,'exited':True,'exitCode':0,'closed':True,'failure':None,'sandboxDenied':False}}


def test_received_exact_whitespace_and_rewritten_partial_wire_replay():
    p=boot();request=p.base.trusted_cli_start_request();request['id']=5
    raw=b' '+line(request);p.receive('client',raw)
    assert p.events[-1]['rawHex']==raw.hex()
    forwarded=bytes(p.pending);decoded=p.base.strict_json(forwarded)
    assert decoded['params']['argv']==['/usr/bin/python3','-I','-S','/usr/bin/exec-server-worker-trampoline.py','--trusted-cli-worker-boundary']
    assert decoded['id']==5 and decoded['params']['env']==p.worker.worker_env
    p.written(1);assert p.worker.awaiting is None
    p.written(len(p.pending));p.receive('server',line({'id':5,'result':{'processId':'fixed-worker'}}))
    p.receive('client',line(p.base.read_request(6)));flush(p);p.receive('server',line(close_response()))
    assert p.complete and m.validate_report(p.report(),RAW,PID,MOUNT)
    report=copy.deepcopy(p.report());report['events'][-2]['rawHex']='00'
    assert not m.validate_report(report,RAW,PID,MOUNT)


@pytest.mark.parametrize('case',['id2','argv','env','network','stdin','trace','second','unknown','read-before','no-stats'])
def test_fixed_start_admission_before_any_forward(case):
    p=boot() if case!='no-stats' else m.Protocol(RAW,PID,MOUNT)
    request=p.base.trusted_cli_start_request();request['id']=5
    if case=='id2':request['id']=2
    if case=='argv':request['params']['argv'].append('caller')
    if case=='env':request['params']['env']['TOKEN']='not-a-secret-fixture'
    if case=='network':request['params']['sandbox']['permissions']['network']='enabled'
    if case=='stdin':request['params']['pipeStdin']=True
    if case=='trace':request['trace']={}
    if case=='unknown':request={'id':5,'method':'http/request','params':{}}
    if case=='read-before':request=p.base.read_request(5)
    if case=='second':
        p.receive('client',line(request));flush(p);p.receive('server',line({'id':5,'result':{'processId':'fixed-worker'}}));request['id']=6
    with pytest.raises(ValueError):p.receive('client',line(request))
    assert not p.pending and p.failed and not p.complete


@pytest.mark.parametrize('case',['duplicate-info','wrong-stat','fake-success','data-field','response-before-write'])
def test_bootstrap_is_actual_unique_and_write_ordered(case):
    p=m.Protocol(RAW,PID,MOUNT)
    for request,response in exchanges()[:3]:
        p.receive('client',line(request));flush(p)
        if response:p.receive('server',line(response))
    request,response=exchanges()[3]
    if case=='duplicate-info':request=p.base.environment_info_request(3)
    if case=='wrong-stat':request['params']['path']='file:///work/other'
    if case in ('duplicate-info','wrong-stat'):
        with pytest.raises(ValueError):p.receive('client',line(request))
    else:
        p.receive('client',line(request))
        if case!='response-before-write':flush(p)
        if case=='fake-success':response={'id':3,'result':{}}
        if case=='data-field':response['error']['data']=None
        with pytest.raises(ValueError):p.receive('server',line(response))
    assert p.failed and not p.complete


def test_source_hash_admission():
    with pytest.raises(ValueError,match='BASE_SOURCE'):m.Protocol(RAW+b'\n',PID,MOUNT)


@pytest.mark.parametrize('process_id',['12345','12345-550e8400-e29b-41d4-a716-446655440000'])
def test_upstream_process_handle_cannot_enter_fixed_worker_gate(process_id):
    """Source-derived incompatibility witness, not a captured client request.

    Pinned upstream 25af12f7, core/src/unified_exec/process_manager.rs
    exec_server_params_for_request uses an i32 decimal handle, with a UUID
    suffix when sandboxed. Neither branch can produce 'fixed-worker'.
    Keep every other field accepted to isolate this decisive mismatch.
    """
    p=boot();request=p.base.trusted_cli_start_request();request['id']=5
    request['params']['processId']=process_id
    with pytest.raises(ValueError,match='^EXEC_REQUEST_REFUSED$'):
        p.receive('client',line(request))
    assert p.failed and not p.pending and not p.worker.started and not p.complete
    # Refusal must also fence a subsequent otherwise valid request.
    request['params']['processId']='fixed-worker'
    with pytest.raises(ValueError):p.receive('client',line(request))
    assert not p.pending and not p.worker.started


@pytest.mark.parametrize('failure',[None,'selector','pin','close','buffered-exit','backpressure'])
def test_actual_loop_with_mockkernel_and_coalesced_client_queue(monkeypatch,failure):
    original=m.load_base
    def loader(raw):
        b=original(raw);b.verify_bootstrap_absence=Mock();b.verify_control_marker=Mock()
        b.load_policy=lambda:SimpleNamespace(ARGV=['fixed','app-server','--stdio'])
        return b
    monkeypatch.setattr(m,'load_base',loader);monkeypatch.setattr(m,'_UNKNOWN',False)
    monkeypatch.setattr(m,'fixed_policy',lambda:SimpleNamespace(ARGV=['fixed','app-server','--stdio']))
    class Pipe:
        def __init__(self,fd):self.fd=fd;self.closed=False
        def fileno(self):return self.fd
        def close(self):self.closed=True
    process=SimpleNamespace(pid=77,stdin=Pipe(10),stdout=Pipe(11),stderr=Pipe(12),returncode=None)
    final_buffered=[False]
    def poll():
        if process.stdin.closed or final_buffered[0]:process.returncode=0
        return process.returncode
    process.poll=poll;process.terminate=lambda:setattr(process,'returncode',0)
    process.kill=process.terminate;process.wait=lambda **kw:process.returncode
    monkeypatch.setattr(m.subprocess,'Popen',lambda *a,**kw:process)
    monkeypatch.setattr(m.os,'pidfd_open',Mock(side_effect=OSError() if failure=='pin' else None,return_value=99),raising=False)
    monkeypatch.setattr(m.os,'set_blocking',lambda *a:None)
    monkeypatch.setattr(m.os,'close',Mock(side_effect=OSError() if failure=='close' else None))
    queue=deque();pairs=exchanges()
    queue.extend([(0,line(pairs[0][0])),(11,line(pairs[0][1])),(0,line(pairs[1][0])+line(pairs[2][0])),(11,line(pairs[2][1]))])
    for req,res in pairs[3:]:queue.extend([(0,line(req)),(11,line(res))])
    b=loader(RAW);start=b.trusted_cli_start_request();start['id']=5
    queue.extend([(0,line(start)),(11,line({'id':5,'result':{'processId':'fixed-worker'}})),(0,line(b.read_request(6))),
        (11,line(close_response())),(0,b''),(11,b''),(12,b'')])
    if failure=='backpressure':queue.appendleft((12,b'fixture stderr\n'))
    wire=[];written_ids=set();pending=bytearray();iterations=[0]
    blocked=set()
    def write(fd,raw):
        raw=bytes(raw)
        if failure=='backpressure':
            if fd not in blocked:blocked.add(fd);raise BlockingIOError()
            raw=raw[:511] if len(raw)>1 else raw
        wire.append((fd,raw))
        if fd==10:
            pending.extend(raw)
            while b'\n' in pending:
                part,_,rest=pending.partition(b'\n');pending[:]=rest
                frame=b.strict_json(part)
                if 'id' in frame:written_ids.add(frame['id'])
                if failure=='buffered-exit' and frame.get('id')==6:final_buffered[0]=True
        return len(raw)
    monkeypatch.setattr(m.os,'write',write)
    def select(timeout):
        iterations[0]+=1;assert iterations[0]<500
        if not queue:return []
        fd,raw=queue[0]
        if fd==11 and raw and b.strict_json(raw)['id'] not in written_ids:return []
        return [(SimpleNamespace(fd=fd,data={0:'client',11:'server',12:'stderr'}[fd]),1)]
    selector=Mock();selector.select.side_effect=select
    monkeypatch.setattr(m.selectors,'DefaultSelector',Mock(side_effect=OSError() if failure=='selector' else None,return_value=selector))
    monkeypatch.setattr(m.os,'read',lambda fd,n:queue.popleft()[1])
    published=[];monkeypatch.setattr(m,'publish',lambda report,deadline:published.append(report))
    if failure=='close':
        with pytest.raises(ValueError,match='CLEANUP_UNKNOWN'):m.run(RAW,dict(m.ENVIRONMENT),PID,MOUNT)
        assert m._UNKNOWN
    else:assert m.run(RAW,dict(m.ENVIRONMENT),PID,MOUNT)==(0 if failure in (None,'buffered-exit','backpressure') else 1)
    assert process.poll() is not None and all(p.closed for p in (process.stdin,process.stdout,process.stderr))
    assert len(published)==1
    if failure in (None,'buffered-exit','backpressure'):
        assert m.validate_report(published[0]['protocol'],RAW,PID,MOUNT)
        assert m.validate_terminal(published[0],RAW,PID,MOUNT)
        for key,value in [('ownedHandlesKnown',False),('processReaped',False),('executorExitCode',1),
                ('executorExitCode',False),('error','ValueError'),('productionReady',True),('outerPidNamespace','pid:[99]')]:
            bad=copy.deepcopy(published[0]);bad[key]=value
            assert not m.validate_terminal(bad,RAW,PID,MOUNT)
        for key,value in [('partialHex',{'client':'00','server':''}),('eofObserved',['server','stderr']),
                ('undeliveredServerBytes',1),('undeliveredStderrBytes',True),('stderrSha256','bad'),
                ('observedBytes',{'client':0,'server':0,'stderr':0})]:
            bad=copy.deepcopy(published[0]);bad['transport'][key]=value
            assert not m.validate_terminal(bad,RAW,PID,MOUNT)
        assert any(fd==1 for fd,_ in wire) and written_ids==set(range(1,7))
        if failure=='backpressure':
            assert blocked=={1,2,10}
            assert b''.join(data for fd,data in wire if fd==2)==b'fixture stderr\n'
            assert b''.join(data for fd,data in wire if fd==1)==b''.join(
                bytes.fromhex(event['rawHex']) for event in published[0]['protocol']['events'] if event['kind']=='server')


@pytest.mark.parametrize('notification',[False,True])
@pytest.mark.parametrize('field,value',[('exitCode',1),('exitCode',False),('sandboxDenied',True),('sandboxDenied',None)])
def test_worker_failure_cannot_complete(notification,field,value):
    p=boot();request=p.base.trusted_cli_start_request();request['id']=5
    p.receive('client',line(request));flush(p)
    p.receive('server',line({'id':5,'result':{'processId':'fixed-worker'}}))
    if notification:
        frame={'method':'process/exited','params':{'processId':'fixed-worker','seq':1,'exitCode':0,'sandboxDenied':False}}
        frame['params'][field]=value
    else:
        p.receive('client',line(p.base.read_request(6)));flush(p)
        frame=close_response();frame['result'][field]=value
    with pytest.raises(ValueError):p.receive('server',line(frame))
    assert p.failed and not p.complete


def test_successful_exit_notifications_have_the_same_completion_contract():
    p=boot();request=p.base.trusted_cli_start_request();request['id']=5
    p.receive('client',line(request));flush(p)
    p.receive('server',line({'id':5,'result':{'processId':'fixed-worker'}}))
    p.receive('server',line({'method':'process/exited','params':{
        'processId':'fixed-worker','seq':1,'exitCode':0,'sandboxDenied':False}}))
    assert not p.complete
    p.receive('server',line({'method':'process/closed','params':{'processId':'fixed-worker','seq':2}}))
    assert p.complete and m.validate_report(p.report(),RAW,PID,MOUNT)


def terminal_fixture():
    p=boot();request=p.base.trusted_cli_start_request();request['id']=5
    p.receive('client',line(request));flush(p)
    p.receive('server',line({'id':5,'result':{'processId':'fixed-worker'}}))
    p.receive('server',line({'method':'process/exited','params':{
        'processId':'fixed-worker','seq':1,'exitCode':0,'sandboxDenied':False}}))
    p.receive('server',line({'method':'process/closed','params':{'processId':'fixed-worker','seq':2}}))
    return {'version':1,'profile':m.PROFILE,'protocol':p.report(),'error':None,
        'ownedHandlesKnown':True,'processReaped':True,'executorExitCode':0,
        'outerPidNamespace':PID,'outerMountNamespace':MOUNT,
        'transport':{'observedBytes':{**p.received,'stderr':0},'partialHex':{'client':'','server':''},
            'stderrSha256':hashlib.sha256(b'').hexdigest(),'eofObserved':['client','server','stderr'],
            'undeliveredServerBytes':0,'undeliveredStderrBytes':0},
        'remoteCleanup':'not-attested','productionReady':False}


@pytest.mark.parametrize('case',['valid','short-reads','empty','oversize','fifo','truncated','grown',
    'inode','mode','mtime','ctime','missing-newline','extra-line','duplicate-json','failed-report',
    'namespace','source','read-error','close-error','prior-unknown'])
def test_owned_terminal_reader_preserves_raw_and_refuses_incomplete_evidence(monkeypatch,case):
    # The reader runs inside Linux; the test replaces every file syscall.
    for name,value in [('O_NOFOLLOW',0x20000),('O_CLOEXEC',0x80000),('O_NONBLOCK',0x800)]:
        monkeypatch.setattr(m.os,name,value,raising=False)
    report=terminal_fixture()
    if case=='failed-report':report['executorExitCode']=False
    data=line(report)
    if case=='missing-newline':data=data[:-1]
    if case=='extra-line':data+=b'\n'
    if case=='duplicate-json':data=b'{"version":1,'+data[1:]
    info=SimpleNamespace(st_dev=1,st_ino=2,st_mode=stat.S_IFREG|0o600,st_size=len(data),st_mtime_ns=3,st_ctime_ns=4)
    after=copy.copy(info)
    if case=='empty':info.st_size=0
    if case=='oversize':info.st_size=m.MAX_TERMINAL+1
    if case=='fifo':info.st_mode=stat.S_IFIFO|0o600
    for label,key in [('inode','st_ino'),('mode','st_mode'),('mtime','st_mtime_ns'),('ctime','st_ctime_ns')]:
        if case==label:setattr(after,key,getattr(after,key)+1)
    if case=='truncated':data=data[:-1]
    if case=='grown':data+=b' '
    original=data;remaining=bytearray(data);requests=[]
    def read(fd,count):
        assert fd==88 and 0<count<=65536
        requests.append(count)
        if case=='read-error':raise OSError('fixture')
        count=min(count,17) if case=='short-reads' else count
        block=bytes(remaining[:count]);del remaining[:count];return block
    opener=Mock(return_value=88);closer=Mock(side_effect=OSError('fixture') if case=='close-error' else None)
    monkeypatch.setattr(m.os,'open',opener);monkeypatch.setattr(m.os,'close',closer)
    monkeypatch.setattr(m.os,'read',read);monkeypatch.setattr(m.os,'fstat',Mock(side_effect=[info,after]))
    monkeypatch.setattr(m,'_UNKNOWN',case=='prior-unknown')
    source=RAW+b'\n' if case=='source' else RAW
    namespace='pid:[99]' if case=='namespace' else PID
    if case in ('valid','short-reads'):
        result=m.read_terminal(source,namespace,MOUNT)
        assert bytes.fromhex(result['rawHex'])==original and result['rawBytes']==len(original)
        assert result['rawSha256']==hashlib.sha256(original).hexdigest()
        assert result['report']==report and result['protocolValidated'] is True
        assert result['remoteCleanup']=='not-attested' and result['productionReady'] is False
        if case=='short-reads':assert len(requests)>10
    else:
        with pytest.raises((ValueError,OSError)):m.read_terminal(source,namespace,MOUNT)
    if case in ('source','prior-unknown'):
        opener.assert_not_called();closer.assert_not_called()
    else:
        opener.assert_called_once_with(m.TRACE,m.os.O_RDONLY|m.os.O_NOFOLLOW|m.os.O_CLOEXEC|m.os.O_NONBLOCK)
        closer.assert_called_once_with(88)
    if case=='close-error':
        assert m._UNKNOWN
        with pytest.raises(ValueError,match='PRIOR_REAL_CLIENT_CLEANUP_UNKNOWN'):m.read_terminal(RAW,PID,MOUNT)
        assert opener.call_count==1
