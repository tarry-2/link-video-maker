# 링크 영상 메이커

뉴스·블로그·상품·여행 등 공개 웹페이지 URL을 입력하면 한국어 대본, 음성, 장면, 자막이 있는 MP4를 생성하는 단일 사용자 서버 앱입니다.

## 화면·옵션

- **테마**: 헤더 버튼으로 라이트(웜 아이보리)/다크(웜 에스프레소)를 전환합니다. 선택은 브라우저에 저장됩니다.
- **영상 길이 기준**(리서치 반영):
  - 숏폼(세로 9:16): 15 / **30(표준)** / 45 / 60초 — Shorts·TikTok·Reels 스위트스팟 및 뉴스 숏 단위
  - 롱폼(가로 16:9): 2 / **3(표준)** / 5 / 8분 — 뉴스 리포트 2~3분, 설명형 5분대, 8분=심층
- **자막**: 넣기/빼기를 옵션에서 고릅니다. 넣으면 영상에 한글 자막을 새기고, 어느 경우든 자막 SRT를 따로 내려받을 수 있습니다.

## 시작

1. Node.js 20 이상과 FFmpeg를 설치합니다. 한글 폰트(Noto Sans CJK 권장)를 설치합니다.
   - **영상에 자막을 새기려면 자막(libass)이 포함된 FFmpeg가 필요합니다.** 자막 기능이 없는 FFmpeg에서도 MP4는 생성되지만 자막은 영상에 새겨지지 않고 SRT로만 제공됩니다.
   - macOS(Homebrew): `brew install ffmpeg-full` 후 `.env`에 `FFMPEG_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg`, `FFPROBE_PATH=/opt/homebrew/opt/ffmpeg-full/bin/ffprobe`를 지정합니다. 기존 시스템 FFmpeg는 건드리지 않습니다.
   - Docker(`docker compose up`)는 자막 지원 FFmpeg와 한글 폰트가 기본 포함됩니다.
2. `.env.example`을 `.env`로 복사하고 `ADMIN_PASSWORD`와 `APP_SECRET`을 설정합니다. `APP_SECRET`은 `openssl rand -hex 32`로 만들 수 있습니다.
3. `npm start`를 실행하고 `http://localhost:3000`을 엽니다. 또는 `docker compose up -d --build`로 실행합니다.
4. 관리자 비밀번호로 로그인해 설정에서 OpenAI, Pexels, Gemini 키를 저장합니다.

공개 서버에 올릴 때는 HTTPS 역방향 프록시와 접근 제한을 적용하세요. Docker Compose 기본 포트는 로컬 컴퓨터에만 바인딩됩니다. `data/`와 `.env`를 GitHub에 올리지 마세요. 키는 APP_SECRET으로 암호화해 `data/settings.enc`에 저장합니다. 비밀번호나 APP_SECRET을 잃으면 기존 설정에 접근할 수 없습니다.

## 생성 흐름

- OpenAI: 링크에서 추출한 텍스트로 장면별 한국어 대본을 만들고 TTS 나레이션을 생성합니다.
- Pexels: 장면별 사진을 찾습니다. 검색 실패 시 단색 장면과 자막으로 대체하며 진행 상태에 표시합니다.
- 애니형: OpenAI 이미지 생성으로 애니메이션풍 장면 이미지를 만듭니다. 사진의 움직임은 FFmpeg 줌 효과로 합성합니다.
- Gemini Veo 3.1 Lite: 선택한 수만큼 핵심 장면의 짧은 AI 영상 클립을 생성합니다. 비용이 발생하므로 기본값은 0개입니다. Veo 실패 시 기존 장면 이미지로 대체합니다.
- FFmpeg: 한글 자막을 AI 이미지 바깥에서 렌더링하고 MP4(H.264/AAC)를 합성합니다.

롱폼은 사진·자막 장면의 길이가 길어질 수 있습니다. AI 영상 전 구간 생성은 하지 않습니다. 영상은 생성 시점에 서버가 렌더링하며, 작업이 끝날 때까지 서버를 켜 두어야 합니다. 대본과 출처를 검토한 뒤 게시하세요.

## 키 발급

| 키 | 기능 | 발급 |
| --- | --- | --- |
| OpenAI API | 대본, 한국어 음성, 애니형 이미지 | https://platform.openai.com/api-keys |
| Pexels API | 무료 스톡 사진 검색 | https://www.pexels.com/api/ |
| Google Gemini API | 선택한 핵심 장면의 Veo AI 영상 | https://aistudio.google.com/app/apikey |

API 사용 요금은 각 제공업체 계정에서 청구됩니다. 키 저장은 서버에서만 처리하며 브라우저 응답에는 저장 여부만 표시합니다.

## 주의

일부 사이트는 자동 추출을 제한합니다. 그때는 원문 텍스트를 직접 입력하세요. 저작권이 있는 기사 원문·사진을 그대로 재게시하지 않도록 확인하고, 사실과 수치를 최종 검토하세요. Pexels 검색 결과가 실제 사건의 증거 영상으로 오인되지 않게 사용하세요.
