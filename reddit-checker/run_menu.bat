@echo off
setlocal EnableExtensions DisableDelayedExpansion
cd /d "%~dp0"
title Reddit Checker - Windows Quick Launcher (Direct Local IP)
chcp 65001 >nul 2>&1
reg add HKCU\Console /v VirtualTerminalLevel /t REG_DWORD /d 1 /f >nul 2>&1
set "NODE_EXE="
for /f "delims=" %%i in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%i"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LocalAppData%\Programs\nodejs\node.exe" set "NODE_EXE=%LocalAppData%\Programs\nodejs\node.exe"
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "HEADLESS=false"

:MENU
cls
echo ========================================================================
echo   REDDIT CHECKER / SOLVER - WINDOWS QUICK LAUNCHER (NO PROXY)
echo ========================================================================
echo   [1] Start Bulk Account Checker (accounts.txt -^> hits.txt / 2fa.txt)
echo   [2] Live Diagnose (Direct Local IP + Visible Browser + reCAPTCHA)
echo   [3] Verify 6 Live Browsers Rotation (Chromium + Firefox + Safari)
echo   [4] Run Full 28-Suite Automated Test Runner (npm test)
echo   [5] Test Single Account Login (--login username password --debug)
echo   [6] Re-run Force Installer (install.bat)
echo   [0] Exit
echo ========================================================================
set /p "CHOICE=Select an option (0-6): "

if "%CHOICE%"=="1" goto :OPT_BULK
if "%CHOICE%"=="2" goto :OPT_DIAG
if "%CHOICE%"=="3" goto :OPT_ROT6
if "%CHOICE%"=="4" goto :OPT_TEST
if "%CHOICE%"=="5" goto :OPT_LOGIN
if "%CHOICE%"=="6" goto :OPT_INSTALL
if "%CHOICE%"=="0" exit /b 0
goto :MENU

:OPT_BULK
echo.
"%NODE_EXE%" "%~dp0reddit_checker.js" --headed
echo.
pause
goto :MENU

:OPT_DIAG
echo.
"%NODE_EXE%" "%~dp0reddit_solver.js" --diagnose --headed --debug
echo.
pause
goto :MENU

:OPT_ROT6
echo.
"%NODE_EXE%" "%~dp0reddit_solver.js" --verify-rotation 6 --headed
echo.
pause
goto :MENU

:OPT_TEST
echo.
call npm test
echo.
pause
goto :MENU

:OPT_LOGIN
echo.
set /p "R_USER=Enter Reddit Username: "
set /p "R_PASS=Enter Reddit Password: "
"%NODE_EXE%" "%~dp0reddit_solver.js" --login "%R_USER%" "%R_PASS%" --headed --debug
echo.
pause
goto :MENU

:OPT_INSTALL
call "%~dp0install.bat" --elevated
goto :MENU
