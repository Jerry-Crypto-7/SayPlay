"""Own visible cgroup2 hierarchy metadata. No manager or host-global claim."""
import ctypes
import hashlib
import json
import math
import os
import re
import stat
import sys
import time

MAX_REPORT_BYTES=512*1024
CGROUP2=0x63677270
ROOT='/sys/fs/cgroup'
PROC_LIMITS={'cgroup':4096,'mountinfo':65536,'stat':4096,'status':16384}
_UNKNOWN=False
_TOKEN=object()

def exact(v,keys):return type(v) is dict and set(v)==set(keys)
def integer(v,lo=0,hi=9007199254740991):return type(v) is int and lo<=v<=hi
def require(v):
    if not v:raise ValueError('COMMON_VIEW_INVALID')
def encode(v):return json.dumps(v,sort_keys=True,separators=(',',':'),allow_nan=False).encode()
def same(a,b):return encode(a)==encode(b)
def sha(raw):return hashlib.sha256(raw).hexdigest()
def strict(raw):
    def pairs(values):
        result={}
        for k,v in values:
            if k in result:raise ValueError('DUPLICATE_KEY')
            result[k]=v
        return result
    return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in ()).throw(ValueError('NONFINITE')))
def identity(info):return {'dev':info.st_dev,'ino':info.st_ino,'type':stat.S_IFMT(info.st_mode)}
def valid_identity(v,kind):return exact(v,('dev','ino','type')) and integer(v['dev']) and integer(v['ino'],1) and type(v['type']) is int and v['type']==kind
def device_numbers(dev):return ((dev>>8)&0xfff)|((dev>>32)&0xfffff000),(dev&0xff)|((dev>>12)&0xffffff00)
def path(value):
    require(type(value) is str and value.startswith('/') and len(value)<=4096 and not any(ord(c)<32 or c in '\\' for c in value))
    require(value=='/' or all(x not in ('','.','..') for x in value[1:].split('/')))
    return value
def ancestors(uid):
    require(integer(uid,1,4294967294))
    values=[ROOT+'/user.slice',ROOT+'/user.slice/user-'+str(uid)+'.slice']
    values.append(values[-1]+'/user@'+str(uid)+'.service');values.append(values[-1]+'/app.slice');return values
def decode_mount(value):
    # Linux mountinfo has exactly these octal escape forms. Decoded control
    # characters, backslashes and ambiguous path components remain forbidden.
    def replace(match):
        require(match[0] in ('\\040','\\011','\\012','\\134'))
        return chr(int(match[0][1:],8))
    return path(re.sub(r'\\[0-9]{3}',replace,value))
def parse_mountinfo(raw):
    require(type(raw) is bytes and 0<len(raw)<=65536)
    lines=raw.decode('ascii').splitlines();require(1<=len(lines)<=512);rows=[];ids=set()
    for line in lines:
        require(len(line)<=4096 and line.count(' - ')==1)
        first,last=line.split(' - ');fields=first.split(' ');tail=last.split(' ')
        require(len(fields)>=6 and len(tail)==3 and re.fullmatch('[1-9][0-9]*',fields[0]) and re.fullmatch('[0-9]+',fields[1]) and re.fullmatch('[0-9]+:[0-9]+',fields[2]))
        mid=int(fields[0]);require(mid not in ids);ids.add(mid)
        root=decode_mount(fields[3]);point=decode_mount(fields[4]);major,minor=map(int,fields[2].split(':'))
        require(integer(mid,1) and integer(major) and integer(minor))
        rows.append({'mountId':mid,'parentId':int(fields[1]),'major':major,'minor':minor,'root':root,'mountpoint':point,'filesystem':tail[0]})
    selected=[v for v in rows if v['mountpoint']==ROOT]
    require(len(selected)==1 and selected[0]['filesystem']=='cgroup2')
    require(not any(v['mountpoint'].startswith(ROOT+'/') for v in rows))
    return selected[0]
def membership(raw):
    require(type(raw) is bytes and 0<len(raw)<=4096 and re.fullmatch(rb'0::/[^\x00\r\n]*\n',raw))
    return path(raw.decode('ascii')[3:-1])
def proc_identity(raw_stat,raw_status,namespaces):
    text=raw_stat.decode('ascii');require(0<len(raw_stat)<=4096 and text.endswith('\n') and ') ' in text)
    prefix,tail=text.rsplit(') ',1);pidtext=prefix.split(' (',1)[0];fields=tail.split()
    require(re.fullmatch('[1-9][0-9]*',pidtext) and len(fields)>=20 and fields[0] not in ('Z','X','x') and re.fullmatch('[1-9][0-9]{0,19}',fields[19]))
    pid=int(pidtext);require(integer(pid,1,2147483647))
    matches=re.findall(rb'^NSpid:\s*([0-9\t ]+)$',raw_status,re.M);require(len(matches)==1 and 0<len(raw_status)<=16384)
    nspid=[int(v) for v in matches[0].split()];require(1<=len(nspid)<=8 and all(integer(v,1,2147483647) for v in nspid) and nspid[-1]==pid)
    require(exact(namespaces,('pid','mnt','cgroup')) and all(type(v) is str and re.fullmatch(k+r':\[[1-9][0-9]{0,19}\]',v) for k,v in namespaces.items()))
    return {'pid':pid,'startTicks':fields[19],'nspid':nspid,'pidNamespace':namespaces['pid'],'mountNamespace':namespaces['mnt'],'cgroupNamespace':namespaces['cgroup']}
def raw_record(raw,info):return {'rawHex':raw.hex(),'bytes':len(raw),'sha256':sha(raw),'identity':info}
def decode_record(record,limit):
    require(exact(record,('rawHex','bytes','sha256','identity')) and type(record['rawHex']) is str and len(record['rawHex'])<=2*limit and valid_identity(record['identity'],stat.S_IFREG))
    raw=bytes.fromhex(record['rawHex']);require(raw.hex()==record['rawHex'] and integer(record['bytes'],1,limit) and len(raw)==record['bytes'] and sha(raw)==record['sha256']);return raw

class Kernel:
    def now(self):return time.monotonic()
    def uid(self):return os.getuid()
    def pid(self):return os.getpid()
    def close(self,fd):os.close(fd)
    def info(self,fd):return identity(os.fstat(fd))
    def namespace(self,kind):return os.readlink('/proc/self/ns/'+kind)
    def read(self,name,deadline):
        require(name in PROC_LIMITS);self.check(deadline)
        fd=os.open('/proc/self/'+name,os.O_RDONLY|os.O_CLOEXEC|os.O_NOFOLLOW|os.O_NONBLOCK)
        try:
            first=self.info(fd);require(valid_identity(first,stat.S_IFREG));result=bytearray()
            while True:
                self.check(deadline);piece=os.read(fd,min(4096,PROC_LIMITS[name]+1-len(result)))
                if not piece:break
                result.extend(piece);require(len(result)<=PROC_LIMITS[name])
            require(self.info(fd)==first);return raw_record(bytes(result),first)
        finally:self.close_known(fd);self.check(deadline)
    def check(self,deadline):
        if self.now()>=deadline:raise ValueError('COMMON_VIEW_DEADLINE')
    def close_known(self,fd):
        global _UNKNOWN
        try:self.close(fd)
        except BaseException:_UNKNOWN=True;raise
    def walk(self,target,deadline):
        path(target);require(target==ROOT or target.startswith(ROOT+'/'))
        flags=os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC
        owned=[]
        try:
            self.check(deadline);fd=os.open('/',flags);owned.append(fd)
            for part in target[1:].split('/'):
                self.check(deadline);fd=os.open(part,flags,dir_fd=fd);owned.append(fd)
            result=owned.pop()
            # Preserve ownership of final FD if an intermediate close fails.
            error=None
            for item in reversed(owned):
                try:self.close_known(item)
                except BaseException as failure:error=error or failure
            owned=[]
            if error:
                self.close_known(result);raise error
            try:self.check(deadline)
            except BaseException:self.close_known(result);raise
            return result
        except BaseException:
            for item in reversed(owned):
                try:self.close_known(item)
                except BaseException:pass
            raise
    def filesystem(self,fd):
        if sys.platform!='linux':raise ValueError('LINUX_FSTATFS_REQUIRED')
        libc=ctypes.CDLL(None,use_errno=True);fn=libc.fstatfs;fn.argtypes=(ctypes.c_int,ctypes.c_void_p);fn.restype=ctypes.c_int
        buffer=ctypes.create_string_buffer(256)
        if fn(fd,buffer)!=0:raise OSError(ctypes.get_errno(),'fstatfs')
        return ctypes.c_long.from_buffer(buffer).value

class SelfView:
    def __init__(self,deadline,kernel,token):
        require(token is _TOKEN);self.deadline=deadline;self.k=kernel;self.handles={};self.closed=False;self.failed=False;self.sequence=0;self.previous=None
    def _snapshot(self):
        records={name:self.k.read(name,self.deadline) for name in PROC_LIMITS}
        namespaces={}
        for kind in ('pid','mnt','cgroup'):
            self.k.check(self.deadline);namespaces[kind]=self.k.namespace(kind);self.k.check(self.deadline)
        return {'proc':records,'namespaces':namespaces}
    def sample(self):
        global _UNKNOWN
        if self.closed or self.failed:raise ValueError('COMMON_VIEW_CLOSED')
        try:
            self.k.check(self.deadline);require(self.sequence<32);began=self.k.now();uid=self.k.uid();fixed=ancestors(uid)
            before=self._snapshot();parsed=validate_snapshot(before);require(parsed['identity']['pid']==self.k.pid() and parsed['identity']['nspid']==[self.k.pid()])
            leaf=ROOT+parsed['membership'] if parsed['membership']!='/' else ROOT
            targets=list(dict.fromkeys([ROOT]+fixed+[leaf]));require(len(leaf.split('/'))<=64)
            directories={}
            for target in targets:
                self.k.check(self.deadline)
                if target not in self.handles:self.handles[target]=self.k.walk(target,self.deadline)
                fd=self.handles[target];first=self.k.info(fd);require(valid_identity(first,stat.S_IFDIR) and self.k.filesystem(fd)==CGROUP2)
                fresh=self.k.walk(target,self.deadline)
                try:require(self.k.info(fresh)==first and self.k.filesystem(fresh)==CGROUP2)
                finally:self.k.close_known(fresh)
                self.k.check(self.deadline);require(self.k.info(fd)==first)
                require(device_numbers(first['dev'])==(parsed['mount']['major'],parsed['mount']['minor']))
                directories[target]={'identity':first,'filesystemType':CGROUP2}
            require(set(self.handles)==set(targets))
            after=self._snapshot();again=validate_snapshot(after);require(same(parsed,again))
            require(all(same(before['proc'][n]['identity'],after['proc'][n]['identity']) for n in PROC_LIMITS))
            if self.previous is not None:require(same(self.previous,parsed))
            # Mountinfo and membership are compared as captured bytes too;
            # identity equality alone does not hide a changed mount table.
            for name in ('mountinfo','cgroup'):require(before['proc'][name]['sha256']==after['proc'][name]['sha256'])
            self.sequence+=1;self.previous=parsed;self.k.check(self.deadline)
            result={'version':1,'kind':'OWN_COMMON_VISIBLE_CGROUP2_VIEW','uid':uid,'sequence':self.sequence,'before':before,'after':after,
              'selfIdentity':parsed['identity'],'membership':parsed['membership'],'mount':parsed['mount'],'directories':directories,
              'startedMonotonic':began,'sealedMonotonic':self.k.now(),'localHandlesClosed':False,'hostInitialNamespaceAttested':False,
              'managerNamespaceAttested':False,'globalCapacityAttested':False}
            require(len(encode(result))<=MAX_REPORT_BYTES);self.k.check(self.deadline);return result
        except BaseException:self.failed=True;_UNKNOWN=True;self.close();raise
    def close(self):
        global _UNKNOWN
        if self.closed:return not self.failed
        self.closed=True;owned=list(self.handles.values());self.handles={}
        for fd in owned:
            try:self.k.close_known(fd)
            except BaseException:self.failed=True;_UNKNOWN=True
        try:self.k.check(self.deadline)
        except BaseException:self.failed=True;_UNKNOWN=True
        return not self.failed

def open_self_view(absolute_deadline):
    if _UNKNOWN:raise ValueError('PRIOR_COMMON_VIEW_UNKNOWN')
    require(type(absolute_deadline) in (int,float) and math.isfinite(absolute_deadline) and 0<absolute_deadline-time.monotonic()<=5)
    return SelfView(absolute_deadline,Kernel(),_TOKEN)
def sample_self(absolute_deadline):
    global _UNKNOWN
    view=open_self_view(absolute_deadline)
    try:report=view.sample()
    finally:known=view.close()
    try:
        require(known);report['localHandlesClosed']=True;report['sealedMonotonic']=view.k.now();view.k.check(absolute_deadline);return report
    except BaseException:_UNKNOWN=True;raise

def validate_snapshot(snapshot):
    require(exact(snapshot,('proc','namespaces')) and exact(snapshot['proc'],PROC_LIMITS))
    raw={n:decode_record(snapshot['proc'][n],limit) for n,limit in PROC_LIMITS.items()}
    return {'identity':proc_identity(raw['stat'],raw['status'],snapshot['namespaces']),'membership':membership(raw['cgroup']),'mount':parse_mountinfo(raw['mountinfo'])}
def validate_self_report(report):
    try:
        require(exact(report,('version','kind','uid','sequence','before','after','selfIdentity','membership','mount','directories','startedMonotonic','sealedMonotonic','localHandlesClosed','hostInitialNamespaceAttested','managerNamespaceAttested','globalCapacityAttested')))
        require(type(report['version']) is int and report['version']==1 and report['kind']=='OWN_COMMON_VISIBLE_CGROUP2_VIEW' and integer(report['sequence'],1) and type(report['localHandlesClosed']) is bool and all(report[k] is False for k in ('hostInitialNamespaceAttested','managerNamespaceAttested','globalCapacityAttested')))
        require(all(type(report[k]) in (int,float) and math.isfinite(report[k]) for k in ('startedMonotonic','sealedMonotonic')) and 0<=report['startedMonotonic']<=report['sealedMonotonic'] and report['sealedMonotonic']-report['startedMonotonic']<5)
        before=validate_snapshot(report['before']);after=validate_snapshot(report['after']);require(same(before,after) and same(before['identity'],report['selfIdentity']) and before['membership']==report['membership'] and same(before['mount'],report['mount']))
        require(report['selfIdentity']['nspid']==[report['selfIdentity']['pid']])
        require(all(report['before']['proc'][n]['sha256']==report['after']['proc'][n]['sha256'] for n in ('cgroup','mountinfo')))
        require(all(same(report['before']['proc'][n]['identity'],report['after']['proc'][n]['identity']) for n in PROC_LIMITS))
        leaf=ROOT+report['membership'] if report['membership']!='/' else ROOT
        targets=set([ROOT]+ancestors(report['uid'])+[leaf]);require(exact(report['directories'],targets))
        for item in report['directories'].values():
            require(exact(item,('identity','filesystemType')) and valid_identity(item['identity'],stat.S_IFDIR) and type(item['filesystemType']) is int and item['filesystemType']==CGROUP2)
            # Linux dev_t encoding, pure equivalent of major/minor (no OS I/O).
            major,minor=device_numbers(item['identity']['dev'])
            require(major==report['mount']['major'] and minor==report['mount']['minor'])
        require(len(encode(report))<=MAX_REPORT_BYTES);return True
    except (ValueError,TypeError,KeyError,IndexError,OverflowError):return False
def held_identity(report):
    require(validate_self_report(report));return {**strict(encode(report['selfIdentity'])),'membership':report['membership']}
def validate_common_view(observer_before,helper,observer_after,expected_binding):
    try:
        require(all(validate_self_report(v) for v in (observer_before,helper,observer_after)))
        require(exact(expected_binding,('unit','uid','mainPid','mainStartTicks','controlGroup')))
        b=expected_binding;require(type(b['unit']) is str and re.fullmatch('codex-cli-resource-[a-f0-9]{32}\\.service',b['unit']) and integer(b['mainPid'],2,2147483647) and type(b['mainStartTicks']) is str)
        fixed=ancestors(b['uid']);expected=fixed[-1].removeprefix(ROOT)+'/'+b['unit'];require(b['controlGroup']==expected and helper['membership']==expected)
        require(helper['selfIdentity']['nspid'][0]==b['mainPid'] and helper['selfIdentity']['startTicks']==b['mainStartTicks'])
        for v in (observer_before,helper,observer_after):
            require(v['selfIdentity']['pidNamespace']==observer_before['selfIdentity']['pidNamespace'] and v['selfIdentity']['nspid']==[v['selfIdentity']['pid']])
        require(same(observer_before['selfIdentity'],observer_after['selfIdentity']) and observer_before['membership']==observer_after['membership'] and observer_before['sequence']<=observer_after['sequence'])
        require(observer_before['sealedMonotonic']<=helper['startedMonotonic']<=helper['sealedMonotonic']<=observer_after['startedMonotonic'])
        for v in (helper,observer_after):
            require(v['uid']==observer_before['uid']==b['uid'] and v['selfIdentity']['cgroupNamespace']==observer_before['selfIdentity']['cgroupNamespace'])
            require(v['mount']['root']==observer_before['mount']['root'] and v['mount']['major']==observer_before['mount']['major'] and v['mount']['minor']==observer_before['mount']['minor'])
            require(all(same(v['directories'][p],observer_before['directories'][p]) for p in [ROOT]+fixed))
        require(observer_before['membership']!=expected and not observer_before['membership'].startswith(expected+'/'))
        return True
    except (ValueError,TypeError,KeyError,IndexError,OverflowError):return False

if __name__=='__main__':raise SystemExit('FIXED_OWN_METADATA_WRAPPER_REQUIRED')
