@echo off
chcp 65001 >nul
echo ============================================
echo   规则养蛊局 RULE LAB · 制度压力测试平台
echo ============================================
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo [错误] 未找到 Node.js，请先安装 Node.js >= 18
  pause
  exit /b 1
)
echo 启动中... 请在浏览器打开 http://localhost:3000
echo 关闭请按 Ctrl+C
node server.js
pause
