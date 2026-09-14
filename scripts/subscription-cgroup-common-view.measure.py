"""Fixed Windows measurement for the separately owned readonly metadata service."""
import hashlib
import json
import math
from pathlib import Path
import subprocess
import sys
import threading
import time
import types
import uuid

SELF='subscription-cgroup-common-view.measure.py'
SERVICE='subscription-cgroup-common-view-service.py'
FILES=(SERVICE,'subscription-cgroup-common-view.py','subscription-cgroup-common-view-child.py',
       'subscription-systemd-fixture-transport.py','subscription-systemd-cli-probe.py')
SOURCES=(*FILES,SELF)
MAX_OUTPUT=2*1024*1024
MAX_ERROR=65536
_UNKNOWN=False


def sha(data):return hashlib.sha256(data).hexdigest()
def encode(value):return (json.dumps(value,separators=(',',':'),allow_nan=False)+'\n').encode()
def load(name,raw):
    module=types.ModuleType('private_view_'+name.replace('-','_'));module.__file__='scripts/'+name
    exec(compile(raw,module.__file__,'exec'),module.__dict__);return module
def capture():
    raw={name:(Path('scripts')/name).read_bytes() for name in SOURCES}
    if any(not 0<len(data)<=1048576 for data in raw.values()):raise ValueError('COMMON_VIEW_SOURCE_BOUND')
    return raw,{name:sha(data) for name,data in raw.items()}
def command():
    return ['wsl.exe','-d','Ubuntu-24.04','--','/usr/bin/env','-i','PATH=/usr/bin:/bin',
            '/usr/bin/python3','-I','-S','/mnt/d/claude/Hackaton/scripts/'+SERVICE]


def drain(stream,limit,result):
    """Retain a bounded prefix and keep draining; overflow never gains PASS."""
    try:
        while True:
            block=stream.read(4096)
            if not block:result['eof']=True;break
            room=limit-len(result['raw']);result['raw'].extend(block[:max(0,room)])
            if len(block)>room:result['overflow']=True
    except BaseException as failure:result['error']=type(failure).__name__


def evaluate(report,raw):
    try:
        if set(raw)!=set(SOURCES):return False
        hashes={name:sha(data) for name,data in raw.items()}
        if report['sourceSha256Before']!=hashes or report['sourceSha256After']!=hashes:return False
        if report['command']!=command() or report['state']!='FINISHED' or report['errors']!=[]:return False
        if type(report['exitCode']) is not int or report['exitCode']!=0 or report['timeout'] is not False:return False
        if report['localClosed'] is not True or report['productionReady'] is not False:return False
        if type(report['elapsedMs']) not in (int,float) or not math.isfinite(report['elapsedMs']) or not 0<=report['elapsedMs']<48000:return False
        if type(report['modelCalls']) is not int or report['modelCalls']!=0:return False
        for name,limit in (('stdout',MAX_OUTPUT),('stderr',MAX_ERROR)):
            item=report[name];data=bytes.fromhex(item['rawHex'])
            if (set(item)!={'rawHex','sha256','eof','overflow','error'} or data.hex()!=item['rawHex']
                    or len(data)>limit or sha(data)!=item['sha256'] or item['eof'] is not True
                    or item['overflow'] is not False or item['error'] is not None):return False
        if report['stderr']['rawHex']!='':return False
        wire=bytes.fromhex(report['stdout']['rawHex'])
        if not wire.endswith(b'\n') or wire.count(b'\n')!=1:return False
        service=load(SERVICE,raw[SERVICE])
        body=service.strict(wire)
        sampler=load('subscription-cgroup-common-view.py',raw['subscription-cgroup-common-view.py'])
        return service.validate_report(body,{name:hashes[name] for name in FILES},(sampler,)) is True
    except (ValueError,TypeError,KeyError,AttributeError,OSError,OverflowError):return False


def main():
    global _UNKNOWN
    if sys.argv[1:] or sys.platform!='win32':raise ValueError('COMMON_VIEW_FIXED_WINDOWS_ENTRY')
    if _UNKNOWN:raise ValueError('COMMON_VIEW_PRIOR_UNKNOWN')
    raw,hashes=capture();folder=Path('scratch')/('session8-common-view-source-'+str(uuid.uuid4()));folder.mkdir()
    archived={}
    for name,data in raw.items():
        target=folder/name;target.write_bytes(data);archived[name]=str(target)
    if capture()[1]!=hashes:raise ValueError('COMMON_VIEW_SOURCE_CAPTURE_DRIFT')
    path=Path('scratch')/('session8-common-view-actual-'+str(uuid.uuid4())+'.json')
    report={'version':1,'state':'PREPARED','sourceSha256Before':hashes,'sourceArchive':archived,
            'command':command(),'productionReady':False,'modelCalls':0,'commonViewValidated':False}
    path.write_text(json.dumps(report,indent=2),encoding='utf8')
    process=None;threads=[];errors=[];timed_out=False;closed=False;began=time.monotonic()
    streams={name:{'raw':bytearray(),'eof':False,'overflow':False,'error':None} for name in ('stdout','stderr')}
    _UNKNOWN=True
    try:
        process=subprocess.Popen(command(),stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        for name,limit in (('stdout',MAX_OUTPUT),('stderr',MAX_ERROR)):
            thread=threading.Thread(target=drain,args=(getattr(process,name),limit,streams[name]),daemon=True)
            thread.start();threads.append(thread)
        # Fixed small admission fits the pipe; no arbitrary caller payload.
        process.stdin.write(encode({'type':'common_view_service','sourceSha256':{name:hashes[name] for name in FILES}}))
        process.stdin.close()
        try:process.wait(timeout=max(0.01,40-(time.monotonic()-began)))
        except subprocess.TimeoutExpired:timed_out=True;errors.append('WINDOWS_DRIVER_DEADLINE')
    except BaseException as failure:errors.append(type(failure).__name__)
    finally:
        def attempt(name,action):
            try:return action()
            except BaseException as failure:errors.append(name+':'+type(failure).__name__);return None
        if process is not None:
            if attempt('POLL',process.poll) is None:
                attempt('OWN_WINDOWS_CLIENT_KILL',process.kill)
                attempt('OWN_WINDOWS_CLIENT_REAP',lambda:process.wait(timeout=2))
            attempt('STDIN_CLOSE',process.stdin.close)
            for thread in threads:attempt('READER_JOIN',lambda thread=thread:thread.join(timeout=2))
            alive=[attempt('READER_STATE',thread.is_alive) is not False for thread in threads]
            if any(alive):errors.append('READER_STILL_RUNNING')
            for index,name in enumerate(('stdout','stderr')):
                if index>=len(alive) or not alive[index]:attempt(name+'_CLOSE',getattr(process,name).close)
            closed=attempt('FINAL_POLL',process.poll) is not None and not any(alive) and not errors
        after={}
        for name in SOURCES:
            try:after[name]=sha((Path('scripts')/name).read_bytes())
            except BaseException as failure:after[name]=None;errors.append('SOURCE_AFTER:'+type(failure).__name__)
        report.update(state='FINISHED',sourceSha256After=after,errors=errors,timeout=timed_out,
            localClosed=closed,elapsedMs=(time.monotonic()-began)*1000,
            exitCode=process.returncode if process is not None else None)
        for name,item in streams.items():
            data=bytes(item['raw']);report[name]={'rawHex':data.hex(),'sha256':sha(data),
                'eof':item['eof'],'overflow':item['overflow'],'error':item['error']}
        try:report['commonViewValidated']=evaluate(report,raw)
        except BaseException as failure:errors.append('EVALUATOR:'+type(failure).__name__)
        # Persistence failure leaves the pessimistic fence set.
        path.write_text(json.dumps(report,indent=2),encoding='utf8')
        _UNKNOWN=report['commonViewValidated'] is not True or bool(errors)
        print(json.dumps({'artifact':str(path),'commonViewValidated':not _UNKNOWN,'errors':errors}))
    return 1 if _UNKNOWN else 0


if __name__=='__main__':raise SystemExit(main())
