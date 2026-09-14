"""Bounded HTTP framing for an authored ResponsesPeer; no sockets or launcher."""
import re

MAX_HEADERS = 16 * 1024
MAX_BODY = 2 * 1024 * 1024
TOKEN = re.compile(rb"[!#$%&'*+.^_`|~0-9A-Za-z-]+\Z")


def need(value, reason):
    if not value:
        raise ValueError(reason)


class Connection:
    """One HTTP/1.1 request. Caller owns socket, deadline, writes and close.

    feed receives actual input bytes; written receives actual write counts.
    eof marks input EOF (half-close is supported). complete means the response
    was fully written, not that the remote peer read it or sockets were closed.
    """
    def __init__(self, peer):
        self.peer = peer
        self.pending = bytearray()
        self.failed = False
        self._input = bytearray()
        self._headers = None
        self._length = None
        self._accepted = False
        self._eof = False
        self._complete = False
        self._response_length = None

    @property
    def complete(self):
        return self._complete and not self.failed

    def _fail(self):
        self.failed = True
        self.pending.clear()
        # A failed connection must not allow a partially delivered peer response
        # to be reused by another connection.
        self.peer.failed = True

    def feed(self, raw):
        try:
            need(not self.failed and not self._eof and not self._accepted,
                 'HTTP_INPUT_CLOSED')
            need(type(raw) is bytes and raw, 'HTTP_INPUT_BYTES')
            need(len(self._input) + len(raw) <= MAX_HEADERS + MAX_BODY,
                 'HTTP_INPUT_BOUND')
            self._input.extend(raw)
            if self._headers is None:
                boundary = self._input.find(b'\r\n\r\n')
                if boundary < 0:
                    need(len(self._input) < MAX_HEADERS, 'HTTP_HEADER_BOUND')
                    return
                need(boundary + 4 <= MAX_HEADERS, 'HTTP_HEADER_BOUND')
                lines = bytes(self._input[:boundary]).split(b'\r\n')
                need(lines[0] == b'POST /v1/responses HTTP/1.1', 'HTTP_REQUEST_LINE')
                headers = []
                names = set()
                for line in lines[1:]:
                    name, sep, value = line.partition(b':')
                    need(sep and TOKEN.fullmatch(name), 'HTTP_HEADER_NAME')
                    need(all(c == 9 or 32 <= c <= 126 for c in value),
                         'HTTP_HEADER_VALUE')
                    key = name.decode('ascii').lower()
                    need(key not in names, 'HTTP_DUPLICATE_HEADER')
                    names.add(key)
                    headers.append((key, value.strip(b' \t').decode('ascii')))
                need(len(headers) <= 64, 'HTTP_HEADER_COUNT')
                values = dict(headers)
                need(values.get('host'), 'HTTP_HOST_REQUIRED')
                need(not ({'transfer-encoding', 'upgrade', 'content-encoding'} & names),
                     'HTTP_UNSUPPORTED_TRANSPORT')
                length = values.get('content-length', '')
                need(re.fullmatch(r'[1-9][0-9]{0,6}', length), 'HTTP_CONTENT_LENGTH')
                self._length = int(length)
                need(self._length <= MAX_BODY, 'HTTP_BODY_BOUND')
                self._headers = headers
                del self._input[:boundary + 4]
            need(len(self._input) <= self._length, 'HTTP_TRAILING_BYTES')
            if len(self._input) < self._length:
                return
            response = self.peer.prepare('POST', '/v1/responses', self._headers,
                                         bytes(self._input))
            need(type(response) is bytes and 0 < len(response) <= MAX_BODY,
                 'HTTP_RESPONSE_BOUND')
            self._response_length = len(response)
            self.pending.extend(b'HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n'
                + b'Content-Length: ' + str(len(response)).encode('ascii')
                + b'\r\nConnection: close\r\n\r\n' + response)
            self._input.clear()
            self._accepted = True
        except Exception:
            self._fail()
            raise

    def written(self, count):
        try:
            need(not self.failed and self._accepted and not self._complete
                 and type(count) is int and 0 < count <= len(self.pending),
                 'HTTP_WRITE_COUNT')
            del self.pending[:count]
            if not self.pending:
                self.peer.delivered(self._response_length)
                self._complete = True
        except Exception:
            self._fail()
            raise

    def eof(self):
        try:
            need(not self.failed and not self._eof and self._accepted,
                 'HTTP_TRUNCATED_OR_REPEATED_EOF')
            self._eof = True
        except Exception:
            self._fail()
            raise
