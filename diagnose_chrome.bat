@echo off
title Chrome Debug Diagnostic
echo ============================================================
echo  CHROME DEBUG DIAGNOSTIC TOOL
echo ============================================================
echo.

echo [1/3] Checking if Port 9222 is listening...
netstat -ano | findstr :9222
if %ERRORLEVEL% EQU 0 (
    echo [+] Port 9222 is OPEN.
) else (
    echo [-] Port 9222 is CLOSED.
)
echo.

echo [2/3] Checking Chrome Process Flags...
echo ------------------------------------------------------------
powershell -Command "Get-CimInstance Win32_Process -Filter \"name = 'chrome.exe'\" | Select-Object CommandLine | Format-List"
echo ------------------------------------------------------------
echo.

echo [3/3] Testing HTTP Connection...
powershell -Command "try { $r = Invoke-WebRequest -Uri http://127.0.0.1:9222/json/version -TimeoutSec 2; Write-Host '[+] HTTP Connection SUCCESSFUL' } catch { Write-Host \"[-] HTTP Connection FAILED: $($_.Exception.Message)\" }"
echo.

echo ============================================================
echo  DIAGNOSTIC COMPLETE
echo ============================================================
echo.
set /p "dummy=Press ENTER to close this window..."
