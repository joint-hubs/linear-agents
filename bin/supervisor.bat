@echo off
set "LA_SUPERVISOR_REPO=%CD%"
REM The ONLY user-facing launcher of the supervised pipeline (ADR-0009): Mateusz
REM talks here and nowhere else. Children (plan/dev/review/test) are started by
REM scripts/supervisor-spawn.mjs as headless processes in their own worktrees -
REM never by a .bat, never with a console. LA_SUPERVISOR_REPO (the repo being
REM worked ON = the launch cwd, FOC-172) is captured here before anything can
REM cd; the Node side also derives it from its own cwd.
node --disable-warning=ExperimentalWarning "%~dp0..\scripts\squad-start.mjs" supervisor %*
exit /b %errorlevel%
