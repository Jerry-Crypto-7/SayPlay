"""Pure linkage of completed metadata documents; never stress admission alone."""
import json
import re

LABELS=('service','capacity-before-open','capacity-after-open','target-ancestry',
        'capacity-before-work','capacity-after-work')
LIMITS=(2*1024*1024,512*1024,512*1024,2*1024*1024,512*1024,512*1024)


def require(value):
    if not value:raise ValueError('COMMON_EVIDENCE_LINKAGE')
def same(a,b):return json.dumps(a,sort_keys=True,allow_nan=False)==json.dumps(b,sort_keys=True,allow_nan=False)
def strict(raw):
    def pairs(items):
        result={}
        for key,value in items:
            require(key not in result);result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=pairs,
        parse_constant=lambda _:(_ for _ in ()).throw(ValueError('COMMON_EVIDENCE_NONFINITE')))


def match_view(value,anchor,sampler):
    require(sampler.validate_self_report(value) is True)
    require(value['uid']==anchor['uid'] and same(value['selfIdentity'],anchor['selfIdentity'])
            and value['membership']==anchor['membership'])
    require(all(value['mount'][key]==anchor['mount'][key] for key in ('root','major','minor')))
    require(all(same(value['directories'][path],anchor['directories'][path])
                for path in [sampler.ROOT]+sampler.ancestors(anchor['uid'])))


def validate_documents(documents,owner_unit,expected_hashes,deps):
    """Caller separately verifies transport, capacity numbers, resource events,
    target manager binding, actual action delivery and all final cleanup.

    Dependencies are exact source-bound private modules supplied by the trusted
    orchestrator. Python object provenance is not a cryptographic attestation.
    """
    try:
        service,sampler,target,events=deps
        require(type(documents) is dict and tuple(documents)==LABELS)
        require(type(owner_unit) is str and re.fullmatch(r'codex-cli-resource-[a-f0-9]{32}\.service',owner_unit))
        expected_names=set(service.FILES)|set(target.FILES)
        require(type(expected_hashes) is dict and set(expected_hashes)==expected_names
                and all(type(value) is str and re.fullmatch('[a-f0-9]{64}',value) for value in expected_hashes.values()))
        bodies={}
        for label,limit in zip(LABELS,LIMITS):
            raw=documents[label];require(type(raw) is bytes and 0<len(raw)<=limit);bodies[label]=strict(raw)
        report=bodies['service']
        require(service.validate_report(report,{name:expected_hashes[name] for name in service.FILES},(sampler,)) is True)
        require(report['commonViewValidated'] is True and report['unit']!=owner_unit)
        anchor=report['observerAfter']
        self_reports=[bodies[label] for label in (LABELS[1],LABELS[2],LABELS[4],LABELS[5])]
        for value in self_reports:
            match_view(value,anchor,sampler);require(value['localHandlesClosed'] is True)
        ancestry=bodies['target-ancestry']
        require(target.validate_report(ancestry,{name:expected_hashes[name] for name in target.FILES},(sampler,events)) is True)
        require(ancestry['unit']==owner_unit)
        for key in ('commonSnapshot','observerBefore','observerAfter'):match_view(ancestry[key],anchor,sampler)
        first,last,before_work,after_work=self_reports
        common=ancestry['commonSnapshot']
        # Fixed composition reuses the completed after-open snapshot. Its own
        # sampling start precedes its seal; the target begins after that seal.
        require(same(common,last))
        times=[anchor['sealedMonotonic'],first['startedMonotonic'],first['sealedMonotonic'],
               last['startedMonotonic'],last['sealedMonotonic'],
               ancestry['startedMonotonic'],ancestry['sealedMonotonic'],before_work['startedMonotonic'],
               before_work['sealedMonotonic'],after_work['startedMonotonic'],after_work['sealedMonotonic']]
        require(times==sorted(times))
        return True
    except (ValueError,TypeError,KeyError,IndexError,AttributeError,OverflowError,RecursionError):return False
