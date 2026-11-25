import os,time,json,datetime,subprocess
roots=[r'C:\Windows\SoftwareDistribution',r'C:\Windows\Temp',r'C:\Windows\WinSxS\Temp',r'C:\ProgramData\Microsoft\Windows\DeliveryOptimization',r'C:\ProgramData\Microsoft\Windows\WER',r'C:\$Recycle.Bin',os.environ.get('TEMP',r'C:\Users\sgu07\AppData\Local\Temp')]
log='dir15_20261112.jsonl'
try: os.remove(log)
except: pass
def size(root):
 total=0; stack=[root]
 while stack:
  d=stack.pop()
  try: es=os.scandir(d)
  except: continue
  with es:
   for e in es:
    try:
     if e.is_dir(follow_symlinks=False) and not e.is_symlink(): stack.append(e.path)
     elif e.is_file(follow_symlinks=False): total+=e.stat(follow_symlinks=False).st_size
    except: pass
 return total
def top_temp(root):
 vals=[]
 try: children=[e.path for e in os.scandir(root) if e.is_dir(follow_symlinks=False) and not e.is_symlink()]
 except: children=[]
 for d in children: vals.append((size(d),d))
 return [{'path':p,'bytes':n} for n,p in sorted(vals,reverse=True)[:5]]
for i in range(30):
 ts=datetime.datetime.now().astimezone().isoformat(); row={'timestamp':ts,'freeBytes':0,'sizes':{},'topTemp':[]}
 try: row['freeBytes']=int(subprocess.check_output(['powershell','-NoProfile','-Command','(Get-PSDrive C).Free'],text=True).strip())
 except: pass
 for d in roots: row['sizes'][d]=size(d)
 row['topTemp']=top_temp(os.environ.get('TEMP',r'C:\Users\sgu07\AppData\Local\Temp'))
 with open(log,'a',encoding='utf-8') as f:f.write(json.dumps(row,separators=(',',':'))+'\n')
 print(f'{i+1}/30 {ts} free={row["freeBytes"]/1073741824:.2f}GB',flush=True)
 if i<29: time.sleep(30)
