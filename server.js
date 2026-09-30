import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);

// ---------- 人员：化验员只能确认分派给自己的样品；放行由另一名负责人完成 ----------
const users = {
  "周化验": { role: "化验员" },
  "吴化验": { role: "化验员" },
  "林素": { role: "负责人" },
  "郑渠": { role: "负责人" }
};
export const roles = users;

// ---------- 种子数据（新库）/ 迁移（旧库：无池号、无排水量的数据原样保留） ----------
function seedDb() {
  return {
    version: 2,
    users,
    tanks: [
      {
        code: "T1",
        name: "一号沉淀池",
        capacity: 50,
        createdAt: "2026-06-15T08:00:00.000Z"
      },
      {
        code: "T2",
        name: "二号沉淀池",
        capacity: 30,
        createdAt: "2026-06-15T08:00:00.000Z"
      }
    ],
    tickets: [
      {
        ticketNo: "现场-20200615-01",
        batchCode: "PF-001",
        tankCode: "T1",
        drainVolume: 12,
        submittedBy: "林素",
        status: "待化验",
        createdAt: "2026-06-15T09:10:00.000Z",
        events: [
          { at: "2026-06-15T09:10:00.000Z", type: "进水登记", by: "林素", note: "泡料水换排后进沉淀池，清洁度待化验" }
        ]
      }
    ],
    pendingTickets: [],
    items: [
      {
        code: "PF-001",
        source: "构树皮",
        vat: "三号缸",
        days: 5,
        owner: "林素",
        status: "发酵中",
        logs: [
          { at: "2026-06-15", step: "观察", note: "温度24.6，气味微酸，纤维开始松散", abnormal: false }
        ]
      }
    ]
  };
}

// 旧库升级：没有池号、排水量字段的历史数据一律原样保留，只补结构
function migrate(raw) {
  const db = raw && typeof raw === "object" ? raw : {};
  db.items ||= [];
  db.tanks ||= [];
  db.tickets ||= [];
  db.pendingTickets ||= [];
  db.users ||= users;
  // 历史批次：无沉淀池/排水量信息，标记 legacy 供界面提示，但状态与统计照常参与
  for (const item of db.items) {
    if (item.legacy === undefined) item.legacy = !item.tankCode && !item.ticketNo;
  }
  // 历史水单（若有缺字段的旧结构）：不回填、不臆造池号与排水量
  for (const t of db.tickets) {
    if (t.legacy === undefined) t.legacy = !t.tankCode || !t.drainVolume;
    t.events ||= [];
  }
  db.version = 2;
  return db;
}

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    const seeded = migrate(seedDb());
    await writeFile(dbPath, JSON.stringify(seeded, null, 2));
    return seeded;
  }
  return migrate(JSON.parse(await readFile(dbPath, "utf8")));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function nowIso() { return new Date().toISOString(); }
function newId(prefix) { return prefix + "-" + Date.now(); }
class HttpError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

// ---------- 容量核算：非"已放行/已排放"水单都占用沉淀池余量（含待补记，保守计入） ----------
const OCCUPYING = new Set(["草稿", "待化验", "待放行"]);
function tankUsed(db, tankCode) {
  let used = 0;
  for (const t of db.tickets) {
    if (t.tankCode === tankCode && OCCUPYING.has(t.status)) used += Number(t.drainVolume || 0);
  }
  for (const p of db.pendingTickets) {
    if (p.payload && p.payload.tankCode === tankCode) used += Number(p.payload.drainVolume || 0);
  }
  return used;
}
function decorateTank(db, tank) {
  const used = tankUsed(db, tank.code);
  return { ...tank, used, remaining: Number(tank.capacity) - used };
}
function ticketChain(db, t) {
  return {
    ...t,
    tank: db.tanks.find(x => x.code === t.tankCode) || null,
    batch: db.items.find(x => x.code === t.batchCode) || null
  };
}

const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = [...stages];
const cleanlinessOptions = ["合格", "不合格"];

function computeStats(db) {
  const batchStats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of db.items) {
    if (batchStats[item.status] !== undefined) batchStats[item.status] += 1;
  }
  const ticketStats = { 草稿: 0, 待化验: 0, 待放行: 0, 已放行: 0, 已排放: 0 };
  for (const t of db.tickets) ticketStats[t.status] = (ticketStats[t.status] || 0) + 1;
  return {
    batches: batchStats,
    tickets: ticketStats,
    tanks: db.tanks.length,
    pending: db.pendingTickets.length,
    legacyBatches: db.items.filter(i => i.legacy).length,
    legacyTickets: db.tickets.filter(t => t.legacy).length
  };
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}

// ---------- 水单业务 ----------
function findTicket(db, ticketNo) {
  return db.tickets.find(t => t.ticketNo === ticketNo);
}
function requireUser(name, extraRole) {
  const u = users[name];
  if (!u) throw new HttpError(400, "unknown_operator", "未知操作人：" + name);
  if (extraRole && u.role !== extraRole) {
    throw new HttpError(403, "forbidden_role", "该操作要求" + extraRole);
  }
  return u;
}

// 建立/合并水单（进水登记；可与复用确认同时提交）
// 同池同单号：只保留一份，确认信息合并进同一条，不重复扣容量
function applyTicket(db, input) {
  const ticketNo = String(input.ticketNo || "").trim();
  const tankCode = String(input.tankCode || "").trim();
  const batchCode = String(input.batchCode || "").trim();
  const submittedBy = String(input.submittedBy || "").trim();
  if (!ticketNo) throw new HttpError(400, "ticket_no_required", "现场单号必填");
  if (!tankCode) throw new HttpError(400, "tank_required", "沉淀池必填");
  if (!batchCode) throw new HttpError(400, "batch_required", "批次必填");
  if (!submittedBy) throw new HttpError(400, "operator_required", "登记人必填");
  requireUser(submittedBy);
  const tank = db.tanks.find(x => x.code === tankCode);
  if (!tank) throw new HttpError(404, "tank_not_found", "沉淀池不存在：" + tankCode);
  if (!db.items.find(x => x.code === batchCode)) throw new HttpError(404, "batch_not_found", "批次不存在：" + batchCode);
  const drainVolume = num(input.drainVolume);
  if (!Number.isFinite(drainVolume) || drainVolume <= 0) throw new HttpError(400, "drain_volume_required", "实际排水量必须为正数");

  const existing = findTicket(db, ticketNo);
  if (existing) {
    if (existing.tankCode !== tankCode) throw new HttpError(409, "ticket_tank_mismatch", "同一现场单号不能改挂其他沉淀池");
    if (existing.batchCode !== batchCode) throw new HttpError(409, "ticket_batch_mismatch", "同一现场单号不能改挂其他批次");
    if (Number(existing.drainVolume) !== drainVolume) throw new HttpError(409, "ticket_volume_mismatch", "重复提交排水量不一致");
    // 已存在：保留原记录，仅在附带确认时合并确认，容量不重复扣减
    if (input.sample) {
      mergeSample(db, existing, input.sample, true);
    } else {
      existing.events.push({ at: nowIso(), type: "重复提交", by: submittedBy, note: "同池同单号的重复进水登记，已忽略，只保留一份" });
    }
    return { ticket: existing, duplicated: true };
  }

  // 容量校验：按实际排水量扣减，超过余量直接拒绝，不写任何记录
  const remaining = Number(tank.capacity) - tankUsed(db, tankCode);
  if (drainVolume > remaining) {
    throw new HttpError(409, "tank_capacity_exceeded",
      `沉淀池 ${tankCode} 余量不足：需排入 ${drainVolume}，剩余 ${remaining}`);
  }

  const ticket = {
    ticketNo,
    batchCode,
    tankCode,
    drainVolume,
    submittedBy,
    cleanliness: null,
    sampleResult: null,
    sampleAssignee: null,
    confirmedBy: null,
    confirmedAt: null,
    releasedBy: null,
    releasedAt: null,
    status: "待化验",
    createdAt: nowIso(),
    events: [{ at: nowIso(), type: "进水登记", by: submittedBy, note: `实际排水 ${drainVolume} 排入沉淀池 ${tankCode}` }]
  };
  db.tickets.unshift(ticket);

  const batch = db.items.find(x => x.code === batchCode);
  batch.logs ||= [];
  batch.logs.push({ at: nowIso(), step: "换水", note: `排水 ${drainVolume} 至 ${tankCode}，回用水单 ${ticketNo}` });

  if (input.sample) mergeSample(db, ticket, input.sample, false);
  return { ticket, duplicated: false };
}

// 化验确认（独立提交）：化验员只能确认分派给自己的样品
function confirmSample(db, input) {
  const ticketNo = String(input.ticketNo || "").trim();
  const analyst = String(input.analyst || "").trim();
  const ticket = findTicket(db, ticketNo);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "回用水单不存在：" + ticketNo);
  requireUser(analyst, "化验员");
  mergeSample(db, ticket, {
    assignee: input.assignee || analyst,
    result: input.result,
    cleanliness: input.cleanliness,
    note: input.note
  }, false, analyst);
  return ticket;
}

// 合并化验确认；allowSame=true 用于"进水+确认同时提交"合并到已存在水单
function mergeSample(db, ticket, sample, allowSame, forceAnalyst) {
  const assignee = String((sample.assignee ?? "") || forceAnalyst || "").trim();
  const analyst = String(forceAnalyst || sample.confirmedBy || assignee).trim();
  const result = sample.result;
  const cleanliness = sample.cleanliness;
  if (!analyst) throw new HttpError(400, "analyst_required", "化验员必填");
  const u = users[analyst];
  if (!u || u.role !== "化验员") throw new HttpError(403, "forbidden_role", "只有化验员可以确认样品");

  // 首次确认：样品必须已分派，且只能确认分派给自己的样品；越权直接拒绝
  if (!ticket.sampleAssignee) {
    if (!assignee) throw new HttpError(400, "sample_not_assigned", "样品尚未分派，无法确认");
    if (assignee !== analyst) throw new HttpError(403, "sample_forbidden", "越权确认：该样品分派给 " + assignee);
  } else if (ticket.sampleAssignee !== analyst) {
    throw new HttpError(403, "sample_forbidden", "越权确认：该样品分派给 " + ticket.sampleAssignee);
  }
  if (ticket.confirmedBy && ticket.confirmedBy !== analyst && !allowSame) {
    throw new HttpError(409, "sample_already_confirmed", "样品已由 " + ticket.confirmedBy + " 确认");
  }
  if (ticket.confirmedBy && allowSame) {
    ticket.events.push({ at: nowIso(), type: "重复确认", by: analyst, note: "同一单的复用确认已存在，只保留一份" });
    return ticket;
  }
  if (ticket.status === "已放行" || ticket.status === "已排放") {
    throw new HttpError(409, "ticket_locked", "水单已放行，不能再改化验结果");
  }

  ticket.sampleAssignee = ticket.sampleAssignee || assignee;
  ticket.sampleResult = result || ticket.sampleResult;
  ticket.cleanliness = cleanliness || ticket.cleanliness;
  ticket.confirmedBy = analyst;
  ticket.confirmedAt = nowIso();
  ticket.status = cleanliness === "不合格" ? "待化验" : "待放行";
  ticket.events.push({
    at: nowIso(),
    type: "化验确认",
    by: analyst,
    note: `清洁度 ${cleanliness || result}${sample.note ? "；" + sample.note : ""}`
  });
  return ticket;
}

// 复用放行：另一名负责人完成，且清洁度合格
function releaseTicket(db, input) {
  const ticketNo = String(input.ticketNo || "").trim();
  const releaser = String(input.releaser || "").trim();
  const ticket = findTicket(db, ticketNo);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "回用水单不存在：" + ticketNo);
  requireUser(releaser, "负责人");
  if (!ticket.confirmedBy) throw new HttpError(409, "sample_not_confirmed", "样品尚未化验确认，不能放行");
  if (ticket.cleanliness === "不合格") throw new HttpError(409, "cleanliness_failed", "清洁度不合格，禁止复用放行");
  // 职责分离：放行必须由另一名负责人完成（不能是登记人本人，也不能是化验员）
  if (ticket.submittedBy === releaser) {
    throw new HttpError(403, "release_separation_required", "复用放行必须由另一名负责人完成，登记人不能自行放行");
  }
  if (ticket.status === "已放行" || ticket.status === "已排放") {
    throw new HttpError(409, "ticket_locked", "水单已放行");
  }
  ticket.releasedBy = releaser;
  ticket.releasedAt = nowIso();
  ticket.status = "已放行";
  ticket.events.push({ at: nowIso(), type: "复用放行", by: releaser, note: "清洁度合格，准予回用" });

  const batch = db.items.find(x => x.code === ticket.batchCode);
  if (batch) {
    batch.logs ||= [];
    batch.logs.push({ at: nowIso(), step: "回用", note: `回用水单 ${ticketNo} 由 ${releaser} 放行复用` });
  }
  return ticket;
}

// 用毕登记终态（容量在放行复用时已释放）
function dischargeTicket(db, input) {
  const ticketNo = String(input.ticketNo || "").trim();
  const operator = String(input.operator || "").trim();
  const ticket = findTicket(db, ticketNo);
  if (!ticket) throw new HttpError(404, "ticket_not_found", "回用水单不存在：" + ticketNo);
  requireUser(operator);
  if (ticket.status !== "已放行") throw new HttpError(409, "not_released", "只有已放行的水单可以登记排放");
  ticket.status = "已排放";
  ticket.events.push({ at: nowIso(), type: "排放离池", by: operator, note: "回用水用毕排放，登记终态" });
  return ticket;
}

// ---------- 待补记（outbox）：写入失败保留水单，恢复后按同一现场单号补记 ----------
function pendingRecord(db, payload, { simulateFailure = false } = {}) {
  const pending = db.pendingTickets.find(p => p.payload.ticketNo === payload.ticketNo);
  if (pending) {
    pending.attempts += 1;
    pending.lastError = "重复提交，沿用同一现场单号";
    return { pending, duplicated: true };
  }
  const rec = {
    id: newId("PEND"),
    payload,
    createdAt: nowIso(),
    attempts: 0,
    lastError: simulateFailure ? "模拟写入失败" : null
  };
  db.pendingTickets.push(rec);
  return { pending: rec, duplicated: false };
}
async function recoverPending(db) {
  const recovered = [];
  const failed = [];
  // 先进先出，逐条重新落主记录；成功一条删一条
  while (db.pendingTickets.length) {
    const rec = db.pendingTickets[0];
    try {
      const { ticket, duplicated } = applyTicket(db, rec.payload);
      rec.attempts += 1;
      db.pendingTickets.shift();
      recovered.push({ ticketNo: rec.payload.ticketNo, duplicated, ticket });
    } catch (e) {
      rec.attempts += 1;
      rec.lastError = e.code || e.message;
      failed.push({ ticketNo: rec.payload.ticketNo, error: e.code, message: e.message });
      break; // 头部都处理不了，先保留剩余水单等下次恢复
    }
  }
  return { recovered, failed };
}

// 同一沉淀池的提交串行化：复用确认与进水同时到达时，只保留一份
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

// ---------- 页面 ----------
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>泡料水回用记录链</title>
  <style>
    :root { --bg:#eef2ec; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --hold:#8a6d1d; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:20px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:23px; } h2 { margin:0 0 12px; font-size:17px; } h3 { margin:0; font-size:15px; }
    main { padding:20px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:15px; }
    label { display:block; margin:9px 0 4px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:8px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:9px 12px; font-weight:700; cursor:pointer; margin-top:12px; } button.secondary { background:#69736a; } button.warn { background:var(--warn); }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:22px; }
    .layout { display:grid; grid-template-columns:390px 1fr; gap:18px; align-items:start; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; }
    .card { display:grid; gap:6px; }
    .meta { color:var(--muted); font-size:12px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:2px 8px; font-size:12px; }
    .pill.ok { background:#e7f0e1; } .pill.bad { background:#f6e3de; } .pill.hold { background:#f6efdd; }
    .logs { border-top:1px solid var(--line); padding-top:7px; max-height:110px; overflow:auto; font-size:12px; }
    .warn-text { color:var(--warn); font-weight:700; } .hold-text { color:var(--hold); font-weight:700; }
    .tabs { display:flex; gap:8px; margin-bottom:14px; } .tabs button { margin:0; background:#d9e0d4; color:var(--ink); } .tabs button.active { background:var(--accent); color:#fff; }
    .row { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .banner { border:1px solid var(--hold); background:#f6efdd; color:#5f4d14; padding:9px 12px; border-radius:6px; margin-bottom:12px; font-size:13px; }
    .bar { height:8px; background:#e4e9e0; border-radius:99px; overflow:hidden; } .bar i { display:block; height:100%; background:var(--accent); }
    .inline { display:flex; gap:8px; align-items:end; flex-wrap:wrap; } .inline > div { flex:1; min-width:120px; }
    @media (max-width:960px){ .layout{grid-template-columns:1fr} header{display:block;padding:16px} main{padding:14px} }
  </style>
</head>
<body>
  <header>
    <div><h1>泡料水回用记录链</h1><div class="meta">批次换水 · 沉淀池余量 · 回用水单 · 化验确认 · 复用放行（旧数据无池号/排水量仍可查可统计）</div></div>
    <button id="reload" class="secondary">刷新</button>
  </header>
  <main>
    <div class="tabs">
      <button data-tab="water" class="active">泡料水回用</button>
      <button data-tab="batch">发酵批次</button>
    </div>

    <section id="tab-water">
      <div class="stats" id="stats"></div>
      <div class="layout">
        <div>
          <form id="ticketForm" class="panel">
            <h2>换水登记（生成回用水单）</h2>
            <div class="row">
              <div><label>现场单号（沿用同一单号补记）</label><input name="ticketNo" placeholder="留空自动生成"></div>
              <div><label>批次</label><select name="batchCode" id="batchSelect"></select></div>
            </div>
            <div class="row">
              <div><label>沉淀池</label><select name="tankCode" id="tankSelect"></select></div>
              <div><label>实际排水量（吨）</label><input name="drainVolume" type="number" min="0" step="0.1" required></div>
            </div>
            <label>登记人（现场负责人）</label><select name="submittedBy" id="submitSelect"></select>
            <label style="margin-top:12px;font-weight:700;">进水与化验确认同时提交（同一沉淀池只保留一份）</label>
            <div class="row">
              <div><label>样品化验员</label><select name="analyst"><option value="">不附带化验</option><option>周化验</option><option>吴化验</option></select></div>
              <div><label>样品分派给</label><select name="assignee"><option value="">（默认化验员本人）</option><option>周化验</option><option>吴化验</option></select></div>
            </div>
            <div class="row">
              <div><label>清洁度</label><select name="cleanliness"><option value="">待定</option><option>合格</option><option>不合格</option></select></div>
              <div style="align-self:end;"><label><input type="checkbox" name="simulate" style="width:auto"> 模拟写入失败（保留水单）</label></div>
            </div>
            <button>提交（按排水量扣减池容量）</button>
          </form>

          <form id="confirmForm" class="panel" style="margin-top:14px">
            <h2>化验确认（化验员只能确认自己被分派的样品）</h2>
            <div class="row">
              <div><label>回用水单</label><select name="ticketNo" id="confirmTicketSelect"></select></div>
              <div><label>化验员</label><select name="analyst"><option>周化验</option><option>吴化验</option></select></div>
            </div>
            <div class="row">
              <div><label>清洁度</label><select name="cleanliness"><option>合格</option><option>不合格</option></select></div>
              <div><label>备注</label><input name="note"></div>
            </div>
            <button class="secondary">提交化验确认</button>
          </form>

          <form id="releaseForm" class="panel" style="margin-top:14px">
            <h2>复用放行（由另一名负责人完成）</h2>
            <div class="row">
              <div><label>回用水单</label><select name="ticketNo" id="releaseTicketSelect"></select></div>
              <div><label>放行负责人</label><select name="releaser"><option>林素</option><option>郑渠</option></select></div>
            </div>
            <button>放行回用</button>
          </form>
        </div>

        <div>
          <div class="panel" id="pendingBox" style="margin-bottom:14px"></div>
          <h2>沉淀池余量</h2>
          <div class="grid" id="tankCards" style="margin:10px 0 18px"></div>
          <h2>回用水单（批次 → 沉淀池 → 放行 全链可追溯）</h2>
          <div class="grid" id="ticketCards" style="margin-top:10px"></div>
        </div>
      </div>
    </section>

    <section id="tab-batch" hidden>
      <div class="layout">
        <section>
          <form id="createForm" class="panel"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status" id="newStatus"></select><button>保存纸浆批次</button></form>
          <form id="actionForm" class="panel" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button class="secondary">提交记录</button></form>
        </section>
        <section>
          <div class="stats" id="batchStats"></div>
          <div class="panel"><h2>批次记录（含升级前无池号/排水量的历史数据）</h2><div class="grid" id="cards"></div></div>
        </section>
      </div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const $ = s => document.querySelector(s);
    let state = { items: [], tanks: [], tickets: [], pending: [] };

    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || data.error || '请求失败');
      return data;
    }
    function esc(s){ return String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

    async function load() {
      const [items, tanks, tickets, pending, stats] = await Promise.all([
        api('/api/items'), api('/api/tanks'), api('/api/tickets'), api('/api/tickets/pending'), api('/api/stats')
      ]);
      state = { items, tanks, tickets, pending, stats };
      renderWater(); renderBatch();
    }

    function statusPill(s){
      const cls = s==='已放行' ? 'ok' : (s==='待化验'?'hold':s==='待放行'?'hold':s==='已排放'?'':'bad');
      return '<span class="pill '+cls+'">'+s+'</span>';
    }

    function renderWater(){
      const s = state.stats;
      $('#stats').innerHTML =
        '<div class="stat"><span>沉淀池</span><strong>'+s.tanks+'</strong></div>' +
        '<div class="stat"><span>待化验</span><strong>'+s.tickets['待化验']+'</strong></div>' +
        '<div class="stat"><span>待放行</span><strong>'+s.tickets['待放行']+'</strong></div>' +
        '<div class="stat"><span>已放行复用</span><strong>'+s.tickets['已放行']+'</strong></div>' +
        '<div class="stat"><span>待补记水单</span><strong>'+s.pending+'</strong></div>' +
        '<div class="stat"><span>历史批次(无池号/排量)</span><strong>'+s.legacyBatches+'</strong></div>';

      $('#batchSelect').innerHTML = state.items.map(i => '<option value="'+esc(i.code)+'">'+esc(i.code)+' · '+esc(i.source||'')+'</option>').join('');
      $('#tankSelect').innerHTML = state.tanks.map(t => '<option value="'+esc(t.code)+'">'+esc(t.name)+'（余 '+t.remaining+'/'+t.capacity+'）</option>').join('');
      if (!$('#submitSelect').dataset.filled) {
        $('#submitSelect').innerHTML = '<option>林素</option><option>郑渠</option>';
        $('#submitSelect').dataset.filled = '1';
      }
      const openTickets = state.tickets.filter(t => ['待化验','待放行'].includes(t.status));
      $('#confirmTicketSelect').innerHTML = openTickets.map(t => '<option value="'+esc(t.ticketNo)+'">'+esc(t.ticketNo)+' · '+(t.sampleAssignee?'分派:'+esc(t.sampleAssignee):'未分派')+'</option>').join('') || '<option value="">暂无</option>';
      $('#releaseTicketSelect').innerHTML = state.tickets.filter(t=>t.status==='待放行').map(t => '<option value="'+esc(t.ticketNo)+'">'+esc(t.ticketNo)+'</option>').join('') || '<option value="">暂无</option>';

      $('#pendingBox').innerHTML = state.pending.length
        ? '<div class="banner">⚠ 有 '+state.pending.length+' 张回用水单写入失败但已保留，恢复后沿用同一现场单号补记。</div>'
          + state.pending.map(p => '<div class="meta">'+esc(p.payload.ticketNo)+' · 池 '+esc(p.payload.tankCode)+' · 排水 '+esc(p.payload.drainVolume)+' 吨 · 原因：'+esc(p.lastError||'')+' · 尝试 '+p.attempts+' 次</div>').join('')
          + '<button id="recoverBtn">恢复并补记</button>'
        : '<h2>待补记水单</h2><div class="meta">无。写入失败时水单会先保存在这里，不丢失。</div>';
      const rb = $('#recoverBtn'); if (rb) rb.onclick = async e => { e.preventDefault(); try { const r = await api('/api/tickets/recover', { method:'POST', body:'{}' }); alert('补记 '+r.recovered.length+' 张，失败 '+r.failed.length+' 张'); } catch(err){ alert(err.message); } await load(); };

      $('#tankCards').innerHTML = state.tanks.map(t => {
        const pct = Math.min(100, Math.round(t.used/t.capacity*100));
        return '<article class="card"><h3>'+esc(t.name)+'（'+esc(t.code)+'）</h3>'
          + '<div>容量 <b>'+t.capacity+'</b> 吨 · 已占 <b>'+t.used+'</b> 吨 · 余量 <b class="'+(t.remaining<=0?'warn-text':'')+'">'+t.remaining+'</b> 吨</div>'
          + '<div class="bar"><i style="width:'+pct+'%"></i></div></article>';
      }).join('');

      $('#ticketCards').innerHTML = state.tickets.map(t => {
        const legacy = t.legacy ? '<div class="hold-text">历史数据：缺池号或排水量，原样保留</div>' : '';
        const sample = t.sampleAssignee
          ? '<div class="meta">样品分派：'+esc(t.sampleAssignee)+'；确认：'+esc(t.confirmedBy||'未确认')+'（'+esc(t.cleanliness||'待定')+'）</div>'
          : '<div class="meta">样品尚未分派/确认</div>';
        const rel = t.releasedBy ? '<div class="meta">放行：'+esc(t.releasedBy)+' @ '+esc(t.releasedAt)+'</div>' : '';
        const logs = (t.events||[]).map(ev => '<div>['+esc(ev.at)+'] '+esc(ev.type)+' · '+esc(ev.by)+'：'+esc(ev.note||'')+'</div>').join('');
        return '<article class="card"><div class="inline"><h3>'+esc(t.ticketNo)+'</h3>'+statusPill(t.status)+'</div>'
          + '<div class="meta">批次 '+esc(t.batchCode)+' → 沉淀池 '+esc(t.tankCode||'—')+' → 实际排水 '+(t.drainVolume ?? '—')+' 吨</div>'
          + '<div class="meta">登记：'+esc(t.submittedBy)+'</div>'+sample+rel+legacy
          + '<div class="logs">'+(logs||'暂无轨迹')+'</div></article>';
      }).join('');
    }

    function renderBatch(){
      $('#itemSelect').innerHTML = state.items.map(i => '<option value="'+esc(i.code)+'">'+esc(i.code)+' · '+esc(i.source||'')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(x=>[x,0]));
      state.items.forEach(i => { if (stats[i.status] !== undefined) stats[i.status]++; });
      $('#batchStats').innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      $('#cards').innerHTML = state.items.map(i => {
        const logs = (i.logs||[]).slice(-5).map(l => '<div>'+esc(l.step)+'：'+esc(l.note)+'</div>').join('');
        return '<article class="card"><h3>'+esc(i.code)+'</h3><span class="pill">'+esc(i.status)+'</span>'
          + '<div>原料 '+esc(i.source)+' · '+esc(i.vat)+' · '+esc(i.days)+'天 · '+esc(i.owner)+'</div>'
          + (i.legacy ? '<div class="hold-text">升级前历史数据：无池号/排水量，照常查看与统计</div>' : '')
          + '<div class="logs meta">'+(logs||'暂无记录')+'</div></article>';
      }).join('');
    }

    $('#ticketForm').onsubmit = async e => {
      e.preventDefault();
      const f = new FormData($('#ticketForm'));
      const payload = {
        ticketNo: f.get('ticketNo') || ('现场-'+new Date().toISOString().slice(0,10).replace(/-/g,'')+'-'+String(Date.now()).slice(-5)),
        batchCode: f.get('batchCode'), tankCode: f.get('tankCode'),
        drainVolume: Number(f.get('drainVolume')), submittedBy: f.get('submittedBy')
      };
      if (f.get('analyst')) {
        payload.sample = { assignee: f.get('assignee') || f.get('analyst'), confirmedBy: f.get('analyst'), cleanliness: f.get('cleanliness'), result: f.get('cleanliness') };
      }
      try {
        await api('/api/tickets', { method:'POST', body: JSON.stringify(payload), headers: Object.assign({'Content-Type':'application/json'}, f.get('simulate') ? {'X-Simulate-Failure':'1'} : {}) });
        alert('已登记并扣减沉淀池容量');
      } catch (err) { alert(err.message); }
      $('#ticketForm').reset(); await load();
    };
    $('#confirmForm').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData($('#confirmForm')).entries());
      try { await api('/api/tickets/confirm', { method:'POST', body: JSON.stringify(f) }); alert('化验确认完成'); }
      catch (err) { alert(err.message); }
      await load();
    };
    $('#releaseForm').onsubmit = async e => {
      e.preventDefault();
      const f = Object.fromEntries(new FormData($('#releaseForm')).entries());
      try { await api('/api/tickets/release', { method:'POST', body: JSON.stringify(f) }); alert('已放行复用'); }
      catch (err) { alert(err.message); }
      await load();
    };

    // 批次页（原有功能）
    $('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
    $('#newStatus').innerHTML = stages.map(s=>'<option>'+s+'</option>').join('');
    $('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    $('#createForm').onsubmit = async e => { e.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData($('#createForm').entries())) }); $('#createForm').reset(); await load(); };
    $('#actionForm').onsubmit = async e => { e.preventDefault(); const id = $('#itemSelect').value; await api('/api/items/'+id+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData($('#actionForm').entries())) }); $('#actionForm').reset(); await load(); };

    document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
      document.querySelectorAll('.tabs button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('#tab-water').hidden = b.dataset.tab !== 'water';
      $('#tab-batch').hidden = b.dataset.tab !== 'batch';
    });
    $('#reload').onclick = load;
    load();
  </script>
</body>
</html>`;
}

// ---------- 路由 ----------
const server = http.createServer((req, res) => {
  Promise.resolve().then(() => handle(req, res)).catch(error => {
    if (error instanceof HttpError) return send(res, error.status, { error: error.code, message: error.message });
    send(res, 500, { error: "internal_error", message: error.message });
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/") return html(res, page());

  // 沉淀池
  if (req.method === "GET" && p === "/api/tanks") {
    const db = await loadDb();
    return send(res, 200, db.tanks.map(t => decorateTank(db, t)));
  }
  if (req.method === "POST" && p === "/api/tanks") {
    const input = await body(req);
    const code = String(input.code || "").trim();
    const capacity = num(input.capacity);
    if (!code) throw new HttpError(400, "code_required", "沉淀池编号必填");
    if (!Number.isFinite(capacity) || capacity <= 0) throw new HttpError(400, "capacity_required", "容量必须为正数");
    const db = await loadDb();
    if (db.tanks.some(t => t.code === code)) throw new HttpError(409, "tank_exists", "沉淀池编号已存在");
    const tank = { code, name: input.name || code, capacity, createdAt: nowIso() };
    db.tanks.push(tank);
    await saveDb(db);
    return send(res, 201, decorateTank(db, tank));
  }

  // 回用水单：查询 / 提交（进水；可与确认同时提交）
  if (req.method === "GET" && p === "/api/tickets") {
    const db = await loadDb();
    return send(res, 200, db.tickets.map(t => ticketChain(db, t)));
  }
  if (req.method === "GET" && p === "/api/tickets/pending") {
    const db = await loadDb();
    return send(res, 200, db.pendingTickets);
  }
  if (req.method === "POST" && p === "/api/tickets") {
    const input = await body(req);
    const simulate = req.headers["x-simulate-failure"] === "1";
    return serialize(async () => {
      // 先做校验：超额直接拒绝，原记录与池容量一律不变
      const probe = await loadDb();
      try {
        applyTicket(probe, input);
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
        throw e;
      }
      // 校验通过后先把水单持久化（待补记），再写主记录；主记录失败水单也不丢
      const db0 = await loadDb();
      const { pending, duplicated } = pendingRecord(db0, input, { simulateFailure: simulate });
      await saveDb(db0);
      if (duplicated) {
        // 同单号已在补记队列：保留一份，直接报冲突
        return send(res, 409, { error: "pending_duplicate", message: "同一现场单号已在待补记队列，恢复时只保留一份", pending });
      }
      if (simulate) {
        return send(res, 502, { error: "write_failed_pending", message: "写入主记录失败，回用水单已保留，可恢复补记", pending });
      }
      try {
        const db = await loadDb();
        const result = applyTicket(db, input);
        const rec = db.pendingTickets.find(x => x.id === pending.id);
        if (rec) db.pendingTickets = db.pendingTickets.filter(x => x.id !== pending.id);
        await saveDb(db);
        return send(res, 201, { ticket: ticketChain(db, result.ticket), duplicated: result.duplicated });
      } catch (e) {
        // 主记录写入失败：水单已在 pendingTickets，等待恢复
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message, pending });
        return send(res, 502, { error: "write_failed_pending", message: "写入主记录失败，回用水单已保留，可恢复补记", pending });
      }
    });
  }
  if (req.method === "POST" && p === "/api/tickets/confirm") {
    const input = await body(req);
    return serialize(async () => {
      const db = await loadDb();
      try {
        const ticket = confirmSample(db, input);
        await saveDb(db);
        return send(res, 200, ticketChain(db, ticket));
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
        throw e;
      }
    });
  }
  if (req.method === "POST" && p === "/api/tickets/release") {
    const input = await body(req);
    return serialize(async () => {
      const db = await loadDb();
      try {
        const ticket = releaseTicket(db, input);
        await saveDb(db);
        return send(res, 200, ticketChain(db, ticket));
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
        throw e;
      }
    });
  }
  if (req.method === "POST" && p === "/api/tickets/discharge") {
    const input = await body(req);
    return serialize(async () => {
      const db = await loadDb();
      try {
        const ticket = dischargeTicket(db, input);
        await saveDb(db);
        return send(res, 200, ticketChain(db, ticket));
      } catch (e) {
        if (e instanceof HttpError) return send(res, e.status, { error: e.code, message: e.message });
        throw e;
      }
    });
  }
  if (req.method === "POST" && p === "/api/tickets/recover") {
    return serialize(async () => {
      const db = await loadDb();
      const result = await recoverPending(db);
      await saveDb(db);
      return send(res, 200, {
        recovered: result.recovered.map(r => ({ ticketNo: r.ticketNo, duplicated: r.duplicated })),
        failed: result.failed
      });
    });
  }
  if (req.method === "GET" && p === "/api/stats") {
    const db = await loadDb();
    return send(res, 200, computeStats(db));
  }

  // ---------- 原有：发酵批次 ----------
  if (req.method === "GET" && p === "/api/items") {
    const db = await loadDb();
    return send(res, 200, db.items.map(summarize));
  }
  if (req.method === "POST" && p === "/api/items") {
    const input = await body(req);
    const db = await loadDb();
    const item = { id: newId("PF"), ...input, logs: [{ at: nowIso(), step: "建档", note: "创建纸浆批次" }] };
    db.items.unshift(item);
    await saveDb(db);
    return send(res, 201, item);
  }
  const patch = p.match(/^\/api\/items\/([^/]+)$/);
  if (patch && req.method === "PATCH") {
    const db = await loadDb();
    const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
    if (!item) throw new HttpError(404, "item_not_found", "批次不存在");
    Object.assign(item, await body(req));
    item.logs ||= [];
    item.logs.push({ at: nowIso(), step: "状态", note: "更新为" + item.status });
    await saveDb(db);
    return send(res, 200, item);
  }
  const logm = p.match(/^\/api\/items\/([^/]+)\/logs$/);
  if (logm && req.method === "POST") {
    const db = await loadDb();
    const item = db.items.find(x => x.id === logm[1] || x.code === logm[1]);
    if (!item) throw new HttpError(404, "item_not_found", "批次不存在");
    const input = await body(req);
    item.logs ||= [];
    item.logs.push({ at: nowIso(), step: input.step || "记录", note: input.note || "" });
    await saveDb(db);
    return send(res, 201, item);
  }
  const action = p.match(/^\/api\/items\/([^/]+)\/action$/);
  if (action && req.method === "POST") {
    const db = await loadDb();
    const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
    if (!item) throw new HttpError(404, "item_not_found", "批次不存在");
    const input = await body(req);
    item.logs ||= [];
    const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
    item.observations ||= [];
    item.observations.push({ at: nowIso(), ...input, abnormal });
    item.days = Number(item.days || 0) + 1;
    item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
    item.logs.push({ at: nowIso(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
    await saveDb(db);
    return send(res, 201, item);
  }

  send(res, 404, { error: "not_found", message: "接口不存在" });
}

server.listen(port, () => console.log("泡料水回用记录链 listening on http://localhost:" + port));

// 导出供测试使用
export { loadDb, saveDb, migrate, seedDb, applyTicket, confirmSample, releaseTicket, dischargeTicket, recoverPending, tankUsed, serialize, HttpError };
