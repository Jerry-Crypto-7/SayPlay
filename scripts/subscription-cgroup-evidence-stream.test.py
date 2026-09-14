"""Pure transport fixtures. No kernel, service, subprocess or network."""
import importlib.util
import json
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location('evidence_stream', Path(__file__).with_name('subscription-cgroup-evidence-stream.py'))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
UNIT = 'codex-cli-resource-' + 'a' * 32 + '.service'


def test_full_worst_case_stream_and_bounded_retention():
    decoder = m.Decoder(UNIT)
    total = 0
    for label in m.LABELS:
        raw = b'x' * m.LIMITS[label]
        for wire in m.encode_document(UNIT, label, raw):
            assert len(wire) <= 45000
            result = decoder.feed(wire)
            total += len(wire)
        assert result['raw'] == raw
        assert decoder.active is None
        assert all('raw' not in entry for entry in decoder.documents.values())
    assert decoder.complete
    assert len(decoder.finish()) == 6
    budget = m.worst_case_budget()
    assert total == budget['evidenceBytes']
    assert budget['total'] < 16 * 1024 * 1024
    assert budget['maximumFrameBytes'] < 45000
    assert sum(m.LIMITS.values()) == 6 * 1024 * 1024


@pytest.mark.parametrize('size', [1, 32767, 32768, 32769, 65536])
def test_fragment_boundaries(size):
    decoder = m.Decoder(UNIT)
    for wire in m.encode_document(UNIT, 'service', b'a' * size):
        result = decoder.feed(wire)
    assert result['raw'] == b'a' * size
    assert not decoder.complete


@pytest.mark.parametrize('mutation', [
    {'version': True}, {'unit': 'other'}, {'label': 'target-ancestry'},
    {'kind': 'unknown'}, {'bytes': True}, {'bytes': 0}, {'bytes': 2097153},
    {'chunks': True}, {'chunks': 2}, {'sha256': 'A' * 64}, {'extra': 0},
])
def test_begin_mutations_fence(mutation):
    wire = next(m.encode_document(UNIT, 'service', b'x'))
    value = json.loads(wire)
    value.update(mutation)
    decoder = m.Decoder(UNIT)
    with pytest.raises(ValueError): decoder.feed(m.canonical(value))
    with pytest.raises(ValueError): decoder.feed(wire)
    assert decoder.blocked


@pytest.mark.parametrize('mutation', [
    {'seq': True}, {'seq': 1}, {'data': ''}, {'data': 'eA'},
    {'data': 'eA==\n'}, {'data': 'eB=='}, {'data': 'eHg='}, {'data': 1},
])
def test_chunk_mutations(mutation):
    frames = list(m.encode_document(UNIT, 'service', b'x'))
    decoder = m.Decoder(UNIT)
    decoder.feed(frames[0])
    value = json.loads(frames[1]); value.update(mutation)
    with pytest.raises(ValueError): decoder.feed(m.canonical(value))


def test_bad_digest_and_early_end():
    frames = list(m.encode_document(UNIT, 'service', b'x'))
    for prefix in ([frames[0]], frames[:2]):
        decoder = m.Decoder(UNIT)
        for wire in prefix: decoder.feed(wire)
        end = json.loads(frames[-1]); end['sha256'] = '0' * 64
        with pytest.raises(ValueError): decoder.feed(m.canonical(end))


def test_duplicate_begin_data_and_completed_document():
    frames = list(m.encode_document(UNIT, 'service', b'x'))
    for prefix, duplicate in [(frames[:1], frames[0]), (frames[:2], frames[1]), (frames, frames[0])]:
        decoder = m.Decoder(UNIT)
        for wire in prefix: decoder.feed(wire)
        with pytest.raises(ValueError): decoder.feed(duplicate)


@pytest.mark.parametrize('wire', [b'{}\n', b'null\n', b'[]\n', b'{', b'\xff', b'x' * 45001], ids=['empty-object','null','array','syntax','utf8','oversize'])
def test_invalid_wire(wire):
    with pytest.raises(ValueError): m.Decoder(UNIT).feed(wire)


def test_noncanonical_duplicate_keys_and_extra_newline():
    wire = next(m.encode_document(UNIT, 'service', b'x'))
    for bad in [wire + b'\n', b' ' + wire, wire.replace(b'"version":1', b'"version":1,"version":1')]:
        with pytest.raises(ValueError): m.Decoder(UNIT).feed(bad)


def test_incomplete_finish_is_irreversible():
    decoder = m.Decoder(UNIT)
    with pytest.raises(ValueError): decoder.finish()
    with pytest.raises(ValueError): decoder.feed(next(m.encode_document(UNIT, 'service', b'x')))


@pytest.mark.parametrize('label,raw', [('other', b'x'), ('service', b''), ('service', bytearray(b'x')), ('capacity-before-open', b'x' * 524289)], ids=['label','empty','mutable','oversize'])
def test_encoder_rejects(label, raw):
    with pytest.raises(ValueError): next(m.encode_document(UNIT, label, raw))


def test_encoder_is_lazy_and_global_wire_guard():
    iterator = m.encode_document(UNIT, 'service', b'x' * 2097152)
    assert iter(iterator) is iterator
    decoder = m.Decoder(UNIT)
    decoder.wire_bytes = m.WIRE_LIMIT
    with pytest.raises(ValueError): decoder.feed(next(iterator))


def test_deep_json_rejection_is_fenced():
    decoder = m.Decoder(UNIT)
    with pytest.raises(ValueError): decoder.feed(b'[' * 1500 + b'0' + b']' * 1500)
    assert decoder.blocked


@pytest.mark.parametrize('unit', ['codex-cli-resource-' + 'A' * 32 + '.service', UNIT + '/other', True])
def test_fixed_unit_only(unit):
    with pytest.raises(ValueError): m.Decoder(unit)
