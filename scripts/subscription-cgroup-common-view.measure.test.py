import copy
import io
import importlib.util
import json
from pathlib import Path
import types
import uuid

import pytest


@pytest.fixture
def driver():
    path=Path(__file__).with_name('subscription-cgroup-common-view.measure.py')
    module=types.ModuleType('common_view_measure_test');module.__file__=str(path)
    exec(compile(path.read_bytes(),str(path),'exec'),module.__dict__);return module


def fixture(driver):
    # Wire/accounting fixture only. Actual service validator composition has
    # separate tests before any actual admission.
    raw={name:b'# fixed\n' for name in driver.SOURCES}
    raw[driver.SERVICE]=b'import json\nstrict=json.loads\ndef validate_report(body,expected,deps):\n return body=={"valid":True} and len(expected)==5 and len(deps)==1\n'
    hashes={n:driver.sha(b) for n,b in raw.items()}
    def stream(data):return {'rawHex':data.hex(),'sha256':driver.sha(data),'eof':True,'overflow':False,'error':None}
    report={'state':'FINISHED','sourceSha256Before':hashes,'sourceSha256After':dict(hashes),'command':driver.command(),
        'errors':[],'exitCode':0,'timeout':False,'localClosed':True,'elapsedMs':100,'productionReady':False,'modelCalls':0,
        'stdout':stream(b'{"valid":true}\n'),'stderr':stream(b'')}
    return raw,report


def test_fixed_wire_replay(driver):
    raw,report=fixture(driver);assert driver.evaluate(report,raw)


@pytest.mark.parametrize('field,value',[('eof',False),('overflow',True),('error','OSError'),('eof',1)])
def test_reader_evidence_rejected(driver,field,value):
    raw,report=fixture(driver);report['stdout'][field]=value
    assert not driver.evaluate(report,raw)


@pytest.mark.parametrize('field,value',[('timeout',True),('localClosed',False),('exitCode',True),('elapsedMs',float('nan')),('elapsedMs',48000)])
def test_failure_never_passes(driver,field,value):
    raw,report=fixture(driver);report[field]=value;assert not driver.evaluate(report,raw)


def test_source_drift(driver):
    raw,report=fixture(driver);raw[driver.SELF]=b'changed';assert not driver.evaluate(report,raw)


def test_drain_retains_non_json_tail(driver):
    evidence={'raw':bytearray(),'eof':False,'overflow':False,'error':None}
    driver.drain(io.BytesIO(b'bad\n\x00tail'),100,evidence)
    assert evidence=={'raw':bytearray(b'bad\n\x00tail'),'eof':True,'overflow':False,'error':None}


def test_drain_overflow_explicit(driver):
    evidence={'raw':bytearray(),'eof':False,'overflow':False,'error':None}
    driver.drain(io.BytesIO(b'abcdef'),3,evidence)
    assert evidence['raw']==b'abc' and evidence['overflow'] and evidence['eof']


def test_unknown_blocks_before_sources(driver,monkeypatch):
    monkeypatch.setattr(driver.sys,'platform','win32');monkeypatch.setattr(driver.sys,'argv',['measure'])
    driver._UNKNOWN=True
    monkeypatch.setattr(driver,'capture',lambda:pytest.fail('capture after unknown'))
    with pytest.raises(ValueError,match='PRIOR_UNKNOWN'):driver.main()


def test_no_argument_override(driver,monkeypatch):
    monkeypatch.setattr(driver.sys,'platform','win32');monkeypatch.setattr(driver.sys,'argv',['measure','--unit=other'])
    with pytest.raises(ValueError,match='FIXED_WINDOWS_ENTRY'):driver.main()


@pytest.mark.parametrize('valid',[True,False])
def test_main_archives_and_seals_fixed_mock_process(driver,monkeypatch,capsys,valid):
    raw,report=fixture(driver);hashes=report['sourceSha256Before']
    monkeypatch.setattr(driver.sys,'platform','win32');monkeypatch.setattr(driver.sys,'argv',['measure'])
    monkeypatch.setattr(driver,'capture',lambda:(raw,hashes))
    real_path=Path
    mock_root=real_path('scratch')/('session8-common-view-mock-main-'+str(uuid.uuid4()))
    mock_root.mkdir()
    class SourceDirectory:
        def __truediv__(self,name):return types.SimpleNamespace(read_bytes=lambda:raw[name])
    monkeypatch.setattr(driver,'Path',lambda name:SourceDirectory() if name=='scripts' else mock_root if name=='scratch' else real_path(name))
    class Process:
        returncode=0
        def __init__(self):
            self.stdin=io.BytesIO();self.stdout=io.BytesIO(driver.encode({'valid':valid}));self.stderr=io.BytesIO()
        def poll(self):return 0
        def wait(self,timeout):return 0
        def kill(self):pytest.fail('unexpected client kill')
    launches=[]
    def spawn(argv,**kwargs):launches.append(argv);return Process()
    monkeypatch.setattr(driver.subprocess,'Popen',spawn)
    assert driver.main()==(0 if valid else 1)
    saved=json.loads(capsys.readouterr().out);artifact=json.loads(real_path(saved['artifact']).read_text())
    assert artifact['commonViewValidated'] is valid and artifact['localClosed'] is True
    assert artifact['sourceSha256Before']==artifact['sourceSha256After']==hashes
    assert launches==[driver.command()]
    for name,path in artifact['sourceArchive'].items():assert real_path(path).read_bytes()==raw[name]
    if not valid:
        with pytest.raises(ValueError,match='PRIOR_UNKNOWN'):driver.main()


def integrated_fixture(driver):
    path=Path(__file__).with_name('subscription-cgroup-common-view-service.test.py')
    spec=importlib.util.spec_from_file_location('common_service_authored_fixture',path)
    fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
    body,_,_=fixtures.complete_report()
    raw={name:Path(__file__).with_name(name).read_bytes() for name in driver.SOURCES}
    hashes={name:driver.sha(data) for name,data in raw.items()}
    body['sourceSha256']={name:hashes[name] for name in driver.FILES}
    body['sourceSha256After']=dict(body['sourceSha256'])
    body['helper']['sourceSha256']={name:hashes[name] for name in driver.FILES[1:3]}
    body['rawStdoutHex']=driver.encode(body['helper']).hex()
    _,report=fixture(driver)
    report['sourceSha256Before']=hashes;report['sourceSha256After']=dict(hashes)
    wire=driver.encode(body);report['stdout']['rawHex']=wire.hex();report['stdout']['sha256']=driver.sha(wire)
    return raw,report,body


def test_actual_service_and_sampler_pure_composition(driver):
    raw,report,_=integrated_fixture(driver)
    assert driver.evaluate(report,raw)


@pytest.mark.parametrize('case',['helper_close','pid_namespace','ancestor_inode','unit_cleanup','raw_stat'])
def test_actual_service_cross_composition_rejects(driver,case):
    raw,report,body=integrated_fixture(driver)
    if case=='helper_close':body['helper']['observation']['localHandlesClosed']=False
    elif case=='pid_namespace':body['helper']['observation']['selfIdentity']['pidNamespace']='pid:[999]'
    elif case=='ancestor_inode':
        directory=next(iter(body['helper']['observation']['directories'].values()));directory['identity']['ino']+=1
    elif case=='unit_cleanup':body['cleanup']['unitAbsent']=False
    else:body['mainAfter']['rawStatSha256']='0'*64
    body['rawStdoutHex']=driver.encode(body['helper']).hex()
    wire=driver.encode(body);report['stdout']['rawHex']=wire.hex();report['stdout']['sha256']=driver.sha(wire)
    assert not driver.evaluate(report,raw)
