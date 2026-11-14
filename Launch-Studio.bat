@echo off
setlocal EnableDelayedExpansion
title Dry Run Studio v1.0.0 — by SRP Hub (srphub.in)
color 0B
cd /d "%~dp0"

:: [BUILD-ID: dryrun-studio-launcher-v1.0.0]
:: © 2026 SRP Hub (srphub.in) — MIT Open-Source License

set ASTRO_TELEMETRY_DISABLED=1
set NEXT_TELEMETRY_DISABLED=1
set DO_NOT_TRACK=1
set NO_UPDATE_NOTIFIER=1

where node >nul 2>nul
if %errorlevel% neq 0 (
    color 0C
    echo ====================================================================
    echo  [REQUIREMENT] Node.js is not installed on this PC.
    echo  Opening https://nodejs.org/ so you can install Node.js LTS...
    echo ====================================================================
    start "" "https://nodejs.org/"
    pause
    exit /b 1
)

if not exist "%~dp0src\server.mjs" (
    color 0C
    echo [ERROR] Missing src\server.mjs. Please extract the full Dry Run Studio ZIP folder first.
    pause
    exit /b 1
)

:: Silently remove Mark-of-the-Web zone identifiers from extracted ZIP files
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-ChildItem -LiteralPath '%~dp0' -Recurse -File | Unblock-File -ErrorAction SilentlyContinue" >nul 2>nul

echo ====================================================================
echo  Dry Run Studio v1.0.0 — Check it on localhost before it goes to cloud
echo  (c) 2026 SRP Hub (srphub.in) ^| MIT Open-Source License
echo ====================================================================
echo.
echo Starting local studio engine on http://127.0.0.1:49152 ...
echo (Keep this console minimized while working. It closes automatically on Exit.)

node "%~dp0src\server.mjs" "%~dp0"
set "EXIT_CODE=%errorlevel%"

if %EXIT_CODE% neq 0 (
    color 0C
    echo.
    echo [ERROR] Dry Run Studio exited with code %EXIT_CODE%.
    pause
)
exit /b 0
