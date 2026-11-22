// 15분마다 자동 실행: 공포탐욕지수 + 나스닥 선물 + 알트코인지수 + 코인 기사를 모아서 data.json 으로 저장합니다.
import { readFile, writeFile } from "node:fs/promises";

const FEEDS = [
  { name: "블록미디어", url: "https://www.blockmedia.co.kr/feed" },
  { name: "토큰포스트", url: "https://www.tokenpost.kr/rss" },
  { name: "코인데스크코리아", url: "https://www.coindeskkorea.com/rss/allArticle.xml" },
  { name: "Coingeek", url: "https://coingeek.com/feed/" },
];
const PER_FEED = 8;
const MAX_ITEMS = 30;

function decode(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "(?:\\s[^>]*)?>([\\s\\S]*?)</" + name + ">", "i"));
  return m ? decode(m[1]) : "";
}
export function parseFeed(xml, source) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  const out = [];
  for (const b of blocks) {
    const title = tag(b, "title");
    let link = tag(b, "link");
    if (!link) { const m = b.match(/<link[^>]*href=["']([^"']+)["']/i); link = m ? m[1] : ""; }
    const date = tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date");
    const ts = Date.parse(date);
    if (title && /^https?:\/\//.test(link) && !Number.isNaN(ts)) out.push({ title, link, source, ts });
  }
  return out.sort((a, b) => b.ts - a.ts).slice(0, PER_FEED);
}

async function get(url, extraHeaders = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/rss+xml, application/xml, text/xml, application/json, text/html, */*",
        ...extraHeaders,
      },
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}

async function fetchNasdaq(fallback) {
  try {
    const raw = await get("https://query1.finance.yahoo.com/v8/finance/chart/NQ=F?interval=1d&range=5d");
    const j = JSON.parse(raw);
    const meta = j?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!Number.isFinite(price)) throw new Error("가격 값 없음");
    const chg = Number.isFinite(prev) && prev > 0 ? +(((price - prev) / prev) * 100).toFixed(2) : 0;
    const out = { price: +price.toFixed(2), chg };
    console.log("OK   나스닥 선물", out.price, out.chg + "%");
    return out;
  } catch (e) {
    console.log("SKIP 나스닥 선물 -", e.message);
    return fallback ?? null;
  }
}

async function fetchAltseason(fallback) {
  const sources = [
    "https://www.blockchaincenter.net/en/altcoin-season-index/",
    "https://www.coinglass.com/pro/i/alt-coin-index",
  ];
  for (const url of sources) {
    try {
      const html = await get(url);
      const m = html.match(/(?:Altcoin\s*Season\s*Index|altseason)[^0-9]{0,80}(\d{1,3})/i);
      if (m) {
        const val = parseInt(m[1], 10);
        if (val >= 0 && val <= 100) {
          console.log("OK   알트코인지수", val);
          return val;
        }
      }
    } catch (e) {
      console.log("SKIP 알트코인지수 (" + url + ") -", e.message);
    }
  }
  return fallback ?? null;
}

async function main() {
  let old = {};
  try { old = JSON.parse(await readFile("data.json", "utf8")); } catch {}

  // 기사
  let news = [];
  for (const f of FEEDS) {
    try {
      const items = parseFeed(await get(f.url), f.name);
      console.log("OK  ", f.name, items.length + "건");
      news.push(...items);
    } catch (e) { console.log("SKIP", f.name, "-", e.message); }
  }
  const seen = new Set();
  news = news.sort((a, b) => b.ts - a.ts).filter(n => !seen.has(n.link) && seen.add(n.link)).slice(0, MAX_ITEMS);
  if (!news.length) news = old.news || [];

  // 공포탐욕지수
  let fng = old.fng || null;
  try {
    const j = JSON.parse(await get("https://api.alternative.me/fng/?limit=2"));
    const d = j.data;
    fng = { value: +d[0].value, label: d[0].value_classification, ts: +d[0].timestamp * 1000, prev: d[1] ? +d[1].value : null };
    console.log("OK   공포탐욕지수", fng.value);
  } catch (e) { console.log("SKIP 공포탐욕지수 -", e.message); }

  // 나스닥 선물 & 알트코인지수
  const nasdaq = await fetchNasdaq(old.nasdaq);
  const altseason = await fetchAltseason(old.altseason);

  await writeFile(
    "data.json",
    JSON.stringify({ updated: new Date().toISOString(), fng, nasdaq, altseason, news }, null, 2)
  );
}
if (process.argv[1] && process.argv[1].endsWith("fetch-data.mjs")) main();
