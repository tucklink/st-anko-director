@echo off
setlocal
cd /d "%~dp0"

rem ---------------------------------------------------------------------------
rem  Anko Director - build a single-file portable exe
rem  Run this by double-clicking in a NORMAL terminal.
rem  Inside a sandboxed environment, Node's child_process.spawn is blocked and
rem  electron-builder fails with: Cannot spawn app-builder.exe: spawn EPERM
rem  Keep this file ASCII-only (see the launcher .cmd for the reason).
rem ---------------------------------------------------------------------------

set ELECTRON_RUN_AS_NODE=
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
set CSC_IDENTITY_AUTO_DISCOVERY=false

if not exist "node_modules\electron-builder" (
    echo [x] Dependencies missing. Run first:
    echo       npm install --ignore-scripts
    pause
    exit /b 1
)

echo [*] Packaging ... first run downloads NSIS, may take a few minutes.
call npm run app:dist
set CODE=%ERRORLEVEL%

echo.
if exist "dist-app\*.exe" (
    echo [ok] Done. Output:
    dir /b "dist-app\*.exe"
) else (
    echo [x] Build failed, exit code = %CODE%
    echo     Keep the error text above.
)

pause
endlocal
