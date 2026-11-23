@echo off
rem Abre o Painel ABEP-TIC. Deixe esta janela aberta enquanto usa o painel.
cd /d "%~dp0"
python servidor.py %*
if errorlevel 1 pause
