# OnVideo v2 — Remotion 서버 렌더용 Docker (Railway 배포)
FROM node:22-bookworm-slim

# Chrome Headless Shell 의존성 + ffmpeg + yt-dlp(유튜브 하이라이트용, python 런타임 포함)
RUN apt-get update && apt-get install -y \
  libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
  libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
  libpango-1.0-0 libcairo2 libcups2 ffmpeg fonts-noto-cjk \
  python3 python3-pip libgl1 libglib2.0-0 curl unzip git \
  && curl -L https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
  && chmod a+rwx /usr/local/bin/yt-dlp \
  # ↑빌드 시점 바이너리를 심고(초기값), 실제 사용 버전은 부팅 때 CMD에서 자동 최신화한다(아래).
  #   ★이유: 유튜브는 봇차단 로직을 수시로 바꿔서, 고정 버전이면 어느 날 '전 클라이언트'가 한꺼번에 막힌다.
  #   부팅마다 yt-dlp를 최신으로 올리면 재배포만으로(혹은 자동) 유튜브 변경에 따라붙는다 = 봇차단 영구 대응의 핵심.
  #   (a+rwx = 부팅 때 self-update가 바이너리를 제자리에 덮어쓸 수 있게 쓰기권한 부여.)
  && rm -rf /var/lib/apt/lists/*

# ★스마트 리프레임(인물 추적 세로변환)용 opencv + YuNet 얼굴감지 모델.
#   libgl1/libglib2.0-0 = opencv 런타임 의존. YuNet(337KB)=가볍고 정확한 최신 얼굴감지기.
#   설치 실패해도 앱은 뜨고(리프레임만 블러레터박스로 폴백) — lib/reframe.ts가 방어적.
RUN pip3 install --no-cache-dir --break-system-packages opencv-python-headless numpy || echo "opencv install skipped"
RUN mkdir -p /opt/models \
  && curl -fL https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx -o /opt/models/yunet.onnx \
  || echo "yunet model download skipped(haar 폴백)"
ENV YUNET_MODEL=/opt/models/yunet.onnx

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
# ①yt-dlp 부팅 자동 최신화 — ★self-update(`yt-dlp -U`)는 조용히 실패해 '옛 버전에 묶이는' 사고가 잦다
#   (테리: 2개월 묵은 2026.08.19에 멈춰 전 클라이언트가 봇차단됨). 그래서 self-update 대신 GitHub
#   nightly-builds 최신 바이너리를 '직접 내려받아' 덮어쓴다(결정적). nightly=유튜브 변경을 제일 빨리 반영.
#   다운로드 실패(깃허브 장애 등)해도 기존 바이너리로 그대로 진행(.new만 버림). 앱 내 '🔄 최신화' 버튼으로도 동일 동작.
# ②PO토큰 제공자 서버를 백그라운드로 띄우고(4416), ③앱을 메인 프로세스로 실행(exec로 시그널 전달).
CMD ["sh", "-c", "echo '[boot] yt-dlp 최신 nightly 내려받는 중…'; (curl -fsSL --max-time 90 https://github.com/yt-dlp/yt-dlp-nightly-builds/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp.new && chmod a+rwx /usr/local/bin/yt-dlp.new && mv -f /usr/local/bin/yt-dlp.new /usr/local/bin/yt-dlp && echo '[boot] yt-dlp nightly 갱신 완료') || echo '[boot] yt-dlp 갱신 실패 — 기존 버전 사용'; yt-dlp --version 2>&1 | sed 's/^/[boot] yt-dlp /'; node /opt/bgutil/server/build/main.js >/tmp/bgutil.log 2>&1 & exec npx tsx server.ts"]
