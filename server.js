import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH ? resolve(process.env.DB_PATH) : join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);
const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
      "owner": "林素",
      "status": "发酵中",
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    }
  ],
  "tanks": [],
  "waterOrders": []
};
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = ["入缸","发酵中","可抄纸","异常观察"];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  // 升级迁移：旧数据没有沉淀池和回用水单，补齐为空数组；旧批次没有池号和排水量，保持不变
  if (!Array.isArray(db.tanks)) db.tanks = [];
  if (!Array.isArray(db.waterOrders)) db.waterOrders = [];
  for (const item of db.items || []) {
    if (!item.logs) item.logs = [];
    if (!item.observations) item.observations = [];
  }
  return db;
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
function newId(prefix) { return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function now() { return new Date().toISOString(); }

// 回用水单变更全局串行化，锁内重读盘，保证并发提交（复用确认与进水同时提交）只保留一份、互不覆盖
let orderLockPromise = Promise.resolve();
function withOrderLock(fn) {
  const run = orderLockPromise.then(() => fn());
  orderLockPromise = run.catch(() => {});
  return run;
}

// 复用确认：化验员只能确认自己的样品（取样人），越权直接拒绝；同一单幂等只保留一份
function applyConfirm(order, input) {
  const confirmer = String(input.confirmer || "").trim();
  if (!confirmer) return { status: 400, error: "invalid_confirmer", message: "复用确认须填写化验员姓名" };
  if (!order.sampler && input.sampler) order.sampler = String(input.sampler).trim();
  if (!order.sampler) return { status: 409, error: "missing_sampler", message: "尚未登记取样人，无法确认" };
  if (confirmer !== order.sampler) {
    order.logs.push({ at: now(), step: "拒绝", note: "化验员" + confirmer + "越权确认" + order.sampler + "的样品" });
    return { status: 403, error: "unauthorized_confirm", message: "化验员只能确认自己的样品，已拒绝" };
  }
  if (order.stage === "复用确认" || order.status === "已放行") return null; // 已确认过，幂等返回同一份
  order.confirmer = confirmer;
  order.cleanliness = input.cleanliness != null ? String(input.cleanliness) : order.cleanliness;
  order.stage = "复用确认";
  order.confirmedAt = now();
  if (order.status === "已记录") order.status = "已确认";
  order.logs.push({ at: now(), step: "复用确认", note: "化验员" + confirmer + "确认清洁度" + (order.cleanliness || "") });
  return null;
}

function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount };
}
function tankView(tank) {
  const water = Number(tank.water || 0);
  const capacity = Number(tank.capacity || 0);
  return { ...tank, water, capacity, 余量: capacity - water };
}
function orderView(order, tanks, items) {
  const tank = tanks.find(t => t.id === order.tankId);
  const item = items.find(i => i.id === order.batchId || i.code === order.batchId);
  return {
    ...order,
    tankName: tank ? tank.name : (order.tankId || ""),
    batchCode: item ? (item.code || item.id) : (order.batchId || "")
  };
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --pending:#8a6d3b; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.danger { background:var(--warn); } button.small { padding:6px 9px; font-size:12px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; } .pending { color:var(--pending); font-weight:700; }
    table { width:100%; border-collapse:collapse; font-size:13px; } th,td { text-align:left; padding:7px 8px; border-bottom:1px solid var(--line); } th { color:var(--muted); font-weight:600; }
    .chain { font-size:12px; color:var(--muted); } .actions { display:flex; gap:6px; flex-wrap:wrap; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、沉淀池、回用水单与复用放行</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="tankForm" style="margin-top:14px"><h2>新增沉淀池</h2><label>池名</label><input name="name" required><label>容量</label><input name="capacity" type="number" min="1" required><button>保存沉淀池</button></form>
      <form id="orderForm" style="margin-top:14px"><h2>换水登记（回用水单）</h2><label>纸浆批次</label><select name="batchId" id="orderBatch"></select><label>沉淀池</label><select name="tankId" id="orderTank"></select><label>排水量</label><input name="discharge" type="number" min="1" required><label>取样人（化验员）</label><input name="sampler" required><label>清洁度</label><input name="cleanliness" placeholder="如：清澈无异味"><button>提交回用水单</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="panel" style="margin-bottom:14px"><h2>沉淀池与余量</h2><table id="tankTable"><thead><tr><th>池号</th><th>池名</th><th>容量</th><th>现存水量</th><th>余量</th></tr></thead><tbody></tbody></table></div>
      <div class="panel" style="margin-bottom:14px"><h2>回用水单（批次 → 沉淀池 → 放行）</h2><table id="orderTable"><thead><tr><th>现场单号</th><th>批次</th><th>沉淀池</th><th>排水量</th><th>状态</th><th>取样/确认</th><th>放行</th><th>操作</th></tr></thead><tbody></tbody></table></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况，系统统计发酵进度、异常次数与回用水量。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const tankForm = document.querySelector('#tankForm');
    const orderForm = document.querySelector('#orderForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const orderBatch = document.querySelector('#orderBatch');
    const orderTank = document.querySelector('#orderTank');
    let items = [], tanks = [], orders = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.source || '')+'</option>').join('');
      orderBatch.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+'</option>').join('');
      orderTank.innerHTML = tanks.map(t => '<option value="'+t.id+'">'+t.name+'（余量'+t.余量+'）</option>').join('');
      const bStats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      const pending = orders.filter(o => o.status === '待补记').length;
      const released = orders.filter(o => o.status === '已放行').length;
      const totalWater = tanks.reduce((n,t) => n + Number(t.water||0), 0);
      statsEl.innerHTML =
        Object.entries(bStats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('')
        + '<div class="stat"><span>沉淀池</span><strong>'+tanks.length+'</strong></div>'
        + '<div class="stat"><span>回用水单</span><strong>'+orders.length+'</strong></div>'
        + '<div class="stat"><span>待补记</span><strong class="pending">'+pending+'</strong></div>'
        + '<div class="stat"><span>已放行</span><strong>'+released+'</strong></div>'
        + '<div class="stat"><span>现存水量</span><strong>'+totalWater+'</strong></div>';
      document.querySelector('#tankTable tbody').innerHTML = tanks.map(t => '<tr><td>'+t.id+'</td><td>'+t.name+'</td><td>'+t.capacity+'</td><td>'+t.water+'</td><td class="'+(t.余量 < 0 ? 'warn' : '')+'">'+t.余量+'</td></tr>').join('') || '<tr><td colspan="5" class="meta">暂无沉淀池</td></tr>';
      document.querySelector('#orderTable tbody').innerHTML = orders.map(o => {
        const confirm = o.confirmer ? (o.confirmer + (o.cleanliness ? ' · ' + o.cleanliness : '')) : '<span class="meta">未确认</span>';
        const release = o.releaser || '<span class="meta">未放行</span>';
        const backfill = o.status === '待补记' ? '<button class="small secondary" data-backfill="'+o.id+'">补记</button>' : '';
        const canConfirm = (o.status === '已记录');
        const canRelease = (o.status === '已确认');
        const confirmBtn = canConfirm ? '<button class="small" data-confirm="'+o.id+'">复用确认</button>' : '';
        const releaseBtn = canRelease ? '<button class="small" data-release="'+o.id+'">复用放行</button>' : '';
        return '<tr><td>'+o.siteNo+'</td><td>'+o.batchCode+'</td><td>'+o.tankName+'</td><td>'+o.discharge+'</td><td class="'+(o.status==='待补记'?'pending':'')+'">'+o.status+'</td><td>'+confirm+'</td><td>'+release+'</td><td><div class="actions">'+backfill+confirmBtn+releaseBtn+'</div></td></tr>';
      }).join('') || '<tr><td colspan="8" class="meta">暂无回用水单</td></tr>';
      document.querySelectorAll('[data-backfill]').forEach(b => b.onclick = async () => { await api('/api/water-orders/'+b.dataset.backfill+'/backfill', { method:'POST' }); await load(); });
      document.querySelectorAll('[data-confirm]').forEach(b => b.onclick = async () => {
        const confirmer = prompt('复用确认：请输入化验员姓名（须与取样人一致）');
        if (!confirmer) return;
        const cleanliness = prompt('清洁度', '清澈无异味') || '';
        await api('/api/water-orders/'+b.dataset.confirm+'/confirm', { method:'POST', body: JSON.stringify({ confirmer, cleanliness }) });
        await load();
      });
      document.querySelectorAll('[data-release]').forEach(b => b.onclick = async () => {
        const releaser = prompt('复用放行：请输入负责人姓名（须与确认人不同）');
        if (!releaser) return;
        await api('/api/water-orders/'+b.dataset.release+'/release', { method:'POST', body: JSON.stringify({ releaser }) });
        await load();
      });
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      const chain = item.tankId ? '<div class="chain">沉淀池：'+item.tankId+' · 排水量：'+(item.discharge ?? '')+'</div>' : '<div class="chain meta">旧数据：无池号/排水量</div>';
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+chain+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() {
      [items, tanks, orders] = await Promise.all([api('/api/items'), api('/api/tanks'), api('/api/water-orders')]);
      render();
    }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    tankForm.onsubmit = async event => { event.preventDefault(); await api('/api/tanks', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(tankForm).entries())) }); tankForm.reset(); await load(); };
    orderForm.onsubmit = async event => { event.preventDefault(); await api('/api/tanks/'+orderTank.value+'/events', { method:'POST', body: JSON.stringify({ type:'进水', batchId: orderBatch.value, discharge: Number(orderForm.discharge.value), sampler: orderForm.sampler.value, cleanliness: orderForm.cleanliness.value }) }); orderForm.reset(); await load(); };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId("PF"), ...input, logs: [{ at: now(), step: "建档", note: "创建纸浆批次" }] };
      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: now(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: now(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
      item.observations ||= [];
      item.observations.push({ at: now(), ...input, abnormal });
      item.days = Number(item.days || 0) + 1;
      item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
      item.logs.push({ at: now(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
      await saveDb(db);
      return send(res, 201, item);
    }

    // 沉淀池
    if (req.method === "GET" && url.pathname === "/api/tanks") return send(res, 200, db.tanks.map(tankView));
    if (req.method === "POST" && url.pathname === "/api/tanks") {
      const input = await body(req);
      const name = String(input.name || "").trim();
      const capacity = Number(input.capacity);
      if (!name || !Number.isFinite(capacity) || capacity <= 0) return send(res, 400, { error: "invalid_tank", message: "池名和容量必填" });
      const tank = { id: newId("CP"), name, capacity, water: 0, createdAt: now() };
      db.tanks.push(tank);
      await saveDb(db);
      return send(res, 201, tankView(tank));
    }
    const tankDetail = url.pathname.match(/^\/api\/tanks\/([^/]+)$/);
    if (tankDetail && req.method === "GET") {
      const tank = db.tanks.find(t => t.id === tankDetail[1]);
      if (!tank) return send(res, 404, { error: "tank_not_found" });
      const orders = db.waterOrders.filter(o => o.tankId === tank.id).map(o => orderView(o, db.tanks, db.items));
      return send(res, 200, { tank: tankView(tank), orders });
    }

    // 回用水单列表
    if (req.method === "GET" && url.pathname === "/api/water-orders") {
      let orders = db.waterOrders.map(o => orderView(o, db.tanks, db.items));
      const tankId = url.searchParams.get("tankId");
      const batchId = url.searchParams.get("batchId");
      const status = url.searchParams.get("status");
      if (tankId) orders = orders.filter(o => o.tankId === tankId);
      if (batchId) orders = orders.filter(o => o.batchId === batchId || o.batchCode === batchId);
      if (status) orders = orders.filter(o => o.status === status);
      return send(res, 200, orders);
    }

    // 沉淀池事件：进水 / 复用确认（同一沉淀池串行化，锁内重读盘，按现场单号幂等，只保留一份）
    const tankEvent = url.pathname.match(/^\/api\/tanks\/([^/]+)\/events$/);
    if (tankEvent && req.method === "POST") {
      const tankId = tankEvent[1];
      const input = await body(req);
      const type = input.type === "复用确认" ? "复用确认" : "进水";
      const siteNo = String(input.siteNo || "").trim() || ("XC-" + Date.now());
      const result = await withOrderLock(async () => {
        const db = await loadDb(); // 锁内重读，拿到上一请求提交后的最新状态
        const tank = db.tanks.find(t => t.id === tankId);
        if (!tank) return { notFound: true };
        let order = db.waterOrders.find(o => o.siteNo === siteNo);
        const created = !order;
        if (created) {
          order = {
            id: newId("HS"), siteNo, tankId,
            batchId: input.batchId || null,
            discharge: 0,
            status: "待补记", stage: "",
            sampler: null, confirmer: null, releaser: null,
            cleanliness: null, failReason: null,
            inflowAt: null, confirmedAt: null, releasedAt: null,
            logs: [], createdAt: now()
          };
          db.waterOrders.push(order);
        }
        let rejected = null;
        // 进水：按实际排水量扣减池容量，超过余量拒绝并保留原记录
        const hasInflow = input.discharge != null && input.discharge !== "";
        if (hasInflow && order.stage !== "进水" && order.status !== "已放行") {
          const discharge = Number(input.discharge);
          if (!Number.isFinite(discharge) || discharge <= 0) {
            rejected = { status: 400, error: "invalid_discharge", message: "排水量必须为正数" };
          } else {
            const water = Number(tank.water || 0);
            const capacity = Number(tank.capacity || 0);
            if (discharge > capacity - water) {
              // 写入失败：保留回用水单为待补记，不改动沉淀池与批次记录
              order.status = "待补记";
              order.failReason = "容量不足，无法扣减";
              order.logs.push({ at: now(), step: "拒绝", note: "排水量" + discharge + "超过余量" + (capacity - water) + "，保留原记录" });
              rejected = { status: 409, error: "capacity_exceeded", message: "排水量超过沉淀池余量，已拒绝并保留回用水单", order: orderView(order, db.tanks, db.items), tank: tankView(tank) };
            } else {
              tank.water = water + discharge;
              order.discharge = discharge;
              order.batchId = input.batchId || order.batchId;
              if (input.sampler) order.sampler = order.sampler || String(input.sampler).trim();
              order.status = "已记录";
              order.stage = "进水";
              order.inflowAt = now();
              order.failReason = null;
              order.logs.push({ at: now(), step: "进水", note: "排水" + discharge + "入" + tank.name + "，现存" + tank.water });
              // 同步到批次：记录池号与排水量，旧数据无这两个字段时保持不变
              const batch = db.items.find(i => i.id === order.batchId || i.code === order.batchId);
              if (batch) { batch.tankId = tankId; batch.discharge = discharge; }
            }
          }
        }
        // 复用确认：化验员越权确认别人的样品直接拒绝
        if (!rejected && (type === "复用确认" || input.confirmer != null)) {
          rejected = applyConfirm(order, input);
        }
        await saveDb(db);
        return { order: orderView(order, db.tanks, db.items), rejected, created };
      });
      if (result.notFound) return send(res, 404, { error: "tank_not_found" });
      if (result.rejected) return send(res, result.rejected.status, result.rejected);
      return send(res, result.created ? 201 : 200, result.order);
    }

    // 回用水单补记：写入失败后恢复，沿用同一现场单号
    const backfill = url.pathname.match(/^\/api\/water-orders\/([^/]+)\/backfill$/);
    if (backfill && req.method === "POST") {
      const result = await withOrderLock(async () => {
        const db = await loadDb();
        const order = db.waterOrders.find(o => o.id === backfill[1]);
        if (!order) return { notFound: "water_order" };
        if (order.status !== "待补记") return { rejected: { status: 409, error: "not_pending", message: "该回用水单不是待补记状态", order: orderView(order, db.tanks, db.items) } };
        const tank = db.tanks.find(t => t.id === order.tankId);
        if (!tank) return { notFound: "tank" };
        const water = Number(tank.water || 0);
        const capacity = Number(tank.capacity || 0);
        const discharge = Number(order.discharge || 0);
        if (discharge > capacity - water) {
          order.failReason = "容量不足，无法补记";
          order.logs.push({ at: now(), step: "拒绝", note: "补记时排水量" + discharge + "仍超过余量" + (capacity - water) });
          await saveDb(db);
          return { rejected: { status: 409, error: "capacity_exceeded", message: "补记时排水量仍超过沉淀池余量，保留回用水单", order: orderView(order, db.tanks, db.items), tank: tankView(tank) } };
        }
        tank.water = water + discharge;
        order.status = "已记录";
        order.stage = "进水";
        order.inflowAt = now();
        order.failReason = null;
        order.logs.push({ at: now(), step: "补记", note: "恢复后补记，沿用现场单号" + order.siteNo + "，排水" + discharge + "入" + tank.name });
        const batch = db.items.find(i => i.id === order.batchId || i.code === order.batchId);
        if (batch) { batch.tankId = tank.id; batch.discharge = discharge; }
        await saveDb(db);
        return { order: orderView(order, db.tanks, db.items) };
      });
      if (result.notFound === "water_order") return send(res, 404, { error: "water_order_not_found" });
      if (result.notFound === "tank") return send(res, 404, { error: "tank_not_found" });
      if (result.rejected) return send(res, result.rejected.status, result.rejected);
      return send(res, 200, result.order);
    }

    // 复用确认（回用水单维度）：化验员越权确认别人的样品直接拒绝，同一单幂等只保留一份
    const confirm = url.pathname.match(/^\/api\/water-orders\/([^/]+)\/confirm$/);
    if (confirm && req.method === "POST") {
      const input = await body(req);
      const result = await withOrderLock(async () => {
        const db = await loadDb();
        const order = db.waterOrders.find(o => o.id === confirm[1]);
        if (!order) return { notFound: true };
        const rejected = applyConfirm(order, input);
        await saveDb(db);
        return { rejected, order: orderView(order, db.tanks, db.items) };
      });
      if (result.notFound) return send(res, 404, { error: "water_order_not_found" });
      if (result.rejected) return send(res, result.rejected.status, result.rejected);
      return send(res, 200, result.order);
    }

    // 复用放行：须由另一名负责人完成（不能与确认人同一人）
    const release = url.pathname.match(/^\/api\/water-orders\/([^/]+)\/release$/);
    if (release && req.method === "POST") {
      const input = await body(req);
      const releaser = String(input.releaser || "").trim();
      if (!releaser) return send(res, 400, { error: "invalid_releaser", message: "复用放行须填写负责人姓名" });
      const result = await withOrderLock(async () => {
        const db = await loadDb();
        const order = db.waterOrders.find(o => o.id === release[1]);
        if (!order) return { notFound: true };
        if (order.status === "已放行") return { order: orderView(order, db.tanks, db.items) }; // 已放行，幂等返回
        if (order.status !== "已确认") return { rejected: { status: 409, error: "not_confirmed", message: "请先完成复用确认", order: orderView(order, db.tanks, db.items) } };
        if (releaser === order.confirmer) return { rejected: { status: 403, error: "duty_conflict", message: "复用放行须由另一名负责人完成，不能与确认人相同" } };
        const tank = db.tanks.find(t => t.id === order.tankId);
        order.releaser = releaser;
        order.releasedAt = now();
        order.status = "已放行";
        if (tank) {
          tank.water = Math.max(0, Number(tank.water || 0) - Number(order.discharge || 0));
          order.logs.push({ at: now(), step: "复用放行", note: "负责人" + releaser + "放行，回用水出" + tank.name });
        } else {
          order.logs.push({ at: now(), step: "复用放行", note: "负责人" + releaser + "放行" });
        }
        await saveDb(db);
        return { order: orderView(order, db.tanks, db.items) };
      });
      if (result.notFound) return send(res, 404, { error: "water_order_not_found" });
      if (result.rejected) return send(res, result.rejected.status, result.rejected);
      return send(res, 200, result.order);
    }

    if (req.method === "GET" && url.pathname === "/api/stats") {
      const batchStats = computeStats(db.items);
      const orderStats = {
        total: db.waterOrders.length,
        待补记: db.waterOrders.filter(o => o.status === "待补记").length,
        已记录: db.waterOrders.filter(o => o.status === "已记录").length,
        已确认: db.waterOrders.filter(o => o.status === "已确认").length,
        已放行: db.waterOrders.filter(o => o.status === "已放行").length
      };
      const tankStats = {
        total: db.tanks.length,
        capacity: db.tanks.reduce((n, t) => n + Number(t.capacity || 0), 0),
        water: db.tanks.reduce((n, t) => n + Number(t.water || 0), 0)
      };
      return send(res, 200, { batches: batchStats, tanks: tankStats, waterOrders: orderStats });
    }
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
}

export { server, dbPath, loadDb, saveDb };
