@echo off
REM Launch a SINGLE sub-agent of a squad: agent.bat <area> <role> [-- claude args].
REM %* is forwarded whole: after --agent the first two args are <area> <role> and
REM the rest go to claude. Model from config/models.map (resolved on the Node side).
node "%~dp0..\scripts\squad-start.mjs" --agent %*
exit /b %errorlevel%
