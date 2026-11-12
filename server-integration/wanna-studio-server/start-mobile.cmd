@echo off
cd /d "%~dp0"
title WANNA FX Mobile
node start-mobile.mjs
if errorlevel 1 pause
