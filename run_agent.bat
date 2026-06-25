@echo off
title Wiley AI Bridge Server
cd /d "C:\Users\thome\Downloads\accessing chrome for hw"

echo Cleaning up old server processes...
taskkill /F /FI "WindowTitle eq Wiley AI Bridge Server" /T >nul 2>&1
for /f "tokens=5" %%a in ('netstat.exe -aon ^| findstr :5000') do taskkill /F /PID %%a >nul 2>&1
timeout /t 1 /nobreak >nul

echo Checking dependencies...
python -m pip install flask flask-cors requests python-dotenv google-generativeai >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo Installing required libraries...
    python -m pip install flask flask-cors requests python-dotenv google-generativeai
)

echo Starting Bridge Server v2.0...
python bridge_server.py
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo [!] THE SERVER CRASHED. 
    echo Please check if you have Python installed correctly.
)
pause
