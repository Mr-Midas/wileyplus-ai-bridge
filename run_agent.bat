@echo off
title Wiley AI Bridge Server
cd /d "%~dp0"

echo ============================================
echo  WileyPLUS AI Bridge Server v7.1
echo ============================================
echo.

echo Cleaning up old server processes...
taskkill /F /FI "WindowTitle eq Wiley AI Bridge Server" /T >nul 2>&1
for /f "tokens=5" %%a in ('netstat.exe -aon ^| findstr :5000') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo Checking dependencies...
python -m pip install flask flask-cors requests python-dotenv google-generativeai playwright >nul 2>&1

echo Launching Chrome with remote debugging...
:: Chrome uses your default logged-in profile automatically
start "" "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
echo Chrome started. Waiting for it to load...
timeout /t 5 /nobreak >nul

echo Starting Bridge Server v7.1 on port 5000...
echo.
python bridge_server.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] THE SERVER CRASHED.
    echo Please check if you have Python installed correctly.
)
pause
