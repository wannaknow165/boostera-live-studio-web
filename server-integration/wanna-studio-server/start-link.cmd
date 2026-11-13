@echo off
cd /d "%~dp0"
title CAM LINK program window
node start-link.mjs %*
if errorlevel 1 pause
