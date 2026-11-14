@echo off
setlocal EnableDelayedExpansion
title Dry Run Studio — Single-File Portable Packager v1.0.0
color 0E
cd /d "%~dp0"

:: [BUILD-ID: dryrun-portable-packager-v1.0.0]
:: © 2026 SRP Hub (srphub.in) — MIT Open-Source License

echo ====================================================================
echo  Building Single-File Portable Edition:
echo  dist-portable\DryRun-Studio-v1.0.0-Portable.bat
echo ====================================================================

if not exist "%~dp0src\server.mjs" (
    color 0C
    echo [ERROR] src\server.mjs not found. Complete all src\ files before packing.
    pause
    exit /b 1
)

if not exist "%~dp0dist-portable" mkdir "%~dp0dist-portable"

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$root = '%~dp0'.TrimEnd('\'); " ^
  "$outDir = Join-Path $root 'dist-portable'; " ^
  "$tempZip = Join-Path $outDir '_bundle_temp.zip'; " ^
  "$outBat = Join-Path $outDir 'DryRun-Studio-v1.0.0-Portable.bat'; " ^
  "if (Test-Path $tempZip) { Remove-Item $tempZip -Force }; " ^
  "Compress-Archive -Path (Join-Path $root 'src'), (Join-Path $root 'LICENSE') -DestinationPath $tempZip -Force; " ^
  "$b64 = [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($tempZip)); " ^
  "Remove-Item $tempZip -Force; " ^
  "$header = @(" ^
  "  '@echo off'," ^
  "  'setlocal EnableDelayedExpansion'," ^
  "  'title Dry Run Studio v1.0.0 (Portable Edition) — by SRP Hub (srphub.in)'," ^
  "  'color 0B'," ^
  "  'set ASTRO_TELEMETRY_DISABLED=1'," ^
  "  'set NEXT_TELEMETRY_DISABLED=1'," ^
  "  'set DO_NOT_TRACK=1'," ^
  "  'set NO_UPDATE_NOTIFIER=1'," ^
  "  'where node >nul 2>nul'," ^
  "  'if %%errorlevel%% neq 0 ( echo [REQUIREMENT] Please install Node.js LTS from https://nodejs.org/ & start https://nodejs.org/ & pause & exit /b 1 )'," ^
  "  'set \"RUNTIME_DIR=%%APPDATA%%\DryRunStudio\runtime-v1\"'," ^
  "  'if not exist \"%%RUNTIME_DIR%%\" mkdir \"%%RUNTIME_DIR%%\"'," ^
  "  'set \"SELF_BAT=%%~f0\"'," ^
  "  'echo Extracting Dry Run Studio v1.0.0 Portable Runtime...'," ^
  "  'powershell -NoProfile -ExecutionPolicy Bypass -Command \"$raw = [System.IO.File]::ReadAllText($env:SELF_BAT); $m = ''::__PORTABLE_ZIP_'' + ''PAYLOAD__::''; $idx = $raw.LastIndexOf($m); $b64 = $raw.Substring($idx + $m.Length).Trim(); $zip = Join-Path $env:RUNTIME_DIR ''pkg.zip''; [System.IO.File]::WriteAllBytes($zip, [Convert]::FromBase64String($b64)); Expand-Archive -Path $zip -DestinationPath $env:RUNTIME_DIR -Force; Remove-Item $zip -Force\"'," ^
  "  'node \"%%RUNTIME_DIR%%\src\server.mjs\" \"%%~dp0\" \"%%~f0\"'," ^
  "  'exit /b 0'," ^
  "  ''," ^
  "  '::__PORTABLE_ZIP_PAYLOAD__::'," ^
  "  $b64" ^
  ") -join \"`r`n\"; " ^
  "[System.IO.File]::WriteAllText($outBat, $header, (New-Object System.Text.UTF8Encoding($false))); " ^
  "Write-Host ('[SUCCESS] Created: ' + $outBat) -ForegroundColor Green"

echo.
pause
