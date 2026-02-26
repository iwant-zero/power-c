// scripts/update_powerball.mjs
// 목적: 동행복권 파워볼(일반볼 5개 + 파워볼 1개) 당첨번호를 수집해 draws.json 저장 + freq.json 생성
// 실행: node scripts/update_powerball.mjs
// 옵션: PB_URL 환경변수로 결과 페이지 URL을 바꿀 수 있음 (차단/리다이렉트 대응용)

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import cheerio from "cheerio";

const ROOT = process.cwd();
const OUT_DRAWS = path.join(ROOT, "power-c", "data", "powerball_draws.json");
const OUT_FREQ  = path.join(ROOT, "power-c", "data", "powerball_freq.json");

// 기본 결과 페이지(추첨결과). 환경변수로 교체 가능.
const PB_URL = process.env.PB_URL || "https://www.dhlottery.co.kr/srfllt/PbWnNoInq";

// 파워볼 규칙(공식 안내 기준)
const NORMAL_MIN = 1, NORMAL_MAX = 28;
const POWER_MIN = 0, POWER_MAX = 9;

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

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

      const text = await res.text();
      if(!res.ok){
        throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
      }

      // “접속 차단/대기” 페이지 감지
      if(/서비스\s+접속이\s+차단|서비스\s+접근\s+대기|접속량이\s+많아/i.test(text)){
        throw new Error("BLOCKED_OR_QUEUE_PAGE");
      }

      return text;
    }catch(e){
      lastErr = e;
      const backoff = 800 + i*1200;
      console.warn(`[fetch retry ${i}/${retries}] ${e?.message || e} -> ${backoff}ms`);
      await sleep(backoff);
    }
  }
  throw lastErr;
}

// HTML에서 “일반볼 5개 + 파워볼 1개” 패턴을 최대한 추출 (범용)
// 페이지 구조가 명확하면 selector 기반으로 바꾸는 게 가장 좋음.
function extractCombosFromHtml(html){
  const $ = cheerio.load(html);
  const text = $.text().replace(/\s+/g, " ").trim();

  // 5개(1~28) + 1개(0~9) 패턴: "1 2 3 4 5 + 6" 형태를 가정하고 넓게 잡음
  const re = /(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\s*[\+\|]\s*(\d{1,2})/g;

  const combos = [];
  let m;
  while((m = re.exec(text)) !== null){
    const normals = [m[1],m[2],m[3],m[4],m[5]].map(Number);
    const power = Number(m[6]);

    // 범위 체크
    if(normals.some(n => n < NORMAL_MIN || n > NORMAL_MAX)) continue;
    if(power < POWER_MIN || power > POWER_MAX) continue;

    // 중복 체크(일반볼 5개)
    if(new Set(normals).size !== 5) continue;

    normals.sort((a,b)=>a-b);
    combos.push({ normals, power });
  }

  return combos;
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

async function main(){
  const prevDraws = await readJsonSafe(OUT_DRAWS, {
    meta:{source:PB_URL, game:"dhlottery-powerball", normal_range:[1,28], power_range:[0,9], updated_at:null},
    draws:[]
  });

  console.log(`[1] Fetch: ${PB_URL}`);
  const html = await fetchText(PB_URL);

  console.log(`[2] Parse combos from HTML (generic regex)`);
  const combos = extractCombosFromHtml(html);

  // 이 방식은 “회차/시간”을 못 잡으면 중복 검출이 애매함.
  // 그래서 (일반5+파워1) 조합을 1건으로 보고 “최근 페이지 범위”에서 빈도를 만드는 용도로 사용.
  // 진짜 ‘역대 전체’ 저장을 원하면: 결과 페이지가 제공하는 회차/일자 selector를 찾아 draw_id를 만들도록 보강해야 함.
  console.log(`  - extracted combos: ${combos.length}`);

  if(combos.length === 0){
    console.warn(`[WARN] combos=0. 사이트 차단/페이지 구조 변경 가능성. PB_URL을 다른 결과 페이지로 바꾸거나, 파서 selector를 조정하세요.`);
    // 그래도 updated_at만 갱신하지 않고 종료
    process.exit(0);
  }

  // draws.json에는 “최근 추출된 콤보들”을 저장 (중복 유지가 필요한 경우 draw_id 파서 보강 필요)
  const now = new Date().toISOString();
  const newDraws = combos.map((c, idx)=>({
    draw_id: `SCRAPE_${now}_${idx}`,
    scraped_at: now,
    normals: c.normals,
    power: c.power
  }));

  const merged = {
    meta: {
      ...prevDraws.meta,
      source: PB_URL,
      updated_at: now,
      notes: "현재 스크립트는 결과 페이지 HTML에서 (일반5+파워1) 패턴을 추출하는 범용 파서입니다. 회차/시간 파싱이 가능하면 draw_id를 실제 값으로 교체하세요."
    },
    draws: newDraws
  };

  console.log(`[3] Build frequencies from extracted draws`);
  const { normalFreq, powerFreq } = buildFreq(merged.draws);

  const freq = {
    meta: {
      source: PB_URL,
      game: "dhlottery-powerball",
      draws: merged.draws.length,
      updated_at: now
    },
    normal: { range:[NORMAL_MIN, NORMAL_MAX], freq: normalFreq },
    power:  { range:[POWER_MIN, POWER_MAX],  freq: powerFreq }
  };

  console.log(`[4] Write JSON outputs`);
  await writePretty(OUT_DRAWS, merged);
  await writePretty(OUT_FREQ, freq);

  console.log(`[OK] updated_at=${now}, draws=${merged.draws.length}`);
}

main().catch(e=>{
  console.error(e);
  process.exit(1);
});
