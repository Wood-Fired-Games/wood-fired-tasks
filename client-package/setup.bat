@echo off
setlocal

REM Wood Fired Tasks client setup wrapper.
REM
REM Preferred (key never appears on a command line):
REM   set WFT_API_KEY=...
REM   setup.bat
REM   setup.bat http://192.0.2.100:3000
REM
REM Legacy (DEPRECATED -- key on argv leaks via shell history and 'wmic process'):
REM   setup.bat YOUR_API_KEY
REM   setup.bat YOUR_API_KEY http://192.0.2.100:3000

if /I "%~1"=="--help" goto :show_help
if /I "%~1"=="-h"     goto :show_help
if /I "%~1"=="/?"     goto :show_help

REM Two-arg form: positional argv API key is deprecated. We forward it to
REM setup.ps1 -ApiKey for backwards compatibility, which itself emits a
REM deprecation warning.
if not "%~2"=="" goto :two_args

REM One-arg form: ambiguous. If the arg looks like a URL, treat it as
REM the server URL and let setup.ps1 resolve the key from env / secret
REM file / prompt. Otherwise assume it is a (deprecated) API key.
if not "%~1"=="" (
    echo %~1 | findstr /R /C:"^https*://" >nul
    if not errorlevel 1 (
        powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -ServerUrl "%~1"
        exit /b %ERRORLEVEL%
    )
    echo [WARN] Passing the API key as a positional argument is DEPRECATED.
    echo [WARN] Set WFT_API_KEY in the environment or let setup.ps1 prompt for it.
    powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -ApiKey "%~1"
    exit /b %ERRORLEVEL%
)

REM Zero-arg form: hand off to setup.ps1. It will pick up WFT_API_KEY from
REM the environment, fall back to the per-user secret file, then prompt.
powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
exit /b %ERRORLEVEL%

:two_args
echo [WARN] Passing the API key as a positional argument is DEPRECATED.
echo [WARN] Set WFT_API_KEY in the environment or let setup.ps1 prompt for it.
powershell -ExecutionPolicy Bypass -File "%~dp0setup.ps1" -ApiKey "%~1" -ServerUrl "%~2"
exit /b %ERRORLEVEL%

:show_help
echo Usage:
echo   set WFT_API_KEY=...
echo   setup.bat                          ^(uses env / secret file / prompt^)
echo   setup.bat ^<SERVER_URL^>             ^(same, with custom server URL^)
echo.
echo Deprecated ^(key on argv leaks via shell history^):
echo   setup.bat ^<API_KEY^>
echo   setup.bat ^<API_KEY^> ^<SERVER_URL^>
exit /b 0
