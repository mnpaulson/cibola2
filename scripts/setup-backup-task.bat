@echo off
setlocal enabledelayedexpansion

echo ===================================================
echo   Cibola2 Automated Nightly DB Backup Setup
echo ===================================================
echo.

:: Get current directory (project root directory)
pushd "%~dp0.."
set "PROJECT_ROOT=%CD%"
popd

set "BACKUP_SCRIPT=%PROJECT_ROOT%\scripts\backup-sqlite.js"
set "TASK_NAME=Cibola2_DB_Backup"

if not exist "%BACKUP_SCRIPT%" (
    echo [ERROR] Backup script not found at: %BACKUP_SCRIPT%
    echo.
    pause
    exit /b 1
)

:: Find Node.js executable path
for /f "tokens=*" %%i in ('where node 2^>nul') do (
    set "NODE_EXE=%%i"
    goto :found_node
)

:found_node
if "%NODE_EXE%"=="" (
    echo [ERROR] Node.js executable was not found in system PATH.
    echo Please make sure Node.js is installed before setting up the backup task.
    echo.
    pause
    exit /b 1
)

echo [1/3] Project Root: %PROJECT_ROOT%
echo [2/3] Node Path:    %NODE_EXE%
echo [3/3] Script Path:  %BACKUP_SCRIPT%
echo.

set /p BACKUP_TIME="Enter nightly backup time in 24-hr format HH:mm [default 02:00]: "
if "%BACKUP_TIME%"=="" set "BACKUP_TIME=02:00"

echo.
echo Registering Windows Scheduled Task "%TASK_NAME%" to run daily at %BACKUP_TIME%...

schtasks /create /tn "%TASK_NAME%" /tr "\"%NODE_EXE%\" \"%BACKUP_SCRIPT%\"" /sc daily /st %BACKUP_TIME% /ru SYSTEM /f >nul 2>&1

if %errorlevel% neq 0 (
    echo.
    echo [INFO] Running as SYSTEM requires elevated Administrative privileges.
    echo Attempting task registration for current user...
    
    schtasks /create /tn "%TASK_NAME%" /tr "\"%NODE_EXE%\" \"%BACKUP_SCRIPT%\"" /sc daily /st %BACKUP_TIME% /f
)

if %errorlevel% equ 0 (
    echo.
    echo ===================================================
    echo   Task Created Successfully!
    echo ===================================================
    echo - Task Name: %TASK_NAME%
    echo - Schedule:  Every day at %BACKUP_TIME%
    echo - Log File:  %PROJECT_ROOT%\backups\backup.log
    echo.
    echo To test the backup task immediately, run:
    echo   schtasks /run /tn "%TASK_NAME%"
    echo.
    echo To view events in Windows Event Viewer:
    echo   Open eventvwr.msc -^> Applications and Services Logs -^> Microsoft -^> Windows -^> TaskScheduler -^> Operational
    echo.
) else (
    echo.
    echo [ERROR] Failed to create scheduled task.
    echo Please right-click 'setup-backup-task.bat' and select 'Run as Administrator'.
    echo.
)

pause
