#!/bin/bash
# 온비디오 시크릿 봇 — 맥 로그인 시 자동 실행 등록(launchd LaunchAgent).
#   1회만 실행하면, 이후 맥을 켤 때마다 봇이 백그라운드로 자동 가동된다(npm 따로 안 켜도 됨 = 퍼블리처럼 "앱 하나" 느낌).
#   창보기 ON이면 실제 크롬창이 화면에 뜬다(LaunchAgent는 로그인 GUI 세션이라 창 접근 가능).
set -e

DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST="$HOME/Library/LaunchAgents/com.onvideo.secretbot.plist"
NODE="$(command -v node)"
if [ -z "$NODE" ]; then echo "❌ node를 찾을 수 없어요. Node.js 설치 후 다시 실행하세요."; exit 1; fi

echo "📦 의존성/브라우저 준비…"
cd "$DIR"
npm install >/dev/null 2>&1 || true
npx playwright install chromium >/dev/null 2>&1 || true
echo "🔧 빌드…"
npm run build

mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.onvideo.secretbot</string>
  <key>ProgramArguments</key><array>
    <string>$NODE</string>
    <string>$DIR/dist/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/bot.log</string>
  <key>StandardErrorPath</key><string>$DIR/bot.err.log</string>
  <key>EnvironmentVariables</key><dict>
    <key>OVBOT_BASE</key><string>https://video.xn--zk5biyyw.com</string>
    <key>OVBOT_TOKEN</key><string>onvideo-secret-bot</string>
  </dict>
</dict></plist>
PL

launchctl unload "$PLIST" 2>/dev/null || true
launchctl load "$PLIST"
echo ""
echo "✅ 등록 완료 — 맥을 켤 때마다 시크릿 봇이 자동 가동됩니다."
echo "   이제 콘솔(로고 7클릭 → 345678)에서 계정 추가하고 시작하면 바로 작동해요."
echo "   끄기:  launchctl unload $PLIST"
echo "   로그:  tail -f $DIR/bot.log"
