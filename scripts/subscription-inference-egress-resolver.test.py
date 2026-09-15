"""Fixed DNS helper unit tests. All DNS calls are mocked."""
import importlib.util
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('resolver_tested',Path(__file__).with_name('subscription-inference-egress-resolver.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)


@pytest.fixture(autouse=True)
def no_dns(monkeypatch):
    monkeypatch.setattr(m.socket,'getaddrinfo',lambda *a,**k:pytest.fail('unmocked DNS'))


def test_fixed_single_hostname_query_and_bounded_shape(monkeypatch):
    calls=[]
    def query(*args):
        calls.append(args)
        return [(m.socket.AF_INET,m.socket.SOCK_STREAM,m.socket.IPPROTO_TCP,'',('1.1.1.1',443))]
    monkeypatch.setattr(m.socket,'getaddrinfo',query)
    assert m.resolve_fixed()=={'version':1,'host':'chatgpt.com','port':443,'candidates':[{'family':4,'address':'1.1.1.1','port':443}]}
    assert calls==[('chatgpt.com',443,m.socket.AF_UNSPEC,m.socket.SOCK_STREAM,m.socket.IPPROTO_TCP)]


@pytest.mark.parametrize('case',['empty','too-many','udp','wrong-port','ipv6-scope','ipv6-flow','address-long'])
def test_resolver_refuses_unbounded_or_noncanonical_os_records(monkeypatch,case):
    value=(m.socket.AF_INET,m.socket.SOCK_STREAM,m.socket.IPPROTO_TCP,'',('1.1.1.1',443))
    rows=[value]
    if case=='empty':rows=[]
    elif case=='too-many':rows=[value]*17
    elif case=='udp':rows=[(m.socket.AF_INET,m.socket.SOCK_DGRAM,m.socket.IPPROTO_UDP,'',('1.1.1.1',443))]
    elif case=='wrong-port':rows=[(*value[:4],('1.1.1.1',80))]
    elif case=='ipv6-scope':rows=[(m.socket.AF_INET6,m.socket.SOCK_STREAM,m.socket.IPPROTO_TCP,'',('2606:4700:4700::1111',443,0,1))]
    elif case=='ipv6-flow':rows=[(m.socket.AF_INET6,m.socket.SOCK_STREAM,m.socket.IPPROTO_TCP,'',('2606:4700:4700::1111',443,1,0))]
    elif case=='address-long':rows=[(*value[:4],('x'*65,443))]
    monkeypatch.setattr(m.socket,'getaddrinfo',lambda *a:rows)
    with pytest.raises(ValueError):m.resolve_fixed()


def test_caller_args_refused_before_query(monkeypatch):
    monkeypatch.setattr(m.sys,'platform','linux');monkeypatch.setattr(m.sys,'argv',['helper','foreign'])
    with pytest.raises(ValueError,match='FIXED_RESOLVER_ENTRY'):m.main()
