// 로컬 봇 엔트리 — 네 맥에서 실행(npm start). 온비디오 작업큐를 폴링하는 워커를 돌린다.
//   헬스체크용 로컬 서버(포트)만 띄우고, 실제 일은 worker.loop()가 한다. 창보기=headed 크롬이 맥 화면에 뜬다.
import express from "express";
import { loop } from "./worker";

const app = express();
app.get("/health", (_req, res) => res.json({ ok: true, at: Date.now() }));

const PORT = Number(process.env.PORT || 4417);
app.listen(PORT, () => {
  console.log(`[시크릿 봇] 로컬 가동 :${PORT}`);
  console.log(`[시크릿 봇] 온비디오(${process.env.OVBOT_BASE || "video.온종일.com"}) 작업 폴링 시작`);
  console.log(`[시크릿 봇] 처음이면 스레드 로그인 창이 뜹니다 — 한 번만 로그인하면 이후엔 세션이 유지됩니다.`);
});

loop().catch((e) => { console.error("[시크릿 봇] 워커 종료:", e); process.exit(1); });
