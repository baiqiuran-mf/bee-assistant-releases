# Real-machine verification: start the packaged exe, bring it to front, capture the screen.
#
# Why this exists: the window title bar is drawn by Windows, not by the page.
# Headless browsers cannot render it, so the ONLY way to prove the title bar
# really turned blue is to launch the real app and screenshot it.
#
# NOTE (Windows PowerShell 5.1): .ps1 files are read as ANSI unless they carry a
# UTF-8 BOM, which garbles any non-ASCII text. So this script is kept 100% ASCII.
# The packaged exe has a Chinese file name - it is discovered with Get-ChildItem
# instead of being written as a literal.
#
# Usage (from repo root):
#   powershell -ExecutionPolicy Bypass -File test\capture_real_titlebar.ps1
# Output: preview\real-titlebar-main.png
param(
  [string]$Out  = "preview\real-titlebar-main.png",
  [int]$WaitSec = 30
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Bee -Name Dpi -MemberDefinition '[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);'
Add-Type -Namespace Bee -Name Api -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
# RECT is declared as a nested struct inside the generated class, so it is reached
# as [Bee.Win+RECT]. -MemberDefinition takes the class body, hence no outer braces.
Add-Type -Namespace Bee -Name Win -MemberDefinition 'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);'

# Must declare DPI awareness first, otherwise the capture is offset when
# Windows scaling is not 100%.
try { [Bee.Dpi]::SetProcessDpiAwareness(2) | Out-Null } catch { }

$root = Split-Path -Parent $PSScriptRoot

# Find the app exe inside dist\win-unpacked (skip helpers: elevate.exe, uninstaller)
$exePath = $null
$dir = Join-Path $root "dist\win-unpacked"
if (Test-Path $dir) {
  $cand = Get-ChildItem -Path $dir -Filter *.exe -File |
          Where-Object { $_.Name -notlike "elevate*" -and $_.Name -notlike "*ninstall*" } |
          Select-Object -First 1
  if ($cand) { $exePath = $cand.FullName }
}
if (-not $exePath) { Write-Output "EXE_NOT_FOUND under $dir"; exit 1 }

$outPath = Join-Path $root $Out
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null

# IMPORTANT: main.js calls app.requestSingleInstanceLock(), so if the installed
# app is already running, a freshly launched copy just quits and we get no window.
# (Passing --user-data-dir does NOT help - the packaged Electron binary rejects
# it with "bad option".)
# Instead we give this verification instance a private APPDATA, which moves
# app.getPath('userData') - and therefore the single-instance lock - away from the
# real one. src/runtime.js also honours BEE_HOME for the data dir.
# Net effect: a throwaway instance runs alongside, and the copy the user is
# actually working in is never disturbed.
# Keep the throwaway profile OUTSIDE the repo - anything sitting in the project
# root can end up being scanned by the packager and confuse a build.
$verifyProfile = Join-Path (Split-Path -Parent $root) "_verify_profile"
New-Item -ItemType Directory -Force -Path $verifyProfile | Out-Null
$oldAppData = $env:APPDATA
$oldBeeHome = $env:BEE_HOME
$oldRunAsNode = $env:ELECTRON_RUN_AS_NODE
$env:APPDATA  = $verifyProfile
$env:BEE_HOME = $verifyProfile

# CRITICAL: some IDEs inject ELECTRON_RUN_AS_NODE=1 into child processes.
# With it set, electron.exe boots as plain Node instead of Electron, so
# require('electron') yields a path string, app is undefined and the app dies
# before any window exists (it also makes the Node CLI parser reject Electron
# switches with "bad option"). Must be cleared before launching.
$env:ELECTRON_RUN_AS_NODE = $null

# Give this instance its own user-data dir -> a separate single-instance lock,
# so it can run alongside the copy that is already open.
$arg = "--user-data-dir=" + $verifyProfile

Write-Output ("EXE        " + $exePath)
Write-Output ("ARG        " + $arg)
Write-Output ("RUN_AS_NODE=" + ($env:ELECTRON_RUN_AS_NODE))
$proc = Start-Process -FilePath $exePath -ArgumentList $arg -PassThru

$hWnd = [IntPtr]::Zero
for ($i = 0; $i -lt $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $proc.Refresh()
  $h = $proc.MainWindowHandle
  # Careful: in PowerShell, $null -ne [IntPtr]::Zero is TRUE, so an explicit
  # null check is required - otherwise the loop exits on a phantom handle.
  if ($h -and $h -ne [IntPtr]::Zero) {
    $hWnd = $h
    Write-Output ("GOT_HANDLE after " + ($i + 1) + "s -> " + $hWnd.ToInt64())
    break
  }
}

if (-not $hWnd -or $hWnd -eq [IntPtr]::Zero) {
  Write-Output "WINDOW_NOT_FOUND"
  Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
  exit 1
}

Start-Sleep -Seconds 6

# Windows blocks SetForegroundWindow for background processes (foreground lock),
# which is why an earlier run captured the IDE instead. The repo already ships a
# native helper that reliably raises a window - reuse it rather than reinvent it.
$settop = Join-Path $root "bin\settop.exe"
if (Test-Path $settop) {
  $settopArg = "--pid " + $proc.Id + " --wait 1500"
  Write-Output ("SETTOP " + $settopArg)
  Start-Process -FilePath $settop -ArgumentList $settopArg -Wait -NoNewWindow | Out-Null
} else {
  [Bee.Api]::SetForegroundWindow($hWnd) | Out-Null
}
Start-Sleep -Seconds 2

# Capture just the window (its own rect), not the whole screen
$r = New-Object Bee.Win+RECT
[Bee.Win]::GetWindowRect($hWnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output ("WINDOW_RECT L=" + $r.Left + " T=" + $r.Top + " " + $w + "x" + $h)

if ($w -le 0 -or $h -le 0) { Write-Output "BAD_RECT"; Stop-Process -Id $proc.Id -Force; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("SAVED " + $w + "x" + $h + " -> " + $outPath)

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
$env:APPDATA  = $oldAppData
$env:BEE_HOME = $oldBeeHome
$env:ELECTRON_RUN_AS_NODE = $oldRunAsNode
Write-Output "APP_CLOSED"
