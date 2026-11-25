$ErrorActionPreference='Continue'
$log=Join-Path (Get-Location) 'fast_monitor_20261112.jsonl'
Remove-Item $log -Force -ErrorAction SilentlyContinue
$seen=@{}
function Size($p){try{$i=Get-Item -LiteralPath $p -Force -ErrorAction Stop; return [int64]$i.Length}catch{return 0}}
function DirSize($p){try{$x=Get-ChildItem -LiteralPath $p -Force -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum; return [int64]$x.Sum}catch{return 0}}
function Procs(){
 $r=@(); try{$c=Get-Counter '\Process(*)\IO Write Bytes/sec','\Process(*)\ID Process' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue; $a=@{};$b=@{}; foreach($s in $c.CounterSamples){if($s.Path -match '\\io write bytes/sec'){$a[$s.InstanceName]=[double]$s.CookedValue}elseif($s.Path -match '\\id process'){$b[$s.InstanceName]=[int]$s.CookedValue}}; foreach($n in $b.Keys){$r += [pscustomobject]@{pid=$b[$n];name=$n;rate=$a[$n]}}}catch{}; return $r}
for($i=0;$i -le 10;$i++){
 $d=Get-PSDrive C; $v=@(Get-Item 'C:\Users\sgu07\AppData\Local\packages\CanonicalGroupLimited.Ubuntu_79rhkp1fndgsc\LocalState\ext4.vhdx','C:\Users\sgu07\AppData\Local\Docker\wsl\disk\docker_data.vhdx','C:\Users\sgu07\AppData\Local\Docker\wsl\main\ext4.vhdx' -Force -ErrorAction SilentlyContinue | ForEach-Object {[ordered]@{path=$_.FullName;bytes=[int64]$_.Length}})
 $s=[ordered]@{timestamp=(Get-Date).ToString('o');free=[int64]$d.Free;pagefile=(Size 'C:\pagefile.sys');statev2=(Size 'C:\Users\sgu07\.t3\userdata\statev2.sqlite');t3userdata=(DirSize 'C:\Users\sgu07\.t3\userdata');t3worktrees=(DirSize 'C:\Users\sgu07\.t3\worktrees');reel=(DirSize 'C:\Users\sgu07\.t3\worktrees\reel-studio');xbe=(DirSize 'C:\Users\sgu07\.xbe-session');temp=(DirSize $env:TEMP);vhdx=$v;procs=@(Procs)}
 $s|ConvertTo-Json -Depth 7 -Compress|Add-Content $log -Encoding utf8
 Write-Output ("FAST {0}/11 FreeGB={1:N2} StateGB={2:N2}" -f ($i+1),($d.Free/1GB),($s.statev2/1GB))
 if($i -lt 10){Start-Sleep -Seconds 120}
}
