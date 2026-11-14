@echo off
chcp 65001 >nul
set /p msg="O que voce mudou? (Enter para usar 'atualizacao'): "
if "%msg%"=="" set msg=atualizacao
git add .
git commit -m "%msg%"
git push
pause
