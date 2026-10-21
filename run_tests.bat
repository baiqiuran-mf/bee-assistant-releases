@echo off
rem ============================================================
rem  Bee Message Collector - full functional test suite (all suites)
rem  Runs in a throwaway data dir (test/_isolate.js), exercises every module
rem  and every API endpoint with a stubbed AI, then deletes the temp dir.
rem  It NEVER touches your real customer data in .\data.
rem
rem  ASCII only on purpose (cmd.exe garbles UTF-8 inside .bat).
rem ============================================================
setlocal

set "ROOT=%~dp0"
if "%ROOT:~-1%"=="\" set "ROOT=%ROOT:~0,-1%"
cd /d "%ROOT%"

chcp 65001 >nul 2>&1

echo ============================================================
echo   Bee Message Collector - full functional test suite (all suites)
echo   (isolated temp data -^> test all modules + all APIs -^> cleanup)
echo ============================================================
echo.

call "%ROOT%\tools\find_node.bat"
if errorlevel 1 goto no_node

echo [env] Node.js : %NODE_VER%
echo [env] node.exe: %NODE_EXE%
echo.
echo [1/4] core suite  (modules + APIs + UI render + AI + translate + media)
"%NODE_EXE%" --experimental-sqlite "%ROOT%\test\run_all.js"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto report

echo.
echo [2/4] smoke suite  (server + customer profile + manual paste)
"%NODE_EXE%" --experimental-sqlite "%ROOT%\test\smoke.test.js"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto report

echo.
echo [3/4] extract interval  (fallback rescan)
"%NODE_EXE%" --experimental-sqlite "%ROOT%\test\extract_interval.test.js"
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" goto report

echo.
echo [4/4] extract interval API
"%NODE_EXE%" --experimental-sqlite "%ROOT%\test\extract_interval_api.test.js"
set "RC=%ERRORLEVEL%"

:report
echo.
if "%RC%"=="0" (
  echo [RESULT] ALL FUNCTIONAL TESTS PASSED
) else (
  echo [RESULT] SOME TESTS FAILED - see the report above  ^(exit code %RC%^)
)
echo.
if not defined BEE_NOPAUSE pause
exit /b %RC%

:no_node
echo [ERROR] Node.js was not found on this computer.
echo.
echo   Bee Message Collector needs Node.js 22 or newer.
echo   Install Node.js 22 LTS from https://nodejs.org, then run again.
echo.
if not defined BEE_NOPAUSE pause
exit /b 1
