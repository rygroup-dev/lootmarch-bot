# Stops the LootMarch bot started by the installer (the restart loop first, then the bot).
param([switch]$Quiet)
$Dir = Split-Path -Parent $PSScriptRoot
$runCmd = Join-Path $Dir 'windows\run.cmd'

Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine -like "*$runCmd*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

$pidFile = Join-Path $Dir 'data\bot.pid'
if (Test-Path $pidFile) {
  $botPid = [int](Get-Content $pidFile -ErrorAction SilentlyContinue)
  if ($botPid) { Stop-Process -Id $botPid -Force -ErrorAction SilentlyContinue }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}
if (-not $Quiet) { Write-Host 'Bot dihentikan. Jalankan lagi: Start-ScheduledTask -TaskName LootMarchBot' -ForegroundColor Green }
