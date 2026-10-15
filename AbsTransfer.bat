@echo off
chcp 65001 >nul
cd /d "%~dp0pc"
start "" pythonw abs_server.py
