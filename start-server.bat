@echo off
title AI MEDVISION - Backend Server
color 0A

echo ============================================
echo   AI MEDVISION - Node.js Backend Launcher
echo ============================================
echo.

:: Check Node.js
where node >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is NOT installed or not in PATH.
    echo.
    echo Please install Node.js from: https://nodejs.org/
    echo Choose the LTS version (recommended).
    echo After installing, close this window and run it again.
    echo.
    pause
    start https://nodejs.org/
    exit /b 1
)

echo [OK] Node.js found:
node --version
echo.

:: Check if node_modules exists
if not exist "node_modules\" (
    echo [INFO] Installing dependencies (first run)...
    call npm install
    if %errorlevel% neq 0 (
        echo [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo [OK] Dependencies installed.
    echo.
)

:: Check if Ollama is running
echo [INFO] Checking Ollama connection...
curl -s http://localhost:11434/api/tags >nul 2>&1
if %errorlevel% neq 0 (
    echo [WARNING] Ollama does not appear to be running at http://localhost:11434
    echo           Start Ollama and make sure the llava model is pulled:
    echo             ollama pull llava
    echo.
    echo           The server will still start - you can retry once Ollama is up.
    echo.
)

echo [INFO] Starting AI MEDVISION backend...
echo [INFO] Open your browser at: http://localhost:3000
echo.
echo Press Ctrl+C to stop the server.
echo.

node server.js
pause
