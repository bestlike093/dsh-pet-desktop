@echo off
cd /d "%~dp0.."
node scripts\daily-sync.mjs %*
