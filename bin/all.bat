@echo off
setlocal
REM Open the lead agent of EVERY area in separate windows (whole pipeline).
REM Each = interactive Claude Code session; close the window to stop that squad.
set "B=%~dp0"
echo Otwieram lead-agentow wszystkich obszarow w osobnych oknach...
start "CADENCE squad" cmd /k "%B%cadence.bat"
start "PLAN squad"    cmd /k "%B%plan.bat"
start "DEV squad"     cmd /k "%B%dev.bat"
start "REVIEW squad"  cmd /k "%B%review.bat"
start "TEST squad"    cmd /k "%B%test.bat"
echo Otwarto: cadence, plan, dev, review, test.
echo (Pojedynczy sub-agent: bin\agent.bat ^<area^> ^<role^>)
endlocal
