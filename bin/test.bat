@echo off
setlocal
call "%~dp0_lib.bat" || exit /b 1
REM Agent 4 - TEST. Spec: docs/agent-4-test.md
REM Main = MiniMax M3 (deploy/run, multimodal screenshoty). scenarios = DeepSeek V4 Flash (small_fast). root-cause -> GLM-5.2.
set "CLAUDE_CONFIG_DIR=%ROOT%\agents\test"
set "ANTHROPIC_MODEL=minimax/minimax-m3"
set "ANTHROPIC_DEFAULT_OPUS_MODEL=anthropic/claude-opus-4.8"
set "ANTHROPIC_DEFAULT_SONNET_MODEL=anthropic/claude-sonnet-4.6"
set "ANTHROPIC_SMALL_FAST_MODEL=deepseek/deepseek-v4-flash"
echo [test] CLAUDE_CONFIG_DIR=%CLAUDE_CONFIG_DIR%
echo [test] main=%ANTHROPIC_MODEL% small_fast=%ANTHROPIC_SMALL_FAST_MODEL%
claude %*
endlocal
