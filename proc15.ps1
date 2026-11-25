$ErrorActionPreference='Continue'
$log='proc15_20261112.jsonl'; Remove-Item $log -Force -ErrorAction SilentlyContinue
for($i=0;$i -lt 90;$i++){
 $now=(Get-Date).ToString('o'); $c=Get-Counter '\Process(*)\IO Write Bytes/sec','\Process(*)\ID Process' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue; $a=@{};$b=@{}; foreach($s in $c.CounterSamples){if($s.Path -match '\\io write bytes/sec'){$a[$s.InstanceName]=[double]$s.CookedValue}elseif($s.Path -match '\\id process'){$b[$s.InstanceName]=[int]$s.CookedValue}}; foreach($n in $b.Keys){[ordered]@{timestamp=$now;name=$n;pid=$b[$n];bytesPerSec=[double]$a[$n]}|ConvertTo-Json -Compress|Add-Content $log -Encoding utf8}; if($i -lt 89){Start-Sleep -Seconds 10}}
