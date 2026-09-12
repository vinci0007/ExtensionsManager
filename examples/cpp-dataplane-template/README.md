# C++ WASM 数据面插件模板

面向 C++ 插件作者的 WASM 数据面模板：用 C++ 编写 `ext_call` / `ext_tick`
契约的 guest 模块，编译为 wasm 后经嵌入式内核进程内执行。

## 契约（与 `docs/embedded-kernel-data-plane.md` 一致）

- 导出 `memory`（线性内存，宿主配额 16 MiB）；
- `ext_call(in_ptr: i32, in_len: i32) -> i64`：请求字节已由宿主写入偏移 0；
  返回 `(out_ptr << 32) | out_len`（负值 = 插件失败）；
- 可选 `ext_tick`：tick 批量入口（同传输约定）；
- 可选 `env.now` 导入（epoch 毫秒）。

## 构建

需要 **clang ≥ 16**（wasm32 freestanding 目标；gcc 不支持 wasm 输出——
MinGW 的 g++ 不能用）。wasi-sdk 或带 wasm-ld 的 clang 均可：

```bash
clang++ --target=wasm32 -O2 -nostdlib -Wl,--no-entry \
  -Wl,--export=ext_call -Wl,--export=ext_tick -Wl,--export=memory \
  -Wl,--allow-undefined -fno-exceptions -fno-rtti \
  plugin.cpp -o plugin.wasm
```

## 文件

- `plugin.cpp` — freestanding C++ 实现（无 CRT、无异常），含字节契约的
  读/写辅助与 `ext_call`/`ext_tick` 示例实现；
- 对照实现（手写 WAT，可直接被本仓库测试与探针加载）：
  `../cpp-embedder-demo/dataplane-guest.wat`。

## 运行

将 `plugin.wasm` 经内核装载（`runtime.kind = "wasm"`，
`entryPath = ./plugin.wasm`）。内核侧强制约束：16 MiB 内存配额、每次调用
fuel 预算（可由宿主帧预算推导）、输入 ≤ 1 MiB 写入偏移 0。

## 注意

- freestanding C++ 无堆/异常/RTTI——动态分配需自带分配器（在 WASM 线性
  内存内自管，注意与宿主写入偏移 0 的输入区隔离，建议输入区固定 1 页）；
- 线性内存不可被宿主强制收缩：大缓冲的分配/释放策略由插件分配器决定，
  内存高水位会被内核记账并用于泄漏侦测（`leak.suspected` 审计事件）。
