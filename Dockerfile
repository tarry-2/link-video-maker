FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg fonts-noto-cjk ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY server.js pipeline.js ./
COPY public ./public
RUN mkdir -p /app/data
ENV PORT=3000
EXPOSE 3000
CMD ["node","server.js"]
