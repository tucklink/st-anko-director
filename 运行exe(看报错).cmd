@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Anko Director - run the single-file exe WITH a visible window.
rem  If the exe exits immediately, this window stays open so you can read why.
rem  Keep this file ASCII-only, no BOM.
rem ---------------------------------------------------------------------------

set EXE=dist-app\AnkoDirector.exe
if not exist "%EXE%" (
    rem fall back to any exe in dist-app
    for %%F in ("dist-app\*.exe") do set EXE=%%~fF
)

if not exist "%EXE%" (
    echo [x] No exe found in dist-app\. Build it first:
    echo       node tools/build-sea.mjs
    pause
    exit /b 1
)

echo [*] Running: %EXE%
echo     A server window will stay open. Do NOT close it while playing.
echo     If the browser does not open, copy the address printed below.
echo.

"%EXE%"
set CODE=%ERRORLEVEL%

echo.
echo [i] Exited with code %CODE%
echo     Startup log: %USERPROFILE%\.anko-director\startup.log
echo.
pause
endlocal
