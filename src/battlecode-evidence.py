#!/usr/bin/env python3
"""Verify the actual replay archive, never a model-supplied marker_verified flag."""
import hashlib,json,sys,zipfile
path,side,marker=sys.argv[1:4]
h=hashlib.sha256()
with open(path,'rb') as f:
 for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
found=not marker
with zipfile.ZipFile(path) as z:
 with z.open('team-'+('a' if side=='0' else 'b')+'.stdout') as f:
  tail=b'';needle=marker.encode()
  while True:
   chunk=f.read(65536)
   if not chunk:break
   data=tail+chunk
   if needle and needle in data:found=True
   tail=data[-max(1,len(needle)):]
print(json.dumps({'sha256':h.hexdigest(),'marker_verified':found}))
