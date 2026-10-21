@echo off
rem ============================================================
rem  Bee Message Collector - start the DESKTOP APP (native window, not a browser)
rem
rem  Double-click this file to open Bee Message Collector as a desktop window.
rem  If the Electron runtime is missing, it falls back to running
rem  the local backend and tells you the localhost URL instead.
rem
rem  ASCII only on purpose (cmd.exe garbles UTF-8 inside .bat).
rem ============================================================
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

chcp 65001 >nul 2>&1

echo ============================================================
echo   Bee Message Collector - desktop app
echo ============================================================
echo.

set "ELEC=%ROOT%\node_modules\electron\dist\electron.exe"
if not exist "%ELEC%" set "ELEC=%ROOT%\node_modules\electron\dist\electron"
if not exist "%ELEC%" goto no_electron

echo Starting desktop window ...
echo   A native Bee Message Collector window should open in a few seconds.
echo   Keep THIS console window open. Close the Bee Message Collector window to quit.
echo.
"%ELEC%" "%ROOT%"
set "RC=%ERRORLEVEL%"
echo.
if "%RC%"=="0" goto app_quit

echo [ERROR] The desktop app exited with code %RC%.
echo   The log above says why. What to try:
echo     - Close any other Bee Message Collector window that is already running.
echo     - Make sure nothing else is using port 8787.
echo     - If Electron is broken: delete node_modules, then run npm install.
if not defined BEE_NOPAUSE pause
exit /b %RC%

:app_quit
echo [stopped] the desktop app has exited.
exit /b 0

:no_electron
echo [WARN] Electron runtime not found (node_modules\electron\dist\electron.exe).
echo [WARN] Falling back to backend-only mode: you will use it in a browser.
echo.
call "%ROOT%\tools\find_node.bat"
if errorlevel 1 goto no_node

echo [env] Node.js : %NODE_VER%
echo Open this URL in your browser:  http://127.0.0.1:8787
echo Keep this window OPEN. Stop with Ctrl+C.
echo.
"%NODE_EXE%" --experimental-sqlite "%ROOT%\src\main.js"

echo.
echo [stopped] the backend has exited.
if not defined BEE_NOPAUSE pause
exit /b 0

:no_node
echo [ERROR] Node.js was not found on this computer.
echo   Install Node.js 22 LTS from https://nodejs.org, then run again.
if not defined BEE_NOPAUSE pause
exit /b 1
