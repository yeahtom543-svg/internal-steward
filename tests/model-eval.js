const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

// 仅发送合成样例到配置的模型，不读取或写入真实日程、不调用通知。
const now = Date.parse("2026-10-29T10:00:00+08:00");
class Clock extends Date { static now() { return now; } }
const context = vm.createContext({
  require(name) {
    if (name === "cos-nodejs-sdk-v5") return class { constructor() { throw new Error("评测禁止访问 COS"); } };
    return require(name);
  },
  process: { env: process.env, on() {} }, Date: Clock, Buffer, URL, console, exports: {},
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "../index.js"), "utf8"), context);
const cases = [
  { text: "明天有什么事", tool: "list_events", check(s, reply) { assert.match(reply, /已有会议/); assert.equal(s.events.length, 1); } },
  { text: "明天下午三点提醒我开会，别忘了", tool: "add_event", check(s) { assert.equal(s.events[1].datetime, Date.parse("2026-10-30T15:00:00+08:00")); assert.equal(s.journals.length, 0); } },
  { text: "帮我明天下午找一小时写报告", tool: "schedule_task", check(s) { assert.equal(s.events[1].datetime, Date.parse("2026-10-30T13:05:00+08:00")); assert.equal(s.events[1].duration_minutes, 60); } },
  { text: "明天下午有一个小时空吗", tool: "find_free_time", check(s) { assert.equal(s.events.length, 1); } },
  { text: "明天开会", tool: null, check(s, reply) { assert.equal(s.events.length, 1); assert.match(reply, /[？?]|几点|时刻/); } },
  { text: "昨天跑了五公里", tool: "add_journal", check(s) { assert.equal(s.journals[0].date, "2026-10-28"); } },
  { text: "下午三点", history: [{ role: "user", content: "[消息时间 2026-10-29 09:59 周四] 明天开会" }, { role: "assistant", content: "明天几点开会？" }], effective: "明天开会，下午三点", tool: "add_event", check(s) { assert.equal(s.events[1].datetime, Date.parse("2026-10-30T15:00:00+08:00")); } },
];

(async () => {
  const config = context.aiConfig();
  console.log("真实模型评测：" + config.model + "；" + cases.length + "个合成样例，会产生 API 费用。无真实日程读写。");
  let failed = 0;
  for (const c of cases) {
    const s = { events: [{ id: 1, title: "已有会议", datetime: Date.parse("2026-10-30T12:00:00+08:00"), duration_minutes: 60, kind: "fixed", status: "active" }], journals: [], notified: {} };
    const started = Date.now();
    try {
      const message = await context.glmChat(c.text, s.events, c.history || [], now);
      const calls = message.tool_calls || [];
      assert.equal(calls.length, c.tool ? 1 : 0);
      assert.equal(calls[0]?.function?.name || null, c.tool);
      const reply = await context.executeIntent(message, s, c.effective || c.text, false);
      c.check(s, reply);
      console.log("PASS " + c.text + " | " + (Date.now() - started) + "ms");
    } catch (e) {
      failed++;
      console.error("FAIL " + c.text + " | " + e.message);
    }
  }
  console.log("结果：" + (cases.length - failed) + "/" + cases.length + "通过。该小样本不能代表全部口语场景。");
  process.exitCode = failed ? 1 : 0;
})().catch((e) => { console.error(e.message); process.exitCode = 1; });
