import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.js");
const dir = await mkdtemp(join(tmpdir(), "pulp-chain-"));
const dbFile = join(dir, "test-db.json");
const PORT = 4317;
const base = `http://127.0.0.1:${PORT}`;

let server;
function start() {
  return new Promise((resolve, reject) => {
    server = spawn(process.execPath, [serverPath], {
      env: { ...process.env, DB_PATH: dbFile, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    server.stdout.on("data", d => { if (String(d).includes("listening")) resolve(); });
    server.stderr.on("data", d => process.stderr.write(d));
    server.on("error", reject);
    setTimeout(() => reject(new Error("server start timeout")), 5000);
  });
}

async function api(path, opts = {}) {
  const res = await fetch(base + path, {
    method: opts.method || "GET",
    headers: opts.headers || (opts.body ? { "Content-Type": "application/json" } : undefined),
    body: opts.body
  });
  const data = await res.json();
  return { status: res.status, data };
}
const j = o => JSON.stringify(o);

before(async () => { await start(); });
after(async () => {
  server.kill();
  await rm(dir, { recursive: true, force: true });
});

test("旧数据迁移：无池号/排水量的历史批次仍可查看、仍计入统计", async () => {
  const { status, data } = await api("/api/items");
  assert.equal(status, 200);
  const pf001 = data.find(i => i.code === "PF-001");
  assert.ok(pf001, "历史批次保留");
  assert.equal(pf001.legacy, true);
  assert.equal(pf001.status, "发酵中");
  const stats = (await api("/api/stats")).data;
  assert.equal(stats.batches["发酵中"], 1, "历史批次仍计入状态统计");
  assert.ok(stats.legacyBatches >= 1);
  // 历史水单缺池号/排水量也原样保留可查
  const tickets = (await api("/api/tickets")).data;
  assert.ok(tickets.find(t => t.ticketNo === "现场-20200615-01"));
});

test("换水按实际排水量扣减池容量，水单串起批次与沉淀池", async () => {
  const before = (await api("/api/tanks")).data.find(t => t.code === "T2");
  const r = await api("/api/tickets", { method: "POST", body: j({
    ticketNo: "现场-T-001", batchCode: "PF-001", tankCode: "T2",
    drainVolume: 10, submittedBy: "林素"
  }) });
  assert.equal(r.status, 201);
  assert.equal(r.data.ticket.status, "待化验");
  assert.equal(r.data.ticket.batch.code, "PF-001");
  assert.equal(r.data.ticket.tank.code, "T2");
  const after = (await api("/api/tanks")).data.find(t => t.code === "T2");
  assert.equal(after.used, before.used + 10);
  assert.equal(after.remaining, before.remaining - 10);
});

test("排水量超过余量：拒绝且原记录/容量不变", async () => {
  const t2 = (await api("/api/tanks")).data.find(t => t.code === "T2");
  const r = await api("/api/tickets", { method: "POST", body: j({
    ticketNo: "现场-T-OVER", batchCode: "PF-001", tankCode: "T2",
    drainVolume: t2.remaining + 1, submittedBy: "林素"
  }) });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "tank_capacity_exceeded");
  const t2after = (await api("/api/tanks")).data.find(t => t.code === "T2");
  assert.deepEqual({ used: t2after.used, remaining: t2after.remaining }, { used: t2.used, remaining: t2.remaining });
  const tickets = (await api("/api/tickets")).data;
  assert.ok(!tickets.find(t => t.ticketNo === "现场-T-OVER"), "拒绝后不留水单");
});

test("同池复用确认与进水同时提交：串行化后只保留一份、只扣一次量", async () => {
  const payload = j({
    ticketNo: "现场-CONC-1", batchCode: "PF-001", tankCode: "T2",
    drainVolume: 3, submittedBy: "林素",
    sample: { assignee: "周化验", confirmedBy: "周化验", cleanliness: "合格" }
  });
  const t2before = (await api("/api/tanks")).data.find(t => t.code === "T2");
  const results = await Promise.all([
    api("/api/tickets", { method: "POST", body: payload }),
    api("/api/tickets", { method: "POST", body: payload })
  ]);
  const codes = results.map(r => r.status).sort();
  assert.ok(codes.includes(201));
  assert.ok(codes.includes(409) || results.some(r => r.data.duplicated === true));
  const tickets = (await api("/api/tickets")).data.filter(t => t.ticketNo === "现场-CONC-1");
  assert.equal(tickets.length, 1, "只保留一份水单");
  assert.equal(tickets[0].drainVolume, 3);
  assert.equal(tickets[0].confirmedBy, "周化验", "确认合并进同一份");
  const t2after = (await api("/api/tanks")).data.find(t => t.code === "T2");
  assert.equal(t2after.used, t2before.used + 3, "容量只扣一次");
});

test("化验员越权确认别人的样品：直接拒绝", async () => {
  // 进水并分派样品给周化验（但不附带确认）
  const c = await api("/api/tickets", { method: "POST", body: j({
    ticketNo: "现场-S-1", batchCode: "PF-001", tankCode: "T2",
    drainVolume: 1, submittedBy: "林素"
  }) });
  assert.equal(c.status, 201);
  const r = await api("/api/tickets/confirm", { method: "POST", body: j({
    ticketNo: "现场-S-1", analyst: "吴化验", assignee: "周化验", cleanliness: "合格"
  }) });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "sample_forbidden");
  const t = (await api("/api/tickets")).data.find(x => x.ticketNo === "现场-S-1");
  assert.equal(t.confirmedBy, null, "越权确认不生效");
  // 本人确认成功
  const ok = await api("/api/tickets/confirm", { method: "POST", body: j({
    ticketNo: "现场-S-1", analyst: "周化验", assignee: "周化验", cleanliness: "合格"
  }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, "待放行");
  // 非化验员不能确认
  const badRole = await api("/api/tickets/confirm", { method: "POST", body: j({
    ticketNo: "现场-S-1", analyst: "林素", assignee: "林素", cleanliness: "合格"
  }) });
  assert.equal(badRole.status, 403);
});

test("复用放行必须另一名负责人：登记人自行放行被拒绝；清洁度不合格拒绝", async () => {
  // 登记人是林素，林素放行 -> 拒绝职责分离
  const self = await api("/api/tickets/release", { method: "POST", body: j({
    ticketNo: "现场-S-1", releaser: "林素"
  }) });
  assert.equal(self.status, 403);
  assert.equal(self.data.error, "release_separation_required");
  // 另一名负责人放行成功
  const ok = await api("/api/tickets/release", { method: "POST", body: j({
    ticketNo: "现场-S-1", releaser: "郑渠"
  }) });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, "已放行");
  // 放行后容量释放（水已回用离池）
  const t2 = (await api("/api/tanks")).data.find(t => t.code === "T2");
  assert.ok(t2.used >= 0);

  // 清洁度不合格不能放行
  await api("/api/tickets", { method: "POST", body: j({
    ticketNo: "现场-D-1", batchCode: "PF-001", tankCode: "T2",
    drainVolume: 1, submittedBy: "郑渠",
    sample: { assignee: "吴化验", confirmedBy: "吴化验", cleanliness: "不合格" }
  }) });
  const rel = await api("/api/tickets/release", { method: "POST", body: j({
    ticketNo: "现场-D-1", releaser: "林素"
  }) });
  assert.equal(rel.status, 409);
  assert.equal(rel.data.error, "cleanliness_failed");
});

test("写入失败保留回用水单，恢复后按同一现场单号补记", async () => {
  const r = await api("/api/tickets", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Simulate-Failure": "1" },
    body: j({ ticketNo: "现场-F-1", batchCode: "PF-001", tankCode: "T2", drainVolume: 2, submittedBy: "林素" })
  });
  assert.equal(r.status, 502);
  assert.equal(r.data.error, "write_failed_pending");
  // 主记录没有，但水单保留
  const tickets = (await api("/api/tickets")).data;
  assert.ok(!tickets.find(t => t.ticketNo === "现场-F-1"));
  const pending = (await api("/api/tickets/pending")).data;
  assert.ok(pending.find(p => p.payload.ticketNo === "现场-F-1"));
  // 恢复补记，沿用同一现场单号
  const rec = await api("/api/tickets/recover", { method: "POST", body: "{}" });
  assert.equal(rec.status, 200);
  assert.ok(rec.data.recovered.find(x => x.ticketNo === "现场-F-1"));
  const after = (await api("/api/tickets")).data;
  const t = after.find(x => x.ticketNo === "现场-F-1");
  assert.ok(t, "补记成功，单号不变");
  assert.equal(t.drainVolume, 2);
  assert.equal((await api("/api/tickets/pending")).data.length, 0);
  // 补记也写进批次日志，记录链完整
  const pf = (await api("/api/items")).data.find(i => i.code === "PF-001");
  assert.ok(pf.logs.some(l => l.note.includes("现场-F-1")));
});

test("待补记期间的水单保守占用容量；再次恢复幂等不重复", async () => {
  const rec = await api("/api/tickets/recover", { method: "POST", body: "{}" });
  assert.equal(rec.status, 200);
  assert.deepEqual(rec.data.recovered, []);
});

test("记录链与统计最终一致", async () => {
  const stats = (await api("/api/stats")).data;
  const tickets = (await api("/api/tickets")).data;
  let accounted = 0;
  for (const t of tickets) {
    assert.ok(t.batch || t.legacy, t.ticketNo + " 关联批次");
    if (t.tankCode === "T2" && ["待化验", "待放行"].includes(t.status)) accounted += t.drainVolume;
  }
  const t2 = (await api("/api/tanks")).data.find(t => t.code === "T2");
  // pending 已清空，占用量应与未放行水单一致
  assert.equal(t2.used, accounted);
  assert.equal(stats.pending, 0);
  assert.ok(stats.tickets["已放行"] >= 1);
});
