import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import pytest

def load(name):
    spec=importlib.util.spec_from_file_location(name,Path(__file__).with_name(name+'.py'))
    value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

m=load('subscription-trusted-cli-worker-probe')

def fixture():
    old=load('subscription-trusted-control-boundary-probe.test');base=old.m
    report=old.report();marker=copy.deepcopy(report['marker']['value'])
    marker[m.ROLE]={'address':['127.0.0.1',2222],'socket':{'dev':99,'ino':500,'type':49152},'networkNamespace':'net:[2]','listenerClosed':True}
    raw=json.dumps(marker,separators=(',',':')).encode()
    report['marker'].update(value=marker,rawHex=raw.hex(),bytes=len(raw),sha256=hashlib.sha256(raw).hexdigest())
    validate=m.adapt(base)
    return {'version':1,'kind':'FIXED_TRUSTED_CLI_ENDPOINT_WORKER','baseReport':report,'workerNetworkNamespace':'net:[3]'},marker,validate

def test_real_base_validator_with_added_endpoint_role():
    report,marker,validate=fixture();assert validate(report,marker)

@pytest.mark.parametrize('case',['own-fd','proc-fd','same-net','network-unknown','listener-live','body-read','version-bool'])
def test_endpoint_boundary_negatives(case):
    report,marker,validate=fixture();base=report['baseReport']
    if case=='own-fd':base['descriptors'][1].update(marker[m.ROLE]['socket'])
    elif case=='proc-fd':base['paths']['/proc/1/fd/0']={'opened':True,'errno':None,'outcome':'opened','bytesRead':0,'bytesWritten':0,'descriptor':{'fd':8,**marker[m.ROLE]['socket']}}
    elif case=='same-net':report['workerNetworkNamespace']='net:[2]'
    elif case=='network-unknown':report['workerNetworkNamespace']=None
    elif case=='listener-live':marker[m.ROLE]['listenerClosed']=False
    elif case=='body-read':base['protectedBodyBytesRead']=1
    else:report['version']=True
    assert not validate(report,marker)
