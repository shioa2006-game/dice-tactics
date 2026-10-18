@echo off
rem ======================================================================
rem  DICE TACTICS launcher (Windows)
rem    Double-click this file to start a local server in this window and
rem    open the game in your default browser. If port 8130 is busy, the
rem    next free port is used.
rem    Quit:            close this window (the server stops)
rem    Start port:      launch.bat 9000
rem  NOTE: keep this file ASCII-only (cmd.exe misreads UTF-8 lines).
rem ======================================================================
setlocal
cd /d "%~dp0"
title DICE TACTICS

where node >nul 2>nul
if errorlevel 1 goto nonode

set "PORT=%~1"
if "%PORT%"=="" set "PORT=8130"

node serve.js %PORT% --open --auto-port
if errorlevel 1 goto failed
exit /b 0

:nonode
echo [ERROR] Node.js was not found.
echo Install Node.js 18 or later from https://nodejs.org/ and run this file again.
start "" "https://nodejs.org/"
echo.
pause
exit /b 1

:failed
echo.
pause
exit /b 1
