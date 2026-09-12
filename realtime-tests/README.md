# Node 实时测试宿主（napi-rs 绑定 + 帧循环 harness）

用于**测试与迭代优化**的 Node 实时宿主：进程内加载嵌入式 Rust 内核（N-API 绑定，
非守护进程子进程），以 500fps 帧循环驱动字节面数据通道（`ext_tick`）并测量延迟。
这不是生产 Node 宿主——它是内核实时行为的测量与迭代工具。

## 构建与运行

```powershell
cargo build -p extensions-kernel-napi --release   # rust/ 下
node realtime-tests/harness.mjs                    # 项目根下
```

harness 每次运行会把 `rust/target/release/extensions_kernel_napi.dll` 复制为
`realtime-tests/kernel.node`（项目内副本），通过 `process.dlopen` 加载——不依赖
@napi-rs/cli。运行期间会有一个核心被打满（帧节拍用"远端粗睡 + 近截止自旋"驱动，
与游戏循环同型），三个场景总时长约 12 秒。

## 绑定面（`extensions-kernel-napi`，包裹 C ABI 语义）

| 绑定 | 对应 C ABI | 说明 |
|---|---|---|
| `request(line)` | `emk_request` | JSON 信封进/出；transport 失败返回 null（`lastError()` 可查） |
| `handleResolve(id)` | `emk_handle_resolve` | 数据面句柄 |
| `invokePtr(handle, in, out)` | `emk_invoke_ptr` | 字节面 invoke；Buffer 由调用方持有、跨帧复用 |
| `tickPtr(handle, in, out)` | `emk_tick_ptr` | 帧驱动 tick 批量入口 |
| `handleRelease(h)` | `emk_handle_release` | 释放句柄 |
| `installResponseSink()` / `drainAsyncResponses()` | `install_global_response_sink` | 调度器异步响应收取（每帧或定时轮询） |
| `reset()` / `abiVersion()` / `lastError()` | `emk_reset` / `emk_abi_version` / `emk_last_error` | 生命周期与诊断 |

## 测量场景（`harness.mjs`，报告写入 `REPORT.md`）

- **S1 · 500fps × 1 插件（3s）**：单插件 tick 延迟分位数（p50/p90/p99/p999/max）。
- **S2 · 500fps × 20 插件（3s）**：逐调用与整帧 JS 耗时聚合（帧预算占比）。
- **S3 · 异步共存（100ms 边界插件）**：健康插件持续 tick；每 250ms 经
  `kernel.invoke` 饱和一次慢进程插件（内核侧异步池受理，JS 线程零阻塞）；
  对照相邻窗口的 P99 偏移 + sink 信封收取完整性。

## 基线数字（2026-09-12，Node v24 / win32 x64 / release）

| 场景 | 节拍 | tick 延迟 | 结论 |
|---|---|---|---|
| S1 单插件 | 1500/1500 帧，0 超帧 | p50 2.8µs · p99 17.4µs | napi 往返 ≈ 数 µs |
| S2 20 插件 | 30000 调用 0 失败 | p50 1.0µs · p99 6.7µs | 整帧 p50 25.3µs = 帧预算 1.3% |
| S3 异步共存 | 1500/1500 帧 | 压力下 p99 20.0µs（基线 24.7µs，**偏移 -19%**） | 慢 100ms 插件零拖累；8/8 受理 + 8/8 信封 |

对照裸 C ABI（release P99 900ns）：N-API 绑定 + JS 开销把 p99 抬到 ~7–20µs，
仍低于 500fps 帧预算（2ms）的 1%——Node 实时宿主对 500fps 帧循环可用。

## 护栏

harness 是测量工具而非 CI 门禁（开发机不是基准机）：断言仅限"零失败调用、
慢调用全部异步受理、sink 信封全部送达、压力 P99 < 1ms 绝对护栏"；严格分位数
验收（<10% 偏移、帧预算占比）在 Rust 测试双档执行。
