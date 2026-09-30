import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = await mkdtemp(join(tmpdir(), "pulp-"));
process.env.DB_PATH = join(dir, "test.json");
process.env.PORT = "0";
const { server } = await import("../server.js");
await new Promise(resolve => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function api(path, options) {
  const res = await fetch(base + path, {
    ...(options || {}),
    headers: { "Content-Type": "application/json", ...(options?.headers || {}) }
  });
  let data = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  return { status: res.status, data };
}

let batchId, tankId;
before(async () => {
  // 旧批次：没有池号和排水量，用于兼容验证
  const old = await api("/api/items", { method: "POST", body: JSON.stringify({ code: "PF-OLD", source: "旧料", vat: "一号缸", days: 3, owner: "老人" }) });
  assert.equal(old.status, 201);
  // 新批次
  const b = await api("/api/items", { method: "POST", body: JSON.stringify({ code: "PF-NEW", source: "构树皮", vat: "三号缸", days: 1, owner: "林素" }) });
  assert.equal(b.status, 201);
  batchId = b.data.id;
  // 沉淀池：容量 100
  const t = await api("/api/tanks", { method: "POST", body: JSON.stringify({ name: "一号沉淀池", capacity: 100 }) });
  assert.equal(t.status, 201);
  tankId = t.data.id;
});

after(async () => {
  await new Promise(resolve => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

test("需求1 记录链：批次 -> 沉淀池 -> 回用水单", async () => {
  const siteNo = "XC-CHAIN-1";
  const r = await api(`/api/tanks/${tankId}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "进水", siteNo, batchId, discharge: 30, sampler: "化验甲", cleanliness: "清澈" })
  });
  assert.equal(r.status, 201);
  assert.equal(r.data.siteNo, siteNo);
  assert.equal(r.data.batchId, batchId);
  assert.equal(r.data.tankId, tankId);
  assert.equal(r.data.status, "已记录");
  // 沉淀池水量增加
  const tank = await api(`/api/tanks/${tankId}`);
  assert.equal(tank.data.tank.water, 30);
  assert.equal(tank.data.tank.余量, 70);
  // 批次同步了池号和排水量
  const items = await api("/api/items");
  const batch = items.data.find(i => i.id === batchId);
  assert.equal(batch.tankId, tankId);
  assert.equal(batch.discharge, 30);
});

test("需求2 容量扣减：超过余量拒绝，保留原记录", async () => {
  // 当前余量 70，排水 80 应被拒绝
  const before = await api(`/api/tanks/${tankId}`);
  const waterBefore = before.data.tank.water;
  const r = await api(`/api/tanks/${tankId}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "进水", siteNo: "XC-OVER-1", batchId, discharge: 80, sampler: "化验甲" })
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, "capacity_exceeded");
  // 沉淀池水量未变
  const after = await api(`/api/tanks/${tankId}`);
  assert.equal(after.data.tank.water, waterBefore);
  // 回用水单保留为待补记
  assert.equal(r.data.order.status, "待补记");
  assert.equal(r.data.order.siteNo, "XC-OVER-1");
  // 列表里能查到这张单
  const list = await api("/api/water-orders?status=待补记");
  assert.ok(list.data.some(o => o.siteNo === "XC-OVER-1"));
});

test("需求3 复用确认和进水同时提交只保留一份", async () => {
  const siteNo = "XC-IDEM-1";
  // 并发提交：进水 + 复用确认，同一现场单号、同一取样人
  const [r1, r2] = await Promise.all([
    api(`/api/tanks/${tankId}/events`, { method: "POST", body: JSON.stringify({ type: "进水", siteNo, batchId, discharge: 10, sampler: "化验甲" }) }),
    api(`/api/tanks/${tankId}/events`, { method: "POST", body: JSON.stringify({ type: "复用确认", siteNo, confirmer: "化验甲", sampler: "化验甲", cleanliness: "清澈无异味" }) })
  ]);
  // 两个请求都成功，且只生成一张回用水单
  assert.ok([200, 201].includes(r1.status), `r1 status ${r1.status}`);
  assert.ok([200, 201].includes(r2.status), `r2 status ${r2.status}`);
  assert.equal(r1.data.id, r2.data.id);
  assert.equal(r2.data.confirmer, "化验甲");
  // 该沉淀池只有这一张 XC-IDEM-1 单
  const list = await api(`/api/water-orders?tankId=${tankId}`);
  const same = list.data.filter(o => o.siteNo === siteNo);
  assert.equal(same.length, 1);
  assert.equal(same[0].confirmer, "化验甲");
});

test("需求4 写入失败保留回用水单，恢复后补记沿用同一现场单号", async () => {
  // 确认并放行测试1的回用水单（XC-CHAIN-1，排水30），腾出沉淀池容量
  const chainList = await api("/api/water-orders?status=已记录");
  const chainOrder = chainList.data.find(o => o.siteNo === "XC-CHAIN-1");
  assert.ok(chainOrder, "前置：XC-CHAIN-1 应已记录");
  const cf = await api(`/api/water-orders/${chainOrder.id}/confirm`, {
    method: "POST", body: JSON.stringify({ confirmer: "化验甲", cleanliness: "清澈" })
  });
  assert.equal(cf.status, 200);
  const rel = await api(`/api/water-orders/${chainOrder.id}/release`, {
    method: "POST", body: JSON.stringify({ releaser: "负责人乙" })
  });
  assert.equal(rel.status, 200);
  assert.equal(rel.data.status, "已放行");
  // 补记 XC-OVER-1（待补记，排水80），恢复后应成功并沿用同一现场单号
  const pending = await api("/api/water-orders?status=待补记");
  const over = pending.data.find(o => o.siteNo === "XC-OVER-1");
  assert.ok(over);
  const bf = await api(`/api/water-orders/${over.id}/backfill`, { method: "POST" });
  assert.equal(bf.status, 200);
  assert.equal(bf.data.siteNo, "XC-OVER-1"); // 沿用同一现场单号
  assert.equal(bf.data.status, "已记录");
  assert.match(bf.data.logs.find(l => l.step === "补记").note, /XC-OVER-1/);
});

test("需求5 化验员越权确认别人的样品直接拒绝", async () => {
  const siteNo = "XC-AUTH-1";
  const created = await api(`/api/tanks/${tankId}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "进水", siteNo, batchId, discharge: 5, sampler: "化验甲" })
  });
  assert.equal(created.status, 201);
  // 化验乙来确认化验甲的样品 -> 拒绝
  const r = await api(`/api/water-orders/${created.data.id}/confirm`, {
    method: "POST",
    body: JSON.stringify({ confirmer: "化验乙", cleanliness: "清澈" })
  });
  assert.equal(r.status, 403);
  assert.equal(r.data.error, "unauthorized_confirm");
  // 原单未被改动
  const list = await api("/api/water-orders");
  const order = list.data.find(o => o.siteNo === siteNo);
  assert.equal(order.confirmer, null);
  assert.equal(order.status, "已记录");
});

test("需求6 复用放行由另一名负责人完成", async () => {
  const siteNo = "XC-SOD-1";
  const created = await api(`/api/tanks/${tankId}/events`, {
    method: "POST",
    body: JSON.stringify({ type: "进水", siteNo, batchId, discharge: 4, sampler: "化验甲" })
  });
  assert.equal(created.status, 201);
  await api(`/api/water-orders/${created.data.id}/confirm`, {
    method: "POST", body: JSON.stringify({ confirmer: "化验甲", cleanliness: "清澈" })
  });
  // 确认人自己放行 -> 拒绝
  const bad = await api(`/api/water-orders/${created.data.id}/release`, {
    method: "POST", body: JSON.stringify({ releaser: "化验甲" })
  });
  assert.equal(bad.status, 403);
  assert.equal(bad.data.error, "duty_conflict");
  // 另一名负责人放行 -> 成功
  const ok = await api(`/api/water-orders/${created.data.id}/release`, {
    method: "POST", body: JSON.stringify({ releaser: "负责人乙" })
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.status, "已放行");
  assert.equal(ok.data.releaser, "负责人乙");
});

test("需求7 旧数据无池号排水量，升级后仍可查看和统计", async () => {
  const items = await api("/api/items");
  const old = items.data.find(i => i.code === "PF-OLD");
  assert.ok(old, "旧批次仍可查看");
  assert.equal(old.tankId, undefined);
  assert.equal(old.discharge, undefined);
  // 统计仍包含旧批次
  const stats = await api("/api/stats");
  assert.ok(stats.data.batches.发酵中 >= 1);
  assert.ok(stats.data.waterOrders.total >= 1);
  // 落盘文件结构完整
  const raw = JSON.parse(await readFile(process.env.DB_PATH, "utf8"));
  assert.ok(Array.isArray(raw.tanks));
  assert.ok(Array.isArray(raw.waterOrders));
});
