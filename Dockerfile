# OnVideo v2 — Remotion 서버 렌더용 Docker (Railway 배포)
FROM node:22-bookworm-slim

# Chrome Headless Shell 의존성 + ffmpeg
RUN apt-get update && apt-get install -y \
  libnss3 libdbus-1-3 libatk1.0-0 libgbm-dev libasound2 libxrandr2 \
  libxkbcommon-dev libxfixes3 libxcomposite1 libxdamage1 libatk-bridge2.0-0 \
  libpango-1.0-0 libcairo2 libcups2 ffmpeg fonts-noto-cjk \
  && rm -rf /var/lib/apt/lists/*

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
CMD ["npx", "tsx", "server.ts"]
