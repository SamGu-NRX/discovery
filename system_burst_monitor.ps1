$ErrorActionPreference='Continue'
$root=Get-Location
$dirLog=Join-Path $root 'system_burst_dirs_20261112.jsonl'
$procLog=Join-Path $root 'system_burst_procs_20261112.jsonl'
Remove-Item $dirLog,$procLog -Force -ErrorAction SilentlyContinue
$empty='C:\Temp\_empty'
New-Item -ItemType Directory -Force -Path $empty | Out-Null

function RoboBytes($path) {
  if (-not (Test-Path -LiteralPath $path)) { return [int64]0 }
  try {
    $lines=@(robocopy $path $empty /L /S /XJ /BYTES /NJH /NDL /NFL /R:0 /W:0 2>&1)
    $line=$lines | Where-Object { $_ -match '^\s*Bytes\s*:' } | Select-Object -Last 1
    if ($line -and $line -match 'Bytes\s*:\s*([0-9,]+)') { return [int64]($Matches[1] -replace ',','') }
  } catch { }
  return [int64]0
}

function TopTemp {
  $result=@()
  try {
    $children=Get-ChildItem -LiteralPath $env:TEMP -Directory -Force -ErrorAction SilentlyContinue
    foreach($d in $children){
      $bytes=(Get-ChildItem -LiteralPath $d.FullName -File -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum
      $result += [ordered]@{path=$d.FullName;bytes=[int64]$bytes}
    }
  } catch { }
  @($result | Sort-Object bytes -Descending | Select-Object -First 5)
}

function ProcRates {
  $out=@()
  try {
    $c=Get-Counter '\Process(*)\IO Write Bytes/sec','\Process(*)\ID Process' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
    $rates=@{};$pids=@{}
    foreach($s in $c.CounterSamples){
      if($s.Path -match '\\io write bytes/sec'){$rates[$s.InstanceName]=[double]$s.CookedValue}
      elseif($s.Path -match '\\id process'){$pids[$s.InstanceName]=[int]$s.CookedValue}
    }
    foreach($n in $pids.Keys){$out += [ordered]@{name=$n;pid=$pids[$n];bytesPerSec=[double]$rates[$n]}}
  } catch { }
  @($out | Sort-Object bytesPerSec -Descending)
}

$dirs=@(
  'C:\Windows\SoftwareDistribution',
  'C:\Windows\Temp',
  'C:\Windows\WinSxS\Temp',
  'C:\ProgramData\Microsoft\Windows\DeliveryOptimization',
  'C:\ProgramData\Microsoft\Windows\WER',
  'C:\$Recycle.Bin'
)
$start=Get-Date
for($i=0;$i -lt 90;$i++){
  $now=Get-Date
  $p=@(ProcRates)
  $p | ForEach-Object { $_.timestamp=$now.ToString('o') }
  $p | ConvertTo-Json -Depth 4 -Compress | Add-Content $procLog -Encoding utf8
  if(($i % 3) -eq 0){
    $sizes=[ordered]@{}
    foreach($d in $dirs){$sizes[$d]=[int64](RoboBytes $d)}
    $sizes[$env:TEMP]=[int64](RoboBytes $env:TEMP)
    $row=[ordered]@{timestamp=$now.ToString('o');freeBytes=[int64](Get-PSDrive C).Free;sizes=$sizes;topTemp=@(TopTemp)}
    $row | ConvertTo-Json -Depth 6 -Compress | Add-Content $dirLog -Encoding utf8
    Write-Output ("DIR {0}/30 {1} FreeGB={2:N2}" -f ([int]($i/3)+1),$now.ToString('s'),((Get-PSDrive C).Free/1GB))
  }
  if($i -lt 89){Start-Sleep -Seconds 10}
}
Write-Output "DIRLOG $dirLog"
Write-Output "PROCLOG $procLog"
