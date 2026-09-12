# 嵌入式内核数据面契约（Embedded Kernel Data-Plane Contract）

面向插件作者与宿主开发者的数据面参考。总路线与验收结果见
`docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md`。

## 形态

内核以 cdylib 嵌入宿主进程：`rust/target/<profile>/extensions_kernel.dll`
（Windows）/ `libextensions_kernel.so`（Linux）。C 头文件：
`rust/extensions-kernel/capi/extensions_kernel.h`。C++ 宿主示例：
`examples/cpp-embedder-demo/`。

## 宿主调用流

```
管理面（低频）                          数据面（每 tick / 每帧）
────────────────                        ────────────────────────
emk_request("kernel.load …")            emk_handle_resolve(extensionId) → handle
emk_request("kernel.activate …")        emk_invoke_ptr(handle, req, out)   ← 单次调用
                                        emk_tick_ptr(handle, batch, out)   ← 每 tick 批量
emk_request("kernel.deactivate …")      emk_handle_release(handle)
```

错误模型：管理面与数据面的失败一律不崩溃宿主——
`emk_request` 返回 NULL、`emk_invoke_ptr`/`emk_tick_ptr` 返回 -1 时，
调用 `emk_last_error()` 取线程级错误文本。

## 插件契约（wasm guest）

### 数值契约（向后兼容，同 `examples/wasm-extension-template`）

- 能力名导出（如 `addOne(i32) -> i32`），input 为数字或 `{"value": n}`，
  缺省参数补 0，返回首个结果（无结果返回 null）
- 可选 `activate` / `deactivate` 导出（无参）
- 可选 `env.now` 导入：`() -> f64`（epoch 毫秒）或 `() -> i64`，其余导入拒绝

### 字节快速路径（数据面，opt-in）

guest 导出 `memory` 与 `ext_call(in_ptr: i32, in_len: i32) -> i64`：

1. 宿主把请求字节（今日为 JSON `{"capability": …, "input": …}`）写入线性内存
   **偏移 0**，调用 `ext_call(0, len)`；
2. guest 把响应字节写到线性内存任意处，返回打包值
   `(out_ptr << 32) | out_len`（i64；负值 = 插件侧失败）；
3. 宿主从 `out_ptr` 读 `out_len` 字节。载荷 schema 对传输层不透明，
   未来可换二进制编码而不破坏签名。

`ext_tick(in_ptr, in_len) -> i64` 同约定，是 tick 批量入口：宿主每帧/tick 推一批
（如 `{"ticks":[{"dtMs":16}]}`），插件回一批——取代轮询式会话，是实时宿主的推荐路径。

### 内核侧强制约束

| 约束 | 值 | 覆盖方式 |
|---|---|---|
| 线性内存配额 | 256 页 = 16 MiB（实例化即强制） | — |
| 单次调用输入上限 | 1 MiB（偏移 0 起写入） | — |
| 每次调用 fuel 预算 | 默认 2 亿指令（确定性陷阱，错误注明预算） | `EXTENSIONS_KERNEL_WASM_FUEL` |
| wasmtime 模块缓存 | 默认关闭 | `EXTENSIONS_KERNEL_WASM_CACHE_DIR`（必须指向宿主项目内目录） |

## C ABI 一览

| 函数 | 用途 |
|---|---|
| `emk_abi_version()` | ABI 版本（当前 1） |
| `emk_request(const char*)` | 管理面 JSON 信封（同 extensionsd 协议） |
| `emk_last_error()` | 线程级错误文本 |
| `emk_string_free(char*)` | 释放库返回的字符串 |
| `emk_handle_resolve(const char*)` | 为已加载扩展解析/注册数据面句柄 |
| `emk_invoke_ptr(handle, in, in_len, out, out_cap)` | 数据面单次调用（响应直写 out） |
| `emk_tick_ptr(handle, in, in_len, out, out_cap)` | 数据面 tick 批量入口 |
| `emk_handle_release(handle)` | 释放句柄 |
| `emk_reset()` | 清空内核状态（重载/测试用） |

## 实测延迟（Windows，release 构建）

宿主进 → C ABI → wasm 调用 → 宿主出，不含插件逻辑：

- Rust 集成基准（`tests/data_plane_latency.rs`）：P50 200 ns / **P99 300 ns** / P999 700 ns
- 真实 C++ 宿主（`examples/cpp-embedder-demo`，20k 次迭代）：P99 300–400 ns
- 1000 Hz tick × 20 插件 ≈ 6 µs/tick ≈ 预算的 0.6%
- 调度隔离：失控插件在 fuel 预算处确定性陷阱，邻居延迟有界，移除失控者后完全恢复

## 策略引擎（性能审核与许可）

宿主通过 `kernel.policy.set`（或 TS 侧 `policy` 配置键）声明性能预算，内核据此
自动推导并强制执行：

- **CPU 维**：`frame.tickHz/frameBudgetMs + pluginSharePct` → 启动期标定
  （ns/fuel）→ 每插件每调用 fuel 上限自动推导（显式 `fuel.perCallOverride` 优先）；
- **内存维**：`memory.totalMb + tiers`（realtime/interactive/batch 每级 MB 上限）
  → 装载准入（清单声明的 `resourceBudget.memoryMb` 对照 tier 上限）+ 每插件
  soft/hard 双层 limiter（soft 内自由 / soft→hard 记 pressure / 超 hard 拒绝）；
- **三级公民**：manifest `extensionClass`（transient/standard/resident）。
  resident（逐帧 + 大内存）走**预留准入**：声明峰值从 `memory.totalMb` 中
  lifetime 预留 + 必须声明 `resourceBudget.fuelPerTick`（保底切片）；运行时
  实际消耗连续 8 tick 超切片 → `contract.violation` 审计事件；
- **许可面**：可例外溢出（tier 溢出 / resident 超预算）内核回
  `KERNEL_CONSENT_REQUIRED`，TS 宿主经 `onPolicyConsent` 钩子裁决，批准后以
  `consentOverride` 重发（内核审计记录）；无钩子 = fail-closed；
- **审计**：`kernel.audit.query`（sinceSeq/limit 分页，FIFO 1024）覆盖
  准入拒绝 / fuel 陷阱 / memory pressure / growth denied / leak.suspected /
  contract.violation / consent override；`accounting` 按插件返回
  调用数/耗时/fuel 消耗/内存高水位。

## 宿主选择指引

| 宿主 | 路径 |
|---|---|
| 原生（C++/Rust/引擎原生插件） | 直接加载 cdylib，管理面 + 数据面全走进程内 |
| Node.js | 管理面走 TS 门面 / daemon 旁路（`CommandKernelBridge`）；数据面 napi 适配器已决策延后（见方案文档风险 5），Node 宿主暂以 daemon 旁路承载 |
| 插件作者（高性能） | Rust：`examples/rust-wasm-dataplane-template`（no_std，已验证）；其他语言：按字节契约手写 wat/wasm，参考 `examples/cpp-embedder-demo/dataplane-guest.wat` |
| 插件作者（非实时） | node/process/python/go/cpp 模板照旧，走 JSON-RPC 路径 |
