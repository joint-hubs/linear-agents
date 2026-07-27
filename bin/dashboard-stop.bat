@echo off
echo [STOP] Zatrzymywanie dashboardu Fenix...

set "KILLED=0"

REM --- Ubij proces na porcie API (7331) ---
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":7331" ^| findstr "LISTENING"') do (
    echo Ubijam proces PID %%a - port 7331 - telemetry-server...
    taskkill /F /PID %%a 2>nul
    set "KILLED=1"
)

REM --- Ubij proces na porcie UI (5173) ---
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173" ^| findstr "LISTENING"') do (
    echo Ubijam proces PID %%a - port 5173 - Vite dev server...
    taskkill /F /PID %%a 2>nul
    set "KILLED=1"
)

if "%KILLED%"=="0" (
    echo [INFO] Nie znaleziono dzialajacych procesow dashboardu na portach 7331 i 5173.
)

echo [OK] Dashboard zatrzymany.
exit /b 0