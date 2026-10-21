@echo off
rem ============================================================
rem  Bee Message Collector - DESKTOP APP TEST
rem  This is NOT a web page test: it launches the desktop app
rem  runtime (Electron) and runs the built-in self test.
rem  It backs up .\data before, and restores it after,
rem  so your real customer data is never polluted.
rem
rem  Content is ASCII only on purpose: cmd.exe reads .bat files
rem  with the console codepage, so UTF-8 Chinese text inside a
rem  .bat gets garbled (that was the earlier error message).
rem ============================================================
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

chcp 65001 >nul 2>&1

echo ============================================================
echo   Bee Message Collector - desktop app test  (desktop runtime, not a web page)
echo ============================================================
echo.

call "%ROOT%\tools\find_node.bat"
if errorlevel 1 goto no_node

echo [env] Node.js : %NODE_VER%
echo [env] node.exe: %NODE_EXE%
echo [env] project : %ROOT%
echo %NODE_VER% | findstr /r /c:"^v2[2-9]" >nul
if errorlevel 1 echo [WARN] Node.js 22+ is required (node:sqlite). Please upgrade Node.js.

echo.
echo Running desktop test ... (backup data - test - restore data)
echo.
"%NODE_EXE%" "%ROOT%\test\desktop.test.js"
set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo [RESULT] DESKTOP TEST PASSED
) else (
  echo [RESULT] DESKTOP TEST FAILED  ^(exit code %RC%^)
)
echo.
if not defined BEE_NOPAUSE pause
exit /b %RC%

:no_node
echo [ERROR] Node.js was not found on this computer.
echo.
echo   Bee Message Collector needs Node.js 22 or newer.
echo   Fix it with ONE of these:
echo     1^) Install Node.js 22 LTS from https://nodejs.org
echo        then run this file again.
echo     2^) Or open this project inside the WorkBuddy app and let the
echo        assistant run the test for you.
echo.
if not defined BEE_NOPAUSE pause
exit /b 1
