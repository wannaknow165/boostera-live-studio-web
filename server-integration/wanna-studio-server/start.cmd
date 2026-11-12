@echo off
cd /d "%~dp0"
title WANNA Studio Server
echo WANNA Studio Server - gallery: http://localhost:8800/   live effects: http://localhost:8800/fx/
start "" http://localhost:8800/
node server.mjs
pause
