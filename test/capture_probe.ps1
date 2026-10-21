# Start the titlebar probe (test\_titlebar_probe) with the project's own Electron,
# bring it to front and capture the whole screen.
#
# Kept 100% ASCII: Windows PowerShell 5.1 reads .ps1 as ANSI unless there is a
# UTF-8 BOM, which garbles non-ASCII text.
#
# Usage (repo root):
#   powershell -ExecutionPolicy Bypass -File test\capture_probe.ps1
# Output: preview\real-titlebar-probe.png
param(
  [string]$Out   = "preview\real-titlebar-probe.png",
  [string]$Url   = "",
  [string]$Title = "",
  [int]$WaitSec  = 40
)

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace Bee -Name Dpi -MemberDefinition '[DllImport("shcore.dll")] public static extern int SetProcessDpiAwareness(int v);'
Add-Type -Namespace Bee -Name Api -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);'
Add-Type -Namespace Bee -Name Win -MemberDefinition 'public struct RECT { public int Left; public int Top; public int Right; public int Bottom; } [DllImport("user32.dll")] public static extern bool GetWindowRect(System.IntPtr h, out RECT r);'

try { [Bee.Dpi]::SetProcessDpiAwareness(2) | Out-Null } catch { }

$root = Split-Path -Parent $PSScriptRoot

$electron = Join-Path $root "node_modules\electron\dist\electron.exe"
$probeDir = Join-Path $root "test\_titlebar_probe"
if (-not (Test-Path $electron)) { Write-Output "ELECTRON_NOT_FOUND $electron"; exit 1 }
if (-not (Test-Path $probeDir)) { Write-Output "PROBE_NOT_FOUND $probeDir"; exit 1 }

$outPath = Join-Path $root $Out
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $outPath) | Out-Null

# Same trap as the other capture script: an injected ELECTRON_RUN_AS_NODE would
# boot electron.exe as plain Node and no window would ever appear.
$env:ELECTRON_RUN_AS_NODE = $null
if ($Url)   { $env:PROBE_URL = $Url } else { $env:PROBE_URL = $null }
if ($Title) { $env:PROBE_TITLE = $Title } else { $env:PROBE_TITLE = $null }

Write-Output ("ELECTRON " + $electron)
Write-Output ("PROBE    " + $probeDir)
Write-Output ("URL      " + $env:PROBE_URL)
$proc = Start-Process -FilePath $electron -ArgumentList $probeDir -WorkingDirectory $root -PassThru

$hWnd = [IntPtr]::Zero
for ($i = 0; $i -lt $WaitSec; $i++) {
  Start-Sleep -Seconds 1
  $proc.Refresh()
  $h = $proc.MainWindowHandle
  # $null -ne [IntPtr]::Zero is TRUE in PowerShell, so test for null explicitly
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

Start-Sleep -Seconds 5
[Bee.Api]::SetForegroundWindow($hWnd) | Out-Null
Start-Sleep -Seconds 1

# Capture the window's own rect rather than the whole screen
$r = New-Object Bee.Win+RECT
[Bee.Win]::GetWindowRect($hWnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left
$h = $r.Bottom - $r.Top
Write-Output ("WINDOW_RECT L=" + $r.Left + " T=" + $r.Top + " " + $w + "x" + $h)

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$g   = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
$bmp.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()
Write-Output ("SAVED " + $w + "x" + $h + " -> " + $outPath)

Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
Write-Output "PROBE_CLOSED"
