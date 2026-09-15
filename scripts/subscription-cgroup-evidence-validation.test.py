import copy
import hashlib
import importlib.util
import json
from pathlib import Path

import pytest


def load(name):
    path=Path(__file__).with_name(name);spec=importlib.util.spec_from_file_location(name,path)
    module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module);return module
m=load('subscription-cgroup-evidence-validation.py')


def complete_documents():
    sf=load('subscription-cgroup-common-view-service.test.py')
    tf=load('subscription-cgroup-target-ancestry.test.py')
    service,_,_=sf.complete_report();ancestry,hashes,td=tf.complete_report()
    sampler,events=td
    helper_unit='codex-cli-resource-'+'b'*32+'.service'
    helper_group=sf.fixtures.GROUP+helper_unit
    service['unit']=helper_unit;service['command']=sf.m.command(helper_unit)
    service['expectedBinding']['unit']=helper_unit;service['expectedBinding']['controlGroup']=helper_group
    for key in ('bindingBefore','bindingAfter'):service[key]['unitMainCgroup']=helper_group
    service['helper']['observation']=sf.fixtures.report(pid=202,member=helper_group,now=2)
    expected={name:hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
              for name in set(sf.m.FILES)|set(tf.m.FILES)}
    service['sourceSha256']={name:expected[name] for name in sf.m.FILES}
    service['sourceSha256After']=dict(service['sourceSha256'])
    service['helper']['sourceSha256']={name:expected[name] for name in sf.m.FILES[1:3]}
    service['rawStdoutHex']=(sf.m.encode(service['helper'])+b'\n').hex()
    def shift(value,offset):
        if isinstance(value,dict):
            for key,item in value.items():
                if key in ('startedMonotonic','sealedMonotonic','monotonic'):value[key]=item+offset
                else:shift(item,offset)
        elif isinstance(value,list):
            for item in value:shift(item,offset)
    shift(ancestry,5)
    docs={'service':service}
    for label,when in [('capacity-before-open',4),('capacity-after-open',6),('capacity-before-work',7),('capacity-after-work',8)]:
        snapshot=copy.deepcopy(ancestry['commonSnapshot'])
        snapshot['startedMonotonic']=snapshot['sealedMonotonic']=when
        snapshot['localHandlesClosed']=True;docs[label]=snapshot
    docs['target-ancestry']=ancestry
    return {label:json.dumps(docs[label],separators=(',',':')).encode() for label in m.LABELS},ancestry['unit'],expected,(sf.m,sampler,tf.m,events)


def test_full_real_validators_link_documents():
    assert m.validate_documents(*complete_documents())


@pytest.mark.parametrize('reuse',[True,False])
def test_nonzero_duration_snapshot_reuse_requires_exact_same_value(reuse):
    docs,unit,hashes,deps=complete_documents()
    ancestry=json.loads(docs['target-ancestry']);common=ancestry['commonSnapshot']
    common['startedMonotonic']=5.9;common['sealedMonotonic']=6
    after=copy.deepcopy(common)
    if not reuse:after['sequence']+=1
    docs['capacity-after-open']=json.dumps(after,separators=(',',':')).encode()
    docs['target-ancestry']=json.dumps(ancestry,separators=(',',':')).encode()
    assert m.validate_documents(docs,unit,hashes,deps) is reuse


@pytest.mark.parametrize('case',['source','owner','order','missing','observer_generation','late_initial','helper_close','target_leaf','raw_hash'])
def test_independent_linkage_failures(case):
    docs,unit,hashes,deps=complete_documents()
    if case=='source':hashes[next(iter(hashes))]='0'*64
    elif case=='owner':unit='codex-cli-resource-'+'f'*32+'.service'
    elif case=='order':docs=dict(reversed(list(docs.items())))
    elif case=='missing':docs.pop('capacity-after-work')
    else:
        label='service' if case=='helper_close' else 'target-ancestry' if case in ('target_leaf','raw_hash') else 'capacity-before-open'
        body=json.loads(docs[label])
        if case=='observer_generation':body['selfIdentity']['startTicks']='999'
        elif case=='late_initial':body['startedMonotonic']=body['sealedMonotonic']=20
        elif case=='helper_close':body['helper']['observation']['localHandlesClosed']=False
        elif case=='target_leaf':body['eventAfter']['directory']['ino']+=1
        else:body['eventBefore']['files']['memory.max']['sha256']='0'*64
        docs[label]=json.dumps(body,separators=(',',':')).encode()
    assert not m.validate_documents(docs,unit,hashes,deps)
