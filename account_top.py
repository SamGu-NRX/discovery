import os,re,sys,subprocess,concurrent.futures
dest=r'C:\Temp'
def one(p):
 try: out=subprocess.run(['robocopy',p,dest,'/L','/S','/XJ','/BYTES','/NJH','/NDL','/NFL','/R:0','/W:0'],capture_output=True,text=True,encoding='utf-8',errors='ignore',timeout=900).stdout
 except Exception as e:return (0,p,str(e))
 m=re.search(r'Bytes\s*:\s*([0-9,]+)',out)
 return (int(m.group(1).replace(',','')) if m else 0,p,'')
root=sys.argv[1] if len(sys.argv)>1 else 'C:\\'
with os.scandir(root) as es: paths=[e.path for e in es if e.is_dir(follow_symlinks=False) and not e.is_symlink()]
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:
 futs=[ex.submit(one,p) for p in paths]
 with open('account_top_20261112.tsv','w',encoding='utf-8') as f:
  for i,fut in enumerate(concurrent.futures.as_completed(futs),1):
   row=fut.result(); f.write(f'{row[0]}\t{row[0]/1073741824:.3f}\t{row[1]}\t{row[2]}\n'); f.flush(); print(i,len(paths),row,flush=True)
