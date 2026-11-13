# Installs kworker as an unattended job on the Zephyrus: a copy of kworker/
# from a git ref in %LOCALAPPDATA%\kworker\app with its own venv, and a Task
# Scheduler task that runs `kworker run` against production every 15
# minutes. A run that is still going when the next one is due is left
# alone (MultipleInstances IgnoreNew). kworker reads KNOWLEDGE_TOKEN from
# the discovery-knowledge-token credential and stops below 15 GB free.
#
#   powershell -File kworker\scripts\install-schedule.ps1 -Ref mvp-loop
#   powershell -File kworker\scripts\install-schedule.ps1 -Uninstall

param(
  [string]$Ref = "mvp-loop",
  [string]$Url = "https://discovery-watcher.sgu07966.workers.dev",
  [int]$EveryMinutes = 15,
  [switch]$Uninstall
)
$ErrorActionPreference = "Stop"
$TaskName = "kworker-drain"
$Root = Join-Path $env:LOCALAPPDATA "kworker"
$App = Join-Path $Root "app"
$Logs = Join-Path $Root "logs"

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  "removed task $TaskName (the app folder $App is left in place)"
  return
}

$repo = (git -C $PSScriptRoot rev-parse --show-toplevel).Trim()
$commit = (git -C $repo rev-parse $Ref).Trim()
New-Item -ItemType Directory -Force $Logs | Out-Null

# A fresh copy each install: kworker keeps no state in its folder.
$staging = Join-Path $Root "app-staging"
if (Test-Path $staging) { Remove-Item -Recurse -Force $staging -Confirm:$false }
New-Item -ItemType Directory -Force $staging | Out-Null
$tar = Join-Path $staging "src.tar"
git -C $repo archive --format=tar -o $tar $commit kworker
tar -xf $tar -C $staging
Remove-Item $tar
$py = (Get-Command python).Source
& $py -m venv (Join-Path $staging "kworker\.venv")
& (Join-Path $staging "kworker\.venv\Scripts\python.exe") -m pip install -q -r (Join-Path $staging "kworker\requirements.txt")
if ($LASTEXITCODE -ne 0) { throw "pip install failed" }
if (Test-Path $App) { Remove-Item -Recurse -Force $App -Confirm:$false }
Move-Item $staging $App
Set-Content -Path (Join-Path $App "COMMIT") -Value $commit

# The task's command: no secret in it. KWORKER_NO_X keeps kworker off X's
# pages and APIs (fxtwitter and the media CDN stay open).
$cmd = Join-Path $App "run-kworker.cmd"
@"
@echo off
set KNOWLEDGE_URL=$Url
set KWORKER_NO_X=1
set PYTHONIOENCODING=utf-8
cd /d "$App\kworker"
for /f %%d in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd"') do set D=%%d
".venv\Scripts\python.exe" -m kworker run >> "$Logs\drain-%D%.log" 2>&1
"@ | Set-Content -Path $cmd -Encoding ASCII

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$cmd`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 12) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
# Runs as Sam, only while he is logged on: the token is in his credential vault.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null
"installed $TaskName from $Ref at $commit; runs every $EveryMinutes minutes against $Url; logs in $Logs"
