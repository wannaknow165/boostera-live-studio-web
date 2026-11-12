@echo off
cd /d "%~dp0"
call npm.cmd install --omit=dev
if errorlevel 1 (pause & exit /b 1)
call start-mobile.cmd
