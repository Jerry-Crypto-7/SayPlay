"""Fixed subscription CONNECT opaque relay; no runtime integration by default."""
import hashlib
import ipaddress
import json
import math
import os
import selectors
import signal
import socket
import stat
import subprocess
import time

REQUEST=b'CONNECT chatgpt.com:443 HTTP/1.1\r\nHost: chatgpt.com:443\r\nProxy-Connection: Keep-Alive\r\n\r\n'
RESPONSE=b'HTTP/1.1 200 Connection Established\r\n\r\n'
RESOLVER='/usr/bin/inference-egress-resolver.py'
RESOLVER_ARGV=('/usr/bin/python3','-I','-S',RESOLVER)
RESOLVER_ENV={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'}
QUEUE_LIMIT=65536
BYTE_LIMIT=8*1024*1024  # Aggregate encrypted transport reads, not model plaintext.
MAX_JOB_SECONDS=180
HEADER_SECONDS=2
DNS_SECONDS=2
CONNECT_SECONDS=2
DNS_CLEANUP_SECONDS=1
_TOKEN=object()
_FENCED=False
SPECIAL_V4=tuple(ipaddress.ip_network(value) for value in (
    '0.0.0.0/8','10.0.0.0/8','100.64.0.0/10','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12',
    '192.0.0.0/24','192.0.2.0/24','192.31.196.0/24','192.52.193.0/24','192.88.99.0/24',
    '192.168.0.0/16','192.175.48.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24',
    '224.0.0.0/4','240.0.0.0/4'))
NATIVE_V6=ipaddress.ip_network('2000::/3')
SPECIAL_V6=tuple(ipaddress.ip_network(value) for value in (
    '2001::/23','2001:db8::/32','2002::/16','2620:4f:8000::/48','3fff::/20','3ffe::/16'))


def strict_json(raw):
    def pairs(items):
        out={}
        for k,v in items:
            if k in out:raise ValueError('DUPLICATE_DNS_KEY')
            out[k]=v
        return out
    return json.loads(raw.decode('ascii'),object_pairs_hook=pairs,
                      parse_constant=lambda _:(_ for _ in ()).throw(ValueError('NONFINITE_DNS')))


def public_candidate(value):
    if type(value) is not dict or set(value)!={'family','address','port'} or type(value['family']) is not int or value['family'] not in (4,6) or type(value['port']) is not int or value['port']!=443 or type(value['address']) is not str or '%' in value['address']:
        raise ValueError('FIXED_DNS_CANDIDATE')
    address=ipaddress.ip_address(value['address'])
    if address.version!=value['family'] or str(address)!=value['address'] or not address.is_global or address.is_private or address.is_loopback or address.is_link_local or address.is_multicast or address.is_reserved or address.is_unspecified:
        raise ValueError('NONPUBLIC_DNS_ADDRESS')
    if address.version==6 and (address.ipv4_mapped is not None or address.sixtofour is not None or address.teredo is not None or address.is_site_local):
        raise ValueError('TRANSLATED_DNS_ADDRESS')
    if address.version==4 and any(address in prefix for prefix in SPECIAL_V4):raise ValueError('NONPUBLIC_DNS_ADDRESS')
    if address.version==6 and (address not in NATIVE_V6 or any(address in prefix for prefix in SPECIAL_V6)):raise ValueError('NONPUBLIC_DNS_ADDRESS')
    return ((socket.AF_INET,(str(address),443)) if address.version==4 else
            (socket.AF_INET6,(str(address),443,0,0)))


def select_address(raw):
    if type(raw) is not bytes or not 0<len(raw)<=4096:raise ValueError('DNS_OUTPUT_LIMIT')
    value=strict_json(raw)
    if type(value) is not dict or set(value)!={'version','host','port','candidates'} or type(value['version']) is not int or value['version']!=1 or value['host']!='chatgpt.com' or type(value['port']) is not int or value['port']!=443 or type(value['candidates']) is not list or not 1<=len(value['candidates'])<=16:
        raise ValueError('FIXED_DNS_RESPONSE')
    selected=[public_candidate(candidate) for candidate in value['candidates']]
    if len(set(selected))!=len(selected):raise ValueError('DUPLICATE_DNS_ADDRESS')
    # Validate every returned candidate, then select exactly one. Never retry.
    return selected[0]


def resolver_identity():
    global _FENCED
    fd=os.open(RESOLVER,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
    try:
        before=os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or not 0<before.st_size<=65536 or not os.fstatvfs(fd).f_flag&os.ST_RDONLY:raise ValueError('READONLY_RESOLVER_REQUIRED')
        raw=os.read(fd,65537);after=os.fstat(fd)
        if len(raw)!=before.st_size or (before.st_dev,before.st_ino,before.st_mtime_ns)!=(after.st_dev,after.st_ino,after.st_mtime_ns):raise ValueError('RESOLVER_SOURCE_DRIFT')
        return {'sha256':hashlib.sha256(raw).hexdigest(),'dev':before.st_dev,'ino':before.st_ino,'bytes':len(raw)}
    finally:
        try:os.close(fd)
        except BaseException:
            _FENCED=True
            raise


class ResolverTask:
    def __init__(self):
        self.process=None;self.pin=None;self.stdout=bytearray();self.stderr_bytes=0
        self.eof={'stdout':False,'stderr':False};self.cutoff=None;self.source=None
        self.cleanup_known=None;self._closed=False
        self.cleanup_method='not-spawned';self.reaped=False;self.pinned=False

    def start(self,selector,deadline):
        now=time.monotonic()
        if deadline-now<=DNS_CLEANUP_SECONDS:raise ValueError('DNS_CLEANUP_RESERVE')
        self.cutoff=min(now+DNS_SECONDS,deadline-DNS_CLEANUP_SECONDS)
        self.source=resolver_identity()
        if time.monotonic()>=self.cutoff:raise ValueError('DNS_DEADLINE')
        self.process=subprocess.Popen(RESOLVER_ARGV,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,
                                      cwd='/',env=dict(RESOLVER_ENV),close_fds=True)
        # Caller already owns this task; every post-Popen failure reaches close().
        self.pin=os.pidfd_open(self.process.pid)
        self.pinned=True
        os.set_inheritable(self.pin,False)
        signal.pidfd_send_signal(self.pin,0)
        for name in ('stdout','stderr'):
            stream=getattr(self.process,name);os.set_blocking(stream.fileno(),False)
            selector.register(stream,selectors.EVENT_READ,('dns',name))
        if resolver_identity()!=self.source:raise ValueError('RESOLVER_SOURCE_DRIFT')
        if time.monotonic()>=self.cutoff:raise ValueError('DNS_DEADLINE')

    def feed(self,name,raw):
        if not raw:self.eof[name]=True;return
        if name=='stdout':
            if len(self.stdout)+len(raw)>4096:raise ValueError('DNS_OUTPUT_LIMIT')
            self.stdout.extend(raw)
        else:
            self.stderr_bytes+=len(raw)
            if self.stderr_bytes>4096:raise ValueError('DNS_STDERR_LIMIT')

    def close(self,deadline):
        global _FENCED
        if self._closed:return self.cleanup_known
        self._closed=True;known=not _FENCED
        process=self.process
        if process is not None:
            try:
                try:code=process.poll()
                except Exception:
                    # Sole waiter still owns this unreaped Popen. Preserve the
                    # observation failure, but do not skip termination/reaping.
                    known=False;code=process.returncode
                if code is None:
                    try:
                        if self.pin is None:
                            # Sole-owned unreaped Popen, never a caller PID.
                            self.cleanup_method='sole-owned-popen-kill'
                            process.kill()
                        else:
                            self.cleanup_method='own-pidfd-kill'
                            signal.pidfd_send_signal(self.pin,signal.SIGKILL)
                    except ProcessLookupError:pass
                    except Exception:known=False
                    # A failed kill must not skip the bounded reap attempt.
                    remaining=min(DNS_CLEANUP_SECONDS,max(0,deadline-time.monotonic()))
                    if remaining<=0:known=False
                    else:
                        try:process.wait(timeout=remaining)
                        except subprocess.TimeoutExpired:known=False
                else:self.cleanup_method='already-exited'
                self.reaped=process.poll() is not None
                if not self.reaped:known=False
                if self.pin is not None:
                    try:signal.pidfd_send_signal(self.pin,0);known=False
                    except ProcessLookupError:pass
            except Exception:known=False
            for name in ('stdout','stderr'):
                stream=getattr(process,name,None)
                if stream is not None:
                    try:stream.close()
                    except Exception:known=False
        if self.pin is not None:
            try:os.close(self.pin)
            except OSError:known=False
            self.pin=None
        self.cleanup_known=known
        if not known:_FENCED=True
        return known


def create_session(absolute_deadline):
    global _FENCED
    if _FENCED:raise ValueError('PRIOR_CLEANUP_UNKNOWN')
    began=time.monotonic()
    if type(absolute_deadline) not in (int,float) or not math.isfinite(absolute_deadline) or not began<absolute_deadline<=began+MAX_JOB_SECONDS:raise ValueError('ABSOLUTE_DEADLINE')
    owned=[]
    try:
        ingress,client=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM);owned.extend((ingress,client))
        control,controller=socket.socketpair(socket.AF_UNIX,socket.SOCK_STREAM);owned.extend((control,controller))
        for endpoint in owned:endpoint.setblocking(False);endpoint.set_inheritable(False)
        if time.monotonic()>=absolute_deadline:raise ValueError('ABSOLUTE_DEADLINE')
        return Session(ingress,control,began,absolute_deadline,_TOKEN),client,controller
    except BaseException:
        for endpoint in owned:
            try:endpoint.close()
            except Exception:_FENCED=True
        raise


class Session:
    def __init__(self,ingress,control,began,deadline,token):
        if token is not _TOKEN:raise ValueError('FACTORY_ONLY')
        self.ingress=ingress;self.control=control;self.began=began;self.deadline=deadline
        self.upstream=None;self.selector=None;self.resolver=None;self.used=False;self.closed=False;self.cleanup_known=None

    def close(self):
        global _FENCED
        if self.closed:return self.cleanup_known
        self.closed=True;known=not _FENCED
        if self.resolver is not None:known=self.resolver.close(self.deadline) is True
        for endpoint in (self.upstream,self.ingress,self.control,self.selector):
            if endpoint is not None:
                try:endpoint.close()
                except Exception:known=False
        self.cleanup_known=known
        if not known:_FENCED=True
        return known

    def run(self):
        if self.closed or self.used or _FENCED:raise ValueError('SESSION_UNAVAILABLE')
        self.used=True;phase='header';reason=None;header=bytearray();connected=False;response_written=0
        observed={'ingress':0,'upstream':0};delivered={'ingress':0,'upstream':0}
        pending={'ingress':bytearray(),'upstream':bytearray()};eof={'ingress':False,'upstream':False};half={'ingress':False,'upstream':False}
        selected=None;connect_deadline=None;connect_calls=0;dns_clean=False
        def check():
            if time.monotonic()>=self.deadline:raise ValueError('ABSOLUTE_DEADLINE')
            if phase=='header' and time.monotonic()>=min(self.began+HEADER_SECONDS,self.deadline):raise ValueError('HEADER_DEADLINE')
            if phase=='dns' and time.monotonic()>=self.resolver.cutoff:raise ValueError('DNS_DEADLINE')
            if phase=='connect' and time.monotonic()>=connect_deadline:raise ValueError('CONNECT_DEADLINE')
        def observe(name,raw):
            observed[name]+=len(raw)
            if sum(observed.values())>BYTE_LIMIT:raise ValueError('ENCRYPTED_BYTE_LIMIT')
        def register(endpoint,events,label):
            try:self.selector.get_key(endpoint)
            except KeyError:
                if events:self.selector.register(endpoint,events,label)
            else:
                if events:self.selector.modify(endpoint,events,label)
                else:self.selector.unregister(endpoint)
        try:
            check();self.selector=selectors.DefaultSelector()
            register(self.control,selectors.EVENT_READ,'control')
            register(self.ingress,selectors.EVENT_READ,'ingress')
            while True:
                check()
                if phase=='dns' and all(self.resolver.eof.values()) and self.resolver.process.poll() is not None:
                    if self.resolver.process.returncode!=0 or self.resolver.stderr_bytes:raise ValueError('DNS_FAILURE')
                    selected=select_address(bytes(self.resolver.stdout))
                    dns_clean=self.resolver.close(self.deadline) is True
                    if not dns_clean:raise ValueError('DNS_CLEANUP_UNKNOWN')
                    check()
                    self.upstream=socket.socket(selected[0],socket.SOCK_STREAM,socket.IPPROTO_TCP)
                    self.upstream.setblocking(False);self.upstream.set_inheritable(False)
                    connect_deadline=min(self.deadline,time.monotonic()+CONNECT_SECONDS);phase='connect'
                    connect_calls+=1;code=self.upstream.connect_ex(selected[1]);check()
                    if type(code) is not int or code not in (0,11,114,115):raise ValueError('UPSTREAM_CONNECT_FAILED')
                    register(self.upstream,selectors.EVENT_WRITE,'upstream')
                if phase=='tunnel':
                    for name,endpoint in (('ingress',self.ingress),('upstream',self.upstream)):
                        other='upstream' if name=='ingress' else 'ingress'
                        if eof[other] and not pending[name] and not half[name]:
                            endpoint.shutdown(socket.SHUT_WR);half[name]=True;check()
                        events=(selectors.EVENT_READ if not eof[name] and len(pending[other])<QUEUE_LIMIT else 0)|(selectors.EVENT_WRITE if pending[name] else 0)
                        register(endpoint,events,name)
                    if all(eof.values()) and not any(pending.values()):check();reason='EOF';break
                events=self.selector.select(min(.01,max(0,self.deadline-time.monotonic())));check()
                # Control wins over a simultaneous socket readiness notification.
                for key,mask in sorted(events,key=lambda item:item[0].data!='control'):
                    check();label=key.data
                    if label=='control':
                        try:raw=self.control.recv(2)
                        except BlockingIOError:continue
                        check();raise ValueError('CANCELLED' if raw==b'C' else 'CONTROL_EOF' if raw==b'' else 'CONTROL_INVALID')
                    if type(label) is tuple:
                        try:raw=os.read(key.fileobj.fileno(),4097)
                        except BlockingIOError:continue
                        check();self.resolver.feed(label[1],raw)
                        if not raw:self.selector.unregister(key.fileobj)
                        continue
                    if phase=='connect' and label=='upstream':
                        socket_error=self.upstream.getsockopt(socket.SOL_SOCKET,socket.SO_ERROR)
                        if type(socket_error) is not int or socket_error!=0:raise ValueError('UPSTREAM_CONNECT_FAILED')
                        check()
                        if self.upstream.getpeername()!=selected[1]:raise ValueError('CONNECTED_PEER_MISMATCH')
                        self.upstream.getsockname();check();connected=True;phase='response'
                        pending['ingress'].extend(RESPONSE)
                        register(self.upstream,0,'upstream');register(self.ingress,selectors.EVENT_READ|selectors.EVENT_WRITE,'ingress')
                        continue
                    endpoint=self.ingress if label=='ingress' else self.upstream
                    if mask&selectors.EVENT_READ:
                        other='upstream' if label=='ingress' else 'ingress'
                        size=min(4096,BYTE_LIMIT-sum(observed.values())+1,
                                 QUEUE_LIMIT-len(pending[other]) if phase=='tunnel' else len(REQUEST)+1)
                        try:raw=endpoint.recv(size)
                        except BlockingIOError:raw=None
                        check()
                        if raw is not None:
                            observe(label,raw)
                            if phase=='header':
                                if not raw:raise ValueError('HEADER_EOF')
                                header.extend(raw)
                                if len(header)>len(REQUEST) or not REQUEST.startswith(header):raise ValueError('CONNECT_HEADER_REFUSED')
                                if bytes(header)==REQUEST:
                                    self.resolver=ResolverTask();self.resolver.start(self.selector,self.deadline);phase='dns'
                            elif phase in ('dns','connect','response'):
                                raise ValueError('EARLY_DATA' if raw else 'CLIENT_EOF_BEFORE_TUNNEL')
                            elif raw:pending[other].extend(raw)
                            else:eof[label]=True
                    if mask&selectors.EVENT_WRITE and pending[label]:
                        try:count=endpoint.send(pending[label])
                        except BlockingIOError:continue
                        if not 0<count<=len(pending[label]):raise ValueError('SOCKET_WRITE_FAILED')
                        del pending[label][:count];delivered[label]+=count
                        if phase=='response':
                            response_written+=count
                            if not pending['ingress']:phase='tunnel'
                        check()
        except Exception as error:
            allowed={'ABSOLUTE_DEADLINE','HEADER_DEADLINE','DNS_DEADLINE','CONNECT_DEADLINE','ENCRYPTED_BYTE_LIMIT','DNS_FAILURE','DNS_CLEANUP_UNKNOWN','UPSTREAM_CONNECT_FAILED','CONNECTED_PEER_MISMATCH','CANCELLED','CONTROL_EOF','CONTROL_INVALID','HEADER_EOF','CONNECT_HEADER_REFUSED','EARLY_DATA','CLIENT_EOF_BEFORE_TUNNEL','SOCKET_WRITE_FAILED','DNS_CLEANUP_RESERVE','READONLY_RESOLVER_REQUIRED','RESOLVER_SOURCE_DRIFT','DNS_OUTPUT_LIMIT','DNS_STDERR_LIMIT','NONPUBLIC_DNS_ADDRESS','TRANSLATED_DNS_ADDRESS','FIXED_DNS_CANDIDATE','FIXED_DNS_RESPONSE','DUPLICATE_DNS_ADDRESS'}
            reason=str(error) if type(error) is ValueError and str(error) in allowed else 'LOCAL_IO_FAILURE'
        finally:known=self.close()
        elapsed=(time.monotonic()-self.began)*1000
        if reason=='EOF' and time.monotonic()>=self.deadline:reason='ABSOLUTE_DEADLINE'
        return {'version':1,'profile':'fixed-subscription-inference-egress','reason':reason,'phase':phase,
                'success':reason=='EOF' and known,'cleanupKnown':known,'resolverCleanupKnown':dns_clean,
                'resolverProcess':None if self.resolver is None else {'pid':None if self.resolver.process is None else self.resolver.process.pid,
                    'pidfdObtained':self.resolver.pinned,'reaped':self.resolver.reaped,'cleanupMethod':self.resolver.cleanup_method},
                'resolverSource':None if self.resolver is None else self.resolver.source,
                'selectedSockaddr':None if selected is None else {'family':4 if selected[0]==socket.AF_INET else 6,'sockaddr':list(selected[1])},
                'connectCalls':connect_calls,'upstreamConnected':connected,'responseBytesWritten':response_written,
                'observedBytes':observed,'deliveredBytes':delivered,'retainedBytes':{k:len(v) for k,v in pending.items()},
                'streamEOF':eof,'elapsedMs':elapsed,'productionReady':False,
                'credentialFilesRead':0,'payloadLogged':False,'tlsDecrypted':False}


if __name__=='__main__':raise SystemExit('REVIEWED_RUNTIME_INTEGRATION_REQUIRED')
