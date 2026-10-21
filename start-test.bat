@echo off
rem ============================================================
rem Bee Assistant - dev mode launcher (ASCII only, no CJK)
rem 1) clears ELECTRON_RUN_AS_NODE so Electron starts a real GUI
rem 2) uses %APPDATA% junction (same D: data, pure ASCII path)
rem 3) keeps this window open so errors stay readable
rem 4) start-test.bat probe  = print real Telegram data-mid
rem ============================================================
set "ELECTRON_RUN_AS_NODE="
set "BEE_DATA_DIR=%APPDATA%\\wa-assistant\\data"
set "BEE_CONFIG=E://WorkBuddy-Projects//wa-assistant//config.yaml"
cd /d "E://WorkBuddy-Projects//wa-assistant"
if /i "%~1"=="probe" goto :probe
echo [1/3] Node modules check...
if not exist "node_modules\\electron\\dist\\electron.exe" (
  echo ERROR: electron.exe not found. Run npm install first.
  pause
  exit /b 1
)
echo [2/3] Data dir: %BEE_DATA_DIR%
echo [3/3] Starting Bee Assistant (dev mode)...
echo.
"node_modules\\electron\\dist\\electron.exe" .
echo.
echo ---- app exited (code %errorlevel%) ----
echo If the window closed by itself, double-click this file again.
pause
exit /b 0
:probe
echo [probe] reading real Telegram page structure...
echo.
"node_modules\\electron\\dist\\electron.exe" tools\\diag-tg-probe.js
echo.
echo ---- probe done (code %errorlevel%) ----
echo Full output also saved to: probe-output.txt
pause
