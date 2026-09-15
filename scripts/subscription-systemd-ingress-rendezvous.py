"""One owned systemd ingress handoff; no generic descriptor sender or unit launcher."""
import array
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import select
import signal
import socket
import stat
import struct
import time
import threading
import types
import uuid

ROOT = Path(__file__).parent
SOURCES = ('subscription-systemd-ingress-rendezvous.py', 'subscription-systemd-ingress-receiver.py',
    'subscription-systemd-fixture-transport.py', 'subscription-systemd-cli-probe.py', 'subscription-trusted-egress-proxy.py',
    'subscription-trusted-ingress-launcher.py')
_FENCED = False


def load_modules(expected):
    if type(expected) is not dict or set(expected) != set(SOURCES): raise ValueError('EXACT_HANDOFF_SOURCES_REQUIRED')
    raw = {name: (ROOT / name).read_bytes() for name in SOURCES}
    if any(hashlib.sha256(value).hexdigest() != expected[name] for name,value in raw.items()): raise ValueError('HANDOFF_SOURCE_DRIFT')
    result = {}
    for key,name in (('receiver', SOURCES[1]),('relay',SOURCES[2]),('probe',SOURCES[3]),('proxy',SOURCES[4]),('launcher',SOURCES[5])):
        spec=importlib.util.spec_from_file_location('fixed_handoff_'+key,ROOT/name)
        module=importlib.util.module_from_spec(spec)
        exec(compile(raw[name],str(ROOT/name),'exec'),module.__dict__)
        result[key]=module
    return types.SimpleNamespace(**result)


def identity(value): return (value.st_dev,value.st_ino,value.st_mode,value.st_uid)


def receive_plain(channel,deadline):
    """Never silently accept ancillary descriptors on HELLO or ACK."""
    raw=bytearray()
    while not raw.endswith(b'\n'):
        if time.monotonic()>=deadline: raise TimeoutError('HANDOFF_DEADLINE')
        try: part,ancillary,flags,_=channel.recvmsg(1,socket.CMSG_SPACE(64),socket.MSG_CMSG_CLOEXEC|socket.MSG_DONTWAIT)
        except BlockingIOError: select.select([channel],[],[],0.01);continue
        received=[]
        for level,kind,body in ancillary:
            if level==socket.SOL_SOCKET and kind==socket.SCM_RIGHTS:
                values=array.array('i');values.frombytes(body[:len(body)-len(body)%values.itemsize]);received.extend(values)
        close_error=None
        for fd in received:
            try:os.close(fd)
            except OSError as error:close_error=error
        if close_error is not None:raise close_error
        if ancillary or flags&(socket.MSG_TRUNC|socket.MSG_CTRUNC) or not part or len(raw)>=1024:raise ValueError('PLAIN_HANDOFF_FRAME_REQUIRED')
        raw.extend(part)
    if time.monotonic()>=deadline:raise TimeoutError('HANDOFF_DEADLINE')
    def pairs(items):
        result={}
        for key,value in items:
            if key in result:raise ValueError('DUPLICATE_HANDOFF_KEY')
            result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=pairs)


class Rendezvous:
    def __init__(self,expected,profile='ingress'):
        if profile not in ('ingress','http'): raise ValueError('FIXED_RENDEZVOUS_PROFILE_REQUIRED')
        self.profile=profile
        global _FENCED
        if _FENCED:raise ValueError('PREVIOUS_HANDOFF_UNCERTAIN')
        self.modules=load_modules(expected);self.sources=dict(expected)
        self.uuid=uuid.uuid4().hex;self.nonce=uuid.uuid4().hex
        self.unit='codex-cli-resource-'+self.uuid+'.service'
        self.path=f'/run/user/{os.getuid()}/rc-ingress-{self.uuid}'
        self.socket_path=self.path+'/handoff.sock'
        self.listener=None;self.channel=None;self.pin=None;self.directory_identity=None;self.socket_identity=None
        self._directory_created=False;self._socket_bound=False
        self.used=False;self.transferred=False;self.closed=False;self.broker=None;self.peers=()
        self.route_started=False;self.route_threads=[];self.route_stop=threading.Event();self.route_active=threading.Event()
        self._final_route=None;self._cleanup_result=None;self._path_cleanup={'socketRemoved':False,'directoryRemoved':False}
        self.route_reports=[];self.route_errors=[];self.route_counts={'beforeBytes':0,'afterBytes':0,'eof':False}
        try:
            for path in ('/run','/run/user',f'/run/user/{os.getuid()}'):
                value=os.lstat(path)
                if not stat.S_ISDIR(value.st_mode):raise ValueError('PRIVATE_RUNTIME_PATH_REQUIRED')
                if path.endswith('/'+str(os.getuid())) and value.st_uid!=os.getuid():raise ValueError('PRIVATE_RUNTIME_OWNER')
            os.mkdir(self.path,0o700)
            self._directory_created=True
            self.directory_identity=identity(os.lstat(self.path))
            if self.directory_identity[2:] != (stat.S_IFDIR|0o700,os.getuid()):raise ValueError('OWN_DIRECTORY_MODE')
            self.listener=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)
            self.listener.set_inheritable(False);self.listener.setblocking(False)
            self.listener.bind(self.socket_path);self._socket_bound=True
            os.chmod(self.socket_path,0o600)
            self.socket_identity=identity(os.lstat(self.socket_path))
            if self.socket_identity[2:] != (stat.S_IFSOCK|0o600,os.getuid()):raise ValueError('OWN_SOCKET_MODE')
            self.listener.listen(1)
            self.broker,ingress,upstream,control=self.modules.proxy.create_offline_session()
            self.peers=(ingress,upstream,control)
        except BaseException:
            self.close();raise

    def receiver_argv(self):
        if self.closed:raise ValueError('HANDOFF_CLOSED')
        ticks=self.modules.relay.process_start_ticks(os.getpid())
        return ('/usr/bin/python3','-I','-S',str(ROOT/'subscription-systemd-ingress-receiver.py'),'--http-handoff' if self.profile=='http' else '--handoff',
            self.uuid,self.nonce,str(os.getpid()),ticks,str(self.socket_identity[0]),str(self.socket_identity[1]))

    def ownership(self):
        self._check_path()
        return {'unit':self.unit,'uuid':self.uuid,'nonce':self.nonce,'controllerPid':os.getpid(),
            'controllerStartTicks':self.modules.relay.process_start_ticks(os.getpid()),
            'rendezvous':{'path':self.socket_path,'dev':self.socket_identity[0],'ino':self.socket_identity[1]},
            'sourceSha256':dict(self.sources)}

    def _sources_match(self):
        return all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==value for name,value in self.sources.items())

    def _check_path(self):
        if identity(os.lstat(self.path))!=self.directory_identity or identity(os.lstat(self.socket_path))!=self.socket_identity:raise ValueError('HANDOFF_PATH_CHANGED')

    def transfer(self,manager_identity,manager_fd):
        global _FENCED
        if self.used or self.closed:raise ValueError('HANDOFF_SINGLE_USE')
        self.used=True;deadline=time.monotonic()+5.0
        receiver,relay,probe=self.modules.receiver,self.modules.relay,self.modules.probe
        try:
            self._check_path()
            while True:
                receiver.check_time(deadline)
                try:self.channel,_=self.listener.accept();break
                except BlockingIOError:select.select([self.listener],[],[],0.01)
            self.channel.set_inheritable(False);self.channel.setblocking(False)
            receiver.check_time(deadline)
            current=relay.binding(probe,self.unit,manager_identity,manager_fd)
            raw=self.channel.getsockopt(socket.SOL_SOCKET,socket.SO_PEERCRED,12)
            if len(raw)!=12:raise ValueError('RECEIVER_PEER_SIZE')
            pid,uid,gid=struct.unpack('=3i',raw)
            if pid!=current['unitMainPid'] or uid!=os.getuid() or gid!=os.getgid():raise ValueError('RECEIVER_NOT_UNIT_MAINPID')
            self.pin=os.pidfd_open(pid);signal.pidfd_send_signal(self.pin,0)
            hello=receive_plain(self.channel,deadline)
            expected={'version':1,'type':'receiver_hello','uuid':self.uuid,'nonce':self.nonce,'pid':pid,'startTicks':current['unitMainStartTimeTicks']}
            if json.dumps(hello,sort_keys=True)!=json.dumps(expected,sort_keys=True):raise ValueError('RECEIVER_HELLO_IDENTITY')
            ingress=self.peers[0];value=os.fstat(ingress.fileno())
            socket_info={'dev':value.st_dev,'ino':value.st_ino,'type':stat.S_IFMT(value.st_mode),'family':int(ingress.family),'socketType':ingress.getsockopt(socket.SOL_SOCKET,socket.SO_TYPE)}
            if socket_info['type']!=49152 or socket_info['family']!=1 or socket_info['socketType']!=1:raise ValueError('OWNED_INGRESS_SOCKET_REQUIRED')
            receiver.send_frame(self.channel,{'version':1,'type':'fd_offer','uuid':self.uuid,'nonce':self.nonce,'socket':socket_info},deadline)
            readback=relay.exact_readback(probe,self.unit)
            if relay.binding(probe,self.unit,manager_identity,manager_fd)!=current:raise ValueError('PRE_TRANSFER_MAINPID_CHANGED')
            self._check_path()
            if not self._sources_match():raise ValueError('PRE_TRANSFER_SOURCE_DRIFT')
            signal.pidfd_send_signal(self.pin,0);receiver.check_time(deadline)
            # One attempt only: no retry after any ambiguous ancillary send.
            count=self.channel.sendmsg([b'F'],[(socket.SOL_SOCKET,socket.SCM_RIGHTS,array.array('i',[ingress.fileno()]).tobytes())],socket.MSG_DONTWAIT)
            if count!=1:raise ValueError('FD_TRANSFER_NOT_COMPLETE')
            self.transferred=True
            receiver.check_time(deadline)
            ack=receive_plain(self.channel,deadline)
            expected={'version':1,'type':'fd_received','uuid':self.uuid,'nonce':self.nonce,'fd':198,'socket':socket_info}
            if json.dumps(ack,sort_keys=True)!=json.dumps(expected,sort_keys=True):raise ValueError('FD_ACK_IDENTITY')
            if relay.binding(probe,self.unit,manager_identity,manager_fd)!=current:raise ValueError('POST_TRANSFER_MAINPID_CHANGED')
            signal.pidfd_send_signal(self.pin,0);receiver.check_time(deadline)
            ingress.close()
            return {'version':1,'unit':self.unit,'nonce':self.nonce,'socket':socket_info,'readback':readback,
                'control':current,'receiverAck':ack,'transferObserved':True,'remoteCleanup':'NOT_ATTESTED','productionReady':False}
        except BaseException:
            _FENCED=True
            self.close()
            raise
        finally:
            cleanup_failed=False
            for endpoint in (self.channel,self.listener):
                if endpoint is not None:
                    try:endpoint.close()
                    except OSError:cleanup_failed=True
            if self.pin is not None:
                try:os.close(self.pin)
                except OSError:cleanup_failed=True
            self.channel=None;self.listener=None;self.pin=None
            if cleanup_failed:
                _FENCED=True
                raise ValueError('HANDOFF_CONTROL_CLEANUP_UNKNOWN')

    def start_route(self):
        global _FENCED
        if not self.transferred or self.closed or self.route_started:raise ValueError('FIXED_ROUTE_STATE')
        self.route_started=True
        def broker_work():
            try:
                deadline=time.monotonic()+30
                while not self.route_stop.is_set():
                    if time.monotonic()>=deadline:raise TimeoutError('ROUTE_FIRST_BYTE_DEADLINE')
                    if select.select([self.broker._sockets[0]],[],[],0.05)[0]:
                        if time.monotonic()>=deadline:raise TimeoutError('ROUTE_FIRST_BYTE_DEADLINE')
                        self.route_active.set();self.route_reports.append(self.broker.run());return
            except (OSError,ValueError) as error:self.route_errors.append(type(error).__name__)
        def fixture_work():
            try:
                while not self.route_active.wait(0.05):
                    if self.route_stop.is_set():return
                deadline=time.monotonic()+self.modules.proxy.SESSION_SECONDS
                peer=self.peers[1]
                for phase,key in (('BEFORE','beforeBytes'),('AFTER','afterBytes')):
                    body=self.modules.launcher.challenge(phase,self.nonce)
                    self.route_counts[key]=self.modules.launcher.recv_exact(peer,body,deadline)
                    self.modules.receiver.check_time(deadline)
                    peer.settimeout(max(0.001,min(1.0,deadline-time.monotonic())))
                    peer.sendall(b'ACK '+body)
                self.modules.receiver.check_time(deadline)
                peer.settimeout(max(0.001,min(1.0,deadline-time.monotonic())))
                if peer.recv(1)!=b'':raise ValueError('EXTRA_ROUTE_BYTES')
                peer.shutdown(socket.SHUT_WR);self.route_counts['eof']=True
            except (OSError,ValueError) as error:self.route_errors.append(type(error).__name__)
        try:
            for target in (broker_work,fixture_work):
                thread=threading.Thread(target=target,daemon=True)
                thread.start();self.route_threads.append(thread)
        except (OSError,RuntimeError):
            _FENCED=True;self.finish_route();raise

    def finish_route(self):
        global _FENCED
        if self._final_route is not None:return self._final_route
        deadline=time.monotonic()+6
        # Preserve naturally completed EOF before issuing cancellation.
        for thread in self.route_threads:thread.join(min(0.5,max(0.0,deadline-time.monotonic())))
        self.route_stop.set()
        if any(thread.is_alive() for thread in self.route_threads):
            try:self.peers[2].settimeout(0.1);self.peers[2].send(b'C')
            except OSError:pass
        for thread in self.route_threads:thread.join(max(0.0,deadline-time.monotonic()))
        threads_closed=all(not thread.is_alive() for thread in self.route_threads)
        known=self.close()
        result={'version':1,'unit':self.unit,'nonce':self.nonce,'route':dict(self.route_counts),
            'broker':self.route_reports[0] if len(self.route_reports)==1 else None,'threadsClosed':threads_closed,
            'ownedCleanupVerified':known,'pathCleanup':dict(self._path_cleanup),
            'peersClosed':all(peer.fileno()==-1 for peer in self.peers),'errors':list(self.route_errors),'remoteUnitCleanup':'NOT_ATTESTED',
            'productionReady':False,'passed':False}
        broker=result['broker']
        try:source_match=self._sources_match()
        except OSError:source_match=False
        result['sourceStable']=source_match
        result['passed']=(source_match and threads_closed and known and not self.route_errors and len(self.route_threads)==2
            and broker is not None and broker.get('reason')=='EOF' and broker.get('brokerDescriptorsClosed') is True
            and self.route_counts=={'beforeBytes':40,'afterBytes':39,'eof':True})
        if not result['passed']:_FENCED=True
        self._final_route=result
        return result

    def close(self):
        global _FENCED
        if self.closed:return self._cleanup_result
        self.closed=True
        failed=(getattr(self,'_directory_created',False) and self.directory_identity is None
            or getattr(self,'_socket_bound',False) and self.socket_identity is None)
        sockets=[v for v in (self.channel,self.listener) if v is not None]+list(self.peers)
        if self.broker is not None:sockets+=list(self.broker._sockets)
        for value in sockets:
            try:value.close()
            except OSError:failed=True
        if self.pin is not None:
            try:os.close(self.pin)
            except OSError:failed=True
        try:
            if self.socket_identity is not None:
                self._check_path();os.unlink(self.socket_path)
                self._path_cleanup['socketRemoved']=True
            if self.directory_identity is not None:
                if identity(os.lstat(self.path))!=self.directory_identity:raise ValueError('OWN_DIRECTORY_CHANGED')
                os.rmdir(self.path)
                self._path_cleanup['directoryRemoved']=True
        except (OSError,ValueError):failed=True
        if any(value.fileno()!=-1 for value in sockets):failed=True
        self.channel=None;self.listener=None;self.pin=None
        if failed:_FENCED=True
        self._cleanup_result=not failed
        return self._cleanup_result


def create_rendezvous(expected_source_hashes):return Rendezvous(expected_source_hashes)


if __name__=='__main__':raise ValueError('REQUIRES_FIXED_RELAY_INTEGRATION')


def create_http_rendezvous(expected_source_hashes):return Rendezvous(expected_source_hashes,'http')


