@echo off
setlocal

if "%~1"=="" (
    echo Usage: setup.bat YOUR_API_KEY [SERVER_URL]
    echo.
    echo Example: setup.bat REDACTED-LEAKED-KEY-ROTATED-2026-05-20
    echo Example: setup.bat YOUR_KEY http://192.168.1.100:3000
    exit /b 1
)

set "API_KEY=%~1"
set "SERVER_URL=%~2"

if "%SERVER_URL%"=="" (
    powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -ApiKey "%API_KEY%"
) else (
    powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -ApiKey "%API_KEY%" -ServerUrl "%SERVER_URL%"
)
