# 泡料水回用记录链（古法纸浆发酵记录）

把**批次换水 → 沉淀池 → 回用水单 → 化验确认 → 复用放行**串成一条可追溯记录链，解决泡料水直接排掉、回用前水量和清洁度无人交接的问题。

运行：

```bash
npm start        # http://localhost:3039
npm test         # 9 项规则的集成测试（独立临时库）
```

数据保存在 `data/paper-pulp-fermentation.json`（可用 `DB_PATH` 环境变量指定）。

## 业务规则

1. **记录链**：每张回用水单带唯一现场单号，关联批次编号与沉淀池编号，所有动作（进水登记 / 化验确认 / 复用放行 / 排放离池）记录操作人与时间。
2. **换水扣容量**：按实际排水量扣减沉淀池余量；`排水量 > 余量` 时返回 `409 tank_capacity_exceeded`，不写水单、不改任何旧记录、不扣容量。水单放行复用后离开沉淀池、释放容量。
3. **并发去重**：同一沉淀池的提交在服务端串行化；同一现场单号的"进水"与"复用确认"同时提交时合并为一份记录，容量只扣一次；改挂别的池/批次或排量不一致返回 `409`。
4. **写入失败保留水单**：登记先持久化到待补记队列（outbox），再写主记录。主记录写入失败（可用请求头 `X-Simulate-Failure: 1` 模拟）返回 502 但水单不丢；恢复后调用补记接口，**沿用同一现场单号**落账，补记幂等。待补记水单保守占用池容量，防止超额。
5. **化验权限**：化验员只能确认分派给自己的样品，越权确认返回 `403 sample_forbidden`；非化验员不能确认。
6. **放行职责分离**：复用放行必须由**另一名负责人**完成（登记人不能自行放行，`403 release_separation_required`）；清洁度不合格或未化验的水单禁止放行。
7. **旧数据兼容**：升级前没有池号、排水量的批次/水单原样保留并标记为历史数据，仍可在列表查看、计入统计，不臆造缺失字段。

## 主要接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/tanks` | 沉淀池列表（含 capacity/used/remaining） |
| POST | `/api/tanks` | 新建沉淀池 `{code,name,capacity}` |
| GET | `/api/tickets` | 回用水单全链（含 batch、tank、events） |
| POST | `/api/tickets` | 换水登记 `{ticketNo,batchCode,tankCode,drainVolume,submittedBy,sample?}`，可与化验确认同时提交 |
| POST | `/api/tickets/confirm` | 化验确认 `{ticketNo,analyst,assignee,cleanliness,note?}` |
| POST | `/api/tickets/release` | 复用放行 `{ticketNo,releaser}`（另一名负责人） |
| POST | `/api/tickets/discharge` | 用毕登记终态 `{ticketNo,operator}` |
| GET | `/api/tickets/pending` | 写入失败、待补记的水单 |
| POST | `/api/tickets/recover` | 恢复补记，沿用原现场单号 |
| GET | `/api/stats` | 批次/水单/沉淀池/历史数据统计 |
| GET/POST/PATCH | `/api/items...` | 原有发酵批次与每日观察记录 |

人员：化验员「周化验、吴化验」；负责人「林素、郑渠」。
