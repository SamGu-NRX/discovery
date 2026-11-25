import os,sys
def size(root):
 total=0; stack=[root]; files=0
 while stack:
  d=stack.pop()
  try: es=os.scandir(d)
  except: continue
  with es:
   for e in es:
    try:
     if e.is_dir(follow_symlinks=False) and not e.is_symlink(): stack.append(e.path)
     elif e.is_file(follow_symlinks=False): total+=e.stat(follow_symlinks=False).st_size; files+=1
    except: pass
 return total,files
for p in sys.argv[1:]:
 n,f=size(p); print(f'{n}\t{n/1073741824:.3f} GB\tfiles={f}\t{p}',flush=True)
