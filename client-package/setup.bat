@echo off
setlocal

if "%~1"=="" (
    echo Usage: setup.bat YOUR_API_KEY [SERVER_URL]
    echo.
    echo Example: setup.bat 912a0df1fc2fc9abb3104195299a4918b221bd03b8cda5f44feb2994bf14f374
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
