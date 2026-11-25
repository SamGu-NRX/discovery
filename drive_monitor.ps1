$ErrorActionPreference = 'Continue'
$logPath = Join-Path (Get-Location) 'drive_monitor_20261112.jsonl'
$topPath = Join-Path (Get-Location) 'drive_monitor_process_totals.csv'
Remove-Item -LiteralPath $logPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $topPath -Force -ErrorAction SilentlyContinue

function Get-Bytes($path) {
  if (-not (Test-Path -LiteralPath $path)) { return 0 }
  try {
    $item = Get-Item -LiteralPath $path -Force -ErrorAction Stop
    if (-not $item.PSIsContainer) { return [int64]$item.Length }
  } catch { return 0 }
  return [int64]0
}

function Get-RobocopyBytes($path) {
  if (-not (Test-Path -LiteralPath $path)) { return [int64]0 }
  try {
    $out = @(robocopy $path 'C:\Temp' /L /S /XJ /BYTES /NJH /NDL /NFL /R:0 /W:0 2>&1)
    $line = $out | Where-Object { $_ -match '^\s*Bytes\s*:' } | Select-Object -Last 1
    if ($line -and $line -match 'Bytes\s*:\s*([0-9,]+)') { return [int64]($Matches[1] -replace ',','') }
  } catch { }
  return [int64]0
}

function Get-VhdxState {
  $roots = @('C:\Users\sgu07\AppData\Local\Packages','C:\Users\sgu07\AppData\Local\Docker')
  $items = @(Get-ChildItem -Path $roots -Filter '*.vhdx' -File -Recurse -Force -ErrorAction SilentlyContinue)
  @($items | ForEach-Object { [ordered]@{ path=$_.FullName; bytes=[int64]$_.Length } })
}

function Get-ShadowState {
  $raw = (cmd /c 'vssadmin list shadowstorage' 2>&1 | Out-String).Trim()
  $used = 0.0
  foreach ($line in ($raw -split "`r?`n")) {
    if ($line -match '(?i)Used Shadow Copy Storage space.*?([0-9]+(?:\.[0-9]+)?)\s*(GB|TB|MB|KB)') {
      $n=[double]$Matches[1]; switch ($Matches[2].ToUpperInvariant()) { 'TB' {$n*=1024}; 'GB' {}; 'MB' {$n/=1024}; 'KB' {$n/=1048576} }; $used += $n
    }
  }
  [ordered]@{ usedGB=$used; raw=$raw }
}

function Get-WslState {
  $df = (wsl -e df -B1 / 2>&1 | Out-String).Trim()
  $du = (wsl -e bash -lc 'timeout 12s du -x -sh /home /tmp /var/lib/docker 2>/dev/null' 2>&1 | Out-String).Trim()
  [ordered]@{ df=$df; du=$du }
}

function Get-ProcessWriteRates {
  $result = @()
  try {
    $counter = Get-Counter -Counter '\Process(*)\IO Write Bytes/sec','\Process(*)\ID Process' -SampleInterval 1 -MaxSamples 1 -ErrorAction SilentlyContinue
    $rates=@{}; $pids=@{}
    foreach ($sample in $counter.CounterSamples) {
      if ($sample.Path -match '(?i)\\process\(([^)]+)\)\\io write bytes/sec') { $rates[$sample.InstanceName]=[double]$sample.CookedValue }
      elseif ($sample.Path -match '(?i)\\process\(([^)]+)\)\\id process') { $pids[$sample.InstanceName]=[int]$sample.CookedValue }
    }
    foreach ($inst in $pids.Keys) {
      $result += [ordered]@{ pid=$pids[$inst]; instance=$inst; rateBytesPerSec=([double]($rates[$inst])) }
    }
  } catch { }
  $result
}

$targets = [ordered]@{
  t3_userdata='C:\Users\sgu07\.t3\userdata'
  t3_worktrees='C:\Users\sgu07\.t3\worktrees'
  reel_worktrees='C:\Users\sgu07\.t3\worktrees\reel-studio'
  xbe_session='C:\Users\sgu07\.xbe-session'
  temp=$env:TEMP
}
$processRecords = @()
$sampleTimes = @()
$start = Get-Date
for ($i=0; $i -le 10; $i++) {
  $now = Get-Date
  $sampleTimes += $now
  $d = Get-PSDrive C
  $dirs=[ordered]@{}
  foreach ($key in $targets.Keys) { $dirs[$key]=[int64](Get-RobocopyBytes $targets[$key]) }
  $wrangler = @(Get-ChildItem -Path 'C:\Users\sgu07\AppData\Local\Temp\knowledge-check','C:\Users\sgu07\.t3\worktrees' -Directory -Filter '.wrangler' -Recurse -Force -ErrorAction SilentlyContinue)
  $wranglerState=@($wrangler | ForEach-Object { [ordered]@{path=$_.FullName; bytes=[int64](Get-RobocopyBytes $_.FullName)} })
  $sample=[ordered]@{
    timestamp=$now.ToString('o')
    freeBytes=[int64]$d.Free
    pagefileBytes=[int64](Get-Bytes 'C:\pagefile.sys')
    vhdx=@(Get-VhdxState)
    shadowStorage=Get-ShadowState
    directories=$dirs
    wrangler=$wranglerState
    wsl=Get-WslState
  }
  $sample | ConvertTo-Json -Depth 8 -Compress | Add-Content -LiteralPath $logPath -Encoding utf8
  foreach ($p in (Get-ProcessWriteRates)) { $p.timestamp=$now.ToString('o'); $processRecords += [pscustomobject]$p }
  Write-Output ("SAMPLE {0}/11 {1} FreeGB={2:N2}" -f ($i+1,$now.ToString('s'),($d.Free/1GB)))
  if ($i -lt 10) {
    $next=$start.AddSeconds(($i+1)*120)
    $sleep=[int][math]::Max(1,[math]::Floor(($next-(Get-Date)).TotalSeconds))
    Start-Sleep -Seconds $sleep
  }
}

$totals=@()
foreach ($group in ($processRecords | Group-Object pid)) {
  $ordered=@($group.Group | Sort-Object timestamp)
  $written=0.0
  for ($j=1; $j -lt $ordered.Count; $j++) {
    $written += (([double]$ordered[$j-1].rateBytesPerSec + [double]$ordered[$j].rateBytesPerSec) / 2.0) * 120.0
  }
  $name=($ordered | Select-Object -Last 1).instance
  $totals += [pscustomobject]@{Pid=[int]$group.Name; Instance=$name; WrittenBytes=[double]$written; WrittenGB=($written/1GB)}
}
$procs=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)
$top=@()
foreach ($t in ($totals | Sort-Object WrittenBytes -Descending | Select-Object -First 5)) {
  $p=$procs | Where-Object {$_.ProcessId -eq $t.Pid} | Select-Object -First 1
  $cmd=if($p){[string]$p.CommandLine}else{''}
  $cmd=$cmd -replace '(?i)(Bearer\s+)\S+','$1<redacted>'
  $cmd=$cmd -replace '(?i)((?:--?|/)?(?:token|api[-_]?key|password|passwd|secret|authorization)(?:=|\s+))("[^"]*"|\S+)','$1<redacted>'
  $top += [pscustomobject]@{Pid=$t.Pid; Instance=$t.Instance; WrittenGB=[math]::Round($t.WrittenGB,3); CommandLine=$cmd}
}
$top | Export-Csv -LiteralPath $topPath -NoTypeInformation -Encoding utf8
$top | Format-Table -AutoSize | Out-String | Write-Output
Write-Output "LOG $logPath"
Write-Output "TOP $topPath"
