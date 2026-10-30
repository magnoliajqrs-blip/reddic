@echo off
setlocal EnableExtensions DisableDelayedExpansion

:: Switch from C:\Windows\System32 (if Run as Admin) to this exact project folder!
cd /d "%~dp0"
title Reddit Bulk Checker - Direct Local IP + Visible Browser Mode
chcp 65001 >nul 2>&1
reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1

:: Locate node.exe safely even with spaces in "C:\Program Files\nodejs\node.exe"
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if defined NODE_EXE goto :NODE_READY
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if defined NODE_EXE goto :NODE_READY
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "PATH=%LocalAppData%\Programs\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
if not defined NODE_EXE goto :ERR_NO_NODE
:NODE_READY
:: Node 20+ is required (package.json engines); fail with a readable message, not a crash
"%NODE_EXE%" -e "process.exit(Number(process.versions.node.split('.')[0])>=20?0:1)" >nul 2>&1
if errorlevel 1 goto :ERR_OLD_NODE
if not exist "%~dp0reddit_checker.js" goto :ERR_NOT_EXTRACTED
if not exist "%~dp0node_modules\node-tls-client" goto :NEED_INSTALL
if not exist "%~dp0node_modules\rebrowser-playwright-core" goto :NEED_INSTALL

:: Direct Local IP (clear any stray OS proxy env vars) + Visible Background Browsers!
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "HEADLESS=false"

"%NODE_EXE%" "%~dp0reddit_checker.js" --headed %*
set "EXIT_CODE=%ERRORLEVEL%"
echo.
echo ========================================================================
if "%EXIT_CODE%"=="0" echo   Checker completed! Results saved in hits.txt / 2fa.txt / invalid.txt
if not "%EXIT_CODE%"=="0" echo   [!] Checker finished with status code %EXIT_CODE%. See messages above.
echo ========================================================================
pause
exit /b %EXIT_CODE%

:NEED_INSTALL
color 0E
echo ========================================================================
echo   [!] First-time setup required - running install.bat automatically...
echo ========================================================================
call "%~dp0install.bat" --elevated
if errorlevel 1 exit /b 1
color 07
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "HEADLESS=false"
"%NODE_EXE%" "%~dp0reddit_checker.js" --headed %*
pause
exit /b %ERRORLEVEL%

:ERR_NOT_EXTRACTED
color 0C
echo ========================================================================
echo   [CRITICAL ERROR] reddit_checker.js not found!
echo   ZIP file-ti age Extract All kore folder-er vitor theke run.bat chalan.
echo ========================================================================
pause
exit /b 1

:ERR_OLD_NODE
color 0C
echo ========================================================================
echo   [CRITICAL ERROR] Node.js is too old. This project needs Node 20 or newer.
echo   Installed: & "%NODE_EXE%" -v
echo   Download: https://nodejs.org/en/download  (LTS 22 recommended)
echo ========================================================================
pause
exit /b 1

:ERR_NO_NODE
color 0C
echo ========================================================================
echo   [CRITICAL ERROR] Node.js not found! Please run install.bat first.
echo ========================================================================
pause
exit /b 1
