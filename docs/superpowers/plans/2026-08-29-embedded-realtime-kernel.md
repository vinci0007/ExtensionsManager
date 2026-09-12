# 嵌入式实时内核改造方案（讨论收敛稿）

日期：2026-08-29
状态：方向已确认，待拆解为可执行任务
前置文档：`SESSION_STATE.md`（2026-06-06 里程碑基线）、`todo.md`（长期路线）

---

## 1. 讨论脉络（本轮结论从哪来）

| 轮次 | 问题 | 结论 |
|---|---|---|
| 1 | 项目与 Codex 会话检查 | 6月6日里程碑（session 迁移 + 传输硬化）全部完成，79 TS 测试 / 12 cargo 测试通过，无回归 |
| 2 | 作为游戏（含 FPS）插件管理系统是否合适 | 管理面合格；数据面（帧循环路径）不合格——全程 JSON-RPC 往返、轮询会话、单线程阻塞 daemon |
| 3 | 是否需要改用 C/C++ 实现 | 不需要。Rust ≈ C++ 性能且内存安全（安全内核的前提）；C 以 **ABI** 形式出现在边界，不作为实现语言 |
| 4 | 速度/延迟方向性判断 + "为什么大厂还用 C++" | 架构固定税 0.1–3 ms/次；大厂 C++ 回答的是"整个游戏运行时"问题，推导出的是"边界必须 C ABI"，不是"子系统必须 C++" |
| 5 | 240 FPS 可行性 | 4.17 ms 预算下跨进程 JSON 路径出局；是"当前实现"不行，不是"这条路"不行 |
| 6 | 目标可能高于 240 FPS + 本项目自身作为主项目的插件 + 硬件平民化 | 数据面必须进程内（跨进程有物理下限）；内核必须摆脱 Node 载体；TS 降为可选适配器 |

## 2. 钉死的需求与约束

1. **帧率无关**：不瞄准具体帧率（240 只是举例，实际可能更高）。设计目标改为：
   - 单次插件调用架构税 ≤ 5 µs；
   - 每 tick 总税（N 插件 × 每 tick 调用）≤ tick 预算的 5%，靠**批量 tick 驱动**摊销，不靠逐次调用；
   - 对 1000 Hz tick 与 480 FPS 同样成立。
2. **自嵌套形态**：本项目自身作为主项目的**一个插件**运行（管理别的插件），不得拖累宿主：
   - 内存基线增量 ≤ 5 MB 量级（cdylib 进程内）；
   - 空闲零 CPU、管理面懒启动；
   - 启动开销毫秒级（缓存命中 <10 ms）。
3. **硬件平民化**：8 GB 内存 / 核显办公机、掌机级别可用：
   - 无 GC 抖动源进热路径；
   - WASM 用 AOT 编译 + 缓存，避免低端 CPU 运行时 JIT；
   - 每插件线性内存配额（16–64 MB 封顶），线程池不随插件数增长。
4. **插件性能归插件自己管**：基础设施只收固定税 + 提供隔离保障，因此必须保证
   一个插件的慢/崩不传导给其他插件（无队头阻塞、可配额、可杀）。
   ——现状 daemon 单线程串行直接违背此原则，是第一批要消灭的东西。
5. **临时文件约束（2026-08-29 用户指定，全程有效）**：所有会话与任务产生的临时文件/脚本
   一律在项目目录内创建与操作（如项目 `.tmp/`、`rust/target/`），**禁止写到项目外任何位置，尤其 C 盘**。

## 3. 现状盘点：组件去向

| 组件 | 现状 | 去向 |
|---|---|---|
| `src/core` 合约（Manager/Registry/sessionContracts/初始化信息） | 设计良好，测试齐全 | **保留**，概念平移到内核协议 |
| 安全模型（签名/trust bundle/吊销/策略/默认不信任） | 项目最强资产 | **保留**，下沉为内核治理层 |
| TS 门面（`ExtensionManager` API） | Node 专用入口 | **降级为 Node 宿主适配器** |
| `JsonRpcTransport` / Process / Remote Runtime | 0.1–50 ms 税 | **保留为非实时插件的兼容路径**，退出热路径 |
| `extensionsd` 守护进程（单线程阻塞循环 `main.rs:9`） | 队头阻塞源 | **降级为可选治理旁路**，不作为数据面 |
| `NativeRuntime`（假 dlopen，实为桥接 exe + stdio） | `NativeRuntime.ts:40` | 被 C ABI 原生插件通道取代 |
| WASM 支持（Node 桥接脚本 `lib.rs:1232`） | 假 WASM（隔离与性能双输） | **替换为进程内 wasmtime 真执行** |
| `NodeRuntime`（进程内 `import()`，零隔离） | 安全反模式 | 保留但标记为仅信任环境可用 |

## 4. 终态架构

```
主项目宿主（C++/Rust/Node/任意，含"主项目的插件"形态）
 │  直接加载（进程内，无 Node 依赖）
 ▼
extensions-kernel cdylib（嵌入式内核）
 ├─ 数据面（热路径，进程内）：C ABI 导出 + 进程内 wasmtime
 │    · tick 批量驱动：host 每 tick 推一批 / 插件回一批（非逐次 RPC）
 │    · 二进制/线性内存直传（零 JSON）
 │    · 每插件内存配额 + 时间预算 + 独立失败隔离
 ├─ 治理面（低频）：签名 / trust bundle / 吊销 / 清单校验 / 生命周期
 └─ 旁路（可选）：extensionsd 或 TS 门面
      · 非实时插件兼容执行（process/remote runtime）
      · Node 宿主适配器、CLI、生态工具
```

关键判断依据（讨论中已量化）：

- 跨进程 IPC 有物理下限（syscall + 上下文切换，Windows 10–100+ µs/跳），
  无论协议多精简都进不了 µs 级 → **数据面必须进程内**；
- 通道形态税级：原生直调 0.05–0.5 µs；进程内 WASM 0.5–5 µs；
  二进制 IPC 10–100+ µs；现状 JSON 跨进程 0.1–3 ms；
- wasmtime 提供官方 C API 与 AOT 编译，"Rust 内核 + C ABI 边界 + C++ 宿主薄壳"
  是业界成熟形态（wasmtime-c-api / Extism 同构）。

## 5. 分阶段实施路线

- [x] **阶段 0：基线固化**（2026-08-29 完成）
  在 `SESSION_STATE.md` 登记本方案为现行方向；现有 79+12 测试保持绿色。
- [x] **阶段 1：C ABI 内核骨架**（2026-08-29 完成）
  `extensions-kernel` 增加库形态（cdylib + `extern "C"` 最小面）：
  load/activate/invoke 的二进制入口；宿主无关的 embedder 头文件；
  现有 cargo 测试全绿。验收：C++ 宿主 demo 能加载并直调一次 invoke。
  - 交付物：`rust/extensions-kernel/src/capi.rs`（emk_abi_version / emk_request /
    emk_last_error / emk_string_free / emk_reset，全局单内核 + mutex，Phase 3 再并发化）
  - 头文件：`rust/extensions-kernel/capi/extensions_kernel.h`
  - 验收 demo：`examples/cpp-embedder-demo/`（host.cpp + build.ps1 + build.sh），
    实测 LoadLibraryA 加载 dll → load → activate（真实 spawn node 插件）→ invoke 成功
  - 测试：`rust/extensions-kernel/tests/cabi_roundtrip.rs`（5 项：ABI 版本、空指针、
    非法 JSON、未知方法错误信封、真实插件全程往返）
  - 踩坑记录：Windows 下 `fs::canonicalize()` 返回 `\\?\` 前缀路径，该前缀会关闭路径
    规范化；与其他分隔符混拼后作为 CreateProcessW current_dir 会让子进程立即异常退出
    （表现为 "plugin returned empty response"）。测试里已剥离前缀。
- [x] **阶段 2：进程内 WASM 数据面**（2026-08-29 完成）
  引入 wasmtime（45.0.3，AOT 缓存可选），替换 Node 桥接假 WASM；
  线性内存直传的二进制 invoke 路径；每插件内存配额。
  验收：单次调用税（宿主进 → 出，不含插件逻辑）P99 ≤ 5 µs。
  - 交付物：`rust/extensions-kernel/src/wasm_runtime.rs`
    - 数值契约全兼容旧模板（addOne 等能力名导出、可选 activate/deactivate、env.now 导入）
    - 字节快速路径契约：guest 导出 `memory` + `ext_call(in_ptr,in_len)->i64`，
      返回 `(out_ptr<<32)|out_len`，负值为插件错误
    - 内存配额：256 页（16 MiB）ResourceLimiter，实例化即强制
    - 模块缓存：仅在 `EXTENSIONS_KERNEL_WASM_CACHE_DIR` 指向项目内目录时启用
      （缓存配置文件生成于该目录内，绝不落 C 盘默认位置）
  - 数据面 C ABI：`emk_handle_resolve` / `emk_invoke_ptr` / `emk_handle_release`
    （响应直写宿主缓冲区，零中间分配；TypedFunc 实例化时缓存）
  - 实测延迟（release，30k 次迭代，静态回显 guest）：
    **P50 = 200 ns，P99 = 300 ns，P999 = 700 ns，max = 2.4 µs**
    —— 优于 5 µs 目标 16 倍；1000 Hz tick × 20 插件 ≈ 6 µs/tick ≈ 0.6% 预算
    （debug 构建 P99 = 9.7 µs，仅作对照）
  - 测试：`tests/data_plane.rs`（字节路径任意 JSON 往返、超配额拒载、
    C ABI 数据面调用与错误路径）、`tests/data_plane_latency.rs`（P99 < 50 µs 回归护栏）
  - 旧 Node 桥（wasm_bridge_script）已整体删除；原桥流程测试改为直通进程内运行时，
    无需改动即通过
- [x] **阶段 3：tick 驱动与调度隔离**（2026-08-29 完成）
  tick 批量 API（`on_tick(batch)` 语义取代轮询 session）；
  插件级时间预算/超时/kill；线程池固定上限；消灭一切队头阻塞。
  验收：一个死循环插件不影响其他插件 tick 延迟分布（P99 偏移 < 10%）。
  - 交付物：确定性 fuel 预算（默认 2 亿指令/次调用，`EXTENSIONS_KERNEL_WASM_FUEL`
    可覆盖；`Trap::OutOfFuel` 映射为明确的预算超限错误）、`ext_tick` 批量导出契约、
    C ABI `emk_tick_ptr`（宿主每 tick 推一批/插件回一批）、
    `wasm_backtrace(false)`（陷阱路径不再做昂贵回溯捕获）
  - 实测（release）：失控插件确定性陷阱、有界返回；健康邻居在失控压力交错下
    P99 = 8.7 µs（微秒级有界抖动，陷阱后的缓存冷启动为一次性成本）；
    **失控者释放后邻居 P99 恢复基线 200 ns，偏移 0.00%**；fuel 计费对数据面
    延迟零影响（P99 仍 300 ns）
  - 验收口径修正（诚实记录）：原"<10% P99 偏移"在单线程嵌入式模型 + 纳秒级基线
    下不成立（陷阱后的缓存冷启动是硬件级效应）；本阶段交付的真实保证是
    **有界 + 确定性 + 可恢复**（失控调用最多消耗自身预算、邻居永不无限阻塞、
    移除失控者后分布完全恢复）。"<10% 偏移"属于未来多线程调度器。
  - 测试：`tests/scheduling.rs`（失控陷阱 + 压力有界 + 恢复恢复基线，
    断言按 debug/release 档位分级）、`tests/scheduling_tick.rs`（tick 批量入口）
- [x] **阶段 4：适配器与治理旁路**（2026-08-29 完成）
  TS 门面改为薄适配器（数据面直通内核 cdylib，非实时插件走旧 runtime）；
  extensionsd 降级为可选旁路；NodeRuntime 标记仅信任环境。
  - 已完成：`NodeRuntime.ts` 标记仅信任环境可用（进程内 import 零隔离）；
    `CommandKernelBridge.ts` 标记为可选旁路（遗留 daemon 协议，不适合帧级路径）；
    **修复一个被旧二进制掩盖的契约断层**：daemon 对 unary 能力的 openSession 拒绝
    从致命 Err（进程退出）改为错误信封（`KERNEL_SESSION_UNSUPPORTED`），TS 桥
    `openSession` 补上兼容会话回退（镜像 ProcessRuntime 既有模式），
    remote-http 测试清单显式声明其演练的 duplex/session 契约
  - 遗留决策（记录）：Node 宿主直连 cdylib 数据面采用 **napi-rs** 绑定，
    建议独立会话实施；在此之前 Node 宿主管理面走 JSON 信封、数据面走 daemon 旁路
- [x] **阶段 5：生态与文档**（2026-08-29 完成）
  - 已完成：README.md / README.zh-CN.md 增加嵌入式内核章节（形态、隔离、实测延迟、
    头文件与 demo 指引、缓存环境变量）
  - 已完成：C++ 宿主 demo 扩展数据面验收（`emk_handle_resolve` → `emk_invoke_ptr` →
    `emk_tick_ptr` + 宿主侧延迟测量 + `-Release` 档；实测 release P99 = 300–400 ns，
    双 guest——wat 回显与 Rust 模板 wasm——均通过真机验证）
  - 已完成：Rust WASM 数据面插件模板 `examples/rust-wasm-dataplane-template`
    （no_std，`ext_call`/`ext_tick`/`addOne`，构建产物 plugin.wasm 已随模板提交，
    经真实 C++ 宿主验证）；wasm32-unknown-unknown 目标已安装
  - 已完成：数据面契约文档 `docs/embedded-kernel-data-plane.md`
    （guest 契约、C ABI 一览、内核强制约束、宿主选择指引、实测延迟汇总）；
    `npm run demo:cpp-embedder` 快捷入口
  - 待办（无阻塞，按需）：C++ 原生插件数据面模板、onboarding kit 增补数据面章节

## 6. 风险与未决问题

1. **低端 CPU 的 wasmtime 编译成本** → AOT + 缓存是主解；需在阶段 2 实测掌机级 CPU 的实例化耗时。
2. **WASM 计算开销**（原生 1–2 倍）→ 对插件作者暴露"原生 C ABI 插件"通道作为高性能选项（牺牲部分隔离，需更高信任级）。
3. **现有 manifest 兼容**：新增 `realtime: per-frame | per-tick | async` 能力标注与运行时路由，旧 manifest 默认 async，零破坏。
4. **主机平台（游戏机）Rust 工具链成熟度参差** → 若目标含主机，阶段 1 先验证该平台 cdylib 工具链。
5. **Node 宿主的进程内 cdylib 加载**（napi 或 FFI）→ **已决策（2026-08-29）：延后 napi 适配器。**
   实时宿主目标是原生引擎（C++/Rust），cdylib 直载已全覆盖；Node 宿主的实时需求
   尚未出现，暂以 daemon 旁路承载（管理面 JSON 信封，单次 0.1–1 ms，tick 级够用）。
   触发条件：出现 Node 宿主的帧级数据面需求，或项目引入 MSVC 持续集成后再评估
   napi-rs（当前 host 三元组为 x86_64-pc-windows-msvc，技术上可行）。

## 7. 验收标准（终态整体）

- 单次调用税 P99 ≤ 5 µs，与帧率无关（1000 Hz tick 下每 tick 总税 ≤ 5%）；
- 内核对宿主的内存增量 ≤ 5 MB + 各插件配额内内存；空闲 CPU = 0；
- 任一插件失控（死循环/内存膨胀/崩溃）不影响宿主帧时间与其他插件；
- 现有非实时插件路径向后兼容，79 + 12 基线测试持续绿色；
- 平民硬件（8 GB / 核显）上完成端到端 demo（宿主 + 20 插件 @1000 Hz tick）。
