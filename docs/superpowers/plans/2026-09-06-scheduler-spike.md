# 调度器设计 Spike（Phase E 前置设计文档）

日期：2026-09-06
状态：**已实施（v1，两层全部落地，验收数字见文末 §7）**
前置：`2026-09-06-policy-engine.md`（策略引擎 A–D 已完成）

---

## 1. 问题陈述

当前内核是**单线程同步模型**：插件在宿主调用线程上顺序执行，一把全局互斥锁
保证正确性。这个模型对帧驱动的 WASM 热路径是最优形态（确定性、缓存友好、
零调度开销——帧预算实测 P99 8.8µs/20插件），但它有一个结构性后果：

**一个慢调用会串行占据互斥锁，其他所有插件的调用被迫排队。**

- WASM 插件：fuel 封顶使排队**有界**（默认 2 亿指令 ≈ 数十 ms，策略推导后更小），
  但在 500fps（2ms 帧）下数十 ms 仍是 10–50 帧的丢失；
- 进程/远程插件：调用本身就是 0.1–50ms 的边界成本，无 fuel 可拦。

调度器要解决的不是"提速"（帧内 WASM 调用已快到并行无意义），而是
**慢插件/异步插件的延迟隔离**。

## 2. 备选方案

| 方案 | 描述 | 裁决 |
|---|---|---|
| A. 全并行（每插件一线程） | N 插件 = N 线程 | 否决：线程数随插件数爆炸，违背平民化硬件约束；帧内并行引入非确定性 |
| B. 全异步（一切走队列） | 所有调用经队列 + 工作池 | 否决：帧内 WASM 调用增加队列往返开销，破坏确定性 tick 语义 |
| **C. 分类分派（选定）** | 帧关键调用保持宿主线程同步；慢/异步类走有限工作池 | 兼顾两类语义，复用三级公民分类 |

## 3. 选定设计（方案 C 细化）

### 3.1 分派规则（按策略引擎的公民类别 + 运行时形态）

| 插件形态 | 公民类别 | 分派 |
|---|---|---|
| 进程内 WASM + resident/standard | 帧关键 | **宿主线程同步**（现状不变） |
| 进程内 WASM + transient（声明 batch） | 可延迟 | 工作池（可选；默认仍同步） |
| 进程子进程 / 远程 HTTP | 边界成本 0.1–50ms | **per-plugin 派发队列 + 有限工作池**（固定线程数，如 min(4, cpu/2)），永不占帧线程 |

要点：调度器**不改变 WASM 热路径**——它把慢边界形态从帧线程上摘走。

### 3.2 机制

- 每个异步插件一个 MPSC 派发队列（有界，满时按背压策略拒绝/等待）；
- 有限工作池消费队列；工作池线程数固定（平民化约束），空闲零 CPU；
- 帧线程的 tick 批量对异步插件变为"投递 + 可选后续收割"（Phase B 的
  tick 批量通道天然适配投递模型）；
- 内核互斥锁的职责收窄为"账本与登记表"，长任务不再持锁跨调用
  （当前锁在调用期间持有——异步化后慢调用不持锁等待）。

### 3.3 兼容性与开关

- 调度器为**opt-in**（`kernel.policy.set` 增 `scheduler: { asyncPoolThreads?: number }`）；
  未配置 = 现状（全同步），零回归风险；
- C ABI 语义不变：`emk_invoke_ptr` 对异步插件返回"已受理"标记或阻塞等待，
  由调用方声明的 realtimeClass 决定（帧关键调用永不异步）。

## 4. 验收标准（预先钉死）

1. **延迟隔离**：一个死循环进程插件存在时，其他进程插件与 WASM 插件的
   tick P99 偏移 < 10%（对照无压力基线）——即帧预算论证中推迟到本阶段的
   "<10% 偏移"验收条目；
2. 工作池线程数固定上限，不随插件数增长；
3. 背压：队列满时结构化拒绝（审计事件），无无界排队；
4. 未配置调度器时行为与现状逐字节一致（回退安全）；
5. 全量回归绿色（TS + Rust 双档 + 全部探针）。

## 5. 风险与开放问题

1. **结果语义**：异步调用的 invoke 返回从"值"变为"Future/受理"——C ABI 与
   TS 会话层都需要一个受理模型（建议：session 化，复用既有 buffered session）；
2. **fuel 与异步**：fuel 是同步指令预算，异步插件改为挂钟预算（epoch）或
   保持同步段 fuel + 总时长上限双约束——实施时裁决；
3. **进程插件的崩溃隔离**：已有 per-plugin 进程隔离 ✓，调度器只解决等待问题；
4. **优先级**：是否给 resident 让路（抢占式 vs 协作式）——建议协作式（帧优先，
   工作池在帧间隙消费），避免实现优先级继承的复杂度。

## 6. 实施预估拆分（确认后细化）

1. 异步插件标记与分派决策点（manifest/策略驱动）；
2. 派发队列 + 工作池 + 背压；
3. 受理/收割 API（C ABI + TS 会话化）；
4. 延迟隔离基准（复用 scheduling 测试骨架，进程插件版）。

---

## 7. 实施记录（v1，2026-09-12）

方案 C 落地为两层，均已验收：

### Layer 1 — 通道化重构（行为不变）

- `ManagedProcess` 重构为线程安全通道：`ProcessIo { child, stdin, pending: Mutex<HashMap>, cond: Condvar }` +
  **每个插件专用读取器线程**（读线程循环解析响应行并唤醒等待者，不再与调用线程争抢 stdout）。
- 内核互斥锁职责收窄为"账本与登记表"：`runtime_handle` 变为
  `Option<Arc<Mutex<RuntimeHandle>>>`（句柄可跨线程共享），audit/accounting 变为
  `Arc<Mutex<..>>`（调度 worker 可无 `&mut self` 记账）。
- 验收：全量 Rust 52/52 绿（重构前后逐字节一致）。

### Layer 2 — 异步分派（opt-in 调度器）

- 策略面：`kernel.policy.set { scheduler: { asyncPoolThreads, queueCap } }`；
  未配置 = 全同步（回退安全，验收条目 4）。
- 分派规则（`handle_invoke`）：启用且存在响应 sink 时，**非 WASM 运行时**
  （process/native-bridge/remote 边界形态）走 `dispatch_invoke_async`；WASM 热路径
  永远保持宿主线程同步（不破坏确定性 tick）。
  - boundary 判定按 runtime kind 做，**不取句柄锁**——worker 持句柄做 100ms 调用时
    新请求不会被卡在判定点（否则会持内核全局锁阻塞帧线程，隔离失效）。
- `dispatch_invoke_async`：有界 in-flight（`queueCap`，满时 `KERNEL_BUSY` + 审计
  `invoke.busy`）→ **立即返回 `{accepted: true, async: true}` 受理标记** → worker 线程
  （句柄 Arc 共享，同插件调用在句柄锁上串行于 worker 侧）执行边界调用 → 记账 +
  in-flight 递减 → 响应信封经 **response sink**（`Arc<Mutex<mpsc::Sender>>`）投递。
  - 实施中发现并修复三个缺陷：句柄原实现被 worker `drop`（插件一次异步调用后即失联）→
    改为 Arc clone 共享；`in_flight_invokes` 只增不减（耗尽后永久 `KERNEL_BUSY`）→
    worker 完成时递减；worker 不记账 → `account_on` 关联函数供 worker 调用。
- 交付面：`extensionsd` 专用写线程消费 sink 序列化到 stdout；嵌入侧经
  `capi::install_global_response_sink() -> Receiver<String>` 安装（Rust 嵌入 seam，
  未来 napi 绑定复用）。无 sink = 保持同步模型（安全默认）。
- 验收测试 `tests/scheduler_async.rs`：100ms 进程插件在异步池饱和 + 健康 WASM
  邻居走 `emk_invoke_ptr` 字节面。
  - **release 数字：健康邻居 P99 基线 900ns，压力下 900ns，偏移 0.00%**
    （验收条目 1 的 <10% 以 0% 达成）；受理标记 <20ms 断言；4 个响应信封
    经 sink 全部送达且 id 匹配。
  - debug 档：14µs → 11.3µs（噪声），守卫 500µs。
- 回归：Rust 全量 41/41 绿（debug）；TS 137 通过 / 0 失败；
  frame_budget release P99 6.7µs（0.241% @360Hz / 0.335% @500fps）；
  scheduling runaway：900ns → 4.5µs → 恢复 900ns。

### 开放项（v2 候选，实施时裁决）

1. ~~真正的常驻工作池~~ **已实施（2026-09-12）**：`AsyncPool` 固定线程数
   （`scheduler.asyncPoolThreads`，惰性创建、线程数变化时重建——旧 worker 排空
   队列后退出），任务队列由守护进程侧 in-flight 计数器把守（queued+executing
   ≤ `queueCap`，超限 `KERNEL_BUSY`）；验收测试
   `async_scheduler_pool_reuse_and_backpressure`（受理 → `KERNEL_BUSY` →
   信封送达 → 槽位释放 → 同一池再次受理）；
2. 异步调用 fuel/挂钟双约束（§5.2）——边界调用已有 artifact `timeoutMs`
   兜底，指令级 fuel 对非 WASM 运行时不适用，暂维持现状；
3. ~~TS 会话层受理模型~~ **已实施（2026-09-12）**：`CommandKernelTransport`
   识别 `kernel.invoke` 的 `{accepted, async}` 受理标记——调用方 Promise 保持
   pending（换上 `asyncInvokeTimeoutMs` 异步结果窗口，默认 120s），直到同一
   request id 的真实信封（结果或 `KERNEL_INVOKE_FAILED`）到达才结算；
   `KERNEL_BUSY` 背压即时拒绝；已结算请求的迟到信封静默丢弃。4 个 TS 测试
   （双阶段结算 / worker 失败 / 背压拒绝 / 超时 + 迟到信封容错）覆盖。
