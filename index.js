/**
 * 微信直聊版日程助理 · 腾讯云函数 SCF 版
 * 自 Cloudflare Worker 迁移（依据《云端迁移战略决策文档 v2》）：
 *   - Web Crypto API → Node crypto 模块（AES-256-CBC + SHA1，逻辑不变）
 *   - fetch(request, env) → main_handler(event, context)
 *   - Cloudflare KV → 腾讯云 COS 存单个 state.json
 *   - 出站请求用 Node 内置 https 模块（不依赖运行时版本的 fetch）
 * 环境变量（SCF 控制台配置）：
 *   WECOM_CORP_ID / WECOM_TOKEN / WECOM_AES_KEY
 *   WECOM_AGENT_ID / WECOM_APP_SECRET / WECOM_TO_USER（主动提醒）
 *   DEEPSEEK_API_KEY / BARK_KEY / WXPUSHER_TOKEN / WXPUSHER_UID
 *   AI_BASE_URL / AI_MODEL / AI_API_KEY（可选，同时配置覆盖默认模型）
 *   COS_BUCKET / COS_REGION / COS_SECRET_ID / COS_SECRET_KEY
 * 定时触发器（北京时间）：
 *   每分钟扫描: 0 * * * * * *
 *   每日晨报:   0 0 8 * * * *
 */
const crypto = require("crypto");
const https = require("https");
const Cos = require("cos-nodejs-sdk-v5");

// COS SDK 内部会产生浮动 Promise 的拒绝（如 NoSuchKey），必须全局兜底，否则整个函数崩溃
process.on("unhandledRejection", (reason) => {
  try {
    console.error("unhandledRejection:", reason && reason.message ? reason.message : String(reason));
  } catch (e) {}
});

const TZ = 8 * 3600 * 1000;
const STATE_KEY = "state.json";

// ================= 基础工具 =================
function httpReq(url, method, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname, port: u.port || 443,
      path: u.pathname + u.search,
      method: method || "GET",
      headers: headers || {},
      timeout: 10000,
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve({ status: res.statusCode, text: d }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("请求超时: " + u.hostname)); });
    if (body) req.write(body);
    req.end();
  });
}
function nowYear() {
  return new Date(Date.now() + TZ).getUTCFullYear();
}
function fmtCST(ts) {
  const d = new Date(ts + TZ);
  const p = (n) => String(n).padStart(2, "0");
  // 非本年度才带年份：正常显示保持简洁，一旦年份解析出错用户能一眼看出来
  const y = d.getUTCFullYear() !== nowYear() ? d.getUTCFullYear() + "年" : "";
  return y + (d.getUTCMonth() + 1) + "月" + d.getUTCDate() + "日 " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
const WEEKCN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
// 日记用的纯日期格式：8月30日 周日（非本年度才带年份）
function fmtDate(ts) {
  const d = new Date(ts + TZ);
  const y = d.getUTCFullYear() !== nowYear() ? d.getUTCFullYear() + "年" : "";
  return y + (d.getUTCMonth() + 1) + "月" + d.getUTCDate() + "日 " + WEEKCN[d.getUTCDay()];
}
// 只要 HH:MM（晨报里日期已单独给出，不用重复）
function fmtTime(ts) {
  const d = new Date(ts + TZ);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getUTCHours()) + ":" + p(d.getUTCMinutes());
}
// ===== 星期换算：模型算不准，改由代码强制校正 =====
const WD_MAP = [["周日", 0], ["周天", 0], ["星期天", 0], ["星期日", 0], ["礼拜天", 0], ["礼拜日", 0],
                ["周一", 1], ["星期一", 1], ["礼拜一", 1], ["周二", 2], ["星期二", 2], ["礼拜二", 2],
                ["周三", 3], ["星期三", 3], ["礼拜三", 3], ["周四", 4], ["星期四", 4], ["礼拜四", 4],
                ["周五", 5], ["星期五", 5], ["礼拜五", 5], ["周六", 6], ["星期六", 6], ["礼拜六", 6]];
function extractWeekday(text) {
  if (!text) return null;
  for (const [w, d] of WD_MAP) if (text.includes(w)) return d;
  const m = text.match(/周\s*([一二三四五六日天])/);   // 兜底：处理"周 三"这类带空格写法
  if (m) {
    const idx = "一二三四五六日天".indexOf(m[1]);      // 0=一 ... 5=六, 6=日, 7=天
    if (idx < 0) return null;
    return (idx === 6 || idx === 7) ? 0 : idx + 1;
  }
  return null;
}
// "下周" / "本周" 的周次意图；没说明则返回 null（交给模型）
function weekIntent(text) {
  if (!text) return null;
  if (/下周|下个?星期|下礼拜|下一周/.test(text)) return "next";
  if (/上周|上个?星期|上礼拜|上一周/.test(text)) return "last";
  if (/本周|这周|这个?星期|这礼拜|这一周/.test(text)) return "this";
  return null;
}
// 相对天数：连"明天"模型都会算错一天，这个必须代码接管
function relativeDayOffset(text) {
  if (!text) return null;
  if (/大后天/.test(text)) return 3;
  if (/后天/.test(text)) return 2;
  if (/明天|明日|明早|明晚|明上午|明下午/.test(text)) return 1;
  if (/今天|今日|今晚|今早|今上午|今下午|今晚上/.test(text)) return 0;
  if (/昨天|昨日|昨晚|昨上午|昨下午/.test(text)) return -1;
  if (/大前天/.test(text)) return -3;
  if (/前天/.test(text)) return -2;
  return null;
}
// 给模型的周几换算基准：避免"下周三"这类相对星期算错
function weekHint(ts) {
  const d = new Date(ts + TZ);
  const p = (n) => String(n).padStart(2, "0");
  const f = (x) => x.getUTCFullYear() + "-" + p(x.getUTCMonth() + 1) + "-" + p(x.getUTCDate());
  const dow = d.getUTCDay();
  const monday = new Date(d.getTime() + (dow === 0 ? -6 : 1 - dow) * 86400e3);
  const sunday = new Date(monday.getTime() + 6 * 86400e3);
  const nMon = new Date(monday.getTime() + 7 * 86400e3);
  const nSun = new Date(sunday.getTime() + 7 * 86400e3);
  const pMon = new Date(monday.getTime() - 7 * 86400e3);
  const pSun = new Date(sunday.getTime() - 7 * 86400e3);
  return "今天" + WEEKCN[dow] + "；上周=" + f(pMon) + "~" + f(pSun) +
         "；本周=" + f(monday) + "~" + f(sunday) + "；下周=" + f(nMon) + "~" + f(nSun);
}
// 未来 14 天的日期-星期对照表，让模型直接查表，别自己推算星期
function dayTable(ts, fromOff, toOff) {
  const base = new Date(ts + TZ);
  const p = (n) => String(n).padStart(2, "0");
  const f = (x) => x.getUTCFullYear() + "-" + p(x.getUTCMonth() + 1) + "-" + p(x.getUTCDate());
  const tagOf = (i) => i === 0 ? "今天" : i === 1 ? "明天" : i === 2 ? "后天"
                      : i === -1 ? "昨天" : i === -2 ? "前天" : "";
  const out = [];
  for (let i = fromOff; i <= toOff; i++) {
    const d = new Date(base.getTime() + i * 86400e3);
    const tag = tagOf(i);
    out.push(f(d) + WEEKCN[d.getUTCDay()] + (tag ? "(" + tag + ")" : ""));
  }
  return out.join(" ");
}
function fmtFull(ts) {
  const d = new Date(ts + TZ);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate()) +
         " " + p(d.getUTCHours()) + ":" + p(d.getUTCMinutes()) + " " + WEEKCN[d.getUTCDay()];
}
// ===== 日记专用日期工具 =====
function startOfDay(ts) {
  const d = new Date(ts + TZ);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - TZ;
}
function dayKey(ts) {
  const d = new Date(ts + TZ);
  const p = (n) => String(n).padStart(2, "0");
  return d.getUTCFullYear() + "-" + p(d.getUTCMonth() + 1) + "-" + p(d.getUTCDate());
}
function parseTime(s) {
  if (!s) return null;
  if (typeof s !== "string") return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) s += "T00:00:00+08:00";
  else if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(s)) s = s.replace(" ", "T") + "+08:00";
  const t = Date.parse(s);
  return isNaN(t) ? null : t;
}

function validDay(year, month, day) {
  const ts = Date.UTC(year, month - 1, day);
  const d = new Date(ts);
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day ? ts - TZ : null;
}
function beforeSleepBoundary(now) {
  return new Date(now + TZ).getUTCHours() < 4;
}
function relativeDateOffset(text, now, context = "") {
  const offset = relativeDayOffset(text);
  if (offset === null || !beforeSleepBoundary(now) || /自然日|日历|公历|严格按日期/.test(text)) return offset;
  if (offset > 0) return offset - 1;
  const phrasing = text + " " + context;
  if (offset === 0 && !/凌晨|半夜|午夜/.test(phrasing) &&
      /做了|干了|开了|见了|去了|吃了|完成了|发生了|聊完|回顾|记日记/.test(phrasing)) return -1;
  return offset;
}
function resolveDay(text, now, context = "") {
  if (!text) return null;
  const year = new Date(now + TZ).getUTCFullYear();
  let m = text.match(/(\d{4})[-年\/](\d{1,2})[-月\/](\d{1,2})日?/);
  if (m) return validDay(+m[1], +m[2], +m[3]);
  m = text.match(/(\d{1,2})月(\d{1,2})[日号]?/);
  if (m) return validDay(year + (/明年/.test(text) ? 1 : /去年/.test(text) ? -1 : 0), +m[1], +m[2]);
  const offset = relativeDateOffset(text, now, context);
  if (offset !== null) return startOfDay(now) + offset * 86400e3;
  const wd = extractWeekday(text);
  if (wd !== null) {
    const dow = new Date(now + TZ).getUTCDay();
    const intent = weekIntent(text);
    if (intent) {
      const shift = /下下/.test(text) ? 14 : intent === "next" ? 7 : intent === "last" ? -7 : 0;
      return startOfDay(now) + ((dow === 0 ? -6 : 1 - dow) + shift + (wd === 0 ? 6 : wd - 1)) * 86400e3;
    }
    return startOfDay(now) + ((wd - dow + 7) % 7) * 86400e3;
  }
  return null;
}
function resolveRange(text, now, context = "") {
  if (!text) return null;
  const parts = text.split(/到|至|[~～]/);
  if (parts.length === 2) {
    const from = resolveDay(parts[0], now, context), to = resolveDay(parts[1], now, context);
    if (from !== null && to !== null) return { from: Math.min(from, to), to: Math.max(from, to) + 86400e3 };
  }
  const day = resolveDay(text, now, context);
  if (day !== null) {
    const hours = /上午|早上|早晨|明早|今早/.test(text) ? [0, 12] : /下午/.test(text) ? [12, 18] : /晚上|今晚|明晚|夜里/.test(text) ? [18, 24] : [0, 24];
    return { from: day + hours[0] * 3600e3, to: day + hours[1] * 3600e3 };
  }
  const intent = weekIntent(text);
  if (intent) {
    const dow = new Date(now + TZ).getUTCDay();
    const shift = /下下/.test(text) ? 14 : intent === "next" ? 7 : intent === "last" ? -7 : 0;
    const from = startOfDay(now) + ((dow === 0 ? -6 : 1 - dow) + shift) * 86400e3;
    return { from, to: from + 7 * 86400e3 };
  }
  return null;
}
function resolveEventTime(value, dateText, userText, now, clock) {
  const after = userText.split(/改到|改成|改为|推迟到|提前到|挪到/).pop();
  const dateTokens = after.match(/大前天|大后天|前天|后天|今[天日早晚]|明[天日早晚]|昨[天日早晚]|(?:下下|下|上|本|这)?(?:周|星期|礼拜)[一二三四五六日天]|(?:\d{4}年)?\d{1,2}月\d{1,2}[日号]?|\d{4}-\d{1,2}-\d{1,2}/g) || [];
  const anchor = dateTokens.length === 1 ? after : dateText || after;
  const relative = anchor.match(/(\d+)\s*(分钟|小时)(?:后|以后)/);
  if (relative) return now + +relative[1] * (relative[2] === "小时" ? 3600e3 : 60e3);
  if (/半(?:个)?小时后/.test(anchor)) return now + 30 * 60e3;
  const parsed = parseTime(value);
  const day = resolveDay(anchor, now);
  if (day === null && /\d{1,2}月\d{1,2}|\d{4}-\d{1,2}-\d{1,2}/.test(anchor)) return null;
  let hour, minute;
  const time = String(clock || "").match(/^(\d{1,2}):(\d{2})$/);
  if (time) { hour = +time[1]; minute = +time[2]; }
  else if (parsed !== null) { const d = new Date(parsed + TZ); hour = d.getUTCHours(); minute = d.getUTCMinutes(); }
  else return null;
  if (hour > 23 || minute > 59) return null;
  // 只有日期而没有时刻时必须追问，不能采用模型补出来的整点。
  if (!/\d{1,2}[:：]\d{2}|[\d一二三四五六七八九十两]+\s*[点时]|中午|午夜|凌晨/.test(userText)) return null;
  return day !== null ? day + (hour * 60 + minute) * 60e3 : parsed;
}
function eventDuration(event) {
  return Number.isFinite(event.duration_minutes) && event.duration_minutes > 0 ? event.duration_minutes : 30;
}
function dailyEvents(events, day) {
  return events.filter((e) => e.status === "active" && dayKey(e.datetime) === dayKey(day))
    .sort((a, b) => a.datetime - b.datetime || a.id - b.id);
}
function dailyLabel(events, event) {
  return fmtDate(event.datetime) + " 第" + (dailyEvents(events, event.datetime).findIndex((e) => e.id === event.id) + 1) + "项";
}
function dailyReference(args, text, now) {
  const source = text.split(/改到|改成|改为|推迟到|提前到|挪到/)[0];
  const match = source.match(/第\s*([0-9一二三四五六七八九十两]+)\s*(?:项|条|个)/);
  let number = args.daily_number;
  if (match) {
    const token = match[1].replace(/两/g, "二");
    if (/^\d+$/.test(token)) number = +token;
    else {
      const digits = "零一二三四五六七八九";
      const parts = token.split("十");
      number = parts.length === 2 ? (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0) : digits.indexOf(token);
    }
  }
  if (number === undefined) return null;
  return { number, day: resolveDay(source, now) ?? (match ? null : resolveDay(args.source_date_text, now)) };
}
function matchingEvents(events, args, reference) {
  if (reference) return reference.day === null ? [] : dailyEvents(events, reference.day).filter((e, i) => i + 1 === reference.number);
  return events.filter((e) => e.status === "active" && (args.event_id !== undefined ? e.id === args.event_id :
    typeof args.target === "string" && args.target.trim() && e.title.includes(args.target.trim())));
}
function conflicts(events, start, duration, skipId) {
  const end = start + duration * 60e3;
  return events.filter((e) => e.status === "active" && e.kind !== "deadline" && e.id !== skipId &&
    start < e.datetime + eventDuration(e) * 60e3 && end > e.datetime);
}
function findSlot(events, from, to, duration, now) {
  if (!(duration >= 5 && duration <= 720) || to <= from || to - from > 31 * 86400e3) return null;
  const buffer = 5 * 60e3;
  const busy = events.filter((e) => e.status === "active" && e.kind !== "deadline")
    .map((e) => [e.datetime - buffer, e.datetime + eventDuration(e) * 60e3 + buffer]).sort((a, b) => a[0] - b[0]);
  for (let day = startOfDay(from); day < to; day += 86400e3) {
    const end = Math.min(to, day + 18 * 3600e3);
    let cursor = Math.ceil(Math.max(from, day + 9 * 3600e3, now + 60e3) / (5 * 60e3)) * 5 * 60e3;
    for (const [s, e] of busy) {
      if (e <= cursor) continue;
      if (cursor + duration * 60e3 <= Math.min(s, end)) return cursor;
      if (s < cursor + duration * 60e3) cursor = Math.max(cursor, e);
    }
    if (cursor + duration * 60e3 <= end) return cursor;
  }
  return null;
}
function listEvents(state, text, args, now) {
  const range = resolveRange(text, now) || resolveRange(args.date_text, now) ||
    (parseTime(args.from) !== null ? { from: startOfDay(parseTime(args.from)), to: startOfDay(parseTime(args.to || args.from)) + 86400e3 } : null);
  const act = state.events.filter((e) => e.status === "active" &&
    (range ? e.datetime >= range.from && e.datetime < range.to : e.datetime >= now)).sort((a, b) => a.datetime - b.datetime || a.id - b.id);
  const label = range ? fmtDate(range.from) + (dayKey(range.from) !== dayKey(range.to - 1) ? " ~ " + fmtDate(range.to - 1) : "") : "未来";
  if (!act.length) return "📋 " + label + "没有安排。";
  const days = [...new Set(act.map((e) => dayKey(e.datetime)))];
  return "📋 日程安排\n\n" + days.map((key) => {
    const day = parseTime(key);
    const visible = act.filter((e) => dayKey(e.datetime) === key);
    const all = dailyEvents(state.events, day);
    return fmtDate(day) + "\n" + visible.map((e) => (all.findIndex((item) => item.id === e.id) + 1) + ". " +
      fmtTime(e.datetime) + (e.kind === "deadline" ? " 截止" : "") + " " + e.title +
      (e.duration_minutes ? "（" + e.duration_minutes + "分钟）" : "")).join("\n");
  }).join("\n\n");
}
function xmlTag(xml, tag) {
  const m = xml.match(new RegExp("<" + tag + "><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></" + tag + ">")) ||
            xml.match(new RegExp("<" + tag + ">([\\s\\S]*?)</" + tag + ">"));
  return m ? m[1] : "";
}

// ================= 企业微信加解密 (WXBizMsgCrypt · Node crypto 版) =================
function sha1Hex(...parts) {
  return crypto.createHash("sha1").update(parts.slice().sort().join("")).digest("hex");
}
function wxDecrypt(aesKeyStr, b64) {
  const key = Buffer.from(aesKeyStr + "=", "base64");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, key.slice(0, 16));
  decipher.setAutoPadding(false);  // 企微用32字节块PKCS7，必须手动剥离填充
  const padded = Buffer.concat([decipher.update(Buffer.from(b64, "base64")), decipher.final()]);
  const padLen = padded[padded.length - 1];
  if (padLen < 1 || padLen > 32) throw new Error("padding非法: " + padLen);
  const plain = padded.slice(0, padded.length - padLen);
  const len = plain.readUInt32BE(16);
  return {
    msg: plain.slice(20, 20 + len).toString("utf8"),
    receiveid: plain.slice(20 + len).toString("utf8"),
  };
}
function wxEncrypt(aesKeyStr, corpId, plaintext) {
  const key = Buffer.from(aesKeyStr + "=", "base64");
  const random = crypto.randomBytes(16);
  const msgBytes = Buffer.from(plaintext, "utf8");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(msgBytes.length, 0);
  const data = Buffer.concat([random, lenBuf, msgBytes, Buffer.from(corpId, "utf8")]);
  // 企微规范：按32字节块PKCS7填充，对齐时补整块32（与官方WXBizMsgCrypt一致）
  const padLen = 32 - (data.length % 32) || 32;
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, key.slice(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString("base64");
}

// ================= 数据存取 (COS · state.json) =================
function getCos() {
  return new Cos({ SecretId: process.env.COS_SECRET_ID, SecretKey: process.env.COS_SECRET_KEY });
}
// 用回调风格 + 全局兜底，避免 SDK 浮动 Promise 拒绝导致函数崩溃
function cosGet() {
  return new Promise((resolve, reject) => {
    try {
      getCos().getObject(
        { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: STATE_KEY },
        (err, data) => {
          if (err && err.code === "NoSuchKey") return resolve(null);
          if (err) return reject(err);
          if (!data || data.Body == null) return reject(new Error("状态文件内容缺失"));
          try {
            const state = JSON.parse(data.Body.toString("utf8"));
            if (state === null) return reject(new Error("状态文件不能为空值"));
            resolve(state);
          }
          catch (e) { reject(new Error("状态文件 JSON 损坏")); }
        }
      );
    } catch (e) { reject(e); }
  });
}
function cosPut(body) {
  return new Promise((resolve) => {
    try {
      getCos().putObject(
        { Bucket: process.env.COS_BUCKET, Region: process.env.COS_REGION, Key: STATE_KEY, Body: body },
        (err) => resolve(!err)
      );
    } catch (e) { resolve(false); }
  });
}
async function loadState() {
  const s = await cosGet();
  if (s === null) return { events: [], journals: [], notified: {} };
  if (!s || !Array.isArray(s.events) ||
      (s.journals !== undefined && !Array.isArray(s.journals)) ||
      (s.notified !== undefined && (!s.notified || typeof s.notified !== "object" || Array.isArray(s.notified)))) {
    throw new Error("状态文件结构异常，已停止操作以保护现有数据");
  }
  return { ...s, journals: s.journals || [], notified: s.notified || {} };
}
async function saveState(state) {
  if (!await cosPut(JSON.stringify(state))) throw new Error("日程保存失败，请稍后重试");
}

// ================= 通知发送 =================
let wecomTokenCache;
async function wecomAccessToken(refresh = false) {
  const corp = process.env.WECOM_CORP_ID, secret = process.env.WECOM_APP_SECRET;
  const key = crypto.createHash("sha256").update(corp + "|" + secret).digest("hex");
  if (!refresh && wecomTokenCache?.key === key && wecomTokenCache.expires > Date.now()) return wecomTokenCache.token;
  const r = await httpReq("https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=" + encodeURIComponent(corp) + "&corpsecret=" + encodeURIComponent(secret));
  let data;
  try { data = JSON.parse(r.text); } catch { throw new Error("wecom_token_invalid_response"); }
  if (r.status < 200 || r.status >= 300 || data.errcode !== 0 || !data.access_token || !(data.expires_in > 60)) throw new Error("wecom_token_failed_" + (Number(data.errcode) || r.status));
  wecomTokenCache = { key, token: data.access_token, expires: Date.now() + (data.expires_in - 60) * 1000 };
  return data.access_token;
}
async function sendWecom(title, body, recipient) {
  const user = recipient || process.env.WECOM_TO_USER;
  const agent = Number(process.env.WECOM_AGENT_ID);
  if (!process.env.WECOM_CORP_ID || !process.env.WECOM_APP_SECRET || !Number.isSafeInteger(agent) || agent <= 0 || !user || user === "@all" || /[|]/.test(user)) return { configured: false, ok: false };
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await wecomAccessToken(attempt > 0);
    const r = await httpReq("https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=" + encodeURIComponent(token), "POST", { "Content-Type": "application/json" }, JSON.stringify({
      touser: user, msgtype: "text", agentid: agent,
      text: { content: title + "\n" + body }, safe: 0,
      enable_duplicate_check: 1, duplicate_check_interval: 60,
    }));
    let data;
    try { data = JSON.parse(r.text); } catch { return { configured: true, ok: false, http: r.status }; }
    if ([40014, 42001].includes(data.errcode) && attempt === 0) { wecomTokenCache = null; continue; }
    return { configured: true, ok: r.status >= 200 && r.status < 300 && data.errcode === 0 && !data.invaliduser && !data.unlicenseduser,
      http: r.status, code: data.errcode };
  }
}
function reminderChannels(strong) { return strong ? ["wecom", "bark", "wxpusher"] : ["wecom", "wxpusher"]; }
async function sendBark(title, body, strong) {
  if (!process.env.BARK_KEY) return { configured: false, ok: false };
  const q = strong ? "?level=timeSensitive&call=1&sound=alarm&group=schedule" : "?group=schedule";
  const url = "https://api.day.app/" + process.env.BARK_KEY + "/" +
    encodeURIComponent(title + " " + body) + q;
  const r = await httpReq(url);
  let data;
  try { data = JSON.parse(r.text); } catch { return { configured: true, ok: false, http: r.status }; }
  return { configured: true, ok: r.status >= 200 && r.status < 300 && data.code === 200, http: r.status, code: data.code };
}
async function sendWxPusher(title, body) {
  if (!process.env.WXPUSHER_TOKEN || !process.env.WXPUSHER_UID) return { configured: false, ok: false };
  const r = await httpReq(
    "https://wxpusher.zjiecode.com/api/send/message", "POST",
    { "Content-Type": "application/json" },
    JSON.stringify({
      appToken: process.env.WXPUSHER_TOKEN,
      content: "**" + title + "**\n\n" + body,
      summary: (title + " " + body).slice(0, 20),
      contentType: 3,
      uids: [process.env.WXPUSHER_UID],
    })
  );
  let data;
  try { data = JSON.parse(r.text); } catch { return { configured: true, ok: false, http: r.status }; }
  const rejected = Array.isArray(data.data) && data.data.some((item) => item.code !== undefined && item.code !== 1000);
  return { configured: true, ok: r.status >= 200 && r.status < 300 && data.code === 1000 && !rejected, http: r.status, code: data.code };
}
async function pushAll(title, body, strong, channels = reminderChannels(strong), recipient) {
  const results = {};
  for (const channel of channels) {
    if (channel === "wxpusher" && results.wecom?.ok) {
      results[channel] = { configured: false, ok: false, reason: "primary_accepted" }; continue;
    }
    try {
      if (channel === "wecom") results[channel] = await sendWecom(title, body, recipient);
      else if (channel === "bark") results[channel] = await sendBark(title, body, strong);
      else if (channel === "wxpusher") results[channel] = await sendWxPusher(title, body);
      else results[channel] = { configured: false, ok: false };
    }
    catch (error) {
      const tokenCode = String(error.message || "").match(/^wecom_token_failed_(\d+)$/);
      results[channel] = { configured: true, ok: false, error: "request_failed", ...(tokenCode ? { code: +tokenCode[1] } : {}) };
    }
  }
  console.log("[push] " + title + " " + JSON.stringify(results));
  return results;
}

function reminderGeneration(ev) {
  return [ev.datetime, ev.notify_at, ev.fallback_at].join("|");
}
function reminderState(ev, log, now) {
  if (ev.reminder?.generation === reminderGeneration(ev)) return ev.reminder;
  const legacy = !!log[ev.id + "|main"];
  ev.reminder = {
    generation: reminderGeneration(ev), code: "R" + ev.id + "-" + crypto.randomBytes(3).toString("hex").toUpperCase(),
    created_at: now, legacy, rounds: {}, first_accepted_at: null,
  };
  return ev.reminder;
}
function awaitingReminder(ev) {
  return ev.status === "active" && ev.reminder?.generation === reminderGeneration(ev) &&
    !ev.reminder.ack_at && !ev.reminder.legacy && Object.keys(ev.reminder.rounds).length > 0;
}
function reminderCommands(text, state, owner, now) {
  const code = text.match(/\bR\d+-[A-F0-9]{6}\b/i)?.[0].toUpperCase();
  const command = text.replace(/\bR\d+-[A-F0-9]{6}\b/i, "").trim().replace(/[，,。！!]/g, "");
  const acknowledge = /^(?:1|收到|已收到|知道了|我知道了|确认|停止催促|全部收到)$/.test(command);
  const postpone = command.match(/^(?:推迟|延后|稍后)\s*(\d+)\s*分钟(?:再提醒(?:我)?)?$/) || command.match(/^(\d+)\s*分钟后再提醒(?:我)?$/);
  const status = /^(?:提醒状态|待确认提醒)$/.test(command);
  if (!acknowledge && !postpone && !status) return null;
  const pending = state.events.filter((ev) => awaitingReminder(ev) && (!ev.owner_key || ev.owner_key === owner));
  if (status) return pending.length ? "待确认提醒：\n" + pending.map((ev) => ev.reminder.code + " 【" + ev.title + "】" + fmtCST(ev.datetime) +
    (ev.reminder.snooze_until > now ? "，暂停至" + fmtCST(ev.reminder.snooze_until) : "") +
    "\n" + Object.entries(ev.reminder.rounds).map(([name, round]) => name + ": " + Object.entries(round.channels).map(([ch, s]) => ch + "=" + s.status + (s.error_code !== undefined ? "(错误码" + s.error_code + ")" : "")).join(" ")).join("；")).join("\n") : "当前没有待确认的提醒。";
  const selected = code ? pending.filter((ev) => ev.reminder.code === code) : acknowledge && command !== "全部收到" ? pending.sort((a,b) => b.reminder.created_at - a.reminder.created_at || b.id-a.id).slice(0,1) : pending;
  if (command === "全部收到" && selected.length) {
    selected.forEach((ev) => { ev.reminder.ack_at = now; });
    return "✅ 已确认" + selected.length + "项提醒，停止后续催促；日程完成情况请另回复『完成 标题』。";
  }
  if (!selected.length) return "没有找到待确认的提醒。发送『提醒状态』查看；提醒已确认、取消或改期后，旧提醒码不再生效。";
  if (selected.length > 1) return "有多个待确认提醒，请带上提醒码：\n" + selected.map((ev) => ev.reminder.code + " 【" + ev.title + "】" + fmtCST(ev.datetime)).join("\n") + "\n例如：收到 " + selected[0].reminder.code;
  const ev = selected[0], reminder = ev.reminder;
  if (acknowledge) {
    reminder.ack_at = now;
    return "✅ 已确认【" + ev.title + "】，这项日程后续不再催促。日程本身仍保留。";
  }
  const minutes = +postpone[1];
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 120) return "可以推迟1到120分钟，例如『推迟10分钟 " + reminder.code + "』。";
  const until = now + minutes * 60e3;
  if (until >= ev.datetime + 2 * 3600e3) return "推迟时间超出这项日程的提醒有效期，请直接修改日程时间。";
  reminder.snooze_until = until;
  for (const round of Object.values(reminder.rounds)) for (const channel of Object.values(round.channels)) {
    if (channel.status === "pending") channel.status = "superseded";
  }
  reminder.snooze_count = (reminder.snooze_count || 0) + 1;
  reminder.snooze_round = "snooze" + reminder.snooze_count;
  return "⏰ 【" + ev.title + "】将在 " + fmtCST(until) + " 再提醒；日程时间没有改变。";
}

function reportEvents(state, day, owner) {
  return state.events.filter(e => e.status !== "cancelled" && dayKey(e.datetime) === dayKey(day) && (!owner || !e.owner_key || e.owner_key === owner))
    .sort((a,b) => a.datetime-b.datetime || a.id-b.id);
}
function countdownText(state, now, owner) {
  const rows = (state.countdowns || []).filter(c => !owner || !c.owner_key || c.owner_key === owner).map(c => {
    const days = Math.round((resolveDay(c.date, now)-startOfDay(now))/864e5);
    return { c, days };
  }).sort((a,b) => a.days-b.days);
  return rows.length ? rows.map(({c,days}) => "⏳ " + c.title + "：" + (days > 0 ? "还有"+days+"天" : days === 0 ? "就是今天" : "已过"+(-days)+"天") + "（"+c.date+"）").join("\n") : "暂无重要倒数日。";
}
function addCountdown(state, title, date, now) {
  const day = typeof date === "string" ? resolveDay(date, now) : null;
  if (typeof title !== "string" || !title.trim() || !/^\d{4}-\d{2}-\d{2}$/.test(date || "") || day === null || dayKey(day) !== date) return "请给出标题和有效日期，例如『倒数日 考试 2027-06-07』。";
  state.countdowns ||= [];
  if (state.countdowns.some(c => c.title === title.trim())) return "已有同名倒数日，请先发送『删除倒数日 "+title.trim()+"』再设置。";
  state.countdowns.push({id:crypto.randomBytes(6).toString("hex"),title:title.trim(),date,created_at:now});
  return "✅ 已设置重要倒数日，将显示在晨晚报：\n"+countdownText({countdowns:[state.countdowns.at(-1)]},now);
}
function dayReport(state, now, evening = false, owner) {
  const today = reportEvents(state, now, owner), tomorrow = reportEvents(state, now+864e5, owner);
  const lines = today.map((e,i) => (i+1)+". "+fmtTime(e.datetime)+" "+e.title + (e.completed_at ? " ✅已完成" : e.datetime < now ? " 待确认完成" : " 待进行"));
  let text = fmtDate(startOfDay(now))+ (evening ? " 晚报" : " 晨报") + "\n\n今日事项\n"+(lines.join("\n") || "今天暂无安排");
  text += "\n\n重要倒数日\n"+countdownText(state,now,owner);
  if (evening) {
    text += "\n\n明日安排\n"+(tomorrow.map((e,i)=>(i+1)+". "+fmtTime(e.datetime)+" "+e.title).join("\n") || "明天暂无安排，可以告诉我待办和可用时间。");
    const signature = planSignature(tomorrow);
    text += "\n"+(state.planConfirmations?.[(owner||"default")+"|"+dayKey(now+864e5)]?.signature === signature ? "明日当前安排已确认。" : "回复『确认明天』确认当前安排；要调整请直接说明事项和时间。");
    text += "\n完成事项回复『完成 2』或『完成 标题』，未反馈的不会算作已完成。";
  } else text += "\n收到提醒回复『1』或『收到』确认最新一项；确认不等于完成。";
  return text;
}
function planSignature(events) { return crypto.createHash("sha256").update(JSON.stringify(events.map(e=>[e.id,e.title,e.datetime,e.duration_minutes]))).digest("hex"); }
function dailyCommands(text,state,owner,now) {
  if (/^(?:晨报|今日晨报)$/.test(text)) return dayReport(state,now,false,owner);
  if (/^(?:晚报|今日晚报)$/.test(text)) return dayReport(state,now,true,owner);
  if (/^(?:查看)?倒(?:数|计时)日$/.test(text)) return countdownText(state,now,owner);
  const add=text.match(/^(?:添加|新增|设置)?倒数日\s+(.+?)\s+(\d{4}-\d{2}-\d{2})$/);
  if(add) { const reply=addCountdown(state,add[1],add[2],now); if(reply.startsWith("✅")) state.countdowns.at(-1).owner_key=owner; return reply; }
  const del=text.match(/^删除倒数日\s+(.+)$/);
  if(del) { const matches=(state.countdowns||[]).filter(c=>c.title===del[1]&&(!c.owner_key||c.owner_key===owner)); if(matches.length!==1)return "未找到唯一匹配的倒数日，请发送完整标题。"; state.countdowns=state.countdowns.filter(c=>c!==matches[0]);return "✅ 已删除倒数日【"+del[1]+"】。"; }
  if (/^(?:确认明天|明天确认|确认明日安排)$/.test(text)) {
    const tomorrow=reportEvents(state,now+864e5,owner); state.planConfirmations ||= {};
    state.planConfirmations[owner+"|"+dayKey(now+864e5)]={signature:planSignature(tomorrow),confirmed_at:now};
    return "✅ 已确认"+fmtDate(startOfDay(now+864e5))+"当前"+tomorrow.length+"项安排；改期或增删后需重新确认。";
  }
  const complete=text.match(/^(?:完成|已完成|做完了)\s*(.+)$/);
  if(complete) {
    const rows=reportEvents(state,now,owner), target=complete[1].trim().replace(/^(?:今天第)?(\d+)项?$/,"$1");
    const matches=/^\d+$/.test(target)?[rows[+target-1]].filter(Boolean):rows.filter(e=>e.title===target);
    if(matches.length!==1)return "请用今日晨晚报中的序号或完整标题，例如『完成 2』。";
    const e=matches[0];e.completed_at=now;e.status="done";if(e.reminder)e.reminder.ack_at=now;
    return "✅ 【"+e.title+"】已标记完成，停止后续提醒。";
  }
  return null;
}

// ================= AI 意图解析（默认 DeepSeek） =================
const TOOLS = [
  { type:"function", function:{name:"add_countdown",description:"设置重要长期事项的倒数日，不占用日程时段，晨晚报每天显示",parameters:{type:"object",properties:{title:{type:"string"},date:{type:"string",description:"明确目标日期YYYY-MM-DD，缺日期先追问"}},required:["title","date"]}}},
  { type: "function", function: { name: "add_event", description: "新增日程或提醒任务",
    parameters: { type: "object", properties: {
      title: { type: "string", description: "事项标题" },
      datetime: { type: "string", description: "开始时间(固定型)或截止时间(截止型)，ISO8601格式如2026-08-30T14:00:00+08:00，相对时间要换算成绝对时间" },
      date_text: { type: "string", description: "该事项的日期原话，如明天、下周三、明年1月2日；不要包含另一事项日期" },
      time: { type: "string", description: "用户明确给出的时刻，24小时 HH:MM；未说明时刻则不要调用，先追问" },
      duration_minutes: { type: "integer", description: "事项持续分钟数，未说明默认30" },
      kind: { type: "string", enum: ["fixed", "deadline"], description: "fixed=定点事项(几点开始), deadline=截止任务(几点前完成)" },
      level: { type: "string", enum: ["call", "sms"], description: "call=来电级强提醒(用户说来电/电话/重要), sms=短信级微信提醒" },
    }, required: ["title", "date_text", "time", "kind", "level"] } } },
  { type: "function", function: { name: "reschedule_event", description: "改期：修改已有日程的时间",
    parameters: { type: "object", properties: {
      target: { type: "string", description: "要改的日程关键词，如『牙医』" },
      event_id: { type: "integer", description: "根据已有日程选定的唯一ID；重名必须追问" },
      daily_number: { type: "integer", description: "用户说的当天第几项，从1开始；不能当作event_id" },
      source_date_text: { type: "string", description: "原日程所属日期，如明天；与改到的新日期分开。用户未说明原日期时追问" },
      date_text: { type: "string", description: "新日期原话，如明天，不能填原日期" },
      time: { type: "string", description: "新时刻，24小时 HH:MM" },
      new_datetime: { type: "string", description: "新的时间，ISO8601格式" },
    }, required: ["target", "date_text", "time"] } } },
  { type: "function", function: { name: "cancel_event", description: "取消/删除日程",
    parameters: { type: "object", properties: {
      target: { type: "string", description: "要取消的日程关键词" },
      event_id: { type: "integer", description: "选定日程的唯一ID，重名必须追问" },
      daily_number: { type: "integer", description: "用户说的当天第几项，从1开始；不能当作event_id" },
      source_date_text: { type: "string", description: "要取消的日程所属日期，用户未说明日期时追问" },
    }, required: ["target"] } } },
  { type: "function", function: { name: "list_events", description: "按日期查询计划，如明天有什么事、本周的安排；禁止当作新增", parameters: { type: "object", properties: {
    date_text: { type: "string", description: "查询范围原话，如明天、今天到后天、本周。无范围就留空" },
    from: { type: "string", description: "复杂范围的起始日期 YYYY-MM-DD" },
    to: { type: "string", description: "复杂范围的结束日期 YYYY-MM-DD，包含当天" },
  } } } },
  { type: "function", function: { name: "schedule_task", description: "用户明确授权自动安排任务时使用，根据已有安排查找真正能容纳任务时长的空档；仅询问空闲用 find_free_time", parameters: { type: "object", properties: {
    title: { type: "string" }, date_text: { type: "string", description: "可安排的日期范围原话，如明天下午、本周" },
    duration_minutes: { type: "integer", description: "任务需要的分钟数，必须由用户给出或追问得到" },
    level: { type: "string", enum: ["call", "sms"] },
  }, required: ["title", "date_text", "duration_minutes"] } } },
  { type: "function", function: { name: "find_free_time", description: "按日期和所需时长查询可用空档，不创建日程", parameters: { type: "object", properties: {
    date_text: { type: "string", description: "日期范围原话" }, duration_minutes: { type: "integer", description: "需要连续空闲的分钟数，未说明默认30" },
  }, required: ["date_text"] } } },
  { type: "function", function: { name: "add_journal", description: "记日记：记录已经发生的事、想法、见闻、感悟。用户说过去时态（…了、刚、已经、今天上午…）时用这个",
    parameters: { type: "object", properties: {
      text: { type: "string", description: "日记正文，保留用户原话的关键信息，不要过度润色" },
      date: { type: "string", description: "发生日期 YYYY-MM-DD 格式。今天/刚才/没说日期就填今天" },
      date_text: { type: "string", description: "事情发生的日期原话，如昨天；不要填正文提及的其他计划日期" },
      tags: { type: "array", items: { type: "string" }, description: "可选标签，如客户、论文、家人。最多 3 个，没有就不填" },
    }, required: ["text", "date"] } } },
  { type: "function", function: { name: "query_journal", description: "按日期查询日记，如『昨天做了什么』『上周三在干嘛』『8月20日的记录』",
    parameters: { type: "object", properties: {
      from: { type: "string", description: "起始日期 YYYY-MM-DD" },
      date_text: { type: "string", description: "查询范围原话，如昨天、上周、本周三" },
      to: { type: "string", description: "结束日期 YYYY-MM-DD，查单日时与 from 相同" },
    }, required: ["from"] } } },
];

function aiConfig() {
  const custom = process.env.AI_BASE_URL || process.env.AI_MODEL || process.env.AI_API_KEY;
  if (custom && (!process.env.AI_BASE_URL || !process.env.AI_MODEL || !process.env.AI_API_KEY)) {
    throw new Error("模型配置不完整：请同时配置 AI_BASE_URL、AI_MODEL、AI_API_KEY");
  }
  const base = process.env.AI_BASE_URL || "https://api.deepseek.com";
  const url = base.replace(/\/+$/, "").replace(/\/chat\/completions$/, "") + "/chat/completions";
  if (new URL(url).protocol !== "https:") throw new Error("模型地址必须使用 HTTPS");
  const key = custom ? process.env.AI_API_KEY : process.env.DEEPSEEK_API_KEY;
  if (!key || key.startsWith("<")) throw new Error(custom ? "尚未配置可用的 AI_API_KEY" : "尚未配置 DEEPSEEK_API_KEY，请在云函数环境变量中填写 DeepSeek Key");
  return { url, key, model: process.env.AI_MODEL || "deepseek-flash" };
}
async function glmChat(userText, events, history = [], now = Date.now()) {
  const list = events.filter((e) => e.status === "active").map((e) =>
    "内部ID=" + e.id + " | " + dailyLabel(events, e) + " " + e.title + " | " + (e.kind === "deadline" ? "截止 " : "") + fmtFull(e.datetime) +
    " | 持续" + eventDuration(e) + "分钟 | " + e.level
  ).join("\n") || "(暂无)";
  const config = aiConfig();
  const sys = "你是能查询真实日程、记事、寻找空档和安排任务的私人助理。\n" +
    "本条消息的基准时间：" + fmtFull(now) + "（Asia/Shanghai，UTC+8）。今天=" + dayKey(now) +
    "（自然日期），口语明天=" + dayKey(resolveDay("明天", now)) + "，口语后天=" + dayKey(resolveDay("后天", now)) + "。\n" +
    "用户作息分界为北京时间凌晨04:00。00:00至03:59说的明天指自然日期的今天，后天指自然日期的明天；04:00起正常换日。" +
    "凌晨说今天下午开了会等已发生叙述，今天指前一个白天；今天下午有什么安排等未来查询仍指接下来的白天。" +
    "用户明确年月日或声明按自然日/日历理解时优先遵从。日期原话保留在date_text，不要擅自转成日历明天；无法确定时追问。\n" +
    weekHint(now) + "。自然日日期表（表内今天/明天是自然日期，凌晨口语按上方作息规则）：" + dayTable(now, -7, 21) + "\n" +
    "相对日期以本条基准时间为准；日期原话放 date_text，由程序换算，允许跨年、明年和明确历史年份。\n" +
    "真实已有日程：\n" + list + "\n" +
    "用户看到的序号是每天按时间排序后从1开始的当天序号，不是内部ID。用户说第几项时使用daily_number及source_date_text；未说明哪天则追问，不能猜日期。改期时原日期填source_date_text，新日期填date_text。\n" +
    "规则：询问安排→list_events；回顾已经发生的事情→query_journal；陈述已发生事情→add_journal；" +
    "指定时刻的未来安排→add_event；改期/取消要选择真实ID，重名追问。不要因为有『了』就判断成日记，" +
    "例如『明天三点提醒我，别忘了』是日程。\n" +
    "用户说『帮我明天下午找一小时写报告』且授权安排→schedule_task；『明天下午有一小时空吗』→find_free_time。" +
    "任务时长、日期或具体时刻缺失时简短追问，不能编造；普通固定日程未说时长默认30分钟并在回复显示。" +
    "自动安排默认09:00-18:00，间隔5分钟，只能安排已明确授权的任务，不移动已有安排。\n" +
    "查询必须用工具，不能凭空回答。不要说已经保存/取消，真实执行结果由程序回复。" +
    "每次只执行一个明确动作，多事项请用户逐条发送，不能悄悄只做第一项。" +
    "追问的补充回答需结合近期对话，但历史消息的今天/明天以历史时间戳为准；历史已完成操作不能重做。" +
    "用户说来电/电话/重要/必须时level=call，否则sms。";
  const started = Date.now();
  const r = await httpReq(
    config.url, "POST",
    { "Content-Type": "application/json", Authorization: "Bearer " + config.key },
    JSON.stringify({
      model: config.model, max_tokens: 1500,
      ...(new URL(config.url).hostname === "api.deepseek.com" ? { thinking: { type: "disabled" } } : { temperature: 0.1 }),
      messages: [{ role: "system", content: sys }, ...history, { role: "user", content: userText }],
      tools: TOOLS, tool_choice: "auto",
    })
  );
  console.log("[ai] model=" + config.model + " status=" + r.status + " elapsed_ms=" + (Date.now() - started));
  if (r.status < 200 || r.status >= 300) throw new Error("模型调用失败（HTTP " + r.status + "），请检查模型配置、额度或稍后重试");
  let data;
  try { data = JSON.parse(r.text); } catch { throw new Error("模型返回了无效响应，请稍后重试"); }
  const message = data.choices && data.choices[0] && data.choices[0].message;
  if (!message || (!message.content && !message.tool_calls?.length)) throw new Error("模型没有返回可执行内容，请重试");
  return message;
}

// ================= 空档择时 =================
const PICK_BUFFER = 5 * 60e3;    // 与前后事项的安全间隔
const PICK_MINLEAD = 15 * 60e3;  // 距截止的最小提前量
const PICK_DEFAULT_LEAD = 60 * 60e3;  // 无安排时默认提前多久提醒
function pickNotifyTime(events, deadlineTs, nowTs) {
  const floor = nowTs + 5 * 60e3;
  const cap = deadlineTs - PICK_MINLEAD;
  if (cap <= floor) return Math.min(floor, deadlineTs);

  // 截止前的占用区间，两端各留 5 分钟安全间隔
  const busy = events.filter((e) => e.status === "active").map((e) => {
    if (e.kind === "deadline") return [e.datetime - 30 * 60e3 - PICK_BUFFER, e.datetime + PICK_BUFFER];
    return [e.datetime - PICK_BUFFER, e.datetime + eventDuration(e) * 60e3 + PICK_BUFFER];
  }).filter((iv) => iv[1] > floor && iv[0] < cap).sort((a, b) => a[0] - b[0]);

  // 默认在截止前 DEFAULT_LEAD 提醒；撞上已有安排就往前挪到该安排之前
  let target = Math.max(floor, Math.min(deadlineTs - PICK_DEFAULT_LEAD, cap));
  for (let iter = 0; iter <= busy.length; iter++) {
    let hit = null;
    for (const [s, e] of busy) {
      if (target >= s && target <= e) { hit = s; break; }
    }
    if (hit === null) break;
    const moved = hit - PICK_BUFFER;               // 挪到这段安排开始之前
    if (moved <= floor || moved === target) { target = floor; break; }
    target = moved;
  }
  return Math.max(floor, Math.min(target, cap));
}

// ================= 意图执行 =================
async function executeIntent(message, state, userText, persist = true) {
  const events = state.events;
  if (!state.journals) state.journals = [];
  if (!state.notified) state.notified = {};
  if (!message) return "云端解析暂时不可用，请稍后再试。";
  if (message.tool_calls && message.tool_calls.length) {
    if (message.tool_calls.length > 1) return "这条消息包含多个操作，请逐条发送，我会逐项处理，避免漏记或改错。";
    const call = message.tool_calls[0];
    const fn = call.function?.name;
    console.log("[intent] " + fn);
    let args;
    try { args = JSON.parse(call.function.arguments || "{}"); } catch { return "解析结果不完整，这次没有修改日程，请再说一次。"; }
    if (!args || typeof args !== "object" || Array.isArray(args)) return "解析参数无效，这次没有修改日程，请再说一次。";
    if (fn === "add_countdown") {
      const reply=addCountdown(state,args.title,args.date,Date.now());
      if(reply.startsWith("✅") && persist) await saveState(state);
      return reply;
    }
    if (fn === "schedule_task" || fn === "find_free_time") {
      const now = Date.now();
      const range = resolveRange(args.date_text || userText, now);
      const duration = args.duration_minutes === undefined && fn === "find_free_time" ? 30 : args.duration_minutes;
      if (!range) return "你希望安排在哪天或哪段日期？比如明天下午。";
      if (!Number.isInteger(duration) || duration < 5 || duration > 720) return "这件事大约需要多少分钟？请给出5到720分钟的时长。";
      const slot = findSlot(events, range.from, range.to, duration, now);
      if (slot === null) return "这段时间内没有能容纳" + duration + "分钟的空档（默认安排时段09:00–18:00，事项间隔5分钟）。要扩大日期范围或缩短时长吗？";
      const explanation = fmtCST(slot) + "–" + fmtTime(slot + duration * 60e3) + "，共" + duration + "分钟，已避开现有日程并预留5分钟间隔";
      if (fn === "find_free_time") return "🕒 可用空档：" + explanation + "。这次只查询，没有新建日程。";
      if (typeof args.title !== "string" || !args.title.trim()) return "要帮你安排什么事情？";
      const ev = {
        id: events.length ? Math.max(...events.map((e) => e.id)) + 1 : 1,
        title: args.title.trim(), kind: "fixed", datetime: slot, duration_minutes: duration,
        level: args.level === "call" ? "call" : "sms", status: "active", created_at: now,
        notify_at: Math.max(now, slot - 30 * 60e3), fallback_at: Math.max(now, slot - 5 * 60e3),
      };
      events.push(ev);
      if (persist) await saveState(state);
      return "✅ 已安排【" + ev.title + "】" + explanation + "。\n回复『取消 " + ev.title + "』可撤销。";
    }
    if (fn === "add_event") {
      const now = Date.now();
      const dt = resolveEventTime(args.datetime, args.date_text, userText, now, args.time);
      if (dt === null) return "安排在几点？比如『下午两点』；如果希望我找空档，请说日期范围和需要多久。";
      if (dt <= now) return "你说的时间 " + fmtCST(dt) + " 已经过去了。是要记录已发生的事，还是安排到其他时间？";
      if (typeof args.title !== "string" || !args.title.trim()) return "需要提醒你做什么？";
      const duration = args.duration_minutes === undefined ? 30 : args.duration_minutes;
      if (!Number.isInteger(duration) || duration < 5 || duration > 720) return "事项持续多久？请给出5到720分钟的时长。";
      const overlap = args.kind === "deadline" ? [] : conflicts(events, dt, duration);
      if (overlap.length) return "这个时间与【" + overlap.map((e) => e.title).join("、") + "】冲突，尚未创建。要我找一个" + duration + "分钟的空档吗？";
      const id = events.length ? Math.max(...events.map((e) => e.id)) + 1 : 1;
      const level = args.level === "call" ? "call" : "sms";
      const ev = {
        id, title: args.title.trim(), kind: args.kind === "deadline" ? "deadline" : "fixed", duration_minutes: duration,
        datetime: dt, level, status: "active", created_at: Date.now(),
      };
      if (ev.kind === "deadline") {
        ev.notify_at = pickNotifyTime(events, dt, Date.now());
        ev.fallback_at = dt - 15 * 60e3;
      } else {
        ev.notify_at = dt - 30 * 60e3;
        ev.fallback_at = dt - 5 * 60e3;
      }
      ev.notify_at = Math.max(now, Math.min(ev.notify_at, dt));
      ev.fallback_at = Math.max(now, ev.fallback_at);
      events.push(ev);
      if (persist) await saveState(state);
      const desc = ev.kind === "deadline" ? "截止 " + fmtCST(ev.datetime) : fmtCST(ev.datetime) + " 开始（持续" + duration + "分钟）";
      const remind = ev.notify_at > Date.now() ? ("将在 " + fmtCST(ev.notify_at) + " 提醒你") : "马上提醒";
      return "✅ 已记录【" + ev.title + "】" + desc + "（" + (level === "call" ? "来电级" : "短信级") + "），" + remind +
             "\n回复『取消 " + ev.title + "』可撤销";
    }
    if (fn === "reschedule_event") {
      const reference = dailyReference(args, userText, Date.now());
      if (reference && reference.day === null) return "要改哪天的第" + reference.number + "项？比如『明天第1项改到后天下午三点』。";
      const matches = matchingEvents(events, args, reference);
      if (reference && !matches.length) return "这一天没有第" + reference.number + "项，请先查询当天日程。";
      if (matches.length > 1) return "找到多个日程：" + matches.map((e) => dailyLabel(events, e) + " " + e.title + " " + fmtTime(e.datetime)).join("；") + "。要改哪一个？";
      const ev = matches[0];
      const now = Date.now();
      const dt = resolveEventTime(args.new_datetime, args.date_text, userText, now, args.time);
      if (!ev) return "没找到叫『" + args.target + "』的日程，发送『查询日程』看看？";
      if (dt === null) return "要改到哪天几点？比如明天下午两点。";
      if (dt <= now) return "新时间已经过去了，请给一个未来的时间；这次没有改动。";
      const overlap = ev.kind === "deadline" ? [] : conflicts(events, dt, eventDuration(ev), ev.id);
      if (overlap.length) return "新时间与【" + overlap.map((e) => e.title).join("、") + "】冲突，这次没有改动。要我找其他空档吗？";
      ev.datetime = dt;
      if (ev.kind === "deadline") { ev.notify_at = pickNotifyTime(events.filter((e) => e !== ev), dt, Date.now()); ev.fallback_at = dt - 15 * 60e3; }
      else { ev.notify_at = dt - 30 * 60e3; ev.fallback_at = dt - 5 * 60e3; }
      ev.notify_at = Math.max(now, Math.min(ev.notify_at, dt));
      ev.fallback_at = Math.max(now, ev.fallback_at);
      delete state.notified[ev.id + "|main"];
      delete state.notified[ev.id + "|fb"];
      if (persist) await saveState(state);
      return "✅ 【" + ev.title + "】已改到 " + fmtCST(dt) + "，提醒重排为 " + fmtCST(ev.notify_at);
    }
    if (fn === "cancel_event") {
      const reference = dailyReference(args, userText, Date.now());
      if (reference && reference.day === null) return "要取消哪天的第" + reference.number + "项？比如『取消明天第1项』。";
      const matches = matchingEvents(events, args, reference);
      if (reference && !matches.length) return "这一天没有第" + reference.number + "项，请先查询当天日程。";
      if (matches.length > 1) return "找到多个日程：" + matches.map((e) => dailyLabel(events, e) + " " + e.title + " " + fmtTime(e.datetime)).join("；") + "。要取消哪一个？";
      const ev = matches[0];
      if (!ev) return "没找到叫『" + args.target + "』的日程";
      ev.status = "cancelled";
      if (persist) await saveState(state);
      return "✅ 已取消【" + ev.title + "】";
    }
    if (fn === "list_events") {
      return listEvents(state, userText, args, Date.now());
    }
    if (fn === "add_journal") {
      const journals = state.journals;
      // 兼容从 add_event 转过来的情况（参数名不同）
      let text = args.text || args.title || userText;
      // 模型爱把日记压缩成摘要（实测「今天下午和客户聊完…」被压成「与客户签约」），
      // 压缩超过一半就改用原话——日记是个人的，丢信息比啰嗦更糟
      if (userText && text.length < userText.length * 0.5) text = userText.trim();
      const now = Date.now();
      const dayStart = resolveDay(args.date_text || userText, now, userText) ?? resolveDay(args.date, now) ?? startOfDay(now);
      if (dayStart > startOfDay(now)) return "这件事发生在未来，应该记为日程吗？请告诉我具体时刻，或让我按所需时长找空档。";
      if (typeof text !== "string" || !text.trim()) return "想记下什么事情？";
      const j = {
        id: journals.length ? Math.max(...journals.map((x) => x.id)) + 1 : 1,
        date: dayKey(dayStart), ts: Date.now(), text: text,
        tags: Array.isArray(args.tags) ? args.tags.slice(0, 3) : [],
      };
      journals.push(j);
      if (persist) await saveState(state);
      return "📔 已记下 · " + fmtDate(dayStart) + "\n" + text +
             (j.tags.length ? "\n#" + j.tags.join(" #") : "");
    }
    if (fn === "query_journal") {
      const journals = state.journals;
      const now = Date.now();
      const range = resolveRange(args.date_text, now, userText) || resolveRange(userText, now);
      let from = range ? startOfDay(range.from) : resolveDay(args.from, now);
      let to = range ? startOfDay(range.to - 1) : resolveDay(args.to || args.from, now);
      if (from === null || to === null) return "你想回顾哪天或哪段时间？比如昨天、上周。";
      if (to < from) [from, to] = [to, from];
      const fk = dayKey(from), tk = dayKey(to);
      const hits = journals.filter((j) => j.date >= fk && j.date <= tk)
                           .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      // 同一天已完成的日程也并入回顾，这才是完整的一天
      const done = events.filter((e) => {
        const k = dayKey(e.datetime);
        return k >= fk && k <= tk && (e.status === "done" || (e.status === "active" && e.datetime <= Date.now()));
      }).sort((a, b) => a.datetime - b.datetime);
      const label = fk === tk ? fmtDate(from) : fmtDate(from) + " ~ " + fmtDate(to);
      if (!hits.length && !done.length) return "📔 " + label + " 没有记录";
      let out = "📔 " + label;
      if (hits.length) out += "\n" + hits.map((j) => "· " + j.text).join("\n");
      if (done.length) out += "\n完成的事：\n" + done.map((e) => "✓ " + e.title).join("\n");
      return out;
    }
  }
  if (message.tool_calls?.length) return "这个操作暂不支持，这次没有修改日程。";
  if (/已(?:保存|记录|安排|取消|改到|改期)/.test(message.content || "")) return "模型没有调用日程工具，这次没有修改日程，请再说一次。";
  return message.content || "（没听懂，换个说法试试）";
}

// ================= 消息路由 =================
async function routeMessage(xml, state) {
  const msgType = xmlTag(xml, "MsgType");
  if (msgType === "event") {
    const ev = xmlTag(xml, "Event");
    if (ev === "subscribe") return "👋 我是你的日程助理：直接发消息说安排（支持微信键盘语音听写），例如\n· 明天8点前来电级提醒我交报告\n· 周三下午2点牙医\n· 查询日程";
    return "";
  }
  if (msgType === "voice") {
    return "🔊 暂不支持语音直发：请长按输入框切到键盘，用语音听写转成文字发送（效果相同）。";
  }
  if (msgType !== "text") return "";
  const text = xmlTag(xml, "Content").trim();
  if (!text) return "";
  const now = Date.now();
  const user = xmlTag(xml, "FromUserName") || "default";
  if (!state.conversations || typeof state.conversations !== "object" || Array.isArray(state.conversations)) state.conversations = {};
  const key = crypto.createHash("sha256").update(user).digest("hex");
  const msgId = xmlTag(xml, "MsgId");
  const replayKey = msgId ? key + ":" + msgId : "";
  if (!state.messageReplies || typeof state.messageReplies !== "object" || Array.isArray(state.messageReplies)) state.messageReplies = {};
  const cached = replayKey && state.messageReplies[replayKey];
  if (cached && now - cached.ts < 24 * 3600e3) return cached.reply;
  const previous = state.conversations[key];
  const recent = previous && now - previous.ts < 30 * 60e3 ? previous.messages : [];
  const history = Array.isArray(recent) ? recent.slice(-8) : [];
  // 简单日期查询直接读取真实状态，模型不可用时也能正常查询。
  const simpleQuery = /^(?:请|帮我)?(?:查一下|看看|查询)?\s*(?:(?:今[天日]|明[天日]|后天|大后天|本周|这周|下周|下下周|周[一二三四五六日天])(?:上午|下午|晚上)?)(?:我)?(?:有(?:什么|哪些|啥)(?:事|安排|日程|活动)|(?:的)?(?:安排|日程)(?:是什么|有哪些)?)[？?。！!\s]*$/.test(text) || /^(?:查询日程|查看日程|我的日程)[？?。\s]*$/.test(text);
  const existingIds = new Set(state.events.map((ev) => ev.id));
  const existingCountdowns = new Set((state.countdowns||[]).map(c=>c.id));
  let reply = dailyCommands(text,state,key,now);
  if(reply===null) reply = reminderCommands(text, state, key, now);
  if (reply !== null) { /* 确认操作不调用模型。 */ }
  else if (simpleQuery) reply = listEvents(state, text, {}, now);
  else {
    const msg = await glmChat(text, state.events, history, now);
    const lastUser = history.filter((m) => m.role === "user").slice(-1)[0];
    const lastReply = history[history.length - 1];
    const effectiveText = lastUser && lastReply?.role === "assistant" && /[？?]/.test(lastReply.content) ? lastUser.content.replace(/^\[消息时间[^\]]*\]\s*/, "") + "\n补充：" + text : text;
    reply = await executeIntent(msg, state, effectiveText, false);
  }
  for (const ev of state.events) if (!existingIds.has(ev.id)) { ev.owner_key = key; ev.owner_userid = user; }
  for (const c of state.countdowns||[]) if(!existingCountdowns.has(c.id)) c.owner_key=key;
  if (beforeSleepBoundary(now) && relativeDayOffset(text) > 0 &&
      !/自然日|日历|公历|严格按日期|\d{1,2}月\d{1,2}|\d{4}-\d{1,2}-\d{1,2}/.test(text)) {
    reply += "\n（凌晨按04:00作息分界理解，请以显示的具体日期为准。）";
  }
  state.conversations[key] = { ts: now, messages: [...history,
    { role: "user", content: "[消息时间 " + fmtFull(now) + "] " + text },
    { role: "assistant", content: reply },
  ].slice(-8) };
  const users = Object.keys(state.conversations).sort((a, b) => state.conversations[b].ts - state.conversations[a].ts);
  for (const stale of users.slice(10)) delete state.conversations[stale];
  if (replayKey) state.messageReplies[replayKey] = { ts: now, reply };
  const replies = Object.keys(state.messageReplies).sort((a, b) => state.messageReplies[b].ts - state.messageReplies[a].ts);
  for (const stale of replies) {
    if (now - state.messageReplies[stale].ts >= 24 * 3600e3) delete state.messageReplies[stale];
  }
  for (const stale of replies.slice(100)) delete state.messageReplies[stale];
  await saveState(state);
  return reply;
}

// ================= 定时任务 =================
async function checkDue() {
  const state = await loadState();
  const log = state.notified;
  const now = Date.now();
  let changed = false;
  for (const ev of state.events) {
    if (ev.status !== "active") continue;
    if (now > ev.datetime + 2 * 3600e3) { ev.status = "expired"; changed = true; continue; }
    if (!ev.notify_at || now < ev.notify_at) continue;
    const previousReminder = ev.reminder;
    const reminder = reminderState(ev, log, now);
    if (reminder !== previousReminder) changed = true;
    if (reminder.ack_at || reminder.snooze_until > now) continue;
    let roundName;
    if (reminder.snooze_round) roundName = reminder.snooze_round;
    else if (!reminder.legacy && !reminder.rounds.main) roundName = "main";
    else {
      roundName = Object.keys(reminder.rounds).find((name) => Object.values(reminder.rounds[name].channels).some((s) => s.status === "pending"));
      if (!roundName && ev.level === "call" && !reminder.legacy && !reminder.snooze_count && reminder.first_accepted_at) {
        if (now >= reminder.first_accepted_at + 2 * 60e3 && !reminder.rounds.follow1) roundName = "follow1";
        else if (now >= reminder.first_accepted_at + 5 * 60e3 && !reminder.rounds.follow2) roundName = "follow2";
      }
      if (!roundName && ev.level !== "call" && !reminder.legacy && !reminder.snooze_count && now >= (reminder.first_accepted_at || reminder.created_at)+5*60e3 && !reminder.rounds.escalate) roundName="escalate";
      if (!roundName && reminder.legacy && ev.fallback_at && now >= ev.fallback_at && !log[ev.id + "|fb"] && !reminder.rounds.fb) roundName = "fb";
    }
    if (!roundName) continue;
    const strong=ev.level === "call" || roundName === "escalate";
    const round = reminder.rounds[roundName] ||= { channels: Object.fromEntries(reminderChannels(strong).map((ch) => [ch, { status: "pending", attempts: 0, next_at: now }])) };
    if (reminder.snooze_round === roundName) delete reminder.snooze_round;
    const channels = Object.keys(round.channels).filter((ch) => round.channels[ch].status === "pending" && now >= round.channels[ch].next_at);
    if (!channels.length) continue;
    changed = true;
    const when = ev.kind === "deadline" ? "截止" : "开始";
    const left = Math.round((ev.datetime - now) / 60e3);
    const body = "【" + ev.title + "】" + when + " " + fmtCST(ev.datetime) +
      (left > 0 ? "，还剩 " + left + " 分钟" : "，已到提醒时间") +
      "\n回复1或收到，确认最新提醒；回复全部收到确认所有提醒。\n指定本项：收到 " + reminder.code + "\n稍后提醒：推迟10分钟 " + reminder.code;
    const title = (strong ? "【重要·请确认】" : "") + (roundName === "main" ? "日程提醒" : roundName === "escalate" ? "未确认，升级强提醒" : "日程再次提醒");
    const results = await pushAll(title, body, strong, channels, ev.owner_userid);
    for (const ch of channels) {
      const result = results[ch] || { configured: true, ok: false };
      const s = round.channels[ch];
      s.attempts++;
      s.status = result.reason === "primary_accepted" ? "skipped" : !result.configured ? "unconfigured" : result.ok ? "accepted" : s.attempts >= 3 ? "failed" : "pending";
      s.next_at = now + s.attempts * 60e3;
      if (!result.ok && result.code !== undefined) s.error_code = result.code;
      else if (result.ok) delete s.error_code;
      if (result.ok) {
        s.accepted_at = now;
        if (!reminder.first_accepted_at) reminder.first_accepted_at = now;
        if (roundName === "main" || roundName === "fb") log[ev.id + "|" + roundName] = now;
      }
    }
  }
  if(await sendDailyReports(state,now)) changed=true;
  if (changed) await saveState(state);
}
// 汇总某一天：日记条目 + 当天已完成的事
function dayRecap(state, dayStartTs, now) {
  const key = dayKey(dayStartTs);
  const js = (state.journals || []).filter((j) => j.date === key);
  const done = (state.events || []).filter((e) => {
    if (dayKey(e.datetime) !== key) return false;
    return !!e.completed_at;
  }).sort((a, b) => a.datetime - b.datetime);
  const lines = [];
  js.forEach((j) => lines.push("· " + j.text));
  done.forEach((e) => lines.push("✓ " + e.title));
  return lines;
}
async function sendDailyReports(state,now,only) {
  const day=startOfDay(now); let changed=false;
  state.dailyReports ||= {};
  for(const [kind,offset] of [["morning",8*3600e3],["evening",20.5*3600e3]]) {
    if(only && only!==kind) continue;
    const due=day+offset;
    if(now<due || now>=due+2*3600e3)continue;
    const key=dayKey(now)+"|"+kind;
    const record=state.dailyReports[key] ||= {attempts:0};
    if(record.accepted_at || record.attempts>=3 || (record.last_try && now-record.last_try<60e3))continue;
    const owner=process.env.WECOM_TO_USER ? crypto.createHash("sha256").update(process.env.WECOM_TO_USER).digest("hex") : undefined;
    const result=await pushAll(kind==="morning"?"☀️ 08:00今日晨报":"🌙 20:30复盘与明日安排",dayReport(state,now,kind==="evening",owner),false);
    record.attempts++;record.last_try=now;
    if(Object.values(result).some(r=>r.ok))record.accepted_at=now;
    changed=true;
  }
  for(const key of Object.keys(state.dailyReports)) if(key.slice(0,10)<dayKey(now-7*864e5)){delete state.dailyReports[key];changed=true;}
  return changed;
}
async function morningBrief() { const state=await loadState();if(await sendDailyReports(state,Date.now(),"morning"))await saveState(state); }
async function eveningReview() { const state=await loadState();if(await sendDailyReports(state,Date.now(),"evening"))await saveState(state); }
// ================= SCF 入口 =================
function resp(body, status, contentType) {
  return {
    isBase64Encoded: false,
    statusCode: status || 200,
    headers: { "Content-Type": contentType || "text/plain; charset=utf-8" },
    body,
  };
}
// 兼容两种入口：函数URL用 queryString，API网关用 queryStringParameters
function qp(event, name) {
  const q = event.queryString || event.queryStringParameters || {};
  const v = q[name];
  return Array.isArray(v) ? v[0] : (v == null ? "" : String(v));
}

exports.main_handler = async (event, context) => {
  // ---- 定时触发器 ----
  if (event.Type === "Timer" || event.TriggerName) {
    const name = event.TriggerName || "";
    if (name.indexOf("morning") >= 0) await morningBrief().catch((e) => console.error("晨报失败:", e));
    else if (name.indexOf("evening") >= 0) await eveningReview().catch((e) => console.error("晚回顾失败:", e));
    else await checkDue().catch((e) => console.error("扫描失败:", e));
    return { status: "timer done", trigger: name };
  }
  // ---- HTTP（函数URL）----
  const method = (event.httpMethod || "GET").toUpperCase();
  const msgSignature = qp(event, "msg_signature");
  const timestamp = qp(event, "timestamp");
  const nonce = qp(event, "nonce");

  // 健康检查：GET 无验签参数
  if (method === "GET" && !msgSignature) {
    return resp("ok " + fmtCST(Date.now()) + " (SCF版)");
  }

  try {
    if (method === "GET") {
      // 企微回调验证
      const echostr = qp(event, "echostr");
      const sig = sha1Hex(process.env.WECOM_TOKEN, timestamp, nonce, echostr);
      if (sig !== msgSignature) return resp("signature mismatch", 403);
      const { msg } = wxDecrypt(process.env.WECOM_AES_KEY, echostr);
      return resp(msg);
    }
    // POST：企微消息
    let body = event.body || "";
    if (event.isBase64Encoded) body = Buffer.from(body, "base64").toString("utf8");
    const encrypted = xmlTag(body, "Encrypt");
    const sig = sha1Hex(process.env.WECOM_TOKEN, timestamp, nonce, encrypted);
    if (sig !== msgSignature) return resp("signature mismatch", 403);
    const { msg } = wxDecrypt(process.env.WECOM_AES_KEY, encrypted);
    let reply = "";
    try {
      const state = await loadState();
      reply = await routeMessage(msg, state);
    } catch (e) {
      reply = "内部错误：" + e.message;
    }
    if (!reply) return resp("");
    const plain = "<xml><ToUserName><![CDATA[" + xmlTag(msg, "FromUserName") + "]]></ToUserName>" +
      "<FromUserName><![CDATA[" + xmlTag(msg, "ToUserName") + "]]></FromUserName>" +
      "<CreateTime>" + Math.floor(Date.now() / 1000) + "</CreateTime>" +
      "<MsgType><![CDATA[text]]></MsgType>" +
      "<Content><![CDATA[" + reply + "]]></Content></xml>";
    const outEnc = wxEncrypt(process.env.WECOM_AES_KEY, process.env.WECOM_CORP_ID, plain);
    const outSig = sha1Hex(process.env.WECOM_TOKEN, timestamp, nonce, outEnc);
    const outXml = "<xml><Encrypt><![CDATA[" + outEnc + "]]></Encrypt>" +
      "<MsgSignature><![CDATA[" + outSig + "]]></MsgSignature>" +
      "<TimeStamp>" + timestamp + "</TimeStamp>" +
      "<Nonce><![CDATA[" + nonce + "]]></Nonce></xml>";
    return resp(outXml, 200, "text/xml");
  } catch (e) {
    console.error("回调异常:", e);
    return resp("error: " + e.message, 500);
  }
};
