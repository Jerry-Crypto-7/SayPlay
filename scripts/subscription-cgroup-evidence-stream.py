"""Pure fixed-purpose evidence transport; completeness is not validation."""
import base64
import hashlib
import json
import re

LABELS = ('service', 'capacity-before-open', 'capacity-after-open',
          'target-ancestry', 'capacity-before-work', 'capacity-after-work')
LIMITS = {label: (2 * 1024 * 1024 if label in ('service', 'target-ancestry')
                  else 512 * 1024) for label in LABELS}
CHUNK = 32768
FRAME_LIMIT = 45000
RAW_LIMIT = 6 * 1024 * 1024
WIRE_LIMIT = 16 * 1024 * 1024
UNIT = re.compile(r'codex-cli-resource-[0-9a-f]{32}\.service\Z')
SHA = re.compile(r'[0-9a-f]{64}\Z')


def canonical(value):
    return (json.dumps(value, sort_keys=True, separators=(',', ':'),
                       ensure_ascii=True, allow_nan=False) + '\n').encode('ascii')


def valid_unit(unit):
    if type(unit) is not str or not UNIT.fullmatch(unit):
        raise ValueError('UNIT')


def frame(unit, label, kind, **fields):
    result = canonical(dict(version=1, type='cgroup_evidence', unit=unit,
                            label=label, kind=kind, **fields))
    if len(result) > FRAME_LIMIT:
        raise ValueError('FRAME_LIMIT')
    return result


def encode_document(unit, label, raw):
    """One frame per yield; caller must drain before requesting the next frame."""
    valid_unit(unit)
    if type(label) is not str or label not in LIMITS:
        raise ValueError('LABEL')
    if type(raw) is not bytes or not 0 < len(raw) <= LIMITS[label]:
        raise ValueError('DOCUMENT_LIMIT')
    digest = hashlib.sha256(raw).hexdigest()
    count = (len(raw) + CHUNK - 1) // CHUNK
    yield frame(unit, label, 'begin', bytes=len(raw), chunks=count, sha256=digest)
    for seq in range(count):
        data = base64.b64encode(raw[seq * CHUNK:(seq + 1) * CHUNK]).decode('ascii')
        yield frame(unit, label, 'data', seq=seq, data=data)
    yield frame(unit, label, 'end', bytes=len(raw), chunks=count, sha256=digest)


class Decoder:
    """Strict ordered replay. Any rejection permanently fences this instance."""
    def __init__(self, unit):
        valid_unit(unit)
        self.unit = unit
        self.documents = {}
        self.active = None
        self.blocked = False
        self.wire_bytes = 0

    @property
    def complete(self):
        return not self.blocked and self.active is None and len(self.documents) == len(LABELS)

    def feed(self, wire):
        try:
            return self._feed(wire)
        except (ValueError, TypeError, KeyError, UnicodeError, OverflowError, RecursionError):
            self.blocked = True
            raise ValueError('EVIDENCE_STREAM_REJECTED') from None

    def _feed(self, wire):
        if self.blocked or self.complete or type(wire) is not bytes or not 0 < len(wire) <= FRAME_LIMIT:
            raise ValueError('STATE_OR_SIZE')
        self.wire_bytes += len(wire)
        if self.wire_bytes > WIRE_LIMIT:
            raise ValueError('WIRE_LIMIT')
        value = json.loads(wire)
        if type(value) is not dict or canonical(value) != wire:
            raise ValueError('CANONICAL')
        label = LABELS[len(self.documents)]
        common = dict(version=1, type='cgroup_evidence', unit=self.unit, label=label)
        if any(type(value.get(k)) is not type(v) or value[k] != v for k, v in common.items()):
            raise ValueError('BINDING')
        kind = value.get('kind')
        base = set(common) | {'kind'}
        if kind in ('begin', 'end'):
            if set(value) != base | {'bytes', 'chunks', 'sha256'}:
                raise ValueError('KEYS')
            size, count, digest = value['bytes'], value['chunks'], value['sha256']
            if (type(size) is not int or not 0 < size <= LIMITS[label] or
                    type(count) is not int or count != (size + CHUNK - 1) // CHUNK or
                    type(digest) is not str or not SHA.fullmatch(digest)):
                raise ValueError('HEADER')
            if kind == 'begin':
                if self.active is not None:
                    raise ValueError('DUPLICATE_BEGIN')
                self.active = dict(size=size, count=count, digest=digest, seq=0, raw=bytearray())
                return None
            a = self.active
            if (a is None or (size, count, digest) != (a['size'], a['count'], a['digest']) or
                    a['seq'] != count or len(a['raw']) != size or
                    hashlib.sha256(a['raw']).hexdigest() != digest):
                raise ValueError('INCOMPLETE')
            result = dict(label=label, sha256=digest, bytes=size, raw=bytes(a['raw']))
            self.documents[label] = dict(label=label, sha256=digest, bytes=size)
            self.active = None
            return result
        if kind != 'data' or set(value) != base | {'seq', 'data'} or self.active is None:
            raise ValueError('KIND')
        a = self.active
        if type(value['seq']) is not int or value['seq'] != a['seq'] or a['seq'] >= a['count']:
            raise ValueError('SEQUENCE')
        if type(value['data']) is not str:
            raise ValueError('DATA')
        raw = base64.b64decode(value['data'], validate=True)
        if (base64.b64encode(raw).decode('ascii') != value['data'] or
                len(raw) != min(CHUNK, a['size'] - len(a['raw']))):
            raise ValueError('CHUNK')
        a['raw'].extend(raw)
        a['seq'] += 1
        return None

    def finish(self):
        if not self.complete:
            self.blocked = True
            raise ValueError('INCOMPLETE')
        return dict(self.documents)


def worst_case_budget():
    """Exact evidence wire fixture plus conservative existing transport reserves."""
    unit = 'codex-cli-resource-' + 'f' * 32 + '.service'
    evidence = 0
    maximum = 0
    for label in LABELS:
        for wire in encode_document(unit, label, b'x' * LIMITS[label]):
            evidence += len(wire)
            maximum = max(maximum, len(wire))
    # 3MiB decoded child, 32KiB chunks; 1KiB envelope reserved per chunk.
    child = 96 * (4 * ((CHUNK + 2) // 3) + 1024)
    observations = 40 * FRAME_LIMIT
    reserve = 1024 * 1024  # terminal/control/cleanup framing, hard aggregate still applies
    return dict(evidenceBytes=evidence, maximumFrameBytes=maximum,
                childWireReserve=child, observationReserve=observations,
                framingReserve=reserve, total=evidence + child + observations + reserve,
                wireLimit=WIRE_LIMIT)
