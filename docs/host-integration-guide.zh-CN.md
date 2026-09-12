# 宿主集成指南

[English](host-integration-guide.md) | **简体中文**

面向上游宿主——游戏引擎与通用应用——集成 ExtensionsManager 插件子系统的端到端
指南。全部内容与已发布的代码和实测数字对齐（原始数据面合约见
[embedded-kernel-data-plane.md](embedded-kernel-data-plane.md)，实测报告见
[../realtime-tests/REPORT.md](../realtime-tests/REPORT.md)）。

## 你在哪条轨道上？

| 你的宿主 | 轨道 | 集成什么 |
|---|---|---|
| C++ / Unreal / Unity / 自研引擎（任何能调 C 函数的语言） | **[轨道 A —— 游戏引擎与原生宿主（C ABI）](#轨道-a--游戏引擎与原生宿主c-abi)** | 通过 `emk_*` C ABI 集成 Rust 内核 cdylib |
| Node.js / TypeScript 应用 | **[轨道 B —— 通用应用（TS/Node）](#轨道-b--通用应用tsnode)** | `ExtensionManager` 门面（npm 或本地构建） |
| 需要帧级实时（数百 fps tick）的 Node 宿主 | 轨道 B + **[嵌入式 napi 内核](#b3-内核模式)** | 同一门面，底层换为进程内 napi 插件 |

---

## 第 0 部分 —— 获取内核

### 方式一：预编译二进制（零工具链）

从仓库 **Releases** 页下载对应平台归档（CI 对每个 `v*` 标签自动构建）：

| 归档 | 内容 | 运行环境 |
|---|---|---|
| `extensions-kernel-windows-x64.zip` | `extensions_kernel.dll` · `kernel.node` · `extensionsd.exe` | Windows 10+/Server，x64 |
| `extensions-kernel-linux-x64.tar.gz` | `libextensions_kernel.so` · `kernel.node` · `extensionsd` | Linux x64（glibc 2.28+） |
| `extensions-kernel-macos-arm64.tar.gz` | `libextensions_kernel.dylib` · `kernel.node` · `extensionsd` | macOS 12+，Apple 芯片 |

- `extensions_kernel.*` —— 嵌入式内核 cdylib（轨道 A）。
- `kernel.node` —— 同一内核的 Node N-API 封装（轨道 B 实时路径）。
- `extensionsd*` —— 进程外守护进程 sidecar（轨道 B 守护进程模式）。

### 方式二：源码构建

需要 Rust stable 工具链（`rustup`）。产物统一在 `rust/target/release/`：

```bash
cargo build --release -p extensions-kernel        # cdylib  -> extensions_kernel.dll / libextensions_kernel.so / libextensions_kernel.dylib
cargo build --release -p extensions-kernel-napi   # napi    -> extensions_kernel_napi.dll / libextensions_kernel_napi.{so,dylib}（重命名为 kernel.node）
cargo build --release -p extensionsd              # daemon  -> extensionsd.exe / extensionsd
```

平台说明：

- **Windows**：默认即 MSVC host triple（`x86_64-pc-windows-msvc`），推荐使用。
  cdylib 是纯 C ABI，MinGW g++ 链接同样可行。
- **Linux/macOS**：无特殊要求；只有构建 C++ demo 时才需要 cc
  （`examples/cpp-embedder-demo`，Windows 用 MinGW g++，其余用 clang/gcc）。
- **WASM 插件作者**需要 `rustup target add wasm32-unknown-unknown` ——
  宿主侧完全不涉及。

---

## 轨道 A —— 游戏引擎与原生宿主（C ABI）

目标读者：把内核集成进 C++/Unreal/Unity 代码库的引擎程序员，或任何能调用
C 函数表的宿主。每进程一个内核实例；全部进程内运行——无守护进程、无套接字。

### A1. 加载库

| 平台 | 加载调用 | 符号查找 |
|---|---|---|
| Windows | `LoadLibraryW(L"extensions_kernel.dll")` | `GetProcAddress` |
| Linux | `dlopen("libextensions_kernel.so", RTLD_NOW \| RTLD_LOCAL)` | `dlsym` |
| macOS | `dlopen("libextensions_kernel.dylib", RTLD_NOW)` | `dlsym` |
| Unreal Engine | `FPlatformProcess::GetDllHandle(_T("extensions_kernel.dll"))` | `FPlatformProcess::GetDllExport` |
| Unity（原生插件） | 将 dll/so 放入 `Assets/Plugins/<平台>` | `[DllImport("extensions_kernel")]` 绑定 |

库放在宿主可执行文件旁（或加载器搜索路径上）。ABI 稳定于修订版 1 ——
加载后先用 `emk_abi_version() == 1` 做门禁。

### A2. C ABI 参考

```c
/* 返回 1（ABI 修订版）——加载后检查一次。 */
uint32_t    emk_abi_version(void);

/* 提交一条内核请求：单行 JSON 信封，不带换行符。
   返回堆分配的 NUL 结尾 JSON 响应（调用方用 emk_string_free 释放），
   或传输级失败时返回 NULL（见 emk_last_error）。 */
char*       emk_request(const char* request_json_line);

/* 借用本线程最近一次传输级错误（无则为 NULL）。
   指针在同线程下一次 emk_request 后失效。 */
const char* emk_last_error(void);

/* 释放 emk_request 返回的字符串。接受 NULL。 */
void        emk_string_free(char* ptr);

/* 丢弃全部内核状态（已加载插件、会话、策略）。用于宿主重载。 */
void        emk_reset(void);

/* 解析已加载插件的字节面句柄。0 = 未加载。 */
uint64_t    emk_handle_resolve(const char* extension_id);

/* 字节面 invoke：请求 JSON 字节输入，响应写入你的缓冲区。
   返回写入字节数，或 -1（见 emk_last_error）。缓冲区归调用方所有，
   可跨帧复用 —— 内核侧每帧零分配。 */
int64_t     emk_invoke_ptr(uint64_t handle, const uint8_t* input, size_t input_len,
                           uint8_t* out, size_t out_capacity);

/* tick 入口：同一传输，向插件的 ext_tick 导出推送一批数据。 */
int64_t     emk_tick_ptr(uint64_t handle, const uint8_t* input, size_t input_len,
                         uint8_t* out, size_t out_capacity);

void        emk_handle_release(uint64_t handle);
```

线程契约：所有 `emk_*` 调用由进程全局互斥锁串行化。从你的帧线程调用即可；
内核内部调度器 worker（异步边界调用）不碰该锁——慢的进程外插件不会拖住
你的帧循环（实测：100ms/调用的插件在池上饱和时，健康邻居 P99 偏移
0.00–0.53%，见调度器 spike 文档 §7）。

### A3. 信封协议（emk_request）

一行 JSON 进，一行 JSON 出（产生会话事件时会多行，以 `\n` 连接）：

```jsonc
// 请求
{ "kind": "request", "id": "your-opaque-id", "method": "kernel.activate", "params": { } }

// 成功响应
{ "kind": "response", "id": "your-opaque-id", "result": true }

// 内核级失败（不是传输失败——内核仍然存活）
{ "kind": "response", "id": "your-opaque-id", "error": { "code": "KERNEL_ADMISSION_REJECTED", "message": "..." } }

// 异步/会话事件行（非请求应答）
{ "kind": "event", "sessionId": "...", "event": { "type": "data", "data": { } } }
```

| 方法 | 参数 | 结果 |
|---|---|---|
| `kernel.load` | [加载体](#a4-加载插件)，`consentOverride?` | `{ extensionId, security: { status, reason } }` |
| `kernel.activate` | `{ extensionId, context: {} }` | `true`（拉起进程运行时、实例化 WASM） |
| `kernel.invoke` | `{ extensionId, capability, input }` | 插件结果——调度器开启时边界运行时返回 `{ accepted: true, async: true }` |
| `kernel.policy.set` | [策略体](#a6-策略帧内存fuel调度器) | 推导值（fuel 等） |
| `kernel.openSession` | `{ extensionId, capability, input }` | `{ sessionId }`（duplex/session 能力） |
| `kernel.session.send` / `kernel.cancel` / `kernel.session.close` | `{ sessionId, ... }` | `true`；事件以 `kind:"event"` 行到达 |
| `kernel.audit.query` | `{ sinceSeq?, limit? }` | `{ events[], newestSeq, accounting[] }` |

错误码：`KERNEL_ADMISSION_REJECTED`（装载时策略拒绝）、
`KERNEL_CONSENT_REQUIRED`（宿主可带 `consentOverride: true` 重发）、
`KERNEL_RUNTIME_ERROR`（未知插件/未激活/会话已关闭）、`KERNEL_BUSY`
（调度队列已满）、`KERNEL_INVOKE_FAILED`（异步 worker 失败）、
`KERNEL_UNKNOWN_METHOD`、`KERNEL_SESSION_UNSUPPORTED`。

### A4. 加载插件

WASM 插件（帧关键数据面形态）：

```jsonc
{
  "kind": "request", "id": "load-1", "method": "kernel.load",
  "params": {
    "manifest": {
      "id": "game.aurora", "version": "1.0.0", "protocolVersion": "1",
      "artifact": { "kind": "wasm", "entry": "./aurora.wasm" },
      "runtime": "wasm",
      "capabilities": [{ "name": "dataplane" }]
    },
    "runtime":   { "kind": "wasm", "entryPath": "/abs/path/aurora.wasm", "cwd": "/abs/path" },
    "capabilities": [{
      "name": "dataplane", "interactionMode": "unary", "executionMode": "ephemeral",
      "realtimeClass": "batch", "concurrencyPolicy": "shared", "resourceBudget": {}
    }],
    "permissions": {},
    "artifact":  { "entryPath": ".", "command": ".", "args": [], "cwd": ".", "basePath": ".", "timeoutMs": 5000 },
    "security":  { "signaturePolicy": "allow-unsigned" }
  }
}
```

进程外插件（C++/Go/Python/Rust 可执行文件，stdio 上的 JSON-RPC）：
`runtime: "process"` 带 `command`/`args`/`cwd`；以及 `artifact.command`、
`artifact.args`、`artifact.cwd`、`artifact.basePath`、`artifact.timeoutMs`。
`signaturePolicy` 默认 fail-closed —— 仅开发环境用 `allow-unsigned`
（签名细节见 README 签名章节）。

然后 `kernel.activate`，再选择驱动方式：走 `kernel.invoke`（JSON），
或——对帧关键 WASM——解析一次句柄后使用字节面：

```c
uint64_t h = emk_handle_resolve("game.aurora");
// 每帧：
int64_t written = emk_invoke_ptr(h, req, req_len, out_buf, OUT_CAP);
if (written > 0) { /* 解析 out_buf[0..written] */ }
```

### A5. WASM 宿主合约（字节面）

数据面 guest 导出 `memory` 加以下导出之一或两者：

```wat
(func (export "ext_call") (param i32 i32) (result i64))   ;; invoke
(func (export "ext_tick") (param i32 i32) (result i64))   ;; 帧/tick 批量
```

- 宿主把请求字节写进 guest 内存（`in_ptr`，长度 `in_len`），调用导出；
  guest 以打包 i64 `(out_ptr << 32) | out_len` 应答，指向**它自己**的内存。
  内核把响应拷贝到宿主的 `out` 缓冲区。
- 配额：16 MiB 内存上限（软层告警 + 硬层拒绝均入审计），每次调用确定性
  fuel（默认 2 亿指令，可由策略推导）。
- 可用模板：[`examples/rust-wasm-dataplane-template`](../examples/rust-wasm-dataplane-template)
  （no_std Rust）、[`examples/cpp-dataplane-template`](../examples/cpp-dataplane-template)
  （freestanding C++）、[`examples/cpp-embedder-demo/dataplane-guest.wat`](../examples/cpp-embedder-demo/dataplane-guest.wat)
  （最小 WAT）。

### A6. 策略（帧、内存、fuel、调度器）

装载插件前发送一次；缺省字段回落到安全默认：

```jsonc
{
  "kind": "request", "id": "policy-1", "method": "kernel.policy.set",
  "params": {
    "frame":    { "tickHz": 500, "pluginSharePct": 5 },
    "memory":   { "totalMb": 256, "tiers": { "realtimeMb": 64, "interactiveMb": 128, "batchMb": 256 } },
    "fuel":     { "perCallOverride": 200000000 },
    "scheduler": { "asyncPoolThreads": 2, "queueCap": 8 }
  }
}
```

- `frame` → 单次调用 fuel 由帧预算推导（启动时机器标定）；`memory.totalMb`
  是常驻类插件预留准入的空间；tier 按 `realtimeClass` 门控声明峰值。
- `scheduler`（opt-in）：`asyncPoolThreads > 0` 为边界运行时（进程/远程）
  启用常驻工作池。受理调用立即返回 `{accepted:true, async:true}`；真实信封
  **经守护进程 stdout** 投递（守护进程模式）。纯 C ABI 嵌入没有 sink，
  边界调用保持同步——WASM 数据面调用（帧路径）不受影响。
- 验证数字：20 插件 @500fps 整帧开销为 2ms 帧预算的 1.3%；失控 WASM 插件
  在 fuel 预算处确定性被拦；慢 100ms 进程插件与健康邻居完全隔离。

### A7. 平台清单

| | Windows x64 | Linux x64 | macOS arm64 |
|---|---|---|---|
| 库名 | `extensions_kernel.dll` | `libextensions_kernel.so` | `libextensions_kernel.dylib` |
| 加载/查找 | `LoadLibraryW` / `GetProcAddress` | `dlopen` / `dlsym` | `dlopen` / `dlsym` |
| 已知坑 | 规范化路径的 `\\?\` 前缀在拉起进程插件前需去除（内核内部已处理） | 无特殊 | 首跑做 ABI 门禁检查 |
| Demo | `examples/cpp-embedder-demo/build.ps1`（MinGW g++） | `build.sh` | `build.sh` |

---

## 轨道 B —— 通用应用（TS/Node）

目标读者：给 Node.js 产品加插件系统的应用开发者。使用预编译实时产物时
无需 Rust 工具链。

### B1. 安装

```bash
npm install extensions-manager        # 发布后；或从源码：
npm install && npm run build          # 产出 dist/（tsc），无需 Rust
```

### B2. 快速开始（local 模式）

```ts
import { ExtensionManager, NodeRuntime } from 'extensions-manager'

const manager = new ExtensionManager({ workspacePath: process.cwd() })
manager.registerRuntime(new NodeRuntime())
await manager.loadManifestFile('./plugins/aurora')     // 含 extension.json 的目录
const result = await manager.invoke('store.aurora', 'aurora.convert', { text: 'hi' })
```

完整生命周期（安装/更新/搜索/卸载，完整性固定）在 `PluginStore`；清单
schema、签名模式与 onboarding 配置见
[插件集成矩阵](../PLUGIN_INTEGRATION_MATRIX.md)与
[接入决策树](../PLUGIN_ONBOARDING_DECISION_TREE.zh-CN.md)。

### B3. 内核模式

通过 `host.config.json` 的 `kernel:` 块（或 `createExtensionManagerFromConfig`）配置：

| 模式 | 什么跑在哪 | 何时使用 |
|---|---|---|
| `local`（默认） | TS 门面直接加载插件（node/process/wasm/remote 运行时） | 标准应用 |
| `daemon` | Rust `extensionsd` sidecar 持有插件；门面走 stdio 信封协议 | 进程外治理、非 Node 运行时、由 Rust 内核强制策略准入 |
| embedded（napi） | Rust 内核以同门面进程内运行；实时 harness（`npm run test:realtime`）演示 `process.dlopen` 模式 | Node 的帧级实时（实测 500fps，20 插件占帧预算 1.3%） |

守护进程 + 策略 + 许可示例：

```json
{
  "pluginsDirectory": "./plugins",
  "kernel": {
    "mode": "daemon",
    "command": "./extensionsd.exe",
    "timeoutMs": 5000,
    "asyncInvokeTimeoutMs": 120000,
    "policy": {
      "frame": { "tickHz": 360 },
      "scheduler": { "asyncPoolThreads": 2, "queueCap": 8 }
    }
  }
}
```

异步受理模型（daemon 模式）：对边界运行时的 `kernel.invoke` 返回真实结果
——桥保持 Promise pending 穿过 `{accepted}` 标记，内核投递信封后结算
（`asyncInvokeTimeoutMs` 窗口，默认 120s；`KERNEL_BUSY` 立即拒绝）。

### B4. 实时（嵌入式 napi）路径

从 Releases 下载 `kernel.node`（或自行构建），然后：

```js
import process from 'node:process'
const mod = { exports: {} }
process.dlopen(mod, './kernel.node')
const kernel = mod.exports           // request / handleResolve / invokePtr / tickPtr / ...
kernel.installResponseSink()         // 异步调度器投递 → drainAsyncResponses()
```

完整工作循环——500fps 节拍、分位数测量、慢插件共存——在
[`realtime-tests/harness.mjs`](../realtime-tests/harness.mjs)；报告在
[`realtime-tests/REPORT.md`](../realtime-tests/REPORT.md)。

### B5. 面向 UI 的接口面（仪表盘、插件市场、设置、许可弹窗）

UI 需要的一切都是程序化调用——管理器按无头设计，UI 只是宿主里的又一个调用方。

| UI 功能 | 接口 |
|---|---|
| 插件列表 / 状态 | `manager.list()` · `getInitializationInfo(id).isActive` · `checkStatus(id)` |
| 启用 / 停用 | `manager.activate(id)` / `deactivate(id)` |
| **性能与健康面板** | `await manager.getAudit({ sinceSeq, limit })` → `{ entries, lastSeq, accounting }` —— 每插件调用数、延迟、fuel 陷阱、内存高水位、契约违约；`lastSeq` 即下一次轮询游标 |
| **治理事件实时告警**（免轮询） | `await manager.nextAuditEvent()` —— 内核记录审计条目的瞬间即送达（准入拒绝、fuel 陷阱、内存压力/拒绝、`leak.suspected`、`contract.violation`、`invoke.busy`）；事件同样经守护进程 stdout 与 napi `drainAsyncResponses()` 通道流出，形如 `{"kind":"audit","entry":{…}}` |
| **插件市场** | `await store.installFromRegistry(registryUrl, extensionId)` —— 拉取注册表索引，校验 bundle sha256（对整包字节取 `sha256-<hex>`，逐文件摘要同样校验），拒绝路径穿越与非环回明文 http，然后安装 |
| **插件设置页** | 清单 `settings: [{ key, type: 'string'\|'number'\|'boolean'\|'enum', title?, default?, enum?, min?, max? }]` → `manager.getSettingDefinitions(id)`（UI 通用渲染）、`manager.getSettingValues(id)`、`manager.setSetting(id, key, value)`（带校验）。值在每次（重）激活时以 `context.settings` 下发——调 `reinitialize(id)` 即时生效 |
| **许可弹窗** | 清单 `capabilities[].permission: 'prompt'` + 管理器选项 `onCapabilityPermission: async ({ extensionId, capability }) => boolean`。该能力首次使用时每个激活周期提示一次（缓存决策）；无处理器 = fail-closed |

轨道 A 宿主同样拥有对应能力：`emk_request("kernel.audit.query", …)` 轮询；
安装了响应 sink 的嵌入侧会收到 `{"kind":"audit"}` 行事件。

---

## 下一步

- 原始数据面合约 + 策略参考：[embedded-kernel-data-plane.md](embedded-kernel-data-plane.md)
- 插件开发（13 种语言/形态矩阵、签名、onboarding kit）：[插件集成矩阵](../PLUGIN_INTEGRATION_MATRIX.md)
- 手工安装插件完整性：[manual-install-integrity-guide.md](manual-install-integrity-guide.md)
- 调度器设计 + 实施记录：[scheduler spike §7](superpowers/plans/2026-09-06-scheduler-spike.md)
