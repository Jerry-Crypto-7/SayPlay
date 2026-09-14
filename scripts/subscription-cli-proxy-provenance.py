"""Bounded own-Popen TCP endpoint observations; not atomic byte authorship."""
import hashlib
import json
import math
import os
import re
import signal
import time

PHASES=('accepted-before-read','header-complete-before-refusal')
_FENCED=False


def same(a,b):return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)
def integer(v,minimum=0):return type(v) is int and minimum<=v<=9007199254740991
def network(v):return type(v) is str and re.fullmatch(r'net:\[[1-9][0-9]*\]',v) is not None


def valid_observation(value):
    if type(value) is not dict or set(value)!={'peer','local','socket'}:return False
    for field in ('peer','local'):
        v=value[field]
        if type(v) is not list or len(v)!=2 or v[0]!='127.0.0.1' or not integer(v[1],1) or v[1]>65535:return False
    s=value['socket']
    return (value['peer']!=value['local'] and type(s) is dict and set(s)=={'dev','ino','type'}
        and all(integer(v) for v in s.values()) and s['ino']>0 and s['type']==49152)


def stat_identity(raw,pid):
    text=raw.decode('ascii');end=text.rfind(') ')
    if end<0 or not text.startswith(str(pid)+' ('):raise ValueError('OWN_STAT_FORMAT')
    fields=text[end+2:].split()
    if len(fields)<20 or re.fullmatch('[1-9][0-9]{0,31}',fields[19]) is None:raise ValueError('OWN_STAT_GENERATION')
    return fields[19]


def client_inode(raw,observation):
    if type(raw) is not bytes or len(raw)>65536:raise ValueError('TCP_BYTES_LIMIT')
    lines=raw.decode('ascii').splitlines()
    if not lines or len(lines)-1>256 or 'local_address' not in lines[0]:raise ValueError('TCP_ROWS_LIMIT_OR_HEADER')
    local=f'0100007F:{observation["peer"][1]:04X}';remote=f'0100007F:{observation["local"][1]:04X}'
    matches=[]
    for line in lines[1:]:
        fields=line.split()
        if len(fields)<10:raise ValueError('TCP_ROW_FORMAT')
        if fields[1].upper()==local and fields[2].upper()==remote and fields[3]=='01':
            if re.fullmatch('[1-9][0-9]*',fields[9]) is None:raise ValueError('TCP_INODE_REQUIRED')
            matches.append(int(fields[9]))
    if len(matches)!=1:raise ValueError('UNIQUE_ESTABLISHED_CLIENT_REQUIRED')
    if matches[0]==observation['socket']['ino']:raise ValueError('CLIENT_SERVER_SOCKET_ALIAS')
    return matches[0]


class Observer:
    def __init__(self,process,pin,start_ticks,net,deadline):
        self.process=process;self.pid=process.pid;self.pin=pin;self.start_ticks=start_ticks;self.net=net;self.deadline=deadline
        self.records=[];self.closed=False;self.failed=False;self.close_known=False

    def check_time(self):
        if time.monotonic()>=self.deadline:raise ValueError('PROVENANCE_DEADLINE')

    def io(self,call,*args):
        self.check_time();result=call(*args);self.check_time();return result

    def read(self,path,limit):
        self.check_time();fd=None
        try:
            fd=os.open(path,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK);self.check_time()
            chunks=[];size=0
            while True:
                data=self.io(os.read,fd,min(4096,limit+1-size))
                if not data:break
                chunks.append(data);size+=len(data)
                if size>limit:raise ValueError('PROVENANCE_READ_LIMIT')
            return b''.join(chunks)
        finally:
            if fd is not None:
                try:os.close(fd)
                except OSError:
                    self.fail();raise
                self.check_time()

    def identity(self):
        if self.io(self.process.poll) is not None:raise ValueError('OWN_PROCESS_EXITED')
        self.io(signal.pidfd_send_signal,self.pin,0)
        raw=self.read(f'/proc/{self.pid}/stat',4096)
        ticks=stat_identity(raw,self.pid)
        ownnet=self.io(os.readlink,f'/proc/{self.pid}/ns/net');selfnet=self.io(os.readlink,'/proc/self/ns/net')
        if ticks!=self.start_ticks or ownnet!=self.net or selfnet!=self.net:raise ValueError('OWN_IDENTITY_CHANGED')
        return {'pid':self.pid,'startTicks':ticks,'networkNamespace':ownnet,'observerNetworkNamespace':selfnet,
            'statRawHex':raw.hex(),'statSha256':hashlib.sha256(raw).hexdigest(),'pidfdAlive':True,'pollRunning':True}

    def holders(self,inode):
        holders=[];count=0;names=set();iterator=None
        try:
            self.check_time();iterator=os.scandir(f'/proc/{self.pid}/fd');self.check_time()
            while True:
                self.check_time()
                try:entry=next(iterator)
                except StopIteration:break
                self.check_time();count+=1
                if count>256 or re.fullmatch('0|[1-9][0-9]*',entry.name) is None or entry.name in names:raise ValueError('OWN_FD_LIMIT_OR_NAME')
                names.add(entry.name)
                target=self.io(os.readlink,f'/proc/{self.pid}/fd/{entry.name}')
                if len(target.encode())>4096:raise ValueError('OWN_FD_LINK_LIMIT')
                if target==f'socket:[{inode}]':holders.append(int(entry.name))
        finally:
            if iterator is not None:
                try:iterator.close()
                except OSError:self.fail();raise
                self.check_time()
        if not holders:raise ValueError('OWN_CLIENT_HOLDER_REQUIRED')
        return sorted(holders),count

    def fail(self):
        global _FENCED
        self.failed=True;_FENCED=True

    def __call__(self,phase,observation):
        if self.closed or self.failed:raise ValueError('PROVENANCE_CLOSED_OR_FAILED')
        try:
            self.check_time()
            if len(self.records)>=2 or phase!=PHASES[len(self.records)] or not valid_observation(observation):raise ValueError('PROVENANCE_PHASE_OR_OBSERVATION')
            observation=json.loads(json.dumps(observation))
            if self.records and not same(self.records[0]['observation'],observation):raise ValueError('ACCEPTED_ENDPOINT_CHANGED')
            before=self.identity();raw=self.read('/proc/net/tcp',65536);inode=client_inode(raw,observation)
            if self.records and self.records[0]['clientInode']!=inode:raise ValueError('CLIENT_INODE_CHANGED')
            holders,count=self.holders(inode);after=self.identity();self.check_time()
            record={'version':1,'phase':phase,'observation':observation,'identityBefore':before,'identityAfter':after,
                'tcpRawHex':raw.hex(),'tcpSha256':hashlib.sha256(raw).hexdigest(),'clientInode':inode,'holders':holders,
                'fdEntriesObserved':count,'capturedMonotonic':time.monotonic(),'deadlineMonotonic':self.deadline,
                'scope':'sequential-own-process-holder-not-atomic-byte-author','productionReady':False}
            self.check_time();self.records.append(record)
            return json.loads(json.dumps(record))
        except BaseException:self.fail();raise

    def close(self):
        if self.closed:return {'closed':self.close_known,'processCleanup':'NOT_ATTESTED'}
        self.closed=True
        try:os.close(self.pin)
        except OSError:self.fail();return {'closed':False,'processCleanup':'NOT_ATTESTED'}
        self.close_known=True;return {'closed':True,'processCleanup':'NOT_ATTESTED'}


def create_observer(process,retained_pidfd,start_ticks,network_namespace,deadline):
    """Trusted caller supplies only its own fixed Popen and retained pin; not PID authorization."""
    global _FENCED
    if _FENCED:raise ValueError('PROVENANCE_GLOBAL_FENCE')
    now=time.monotonic()
    if (not integer(getattr(process,'pid',None),1) or not callable(getattr(process,'poll',None)) or not integer(retained_pidfd)
        or type(start_ticks) is not str or re.fullmatch('[1-9][0-9]{0,31}',start_ticks) is None or not network(network_namespace)
        or type(deadline) not in (int,float) or not math.isfinite(deadline) or not now<deadline<=now+2):raise ValueError('TRUSTED_OWN_PROCESS_CONTRACT')
    duplicate=None
    def deadline_check():
        if time.monotonic()>=deadline:raise ValueError('PROVENANCE_DEADLINE')
    try:
        deadline_check();signal.pidfd_send_signal(retained_pidfd,0);deadline_check()
        duplicate=os.dup(retained_pidfd);deadline_check()
        os.set_inheritable(duplicate,False);deadline_check()
        if os.get_inheritable(duplicate):raise ValueError('PIN_CLOEXEC_REQUIRED')
        deadline_check()
        observer=Observer(process,duplicate,start_ticks,network_namespace,deadline)
        observer.identity();observer.check_time();return observer
    except BaseException:
        _FENCED=True
        if duplicate is not None:
            try:os.close(duplicate)
            except OSError:pass
        raise


def validate_records(records,expected_identity,expected_observation):
    try:
        if type(records) is not list or len(records)!=2 or not valid_observation(expected_observation):return False
        if type(expected_identity) is not dict or set(expected_identity)!={'pid','startTicks','networkNamespace'}:return False
        if (not integer(expected_identity['pid'],1) or not network(expected_identity['networkNamespace'])
            or type(expected_identity['startTicks']) is not str or re.fullmatch('[1-9][0-9]{0,31}',expected_identity['startTicks']) is None):return False
        last=None
        for phase,r in zip(PHASES,records):
            if type(r) is not dict or set(r)!={'version','phase','observation','identityBefore','identityAfter','tcpRawHex','tcpSha256','clientInode','holders','fdEntriesObserved','capturedMonotonic','deadlineMonotonic','scope','productionReady'}:return False
            if type(r['version']) is not int or r['version']!=1 or r['phase']!=phase or not same(r['observation'],expected_observation) or r['productionReady'] is not False or r['scope']!='sequential-own-process-holder-not-atomic-byte-author':return False
            for k in ('capturedMonotonic','deadlineMonotonic'):
                if type(r[k]) not in (int,float) or not math.isfinite(r[k]):return False
            if not r['capturedMonotonic']<r['deadlineMonotonic']:return False
            if type(r['tcpRawHex']) is not str or len(r['tcpRawHex'])>131072:return False
            raw=bytes.fromhex(r['tcpRawHex'])
            if hashlib.sha256(raw).hexdigest()!=r['tcpSha256'] or client_inode(raw,expected_observation)!=r['clientInode'] or not integer(r['clientInode'],1):return False
            if not integer(r['fdEntriesObserved'],1) or r['fdEntriesObserved']>256 or type(r['holders']) is not list or not r['holders'] or any(not integer(fd) for fd in r['holders']) or r['holders']!=sorted(set(r['holders'])) or len(r['holders'])>r['fdEntriesObserved']:return False
            for key in ('identityBefore','identityAfter'):
                i=r[key]
                if type(i) is not dict or set(i)!={'pid','startTicks','networkNamespace','observerNetworkNamespace','statRawHex','statSha256','pidfdAlive','pollRunning'}:return False
                if not same({k:i[k] for k in expected_identity},expected_identity) or i['observerNetworkNamespace']!=expected_identity['networkNamespace'] or i['pidfdAlive'] is not True or i['pollRunning'] is not True:return False
                if type(i['statRawHex']) is not str or len(i['statRawHex'])>8192:return False
                stat=bytes.fromhex(i['statRawHex'])
                if len(stat)>4096 or stat_identity(stat,i['pid'])!=i['startTicks'] or hashlib.sha256(stat).hexdigest()!=i['statSha256']:return False
            if last and (last['clientInode']!=r['clientInode'] or last['deadlineMonotonic']!=r['deadlineMonotonic'] or last['capturedMonotonic']>r['capturedMonotonic']):return False
            last=r
        return True
    except (ValueError,TypeError,KeyError,AttributeError):return False
