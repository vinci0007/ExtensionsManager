# ExtensionsManager 内存方向性能测试报告

日期：2026-09-05
范围：仅本项目；全部探针与产物位于 performance-tests/（项目内）。
被测对象：构建产物 dist/（TS 全路径）+ Rust 内核（含本日修复后的构建）。
运行方式：`node --expose-gc performance-tests/probes/<probe>.mjs`
（daemon 相关探针需先 `cargo build -p extensionsd`）。

---

## 0. 测试前发现并修复的问题（先评估、先修、再测）

**`closed_sessions` 无界增长（Rust 内核，真实缺陷）**
- 问题：每个关闭过的会话都在内核留下永久墓碑字符串（HashSet 只进不出）。
  长期运行的宿主（游戏服务器等百万会话场景）内核内存只增不减。
- 修复：改为有界墓碑环（`ClosedSessionTombstones`，FIFO 驱逐，容量 65,536），
  最近关闭的会话保持稳定的 closed-session 语义，极老的墓碑降级为
  "unknown session"（仍是错误，语义可接受）。新增白盒测试断言容量上限、
  FIFO 驱逐与新条目保留。
- 状态：已修复并验证（Rust lib 15/15）。

## 1. 内存泄露（leak-lifecycle.mjs — 4/4 通过）

60 次完整生命周期循环（load → activate → invoke → deactivate → unregister），
每 10 循环 GC 后采样，对比首尾四分位中位数：

| 场景 | 堆增长 | RSS 增长 | 判定 |
|---|---|---|---|
| Node 运行时（60 循环） | +0.20 MB | +0.35 MB | 无泄露（增量来自 ESM 模块缓存，属 Node 语义） |
| WASM 运行时（60 次编译/调用/销毁） | +0.03 MB | +0.24 MB | 无泄露（每次循环都是全新的 WebAssembly.Module） |

## 2. 多插件规模（scale-wasm.mjs — 通过）

进程内 WASM 插件 1 → 10 → 100 → 300，全部存活并轮转调用：

| 插件数 | 进程 RSS | 每插件增量 | 加载 P50 | invoke P50 | invoke P99 |
|---|---|---|---|---|---|
| 1 | 53.8 MB | — | 12.0 ms | 1 µs | 3 µs |
| 10 | 55.7 MB | 0.21 MB | 9.7 ms | 0.4 µs | 2 µs |
| 100 | 56.6 MB | 0.01 MB | 9.9 ms | 1 µs | 3 µs |
| 300 | 57.5 MB | 0.00 MB | 10.0 ms | 0.4 µs | 1 µs |

结论：
- **300 个插件总增量约 3.7 MB（≈12 KB/插件）**——小模块实例的内存占用极小，
  内存不再是插件数量的约束；数百插件在普通 PC 上无压力。
- 加载 P50 ≈ 10 ms/插件（300 插件冷启动约 3 秒）——**归因更正（2026-09-05
  修复后实测）**：小模块场景的装载成本由**文件系统 I/O** 主导（每插件 mkdir +
  写清单 + 读模块），而非 wasm 编译（42 字节模块编译 ~0.1 ms）。编译缓存
  （内容哈希共享 WebAssembly.Module，FIFO 64 上限）已实现并有回归测试证明
  生效，对**大模块**（真实插件，百 KB–MB 级）收益显著；小模块批量装载的
  进一步优化应指向减少每插件文件操作。
- 调用延迟在 1→300 插件间无退化（轮转调用，P99 ≤ 3 µs）。

对照：进程型插件每个是独立 Node 运行时（~40–60 MB 量级，由 Node 本身决定），
300 个即 12–18 GB——**多插件规模化必须走进程内 WASM 数据面**，这也是嵌入式
内核路线的核心依据。

## 2.5 修复轮（2026-09-05，性能测试发现项落地）

1. **编译缓存已实现**（WasmRuntime 内容哈希 → 共享 WebAssembly.Module，
   有界 FIFO 64；身份回归测试证明同字节共享/异字节分离）。
2. **同名热更新已修复**（NodeRuntime 按内容哈希 cache-busting：同字节 →
   命中模块缓存，变字节 → 全新模块；此前同文件名更新会一直服务旧模块直到
   重启，store 的 update 流程因此要求换文件名）。
3. **商店安装自动钉住二进制完整性**（install/update 时计算入口文件 sha256
   写入 artifact.integrity，后续任何二进制篡改在加载时被
   verifyArtifactIntegrity 拒绝——关闭"改二进制不改 manifest"缺口）。
4. **核实更正**：守护进程调用超时已有强制（`timeoutMs ?? 5000` 逐请求计时），
   早前探针的串行拖延是慢插件合法耗时的累计，非缺失超时。

## 3. 内存有界性 / 挂起（boundedness.mjs — 5/5 通过）

| 场景 | 结果 |
|---|---|
| 不读取的洪水：插件推送 5 倍配额事件（20,480 条），宿主从不取 | 堆增 2.57 MB（配额 4096 条封顶，超出即弃）；会话以 EVENT_QUOTA_EXCEEDED 结构化失败 |
| 会话 churn：2000 次 open/close（真实 Rust 守护进程） | P50 0.52 ms / P99 0.94 ms，首尾漂移 0.85 ms——墓碑有界化后无随时间劣化 |
| 失控 CPU 插件：连续 6 次调用（每次烧灼 3 s CPU） | 全部在预期内完成（无基础设施挂死）；宿主侧 RSS 反而 -17.6 MB（GC 正常回收） |

补充说明：
- 计算"炸弹"（死循环）在 WASM 路径由确定性 fuel 预算拦截（scheduling 测试，
  陷阱即返回）；本探针的失控 CPU 场景用的是进程型插件（fuel 不适用于子进程），
  其不挂死结论同样成立，但子进程自身会占满一个核直到返回——实时宿主应使用
  WASM 路径获得确定性时间片。
- 过程记录：探针首版把 churn 与失控 CPU 合并在同一插件上，意外演示了
  "慢插件拖死宿主调用方"的行为（每次会话操作被插件 3 s 烧灼串行拖延）——
  这正是多线程调度器（路线图后续项）要解决的场景；当前契约下通过
  `timeoutMs` 配置缓解。

## 4. 延迟 / 利用率汇总

- 数据面单次调用（进程内 WASM）：P99 = 1–3 µs，与插件数量（1→300）无关。
- 会话往返（守护进程）：P99 ≈ 1 ms，2000 次无劣化。
- 加载：WASM ≈ 10 ms/插件（有缓存优化空间）；失控/洪水场景均可在有界时间
  内返回，无挂起路径。
- 内存：内核与传输层全部有界（事件配额、墓碑容量、staging 上限、句柄表显式
  释放）；生命周期循环零泄露。

## 5. 复跑指引

```
npm run build
node --expose-gc performance-tests/probes/leak-lifecycle.mjs
node --expose-gc performance-tests/probes/scale-wasm.mjs
node --expose-gc performance-tests/probes/boundedness.mjs   # 需 cargo build -p extensionsd
```
