@echo off
setlocal EnableExtensions DisableDelayedExpansion

:: CRITICAL FOR RUN AS ADMINISTRATOR: Switch from C:\Windows\System32 to this exact folder!
cd /d "%~dp0"
title Reddit Checker - Windows Installer
chcp 65001 >nul 2>&1
reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1

:: ------------------------------------------------------------------------
:: PRE-CHECK 1: Ensure ZIP archive was extracted first
:: ------------------------------------------------------------------------
if not exist "%~dp0package.json" goto :ERR_NOT_EXTRACTED
if not exist "%~dp0scripts\windows_install_runner.js" goto :ERR_NOT_EXTRACTED

:: ------------------------------------------------------------------------
:: PRE-CHECK 2: Auto-Elevate to Administrator if not already Admin
:: ------------------------------------------------------------------------
net session >nul 2>&1
if not errorlevel 1 goto :IS_ADMIN
if "%~1"=="--elevated" goto :CONTINUE_NON_ADMIN

echo Requesting Administrator privileges for automatic VC++ ^& DLL setup...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath '%~f0' -ArgumentList '--elevated' -WorkingDirectory '%~dp0.' -Verb RunAs" >nul 2>&1
if not errorlevel 1 exit /b 0

:CONTINUE_NON_ADMIN
echo   [WARN] Running without Administrator rights (UAC declined). Continuing anyway...
goto :AFTER_ADMIN

:IS_ADMIN
:: Add Windows Defender exclusion for %TEMP% and project folder so tls-client-64.dll is never blocked
powershell -NoProfile -ExecutionPolicy Bypass -Command "Try { Add-MpPreference -ExclusionPath $env:TEMP, '%~dp0.' -ErrorAction SilentlyContinue } Catch {}" >nul 2>&1

:AFTER_ADMIN
echo ========================================================================
echo   REDDIT CHECKER / SOLVER - WINDOWS AUTO-INSTALLER
echo   Mode: Direct Local IP (No Proxy) + Visible Background Browsers
echo ========================================================================
echo   Project Folder: "%CD%"
net session >nul 2>&1
if not errorlevel 1 echo   Privilege Mode: [OK] ADMINISTRATOR MODE ACTIVE
echo ========================================================================
echo.

:: ------------------------------------------------------------------------
:: PRE-CHECK 3: Find or Auto-Install Node.js v18+ (Space-Safe Quoted Path!)
:: ------------------------------------------------------------------------
echo [Pre-Check] Locating Node.js on your Windows PC...
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto :CHECK_NODE_VER

if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto :CHECK_NODE_VER

if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if defined NODE_EXE goto :CHECK_NODE_VER

echo   [WARN] Node.js not found! Attempting automatic install via winget...
where winget >nul 2>&1
if errorlevel 1 goto :ERR_NO_NODE
call winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements --accept-source-agreements --force
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE goto :ERR_NO_NODE

:CHECK_NODE_VER
for %%d in ("%NODE_EXE%") do set "PATH=%%~dpd;%PATH%"
for /f "delims=" %%v in ('node -v 2^>nul') do set "NODE_VER=%%v"
echo   [OK] Using Node.js %NODE_VER% at "%NODE_EXE%"

"%NODE_EXE%" -e "const m=parseInt(process.versions.node.split('.')[0],10); process.exit(m>=18?0:1);" >nul 2>&1
if errorlevel 1 goto :ERR_OLD_NODE

:: ------------------------------------------------------------------------
:: RUN MULTI-FALLBACK FORCE INSTALLER (Quoted "%NODE_EXE%" - Zero Space Bug!)
:: ------------------------------------------------------------------------
"%NODE_EXE%" "%~dp0scripts\windows_install_runner.js"
if errorlevel 1 goto :FINISHED_WITH_ERRORS

echo   Press any key to close this installer window...
pause >nul
exit /b 0

:FINISHED_WITH_ERRORS
echo   [!] Error details were also saved to "install_errors.txt" and "install_full.log".
echo   Press any key after reading the error details above to close...
pause >nul
exit /b 1

:ERR_NOT_EXTRACTED
color 0C
echo ========================================================================
echo   [CRITICAL ERROR] Project files not found in "%CD%"!
echo   Doya kore ZIP file-ti age Right-Click -^> Extract All kore nin,
echo   tarpor extract kora folder theke install.bat Run as Administrator korun.
echo ========================================================================
pause
exit /b 1

:ERR_NO_NODE
color 0C
echo ========================================================================
echo   [CRITICAL ERROR] Node.js install kora nei!
echo   Download Node.js LTS (64-bit .msi): https://nodejs.org/en/download
echo ========================================================================
pause
exit /b 1

:ERR_OLD_NODE
color 0C
echo ========================================================================
echo   [CRITICAL ERROR] Node.js version (%NODE_VER%) is older than v18!
echo   Upgrade from: https://nodejs.org/en/download
echo ========================================================================
pause
exit /b 1
