@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   Cibola2 Backend App - Setup Wizard
echo ===================================================
echo.

:: 1. Check Node.js
echo [*] Step 1: Checking Node.js installation...
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js is not installed or not in your system PATH.
    echo Please download and install Node.js from: https://nodejs.org/
    echo.
    pause
    exit /b 1
)
echo Node.js is installed.
echo.

:: 2. Install dependencies
echo [*] Step 2: Installing project dependencies...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Dependency installation failed. Please check the logs.
    echo.
    pause
    exit /b 1
)
echo.

:: 3. Check/Install PM2
echo [*] Step 3: Checking PM2 process manager...
call pm2 -v >nul 2>&1
if %errorlevel% neq 0 (
    echo PM2 was not found on your system.
    set /p install_pm2="Would you like to install PM2 globally for production process management? (y/n): "
    if /i "!install_pm2!"=="y" (
        echo Installing PM2 globally...
        call npm install -g pm2
        if !errorlevel! neq 0 (
            echo [WARNING] Failed to install PM2 globally. You can install it manually later.
        ) else (
            echo PM2 installed successfully.
        )
    ) else (
        echo Skipping PM2 installation.
    )
) else (
    echo PM2 is already installed.
)
echo.

:: 4. Setup configuration file
echo [*] Step 4: Checking environment configuration...
if not exist .env (
    echo .env file not found. Initializing from .env.example...
    copy .env.example .env >nul
    echo.
    echo [IMPORTANT] A new .env file has been created.
    echo Please review and edit the settings inside the .env file
    echo to configure the database path and image upload directories.
) else (
    echo .env file already exists.
)
echo.

echo ===================================================
echo   Setup Completed Successfully!
echo ===================================================
echo.
echo You can run the application using:
echo   Development mode (auto-reload):       npm run dev
echo   Production mode (manual run):         npm start
echo   Production mode (PM2 process manager): pm2 start src/index.js --name "cibola-backend"
echo.
pause
