@echo off
rem ============================================================
rem  find_node.bat
rem  Locate a usable Node.js (v22+ preferred) and export:
rem      NODE_EXE  = full path to node.exe
rem      NODE_VER  = version string, e.g. v22.22.2
rem  Returns errorlevel 0 on success, 1 if no Node.js found.
rem
rem  ASCII ONLY on purpose: cmd.exe reads .bat files using the
rem  console codepage, so UTF-8 Chinese text inside a .bat gets
rem  garbled and can even swallow line endings.
rem
rem  Usage:  call "%~dp0tools\find_node.bat"  &  if errorlevel 1 ...
rem ============================================================

set "NODE_EXE="
set "NODE_VER="
set "NODE_OLD="
set "CAND1="
set "BEE_TMP=%TEMP%\beesnap_node_ver.txt"

rem ---- 1) node already on PATH ----
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined CAND1 set "CAND1=%%i"
)
if defined CAND1 call :probe "%CAND1%"

rem ---- 2) standard installer locations ----
set "PF86=%ProgramFiles(x86)%"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" call :probe "%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%PF86%\nodejs\node.exe" call :probe "%PF86%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" call :probe "%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" call :probe "%APPDATA%\npm\node.exe"

rem ---- 3) nvm-for-windows ----
if not defined NODE_EXE if exist "%NVM_SYMLINK%\node.exe" call :probe "%NVM_SYMLINK%\node.exe"
if not defined NODE_EXE if exist "%NVM_HOME%\node.exe" call :probe "%NVM_HOME%\node.exe"
if not defined NODE_EXE for /d %%d in ("%APPDATA%\nvm\v*") do (
  if not defined NODE_EXE if exist "%%~d\node.exe" call :probe "%%~d\node.exe"
)

rem ---- 4) Node shipped with WorkBuddy ----
if not defined NODE_EXE for /d %%d in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
  if not defined NODE_EXE if exist "%%~d\node.exe" call :probe "%%~d\node.exe"
)
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\WorkBuddy\resources\node\node.exe" call :probe "%LOCALAPPDATA%\Programs\WorkBuddy\resources\node\node.exe"

rem ---- fallback: use whatever we found even if it is older ----
if not defined NODE_EXE if defined NODE_OLD call :accept "%NODE_OLD%"

if not defined NODE_EXE exit /b 1
exit /b 0

rem ------------------------------------------------------------
rem  :probe <path>   accept only if version is v22..v29
rem ------------------------------------------------------------
:probe
set "PV="
"%~1" -v > "%BEE_TMP%" 2>nul
set /p PV=<"%BEE_TMP%"
del "%BEE_TMP%" >nul 2>&1
if not defined PV goto :eof
echo %PV% | findstr /r /c:"^v2[2-9]" >nul
if errorlevel 1 (
  if not defined NODE_OLD set "NODE_OLD=%~1"
  goto :eof
)
if not defined NODE_EXE call :accept "%~1"
goto :eof

rem ------------------------------------------------------------
rem  :accept <path>   set NODE_EXE / NODE_VER
rem ------------------------------------------------------------
:accept
if defined NODE_EXE goto :eof
set "NODE_EXE=%~1"
set "PV2="
"%~1" -v > "%BEE_TMP%" 2>nul
set /p PV2=<"%BEE_TMP%"
del "%BEE_TMP%" >nul 2>&1
set "NODE_VER=%PV2%"
goto :eof
