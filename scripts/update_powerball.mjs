// scripts/update_powerball.mjs
// 목적: (가능한 경우) 동행 파워볼 "추첨결과" 페이지에서 당첨번호(일반 5 + 파워 1)를 추출해
//      /data/powerball_draws.json, /data/powerball_freq.json 을 갱신한다.
//
// ⚠️ 사이트가 접속대기/차단/로그인 리다이렉트가 걸릴 수 있음.
//    그 경우에는 "데이터를 덮어쓰지 않고" 안전하게 종료한다.

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ✅ 레포 루트 기준 경로 고정 (/scripts -> /)
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const OUT_DRAWS = path.join(DATA_DIR, "powerball_draws.json");
const OUT_FREQ  = path.join(DATA_DIR, "powerball_freq.json");

// 소스(추첨결과)
const PB_URL = process.env.PB_URL || "https://www.dhlottery.co.kr/srfllt/PbWnNoInq";

// 규칙
const NORMAL_MIN = 1, NORMAL_MAX = 28;
const POWER_MIN = 0, POWER_MAX = 9;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function readJsonSafe(file, fallback){
  try{
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw);
  }catch{
    return fallback;
  }
}

async function writePretty(file, obj){
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, JSON.stringify(obj, null, 2), "utf8");
}

function stableHash(str){
  let h = 2166136261;
  for(let i=0;i<str.length;i++){
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h>>>0).toString(16);
}

function looksBlockedOrLogin(html){
  return /서비스\s+접근\s+대기|서비스\s+접속이\s+차단|접속량이\s+많아|로그인\s*$/i.test(html)
    || /\/login\b/.test(html); // 내용에 login이 나타나면 의심
}

async function fetchText(url, {retries=4, timeoutMs=20000}={}){
  const headers = {
    "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125 Safari/537.36",
    "accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
    "cache-control": "no-cache",
    "pragma": "no-cache"
  };

  let lastErr = null;
  for(let i=0;i<=retries;i++){
    try{
      const ac = new AbortController();
      const t = setTimeout(()=>ac.abort(), timeoutMs);

      const res = await fetch(url, {headers, signal: ac.signal, redirect:"follow"});
      clearTimeout(t);

      const html = await res.text();
      if(!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

      if(looksBlockedOrLogin(html)){
        throw new Error("BLOCKED_OR_LOGIN_PAGE");
      }

      return html;
    }catch(e){
      lastErr = e;
      const backoff = 900 + i*1400;
      console.warn(`[fetch retry ${i}/${retries}] ${e?.message || e} -> ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

function stripHtml(html){
  // script/style 제거
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  // 태그 제거
  s = s.replace(/<[^>]+>/g, " ");
  // 엔티티 최소 처리
  s = s.replace(/&nbsp;/g, " ");
  s = s.replace(/&amp;/g, "&");
  s = s.replace(/&lt;/g, "<");
  s = s.replace(/&gt;/g, ">");
  // 공백 정리
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function parseDateNear(text, idx){
  // 주변 120자에서 날짜/시간 탐색
  const start = Math.max(0, idx - 120);
  const end   = Math.min(text.length, idx + 80);
  const win = text.slice(start, end);

  const date = (win.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/)||[]).slice(1);
  const time = (win.match(/(\d{1,2}):(\d{2})/)||[]).slice(1);

  let dateStr = null;
  let timeStr = null;
  if(date.length){
    const [y,m,d] = date;
    dateStr = `${y}-${String(m).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  }
  if(time.length){
    const [hh,mm] = time;
    timeStr = `${String(hh).padStart(2,"0")}:${mm}`;
  }
  return {dateStr, timeStr};
}

function extractCombos(text){
  // 핵심: "n n n n n + p" 형태
  // 결과 페이지 구조가 바뀌어도, 최소한 "+" 패턴이 있으면 잡히게
  const re = /(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s*\+\s*(\d{1,2})/g;

  const out = [];
  let m;
  while((m = re.exec(text)) !== null){
    const normals = [m[1],m[2],m[3],m[4],m[5]].map(Number);
    const power = Number(m[6]);

    if(normals.some(n => n < NORMAL_MIN || n > NORMAL_MAX)) continue;
    if(power < POWER_MIN || power > POWER_MAX) continue;
    if(new Set(normals).size !== 5) continue;

    normals.sort((a,b)=>a-b);
    const {dateStr, timeStr} = parseDateNear(text, m.index);

    const key = `${normals.join(",")}|${power}`;
    out.push({ normals, power, dateStr, timeStr, key, pos: m.index });
  }
  return out;
}

function buildFreq(draws){
  const normalFreq = {};
  const powerFreq = {};
  for(let n=NORMAL_MIN; n<=NORMAL_MAX; n++) normalFreq[n] = 0;
  for(let p=POWER_MIN; p<=POWER_MAX; p++) powerFreq[p] = 0;

  for(const d of draws){
    for(const n of d.normals) normalFreq[n] = (normalFreq[n]||0) + 1;
    powerFreq[d.power] = (powerFreq[d.power]||0) + 1;
  }
  return { normalFreq, powerFreq };
}

function mergeDraws(prev, newly){
  const map = new Map();

  // 기존 유지
  for(const d of prev){
    map.set(d.draw_id, d);
  }

  // 신규 추가(가능하면 날짜/시간/조합 기반 draw_id)
  for(const n of newly){
    const baseId = n.dateStr
      ? `D_${n.dateStr}_${n.timeStr || "NA"}_${n.key}`
      : `S_${n.key}`;

    const draw_id = baseId;

    if(!map.has(draw_id)){
      map.set(draw_id, {
        draw_id,
        date: n.dateStr || null,
        time: n.timeStr || null,
        normals: n.normals,
        power: n.power,
        source: PB_URL
      });
    }
  }

  // 날짜/시간 있는 것부터 정렬(없으면 뒤)
  const arr = Array.from(map.values()).sort((a,b)=>{
    const ad = a.date ? `${a.date} ${a.time||"99:99"}` : "9999-99-99 99:99";
    const bd = b.date ? `${b.date} ${b.time||"99:99"}` : "9999-99-99 99:99";
    return ad.localeCompare(bd);
  });

  return arr;
}

async function main(){
  const prevDrawsFile = await readJsonSafe(OUT_DRAWS, {
    meta:{source:PB_URL, game:"dhlottery-powerball", normal_range:[1,28], power_range:[0,9], updated_at:null},
    draws:[]
  });

  const now = new Date().toISOString();

  console.log(`[1] Fetch: ${PB_URL}`);
  let html;
  try{
    html = await fetchText(PB_URL);
  }catch(e){
    console.warn(`[WARN] fetch failed: ${e?.message || e}`);
    console.warn(`[WARN] 기존 데이터는 그대로 유지하고 종료합니다.`);
    process.exit(0);
  }

  const text = stripHtml(html);

  console.log(`[2] Extract combos`);
  const combos = extractCombos(text);
  console.log(`  - combos found: ${combos.length}`);

  if(combos.length === 0){
    console.warn(`[WARN] combos=0. 페이지 구조 변경/차단 가능성. 기존 데이터 유지 후 종료.`);
    process.exit(0);
  }

  // 신규 draw_id 생성에 충돌 방지(같은 페이지에서 동일 조합 여러 번 나오는 경우)
  // pos까지 섞어서 키를 다양화
  const normalized = combos.map(c => ({
    ...c,
    key: `${c.key}|pos:${c.pos}`
  }));

  const mergedDraws = mergeDraws(prevDrawsFile.draws || [], normalized);

  // freq 재생성
  const { normalFreq, powerFreq } = buildFreq(mergedDraws);

  const drawsOut = {
    meta: {
      source: PB_URL,
      game: "dhlottery-powerball",
      normal_range: [NORMAL_MIN, NORMAL_MAX],
      power_range: [POWER_MIN, POWER_MAX],
      updated_at: now,
      draws: mergedDraws.length,
      notes: "update_powerball.mjs가 (일반 5 + 파워 1) 패턴을 추출해 누적/집계합니다. 사이트가 차단/로그인일 경우 기존 데이터 유지."
    },
    draws: mergedDraws
  };

  const freqOut = {
    meta: {
      source: PB_URL,
      game: "dhlottery-powerball",
      draws: mergedDraws.length,
      updated_at: now
    },
    normal: { range:[NORMAL_MIN, NORMAL_MAX], freq: normalFreq },
    power:  { range:[POWER_MIN, POWER_MAX],  freq: powerFreq }
  };

  console.log(`[3] Write outputs -> /data`);
  await writePretty(OUT_DRAWS, drawsOut);
  await writePretty(OUT_FREQ, freqOut);

  console.log(`[OK] updated_at=${now}, draws=${mergedDraws.length}`);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
