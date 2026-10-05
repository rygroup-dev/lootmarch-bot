# LootMarch Bot installer for Windows 10/11
#   Open PowerShell and run:
#   irm https://raw.githubusercontent.com/rygroup-dev/lootmarch-bot/main/install.ps1 | iex
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Repo   = 'rygroup-dev/lootmarch-bot'
$Dir    = if ($env:LM_DIR) { $env:LM_DIR } else { Join-Path $env:USERPROFILE 'lootmarch-bot' }
$Task   = 'LootMarchBot'

function Say($m)  { Write-Host $m -ForegroundColor Cyan }
function Ok($m)   { Write-Host "OK  $m" -ForegroundColor Green }
function Fail($m) { Write-Host "X   $m" -ForegroundColor Red; throw $m }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
}

Say '== LootMarch Bot installer (Windows) =='

# 1) Node.js >= 20
$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
  $major = [int]((node -p "process.versions.node.split('.')[0]") 2>$null)
  if ($major -ge 20) { $needNode = $false }
}
if ($needNode) {
  Say 'Memasang Node.js LTS...'
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements | Out-Null
  } else {
    $lts = (Invoke-RestMethod 'https://nodejs.org/dist/index.json') | Where-Object { $_.lts -and $_.version -like 'v22.*' } | Select-Object -First 1
    $msi = Join-Path $env:TEMP 'node-lts.msi'
    Invoke-WebRequest "https://nodejs.org/dist/$($lts.version)/node-$($lts.version)-x64.msi" -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn" -Wait -Verb RunAs
  }
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Fail 'Node.js belum terpasang. Pasang manual dari https://nodejs.org lalu jalankan installer ini lagi.' }
}
Ok "Node $(node -v)"

# 2) Code: download the repo zip (no git needed). .env and data\ are kept on update.
Say "Mengunduh kode ke $Dir ..."
$zip = Join-Path $env:TEMP 'lootmarch-bot.zip'
$tmp = Join-Path $env:TEMP 'lootmarch-bot-src'
Invoke-WebRequest "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip
if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
Expand-Archive $zip -DestinationPath $tmp -Force
$src = Get-ChildItem $tmp -Directory | Select-Object -First 1
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
# stop a running copy before replacing files
$stopPs1 = Join-Path $Dir 'windows\stop.ps1'
if (Test-Path $stopPs1) { powershell -NoProfile -ExecutionPolicy Bypass -File $stopPs1 -Quiet }
Get-ChildItem $src.FullName -Force | Where-Object { $_.Name -notin @('.env', 'data') } | ForEach-Object {
  Copy-Item $_.FullName -Destination $Dir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $Dir 'data') | Out-Null
Copy-Item (Join-Path $src.FullName 'data\catalog.json') (Join-Path $Dir 'data\catalog.json') -Force
Remove-Item $tmp -Recurse -Force; Remove-Item $zip -Force

Push-Location $Dir
try {
  npm ci --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Fail 'npm ci gagal.' }
  Ok 'Dependency terpasang'

  # 3) .env
  $envFile = Join-Path $Dir '.env'
  if (-not (Test-Path $envFile)) {
    Say 'Setelan bot (buat bot di @BotFather, cek ID Telegram kamu di @userinfobot)'
    $token = Read-Host 'BOT_TOKEN'
    if (-not $token) { Fail 'BOT_TOKEN wajib.' }
    $owner = Read-Host 'ID Telegram kamu (OWNER_IDS)'
    if ($owner -notmatch '^[0-9, ]+$') { Fail 'OWNER_IDS harus angka.' }
    $secret = node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
    Set-Content -Path $envFile -Encoding ascii -Value @("BOT_TOKEN=$token", "OWNER_IDS=$owner", "SECRET_KEY=$secret")
    # only the current user may read .env
    icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
    Ok '.env dibuat (SECRET_KEY acak; JANGAN hilang, dipakai untuk membuka private key tersimpan)'
  } else {
    Ok '.env sudah ada, dipakai ulang'
  }
} finally { Pop-Location }

# 4) Start at logon, hidden, restarting on crash (windows\run.cmd loops).
$vbs = Join-Path $Dir 'windows\start-hidden.vbs'
$action  = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
Register-ScheduledTask -TaskName $Task -Action $action -Trigger $trigger -Settings $settings -Description 'LootMarch Telegram bot' -Force | Out-Null
Start-ScheduledTask -TaskName $Task
Ok "Bot jalan di latar belakang dan otomatis start saat Windows login (task '$Task')."

Write-Host ''
Say 'Selesai! Buka bot kamu di Telegram lalu kirim /start -> Wallet -> Import key.'
Write-Host "  Log      : $Dir\bot.log"
Write-Host "  Hentikan : powershell -ExecutionPolicy Bypass -File `"$Dir\windows\stop.ps1`""
Write-Host "  Jalankan : Start-ScheduledTask -TaskName $Task"
Write-Host '  Update   : jalankan perintah install yang sama lagi'
Write-Host '  Catatan  : bot hanya jalan selama PC menyala & tidak sleep.'
