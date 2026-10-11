@echo off
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" scripts\launch.mjs
) else (
  node scripts\launch.mjs
)
if errorlevel 1 pause
