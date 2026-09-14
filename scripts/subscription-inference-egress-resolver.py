"""Fixed trusted DNS helper. Parent owns deadline and direct-process cleanup."""
import json
import socket
import sys

HOST='chatgpt.com'
PORT=443
MAX_CANDIDATES=16


def resolve_fixed():
    records=socket.getaddrinfo(HOST,PORT,socket.AF_UNSPEC,socket.SOCK_STREAM,socket.IPPROTO_TCP)
    if not 1<=len(records)<=MAX_CANDIDATES:raise ValueError('DNS_CANDIDATE_LIMIT')
    values=[]
    for family,kind,proto,canon,address in records:
        if kind!=socket.SOCK_STREAM or proto!=socket.IPPROTO_TCP:raise ValueError('DNS_RECORD_TYPE')
        if family==socket.AF_INET and len(address)==2 and address[1]==PORT:
            value={'family':4,'address':address[0],'port':PORT}
        elif family==socket.AF_INET6 and len(address)==4 and address[1:]==(PORT,0,0):
            value={'family':6,'address':address[0],'port':PORT}
        else:raise ValueError('DNS_ADDRESS_TYPE')
        if type(value['address']) is not str or not 1<=len(value['address'])<=64:raise ValueError('DNS_ADDRESS_LENGTH')
        if value not in values:values.append(value)
    return {'version':1,'host':HOST,'port':PORT,'candidates':values}


def main():
    if sys.platform!='linux' or sys.argv[1:]:raise ValueError('FIXED_RESOLVER_ENTRY')
    try:
        value=resolve_fixed()
        raw=json.dumps(value,separators=(',',':'),allow_nan=False).encode('ascii')+b'\n'
        if len(raw)>4096:raise ValueError('DNS_OUTPUT_LIMIT')
        sys.stdout.buffer.write(raw);sys.stdout.buffer.flush();return 0
    except Exception:
        # Never copy libc diagnostics, environment, auth or arbitrary records.
        sys.stdout.buffer.write(b'{"error":"FIXED_DNS_FAILURE"}\n');sys.stdout.buffer.flush();return 1


if __name__=='__main__':raise SystemExit(main())
