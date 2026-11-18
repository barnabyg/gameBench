@echo off
setlocal
pushd "%~dp0" || exit /b 1
call npm.cmd run dashboard -- %*
set "dashboard_exit=%errorlevel%"
popd
exit /b %dashboard_exit%
