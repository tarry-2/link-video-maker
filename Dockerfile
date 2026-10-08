# OnVideo v2 — Remotion 서버 렌더용 Docker (Railway 배포)
FROM node:22-bookworm-slim

# Chrome Headless Shell 의존성 + ffmpeg + yt-dlp(유튜브 하이라이트용, python 런타임 포함)
RUN apt-get update && apt-get install -y \
  libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
  libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
  libpango-1.0-0 libcairo2 libcups2 ffmpeg fonts-noto-cjk \
  python3 curl unzip git \
  && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rx /usr/local/bin/yt-dlp \
  && rm -rf /var/lib/apt/lists/*

# ★유튜브 n-challenge(2026-09~) 해결용 JS 런타임 Deno — 없으면 모든 다운로드 실패.
RUN curl -fsSL https://deno.land/install.sh | DENO_INSTALL=/usr/local sh \
  && /usr/local/bin/deno --version

# ★★PO 토큰 제공자(bgutil) — 2025+ 유튜브는 데이터센터 IP에 "쿠키 + PO토큰" 둘 다 요구.
#   쿠키만으론 "Sign in to confirm you're not a bot"가 계속 뜸 → 제공자 서버(127.0.0.1:4416)를
#   컨테이너에 같이 띄우고, yt-dlp 플러그인을 깔면 web/default 클라이언트가 자동으로 PO토큰을 받아 뚫는다.
#   서버와 플러그인 버전을 2.0.2로 맞춘다(불일치 시 토큰 형식 어긋남).
RUN git clone --single-branch --branch 2.0.2 https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git /opt/bgutil \
  && cd /opt/bgutil/server && npm ci && npx tsc
RUN mkdir -p /root/.config/yt-dlp/plugins \
  && curl -L https://github.com/Brainicism/bgutil-ytdlp-pot-provider/releases/download/2.0.2/bgutil-ytdlp-pot-provider.zip -o /tmp/potplugin.zip \
  && unzip -o /tmp/potplugin.zip -d /root/.config/yt-dlp/plugins/ \
  && rm /tmp/potplugin.zip

WORKDIR /app

# 의존성 먼저(캐시 활용)
COPY package.json package-lock.json* ./
RUN npm install

# 소스 복사
COPY tsconfig.json ./
COPY src ./src
COPY lib ./lib
COPY web ./web
COPY server.ts ./
COPY public ./public

# Chrome Headless Shell 설치(렌더용)
RUN npx remotion browser ensure

ENV NODE_ENV=production
EXPOSE 4000
# PO토큰 제공자 서버를 백그라운드로 먼저 띄우고(4416), 앱을 메인 프로세스로 실행(exec로 시그널 전달).
#   제공자가 죽어도 앱은 계속 뜨고, 그 경우 yt-dlp는 PO토큰 없이 시도(폴백).
CMD ["sh", "-c", "node /opt/bgutil/server/build/main.js >/tmp/bgutil.log 2>&1 & exec npx tsx server.ts"]
