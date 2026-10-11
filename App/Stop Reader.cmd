@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" scripts\stop.mjs
) else (
  node scripts\stop.mjs
)
if errorlevel 1 pause
