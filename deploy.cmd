@echo off
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required. Install a version supported by package.json from https://nodejs.org/
  echo Then reopen this file. See docs\setup.md for the guided steps.
  if "%~1"=="" pause
  exit /b 1
)
node "%~dp0scripts\deploy.mjs" %*
set "result=%ERRORLEVEL%"
if "%~1"=="" pause
exit /b %result%
