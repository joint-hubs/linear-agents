@echo off
setlocal
call "%~dp0_lib.bat" || exit /b 1
REM Agent 0 - CADENCE (weekly). Spec: docs/agent-0-cadence.md
REM Main = MiniMax M3 (czyta 100+ issues, tanio). Retro -> GLM-5.2. Digest PL -> DeepSeek V4 Pro. Moze isc z crona.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\cadence"
set "ANTHROPIC_MODEL=minimax/minimax-m3"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4-8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4-6"
set "ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash"
echo [cadence] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [cadence] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
endlocal
