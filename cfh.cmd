@echo off
rem Hand off the most recent local cf/claude session in this directory to Happy (phone control).
rem /exit the cf session first, then run: cfh
rem Why "happy --resume id --fork-session": happy forces --session-id which fights both
rem --continue and --resume unless --fork-session is present (2026-10-07 ??, validated).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cfh.ps1"
