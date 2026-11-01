const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function app(options = {}) {
  const writes = [];
  class Cos {
    getObject(params, callback) {
      callback(options.readError || null, { Body: options.body === undefined ? '{"events":[]}' : options.body });
    }
    putObject(params, callback) {
      writes.push(JSON.parse(params.Body));
      callback(options.writeError || null);
    }
  }
  const now = Date.parse(options.now || "2026-10-29T10:00:00+08:00");
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({
    require(name) {
      if (name === "cos-nodejs-sdk-v5") return Cos;
      if (name === "crypto") return require("node:crypto");
      throw new Error("离线测试禁止访问外部依赖: " + name);
    },
    process: { env: { DEEPSEEK_API_KEY: "offline-test-key", ...options.env }, on() {} },
    console: { log() {}, error() {} },
    Date: Clock, Buffer, URL, exports: {},
  });
  // 用空实现替代网络模块，任何实际请求都会立即失败。
  const originalRequire = context.require;
  context.require = (name) => name === "https" ? { request() { throw new Error("禁止联网"); } } : originalRequire(name);
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../index.js"), "utf8"), context);
  return { context, writes, now };
}

test("只有状态文件不存在时初始化空数据", async () => {
  const { context } = app({ readError: { code: "NoSuchKey" } });
  const state = await context.loadState();
  assert.equal(state.events.length, 0);
  assert.equal(state.journals.length, 0);
  assert.deepEqual(Object.keys(state.notified), []);
});

test("读取失败、内容损坏或结构异常时停止操作，禁止覆盖", async () => {
  for (const options of [
    { readError: new Error("AccessDenied") },
    { readError: { code: "NoSuchBucket", statusCode: 404 } },
    { body: "{" }, { body: "" }, { body: "null" },
    { body: '{"events":{}}' },
    { body: '{"events":[],"notified":[]}' },
    { body: '{"events":[],"journals":{}}' },
  ]) {
    const { context, writes } = app(options);
    await assert.rejects(() => context.loadState());
    assert.equal(writes.length, 0);
  }
});

test("旧状态补齐字段，保留已有日程和扩展字段", async () => {
  const { context } = app({ body: '{"events":[{"id":1}],"custom":"keep"}' });
  const state = await context.loadState();
  assert.equal(state.events[0].id, 1);
  assert.equal(state.custom, "keep");
  assert.equal(state.journals.length, 0);
  assert.deepEqual(Object.keys(state.notified), []);
});

test("写入失败时新增日程不能回复保存成功", async () => {
  const { context, writes } = app({ writeError: new Error("AccessDenied") });
  const state = await context.loadState();
  const message = { tool_calls: [{ function: { name: "add_event", arguments: JSON.stringify({
    title: "开会", datetime: "2026-10-30T14:00:00+08:00", kind: "fixed", level: "sms",
  }) } }] };
  await assert.rejects(() => context.executeIntent(message, state, "明天下午两点开会"), /保存失败/);
  assert.equal(writes.length, 1);
});

test("改期明天时纠正模型日期、保留时分并清除旧提醒标记", async () => {
  const { context, writes } = app();
  const state = { events: [{ id: 1, title: "开会", status: "active", kind: "fixed" }], journals: [], notified: { "1|main": 1, "1|fb": 1 } };
  const message = { tool_calls: [{ function: { name: "reschedule_event", arguments: JSON.stringify({
    target: "开会", new_datetime: "2026-11-05T14:30:00+08:00",
  }) } }] };
  await context.executeIntent(message, state, "开会改到明天下午两点半");
  assert.equal(state.events[0].datetime, Date.parse("2026-10-30T14:30:00+08:00"));
  assert.deepEqual(state.notified, {});
  assert.equal(writes.length, 1);
});

test("多行文本和加密 XML 均能完整提取", () => {
  const { context } = app();
  assert.equal(context.xmlTag("<Content><![CDATA[第一行\n第二行]]></Content>", "Content"), "第一行\n第二行");
  assert.equal(context.xmlTag("<Encrypt>abc\ndef</Encrypt>", "Encrypt"), "abc\ndef");
});

function intent(name, args) {
  return { tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }] };
}
function xml(text, user = "user1") {
  return "<xml><MsgType><![CDATA[text]]></MsgType><FromUserName><![CDATA[" + user + "]]></FromUserName><Content><![CDATA[" + text + "]]></Content></xml>";
}
function event(id, title, datetime, duration = 30) {
  return { id, title, datetime: Date.parse(datetime), status: "active", kind: "fixed", duration_minutes: duration };
}
function state(events = []) { return { events, journals: [], notified: {} }; }

test("北京时间相对日期跨月、跨年及本周已过星期不顺延", () => {
  const { context } = app();
  for (const [now, text, expected] of [
    ["2026-10-31T23:59:00+08:00", "明天", "2026-11-01"],
    ["2026-12-31T23:59:00+08:00", "明天", "2027-01-01"],
    ["2027-01-01T00:01:00+08:00", "昨天", "2026-12-31"],
    ["2026-10-29T10:00:00+08:00", "本周一", "2026-10-26"],
    ["2026-10-29T10:00:00+08:00", "下周三", "2026-11-04"],
    ["2026-10-29T10:00:00+08:00", "下下周三", "2026-11-11"],
    ["2026-10-29T10:00:00+08:00", "周日", "2026-11-01"],
    ["2026-10-29T10:00:00+08:00", "明年1月2日", "2027-01-02"],
  ]) assert.equal(context.dayKey(context.resolveDay(text, Date.parse(now))), expected, text);
  assert.equal(context.resolveDay("2026年2月30日", Date.now()), null);
  assert.equal(context.parseTime("2026-10-30"), Date.parse("2026-10-30T00:00:00+08:00"));
  assert.equal(context.parseTime("2026-10-30T14:00:00"), Date.parse("2026-10-30T14:00:00+08:00"));
});

test("明天有什么事直接查询真实状态，不调用模型且不混入今天和后天", async () => {
  const { context, writes } = app({ env: { DEEPSEEK_API_KEY: "" } });
  const s = state([
    event(1, "今天会议", "2026-10-29T14:00:00+08:00"),
    event(2, "明天牙医", "2026-10-30T14:00:00+08:00"),
    event(3, "后天报告", "2026-10-31T14:00:00+08:00"),
  ]);
  const reply = await context.routeMessage(xml("明天有什么事"), s);
  assert.match(reply, /明天牙医/);
  assert.doesNotMatch(reply, /今天会议|后天报告/);
  assert.equal(s.events.length, 3);
  assert.equal(writes.length, 1);
});

test("查询时间段、本周和日期范围有正确边界", () => {
  const { context, now } = app();
  const s = state([
    event(1, "上午会议", "2026-10-30T10:00:00+08:00"),
    event(2, "下午牙医", "2026-10-30T14:00:00+08:00"),
    event(3, "下周报告", "2026-11-02T14:00:00+08:00"),
  ]);
  const reply = context.listEvents(s, "明天下午有什么安排", {}, now);
  assert.match(reply, /下午牙医/);
  assert.doesNotMatch(reply, /上午会议|下周报告/);
  const week = context.resolveRange("本周", now);
  assert.equal(context.dayKey(week.from), "2026-10-26");
  assert.equal(context.dayKey(week.to), "2026-11-02");
  const range = context.resolveRange("今天到后天", now);
  assert.equal(context.dayKey(range.from), "2026-10-29");
  assert.equal(context.dayKey(range.to), "2026-11-01");
});

test("明天日期压过模型错误年份，带了字的提醒不再变成日记", async () => {
  const { context } = app();
  const s = state();
  const reply = await context.executeIntent(intent("add_event", {
    title: "开会", date_text: "明天", time: "15:00", datetime: "2023-01-01T15:00:00+08:00",
  }), s, "明天三点提醒我开会，别忘了");
  assert.match(reply, /已记录/);
  assert.equal(s.events[0].datetime, Date.parse("2026-10-30T15:00:00+08:00"));
  assert.equal(s.journals.length, 0);
});

test("已过去的今天时刻、无时刻和无效日期不会擅自创建或顺延年份", async () => {
  for (const [text, args] of [
    ["今天早上八点开会", { date_text: "今天", time: "08:00" }],
    ["明天开会", { date_text: "明天", time: "14:00" }],
    ["2026年2月30日下午两点开会", { date_text: "2026年2月30日", time: "14:00", datetime: "2026-03-02T14:00:00+08:00" }],
  ]) {
    const { context, writes } = app();
    const s = state();
    const reply = await context.executeIntent(intent("add_event", { title: "开会", ...args }), s, text);
    assert.doesNotMatch(reply, /已记录/);
    assert.equal(s.events.length, 0);
    assert.equal(writes.length, 0);
  }
});

test("分钟后提醒及临近事项的提醒时间不晚于开始", async () => {
  const { context, now } = app();
  const s = state();
  await context.executeIntent(intent("add_event", { title: "喝水", date_text: "1分钟后" }), s, "1分钟后提醒我喝水");
  assert.equal(s.events[0].datetime, now + 60e3);
  assert.ok(s.events[0].notify_at <= s.events[0].datetime);
});

test("自动排程按持续时长避开会议，保留五分钟缓冲", async () => {
  const { context } = app();
  const s = state([event(1, "长会", "2026-10-30T13:00:00+08:00", 120)]);
  const reply = await context.executeIntent(intent("schedule_task", {
    title: "写报告", date_text: "明天下午", duration_minutes: 60,
  }), s, "帮我明天下午找一小时写报告");
  assert.equal(s.events[1].datetime, Date.parse("2026-10-30T15:05:00+08:00"));
  assert.equal(s.events[1].duration_minutes, 60);
  assert.match(reply, /避开现有日程/);
});

test("仅查询空档不创建，无完整空档或缺少时长时追问", async () => {
  const { context, writes } = app();
  const s = state();
  const reply = await context.executeIntent(intent("find_free_time", { date_text: "明天下午", duration_minutes: 60 }), s, "明天下午有一小时空吗");
  assert.match(reply, /只查询/);
  assert.equal(s.events.length, 0);
  await context.executeIntent(intent("schedule_task", { date_text: "明天下午", title: "写报告" }), s, "帮我安排明天写报告");
  assert.equal(s.events.length, 0);
  const full = state([event(1, "整天会议", "2026-10-30T09:00:00+08:00", 540)]);
  const noSlot = await context.executeIntent(intent("schedule_task", { date_text: "明天", title: "写报告", duration_minutes: 60 }), full, "帮我明天找一小时写报告");
  assert.match(noSlot, /没有.*空档/);
  assert.equal(full.events.length, 1);
  assert.equal(writes.length, 0);
});

test("固定时间冲突及重名取消不会修改已有日程", async () => {
  const { context, writes } = app();
  const s = state([event(1, "开会", "2026-10-30T14:00:00+08:00", 120), event(2, "开会", "2026-10-31T14:00:00+08:00")]);
  const reply = await context.executeIntent(intent("add_event", { title: "牙医", date_text: "明天", time: "15:00" }), s, "明天下午三点牙医");
  assert.match(reply, /冲突/);
  const cancel = await context.executeIntent(intent("cancel_event", { target: "开会" }), s, "取消开会");
  assert.match(cancel, /多个日程/);
  assert.equal(s.events.length, 2);
  assert.equal(s.events[0].status, "active");
  assert.equal(writes.length, 0);
});

test("历史日记保留明确年份，本周已过日期不会变成未来", async () => {
  const { context } = app();
  const s = state();
  await context.executeIntent(intent("add_journal", { text: "参加培训", date: "2025-12-31", date_text: "2025年12月31日" }), s, "2025年12月31日参加了培训");
  assert.equal(s.journals[0].date, "2025-12-31");
  const reply = await context.executeIntent(intent("query_journal", { date_text: "2025年12月31日", from: "2025-12-31" }), s, "2025年12月31日做了什么");
  assert.match(reply, /参加.*培训/);
});

test("模型请求携带当前时间、真实时长和历史，且可切换服务", async () => {
  const { context, now } = app({ env: { AI_BASE_URL: "https://api.deepseek.com", AI_MODEL: "deepseek-flash", AI_API_KEY: "fake" } });
  let request;
  context.httpReq = async (url, method, headers, body) => {
    request = { url, data: JSON.parse(body) };
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "需要多久？" } }] }) };
  };
  await context.glmChat("帮我安排", [event(1, "会议", "2026-10-30T13:00:00+08:00", 120)], [{ role: "user", content: "明天写报告" }], now);
  assert.equal(request.url, "https://api.deepseek.com/chat/completions");
  assert.equal(request.data.model, "deepseek-flash");
  assert.equal(request.data.thinking.type, "disabled");
  assert.match(request.data.messages[0].content, /明天=2026-10-30/);
  assert.match(request.data.messages[0].content, /持续120分钟/);
  assert.equal(request.data.messages[1].content, "明天写报告");
});

test("模型401、非JSON、空回复及不完整配置不能伪装成功", async () => {
  for (const response of [{ status: 401, text: "invalid key" }, { status: 200, text: "bad" }, { status: 200, text: '{}' }]) {
    const { context } = app();
    context.httpReq = async () => response;
    await assert.rejects(() => context.glmChat("明天安排", []));
  }
  assert.throws(() => app({ env: { AI_MODEL: "custom-model" } }).context.aiConfig(), /配置不完整/);
});

test("追问后补时刻可完成记录，一次提交状态，用户历史隔离", async () => {
  const { context, writes } = app();
  let requestCount = 0;
  context.httpReq = async (url, method, headers, body) => {
    const data = JSON.parse(body);
    requestCount++;
    if (requestCount === 1) return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "明天几点开会？" } }] }) };
    if (requestCount === 2) {
      assert.match(data.messages[1].content, /明天开会/);
      return { status: 200, text: JSON.stringify({ choices: [{ message: intent("add_event", { title: "开会", date_text: "明天", time: "15:00" }) }] }) };
    }
    assert.equal(data.messages.length, 2);
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "请告诉我日期。" } }] }) };
  };
  const s = state();
  await context.routeMessage(xml("明天开会"), s);
  const reply = await context.routeMessage(xml("下午三点"), s);
  assert.match(reply, /已记录/);
  assert.equal(s.events[0].datetime, Date.parse("2026-10-30T15:00:00+08:00"));
  assert.equal(writes.length, 2);
  await context.routeMessage(xml("帮我记一件事", "user2"), s);
});

test("多工具操作或无工具宣称保存不能静默修改", async () => {
  const { context, writes } = app();
  const s = state();
  const message = intent("cancel_event", { target: "开会" });
  message.tool_calls.push(message.tool_calls[0]);
  assert.match(await context.executeIntent(message, s, "取消两个会"), /逐条发送/);
  assert.match(await context.executeIntent({ content: "已安排好明天的工作" }, s, "明天安排"), /没有修改/);
  assert.equal(writes.length, 0);
});

test("同一 MsgId 重试返回已保存回复，不重复调用模型或新建日程", async () => {
  const { context, writes } = app();
  let calls = 0;
  context.httpReq = async () => {
    calls++;
    return { status: 200, text: JSON.stringify({ choices: [{ message: intent("add_event", { title: "开会", date_text: "明天", time: "15:00" }) }] }) };
  };
  const s = state();
  const message = xml("明天下午三点开会").replace("</xml>", "<MsgId>123456</MsgId></xml>");
  const reply = await context.routeMessage(message, s);
  const reloaded = JSON.parse(JSON.stringify(writes[0]));
  assert.equal(await context.routeMessage(message, reloaded), reply);
  assert.equal(reloaded.events.length, 1);
  assert.equal(calls, 1);
  assert.equal(writes.length, 1);
});

test("跨日后今天明天按新消息时间换算，过期上下文不传入模型", async () => {
  const { context, now } = app({ now: "2027-01-01T00:01:00+08:00" });
  const s = state();
  const crypto = require("node:crypto");
  const key = crypto.createHash("sha256").update("user1").digest("hex");
  s.conversations = { [key]: { ts: now - 31 * 60e3, messages: [{ role: "user", content: "明天开会" }, { role: "assistant", content: "几点？" }] } };
  context.httpReq = async (url, method, headers, body) => {
    const data = JSON.parse(body);
    assert.equal(data.messages.length, 2);
    assert.match(data.messages[0].content, /今天=2027-01-01.*口语明天=2027-01-01/);
    return { status: 200, text: JSON.stringify({ choices: [{ message: intent("add_event", { title: "开会", date_text: "明天", time: "15:00" }) }] }) };
  };
  await context.routeMessage(xml("明天下午三点开会"), s);
  assert.equal(s.events[0].datetime, Date.parse("2027-01-01T15:00:00+08:00"));
});

test("用户明确明天时即使模型 date_text 也猜错，仍按原话换算", async () => {
  const { context } = app();
  const s = state();
  await context.executeIntent(intent("add_event", { title: "开会", date_text: "2023-01-01", time: "15:00" }), s, "明天下午三点开会");
  assert.equal(s.events[0].datetime, Date.parse("2026-10-30T15:00:00+08:00"));
  const nextYear = state();
  await context.executeIntent(intent("add_event", { title: "培训", date_text: "1月2日", time: "15:00" }), nextYear, "明年1月2日下午三点培训");
  assert.equal(nextYear.events[0].datetime, Date.parse("2027-01-02T15:00:00+08:00"));
});

test("默认请求DeepSeek且不再将智谱Key发给默认接口", async () => {
  const { context } = app();
  const config = context.aiConfig();
  assert.equal(config.url, "https://api.deepseek.com/chat/completions");
  assert.equal(config.model, "deepseek-flash");
  assert.equal(config.key, "offline-test-key");
  assert.throws(() => app({ env: { DEEPSEEK_API_KEY: "", GLM_API_KEY: "legacy-key" } }).context.aiConfig(), /DEEPSEEK_API_KEY/);
  let payload;
  context.httpReq = async (url, method, headers, body) => {
    assert.equal(url, config.url);
    assert.equal(headers.Authorization, "Bearer offline-test-key");
    payload = JSON.parse(body);
    return { status: 200, text: JSON.stringify({ choices: [{ message: { content: "几点？" } }] }) };
  };
  await context.glmChat("明天开会", []);
  assert.equal(payload.model, "deepseek-flash");
  assert.equal(payload.thinking.type, "disabled");
});

test("跨天列表按日期分组且每天从1编号，不展示历史全局ID", () => {
  const { context, now } = app();
  const s = state([event(9, "明天第二件", "2026-10-30T15:00:00+08:00"), event(8, "明天第一件", "2026-10-30T09:00:00+08:00"), event(15, "后天第一件", "2026-10-31T10:00:00+08:00")]);
  const reply = context.listEvents(s, "明天到后天的日程", {}, now);
  assert.match(reply, /10月30日.*\n1\. 09:00 明天第一件[^\n]*\n2\. 15:00 明天第二件/);
  assert.match(reply, /10月31日.*\n1\. 10:00 后天第一件/);
  assert.doesNotMatch(reply, /#8|#9|#15/);
  assert.deepEqual(s.events.map(e=>e.id), [9,8,15]);
});

test("取消明天第1项不误删内部ID1或其他日期第1项", async () => {
  const { context } = app();
  const s = state([event(1, "今天的会", "2026-10-29T14:00:00+08:00"), event(8, "明天的会", "2026-10-30T09:00:00+08:00"), event(9, "明天的报告", "2026-10-30T15:00:00+08:00")]);
  const reply = await context.executeIntent(intent("cancel_event", { event_id:1,target:"会" }), s, "取消明天第一项");
  assert.match(reply, /已取消【明天的会】/);
  assert.equal(s.events[0].status,"active");
  assert.equal(s.events[1].status,"cancelled");
});

test("原日期第2项改到新日期时按原日期选中事项", async () => {
  const { context } = app();
  const s = state([event(8,"早会","2026-10-30T09:00:00+08:00"),event(9,"报告","2026-10-30T15:00:00+08:00")]);
  await context.executeIntent(intent("reschedule_event",{target:"报告",event_id:8,date_text:"后天",time:"16:00"}),s,"明天第2项改到后天下午四点");
  assert.equal(s.events[0].datetime,Date.parse("2026-10-30T09:00:00+08:00"));
  assert.equal(s.events[1].datetime,Date.parse("2026-10-31T16:00:00+08:00"));
});

test("没说日期或序号越界时追问，不根据模型猜测的内部ID执行", async () => {
  const { context,writes } = app();
  const s = state([event(1,"会议","2026-10-30T09:00:00+08:00")]);
  assert.match(await context.executeIntent(intent("cancel_event",{event_id:1,target:"会议"}),s,"取消第一项"),/哪天/);
  assert.match(await context.executeIntent(intent("cancel_event",{event_id:1,target:"会议",source_date_text:"明天",daily_number:1}),s,"取消第一项"),/哪天/);
  assert.match(await context.executeIntent(intent("cancel_event",{event_id:1,target:"会议"}),s,"取消明天第九项"),/没有第9项/);
  assert.equal(s.events[0].status,"active");
  assert.equal(writes.length,0);
});

test("凌晨4点作息分界覆盖零点、月末、年末及04点边界", () => {
  const {context}=app();
  for(const [now,text,expected] of [
    ["2026-10-31T00:00:00+08:00","明天早上","2026-10-31"],
    ["2026-10-31T01:00:00+08:00","明天","2026-10-31"],
    ["2026-10-31T03:59:59+08:00","后天","2026-11-01"],
    ["2026-10-31T04:00:00+08:00","明天","2026-11-01"],
    ["2026-12-31T01:00:00+08:00","后天","2027-01-01"],
    ["2027-01-01T01:00:00+08:00","明天","2027-01-01"],
    ["2027-01-01T01:00:00+08:00","今天下午开了个会","2026-12-31"],
    ["2027-01-01T01:00:00+08:00","今天下午有什么安排","2027-01-01"],
    ["2027-01-01T01:00:00+08:00","今天凌晨做了什么","2027-01-01"],
    ["2026-10-31T01:00:00+08:00","按自然日明天","2026-11-01"],
    ["2026-10-31T01:00:00+08:00","明天，也就是11月1日","2026-11-01"],
    ["2026-10-31T01:00:00+08:00","2027年1月2日","2027-01-02"],
  ]) assert.equal(context.dayKey(context.resolveDay(text,Date.parse(now))),expected,text+' '+now);
});

test("凌晨明天早上八点落到即将到来的早上，不采用模型猜测的次日", async () => {
  const {context}=app({now:"2026-10-31T01:00:00+08:00"});
  const s=state();
  await context.executeIntent(intent("add_event",{title:"起床",date_text:"明天早上",time:"08:00",datetime:"2026-11-01T08:00:00+08:00"}),s,"明天早上八点起床");
  assert.equal(s.events[0].datetime,Date.parse("2026-10-31T08:00:00+08:00"));
});

test("凌晨日记今天保留过去时上下文，未来今天查询不前移", async () => {
  const {context}=app({now:"2026-10-31T01:00:00+08:00"});
  const s=state();
  await context.executeIntent(intent("add_journal",{text:"今天下午开了个会",date_text:"今天",date:"2026-10-31"}),s,"今天下午开了个会");
  assert.equal(s.journals[0].date,"2026-10-30");
  const recap=await context.executeIntent(intent("query_journal",{date_text:"今天",from:"2026-10-31"}),s,"今天下午做了什么");
  assert.match(recap,/开了个会/);
  assert.equal(context.dayKey(context.resolveRange("今天下午有什么安排",Date.parse("2026-10-31T01:00:00+08:00")).from),"2026-10-31");
});

test("凌晨查询明天显示具体日期并提示作息分界，原日程不迁移", async () => {
  const {context}=app({now:"2026-10-31T01:00:00+08:00",env:{DEEPSEEK_API_KEY:""}});
  const s=state([event(8,"起床","2026-10-31T08:00:00+08:00"),event(9,"次日会议","2026-11-01T14:00:00+08:00")]);
  const reply=await context.routeMessage(xml("明天有什么事"),s);
  assert.match(reply,/10月31日/);
  assert.match(reply,/起床/);
  assert.doesNotMatch(reply,/次日会议/);
  assert.match(reply,/04:00/);
  assert.equal(s.events[1].datetime,Date.parse("2026-11-01T14:00:00+08:00"));
});

test("通知业务错误不能当作成功，未配置通道明确跳过", async () => {
  const { context } = app({ env: { BARK_KEY: "test", WXPUSHER_TOKEN: "test", WXPUSHER_UID: "test" } });
  context.httpReq = async () => ({ status: 200, text: '{"code":400}' });
  assert.equal((await context.sendBark("t", "b", true)).ok, false);
  assert.equal((await context.sendWxPusher("t", "b")).ok, false);
  assert.equal((await app().context.sendBark("t", "b")).configured, false);
});

async function reminderTick(saved, now, results) {
  const instance = app({ body: JSON.stringify(saved), now });
  const calls = [];
  instance.context.pushAll = async (title, body, strong, channels) => {
    calls.push({ title, body, channels: [...channels] });
    return Object.fromEntries(channels.map((ch) => [ch, results[ch]]));
  };
  await instance.context.checkDue();
  return { saved: instance.writes.at(-1) || saved, calls, context: instance.context };
}
const accepted = { configured: true, ok: true };
const rejected = { configured: true, ok: false };
function reminderFixture(level = "call") {
  const ev = event(1, "会议", "2026-10-29T11:00:00+08:00");
  ev.level = level;
  ev.notify_at = Date.parse("2026-10-29T10:00:00+08:00");
  ev.fallback_at = Date.parse("2026-10-29T10:55:00+08:00");
  return state([ev]);
}

test("各通道独立重试，成功通道不重复发送，失败最多三次", async () => {
  let saved = reminderFixture("sms");
  for (const time of ["10:00", "10:01", "10:03", "10:04"]) {
    const r = await reminderTick(saved, `2026-10-29T${time}:00+08:00`, { wecom: accepted, bark: accepted, wxpusher: rejected });
    if (time === "10:01" || time === "10:03") assert.deepEqual(r.calls[0].channels, ["wxpusher"]);
    if (time === "10:04") assert.equal(r.calls.length, 0);
    saved = r.saved;
  }
  assert.equal(saved.events[0].reminder.rounds.main.channels.wxpusher.attempts, 3);
  assert.equal(saved.events[0].reminder.rounds.main.channels.wxpusher.status, "failed");
  assert.ok(saved.notified["1|main"]);
  const allFailed = await reminderTick(reminderFixture(), "2026-10-29T10:00:00+08:00", { wecom: rejected, bark: rejected, wxpusher: rejected });
  assert.equal(allFailed.saved.notified["1|main"], undefined);
});

test("强提醒只补催两轮，确认后停止且保留日程", async () => {
  let saved = reminderFixture();
  for (const time of ["10:00", "10:02", "10:05", "10:06"]) {
    const r = await reminderTick(saved, `2026-10-29T${time}:00+08:00`, { wecom: accepted, bark: accepted, wxpusher: accepted });
    assert.equal(r.calls.length, time === "10:06" ? 0 : 1);
    saved = r.saved;
  }
  const { context } = app();
  assert.match(context.reminderCommands("收到", saved, "owner", Date.now()), /已确认/);
  assert.equal(saved.events[0].status, "active");
  const r = await reminderTick(saved, "2026-10-29T10:55:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 0);
});

test("推迟期间停止推送，到时只重发一轮，改期后旧码失效", async () => {
  let r = await reminderTick(reminderFixture(), "2026-10-29T10:00:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  const ev = r.saved.events[0], original = ev.datetime;
  const now = Date.parse("2026-10-29T10:00:00+08:00");
  assert.match(r.context.reminderCommands("推迟10分钟", r.saved, "owner", now), /再提醒/);
  r = await reminderTick(r.saved, "2026-10-29T10:05:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 0);
  r = await reminderTick(r.saved, "2026-10-29T10:10:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 1);
  assert.equal(r.saved.events[0].datetime, original);
  r = await reminderTick(r.saved, "2026-10-29T10:15:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 0);
  r.saved.events[0].datetime += 3600e3;
  assert.match(r.context.reminderCommands("收到", r.saved, "owner", now), /没有找到/);
});

test("确认最新提醒，指定码和归属隔离，确认路由无需模型", async () => {
  let r = await reminderTick(reminderFixture(), "2026-10-29T10:00:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  const second = JSON.parse(JSON.stringify(r.saved.events[0]));
  second.id = 2; second.reminder.code = "R2-ABCDEF";
  r.saved.events.push(second);
  assert.match(r.context.reminderCommands("收到", r.saved, "owner", Date.now()), /已确认/);
  delete second.reminder.ack_at;
  assert.match(await r.context.routeMessage(xml("收到 R2-ABCDEF"), r.saved), /已确认/);
  r.saved.events[0].owner_key = "another";
  assert.match(r.context.reminderCommands("收到", r.saved, "owner", Date.now()), /没有找到/);
});

test("错过一分钟窗口仍补发，过期和取消不发送", async () => {
  const saved = reminderFixture("sms");
  saved.notified["1|main"] = 1;
  let r = await reminderTick(saved, "2026-10-29T10:58:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 1);
  r = await reminderTick(reminderFixture(), "2026-10-29T13:01:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 0);
  assert.equal(r.saved.events[0].status, "expired");
  const cancelled = reminderFixture(); cancelled.events[0].status = "cancelled";
  r = await reminderTick(cancelled, "2026-10-29T10:00:00+08:00", { wecom: accepted, bark: accepted, wxpusher: accepted });
  assert.equal(r.calls.length, 0);
});



test("企业微信缓存token、发送到本人并校验接收人错误", async () => {
  const { context } = app({ env: { WECOM_CORP_ID: "corp", WECOM_APP_SECRET: "secret", WECOM_AGENT_ID: "1000002", WECOM_TO_USER: "member" } });
  const requests = [];
  context.httpReq = async (url, method, headers, body) => {
    requests.push({ url, body });
    return { status: 200, text: JSON.stringify(url.includes("gettoken") ? { errcode: 0, access_token: "mock-token", expires_in: 7200 } : { errcode: 0 }) };
  };
  assert.equal((await context.sendWecom("提醒", "内容")).ok, true);
  assert.equal((await context.sendWecom("提醒", "内容", "creator")).ok, true);
  assert.equal(requests.filter((r) => r.url.includes("gettoken")).length, 1);
  assert.equal(JSON.parse(requests[1].body).touser, "member");
  assert.equal(JSON.parse(requests[2].body).touser, "creator");
  assert.equal(JSON.parse(requests[1].body).agentid, 1000002);
  context.httpReq = async () => ({ status: 200, text: '{"errcode":0,"invaliduser":"member"}' });
  assert.equal((await context.sendWecom("提醒", "内容")).ok, false);
  assert.equal((await context.sendWecom("提醒", "内容", "@all")).configured, false);
});

test("企业微信token失效仅刷新一次，错误响应不能伪装成功", async () => {
  const env = { WECOM_CORP_ID: "corp", WECOM_APP_SECRET: "secret", WECOM_AGENT_ID: "1", WECOM_TO_USER: "member" };
  const { context } = app({ env });
  let tokens = 0, sends = 0;
  context.httpReq = async (url) => ({ status: 200, text: JSON.stringify(url.includes("gettoken") ?
    { errcode: 0, access_token: "token" + (++tokens), expires_in: 7200 } : { errcode: ++sends === 1 ? 42001 : 0 }) });
  assert.equal((await context.sendWecom("t", "b")).ok, true);
  assert.equal(tokens, 2); assert.equal(sends, 2);
  context.httpReq = async () => ({ status: 200, text: "not json" });
  assert.equal((await context.sendWecom("t", "b")).ok, false);
  assert.equal((await app().context.sendWecom("t", "b")).configured, false);
});

test("短信级优先企业微信，电话级加Bark，企业微信失败才走WxPusher", async () => {
  const { context } = app();
  const sent = [];
  context.sendWecom = async () => { sent.push("wecom"); return accepted; };
  context.sendBark = async () => { sent.push("bark"); return accepted; };
  context.sendWxPusher = async () => { sent.push("wxpusher"); return accepted; };
  await context.pushAll("t", "b", false);
  assert.deepEqual(sent.splice(0), ["wecom"]);
  await context.pushAll("t", "b", true);
  assert.deepEqual(sent.splice(0), ["wecom", "bark"]);
  context.sendWecom = async () => { sent.push("wecom"); return rejected; };
  await context.pushAll("t", "b", false);
  assert.deepEqual(sent, ["wecom", "wxpusher"]);
});

test("企业微信失败只保留脱敏错误码，状态查询可定位错误", async () => {
  const { context } = app();
  context.sendWecom = async () => { throw new Error("wecom_token_failed_60020"); };
  const result = await context.pushAll("t", "b", false, ["wecom"]);
  assert.equal(result.wecom.code, 60020);
  const r = await reminderTick(reminderFixture("sms"), "2026-10-29T10:00:00+08:00", { wecom: { configured: true, ok: false, code: 60020 }, wxpusher: accepted });
  assert.match(r.context.reminderCommands("提醒状态", r.saved, "owner", Date.now()), /wecom=pending\(错误码60020\)/);
  context.sendWecom = async () => { throw new Error("https://example.invalid?secret=private"); };
  const safe = await context.pushAll("t", "b", false, ["wecom"]);
  assert.equal(JSON.stringify(safe).includes("private"), false);
});


test("短信受理后五分钟未确认升级一次强提醒，已确认不升级", async () => {
  let r=await reminderTick(reminderFixture("sms"),"2026-10-29T10:00:00+08:00",{wecom:accepted,wxpusher:accepted,bark:accepted});
  r=await reminderTick(r.saved,"2026-10-29T10:04:00+08:00",{wecom:accepted,wxpusher:accepted,bark:accepted});
  assert.equal(r.calls.length,0);
  const before=JSON.parse(JSON.stringify(r.saved));
  r=await reminderTick(r.saved,"2026-10-29T10:05:00+08:00",{wecom:accepted,wxpusher:accepted,bark:accepted});
  assert.equal(r.calls.length,1); assert.ok(r.calls[0].channels.includes("bark"));
  r=await reminderTick(r.saved,"2026-10-29T10:10:00+08:00",{wecom:accepted,wxpusher:accepted,bark:accepted});
  assert.equal(r.calls.length,0);
  r.context.reminderCommands("1",before,"owner",Date.now());
  r=await reminderTick(before,"2026-10-29T10:05:00+08:00",{wecom:accepted,wxpusher:accepted,bark:accepted});
  assert.equal(r.calls.length,0);
});

test("简化确认仅确认最新项，全部收到确认其余，不冒充完成", async () => {
  const r=await reminderTick(reminderFixture(),"2026-10-29T10:00:00+08:00",{wecom:accepted,bark:accepted,wxpusher:accepted});
  const e=JSON.parse(JSON.stringify(r.saved.events[0]));e.id=2;e.reminder.code="R2-ABCDEF";e.reminder.created_at++;
  r.saved.events.push(e);
  assert.match(r.context.reminderCommands("1",r.saved,"owner",Date.now()),/已确认/);
  assert.ok(e.reminder.ack_at);assert.equal(r.saved.events[0].reminder.ack_at,undefined);
  assert.equal(e.completed_at,undefined);
  assert.match(r.context.reminderCommands("全部收到",r.saved,"owner",Date.now()),/1项/);
});

test("倒数日按自然日跨年计数，无效日期拒绝，支持删除和无模型查询", async () => {
  const {context}=app({now:"2026-12-31T23:00:00+08:00"});const s=state();
  assert.match(await context.routeMessage(xml("倒数日 考试 2027-01-02"),s),/还有2天/);
  assert.match(await context.routeMessage(xml("倒数日"),s),/考试/);
  assert.match(context.addCountdown(s,"错误","2027-02-30",Date.parse("2026-12-31T00:00:00+08:00")),/有效日期/);
  assert.equal(s.countdowns.length,1);
  assert.match(await context.routeMessage(xml("删除倒数日 考试"),s),/已删除/);
  assert.equal(s.countdowns.length,0);
});

test("晚报不把过时当完成，按今天序号完成，明日确认随安排变化失效", async () => {
  const {context,now}=app({now:"2026-12-31T20:30:00+08:00"});
  const s=state([event(1,"上午事项","2026-12-31T09:00:00+08:00"),event(2,"明年会议","2027-01-01T10:00:00+08:00")]);
  s.events[0].status="expired";
  let text=context.dayReport(s,now,true,"owner");assert.match(text,/待确认完成/);assert.match(text,/明年会议/);assert.doesNotMatch(text,/✅已完成/);
  assert.match(context.dailyCommands("完成 1",s,"owner",now),/已标记完成/);
  assert.match(context.dayReport(s,now,true,"owner"),/✅已完成/);
  context.dailyCommands("确认明天",s,"owner",now);
  assert.match(context.dayReport(s,now,true,"owner"),/明日当前安排已确认/);
  s.events[1].datetime+=3600e3;
  assert.match(context.dayReport(s,now,true,"owner"),/回复『确认明天』/);
});

test("晨晚报北京时间08点与20点半触发，重复扫描与原触发器去重，失败有限重试", async () => {
  const {context}=app();const s=state();let calls=0;
  context.pushAll=async()=>{calls++;return {wecom:accepted};};
  const ts=t=>Date.parse("2026-10-29T"+t+":00+08:00");
  await context.sendDailyReports(s,ts("07:59"));assert.equal(calls,0);
  await context.sendDailyReports(s,ts("08:00"));await context.sendDailyReports(s,ts("08:01"),"morning");assert.equal(calls,1);
  await context.sendDailyReports(s,ts("20:29"));assert.equal(calls,1);
  await context.sendDailyReports(s,ts("20:30"));await context.sendDailyReports(s,ts("20:31"));assert.equal(calls,2);
  const failed=state();context.pushAll=async()=>{calls++;return {wecom:rejected};};
  for(const t of ["08:00","08:01","08:02","08:03"]) await context.sendDailyReports(failed,ts(t));
  assert.equal(calls,5);
});

test("短信全失败也在五分钟兜底升级，完成短句保留标题中的项字", async () => {
  let saved=reminderFixture("sms"), r;
  for(const t of ["10:00","10:01","10:03","10:05"]) {r=await reminderTick(saved,`2026-10-29T${t}:00+08:00`,{wecom:rejected,wxpusher:rejected,bark:accepted});saved=r.saved;}
  assert.ok(r.calls[0].channels.includes("bark"));
  const s=state([event(1,"项目立项","2026-10-29T09:00:00+08:00")]);
  assert.match(r.context.dailyCommands("已完成项目立项",s,"owner",Date.parse("2026-10-29T10:00:00+08:00")),/已标记完成/);
});
