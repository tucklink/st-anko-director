@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Anko Director - local web version (no Electron)
rem  Electron cannot run on this machine: the environment forbids named pipes
rem  (FATAL:platform_channel.cc Check failed / access denied). Node works fine.
rem  Keep this file ASCII-only, no BOM.
rem ---------------------------------------------------------------------------

set ELECTRON_RUN_AS_NODE=

where node >nul 2>nul
if errorlevel 1 (
    echo [x] Node.js not found in PATH.
    pause
    exit /b 1
)

if not exist "server.mjs" (
    echo [x] server.mjs not found. Run this file in the project root.
    pause
    exit /b 1
)

echo [*] Starting Anko Director ...
echo     Close this window to stop the server.
echo.

start "" http://127.0.0.1:8123/
node server.mjs
set CODE=%ERRORLEVEL%

echo.
echo [i] Server stopped, exit code = %CODE%
pause
endlocal
