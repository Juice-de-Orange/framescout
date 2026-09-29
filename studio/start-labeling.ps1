# Framescout Studio - one-click LOCAL labeling launcher (created by Claude Code).
#
# Starts the local label-queue backend (serves this PC's image backlog as
# the queue) and the Studio UI, then opens the browser. Label species +
# individual names on the GPU box; confirmed labels are written to the
# training dataset. Ctrl+C stops the Studio; the backend is stopped too.
#
# Run from PowerShell (in studio/):  .\start-labeling.ps1
#
# ASCII-only on purpose: Windows PowerShell 5.1 reads .ps1 as CP1252, so a
# non-ASCII char here would corrupt parsing.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot
$env:PYTHONUTF8 = '1'   # trainer/UI print non-ASCII chars; avoids a cp1252 crash

$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) {
    Write-Error "venv python not found at $py - run the studio setup first (uv venv + uv pip install)."
    exit 1
}

# Read the backend port from studio.toml (default 9099).
$port = 9099
$cfg = Join-Path $PSScriptRoot 'studio.toml'
if (Test-Path $cfg) {
    $m = Select-String -Path $cfg -Pattern '^\s*port\s*=\s*(\d+)' -AllMatches |
         Where-Object { $_.Line -match '909' } | Select-Object -First 1
    if ($m -and $m.Matches.Count -gt 0) { $port = [int]$m.Matches[0].Groups[1].Value }
}

# Start the label-queue backend unless something already listens on the port.
$already = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
$shim = $null
if ($already) {
    Write-Host "Label-queue backend already running on port $port - reusing it." -ForegroundColor Yellow
} else {
    Write-Host "Starting local label-queue backend on http://127.0.0.1:$port ..." -ForegroundColor Green
    $shim = Start-Process -FilePath $py -ArgumentList 'local_queue_server.py' -PassThru -WindowStyle Minimized
}

# Wait until the backend answers /healthz (it scans + hashes the corpus first).
Write-Host "Waiting for the backend to index the image backlog..." -NoNewline
$ready = $false
foreach ($i in 1..60) {
    try {
        $h = Invoke-RestMethod -Uri "http://127.0.0.1:$port/healthz" -TimeoutSec 2
        if ($h.ok) { $ready = $true; Write-Host " ready ($($h.pending)/$($h.total) crops to label)." -ForegroundColor Green; break }
    } catch { Start-Sleep -Milliseconds 700; Write-Host "." -NoNewline }
}
if (-not $ready) {
    Write-Host ""
    Write-Warning "Backend did not become ready - check its window. Starting the Studio anyway."
}

# Run the Studio in the foreground (opens the browser at http://127.0.0.1:8770).
# When it exits (Ctrl+C), stop the backend we started.
Write-Host "Starting Framescout Studio -> http://127.0.0.1:8770   (Ctrl+C to stop)" -ForegroundColor Green
try {
    & $py -m framescout_studio
} finally {
    if ($shim -and -not $shim.HasExited) {
        Stop-Process -Id $shim.Id -Force -ErrorAction SilentlyContinue
        Write-Host "Stopped the label-queue backend." -ForegroundColor Yellow
    }
}
