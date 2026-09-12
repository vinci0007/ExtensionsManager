# 插件接入矩阵

这是一份面向插件作者和接入方的专用兼容性与接入矩阵文档。

如果你不想看矩阵，而是想按问题一步步做决策，请参考：

- `PLUGIN_ONBOARDING_DECISION_TREE.zh-CN.md`

## 接入矩阵

| 语言 / 产物形式 | 推荐 runtime | 推荐 artifact.kind | 当前可直接运行 | 是否支持签名 | 推荐接入配置 | 示例 / 模板 |
| --- | --- | --- | --- | --- | --- | --- |
| JS / TS 进程内模块 | `node` | `module` | 是 | 是 | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-extension` |
| JS / TS 源文件 | `node` | `source-file` | 是 | 是 | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-source-file-extension` |
| JS / TS 源目录 | `node` | `source-dir` | 是 | 是 | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-source-dir-extension` |
| JS / TS 包产物 | `node` | `package` | 是 | 是 | `examples/onboarding-kit/plugin-onboarding.config.json` | `examples/node-package-extension` |
| Node 子进程 | `process` | `binary` | 是 | 是 | `examples/onboarding-kit/plugin-onboarding.file.config.json` | `examples/process-extension` |
| Python 子进程 | `process` | `binary` | 是，前提是已安装 Python | 是 | `examples/onboarding-kit/plugin-onboarding.file.config.json` | `examples/process-python-extension` |
| Rust 可执行文件 | `process` | `binary` | 当前是模板 | 是 | 参考 process 的 file / inline 配置模式 | `examples/rust-process-extension-template` |
| Go 可执行文件 | `process` | `binary` | 当前是模板 | 是 | `plugin-onboarding.go.file.config.json` / `plugin-onboarding.go.inline.config.json` | `examples/go-process-extension-template` |
| C 可执行文件 | `process` | `binary` | 当前是模板 | 是 | `plugin-onboarding.c.file.config.json` / `plugin-onboarding.c.inline.config.json` | `examples/c-process-extension-template` |
| C++ 可执行文件 | `process` | `binary` | 当前是模板 | 是 | `plugin-onboarding.cpp.file.config.json` / `plugin-onboarding.cpp.inline.config.json` | `examples/cpp-process-extension-template` |
| 动态库（`.dll` / `.so` / `.dylib`） | `native` | `shared-library` | 否，仅有 runtime 占位 | manifest 签名支持；运行时加载未实现 | 暂无 | `examples/native-shared-library-template` |
| WASM 产物 | `wasm` | `wasm` | 是——两条已实现路径：TS 门面运行时（内存配额守卫）与嵌入式 Rust 内核字节面数据通道（`ext_call`/`ext_tick`，release P99 ≈ 0.9µs，16MiB 配额 + 确定性 fuel） | manifest 签名支持 | `plugin-onboarding.wasm.file.config.json` / `plugin-onboarding.wasm.inline.config.json` | `examples/rust-wasm-dataplane-template`、`examples/cpp-dataplane-template`、`examples/cpp-embedder-demo/dataplane-guest.wat`；实测数据见 `docs/embedded-kernel-data-plane.md` 与 `docs/host-integration-guide.md` |
| 静态库（`.a` / `.lib`） | 不是直接模式 | 不是直接模式 | 否 | 不是当前可直接加载的插件产物 | 不适用 | 需要包成进程插件或其他适配层 |

## 签名认证模式矩阵

| 信任模式 | 验签来源 | 推荐用途 | 当前是否支持 |
| --- | --- | --- | --- |
| `file` | `trusted-keys/<keyId>.pem` 公钥文件 | 生产环境、多插件宿主、便于轮换密钥 | 是 |
| `inline` | 配置中的 PEM 公钥字符串 | 演示、测试、内嵌式分发 | 是 |

默认推荐：`trustedKeyMode: "file"`。

## 选型建议

- 如果插件本身就是 JS / TS，并且可以安全地运行在宿主进程内，优先用 `runtime: "node"`。
- 如果插件来自其他语言，优先用 `runtime: "process"`，通过 stdio 上的 JSON-RPC 接入。
- 如果插件产物是编译后的独立可执行文件，使用 `artifact.kind: "binary"`。
- 如果插件产物是动态库，当前可以先完成 manifest 建模，但在 native runtime 实现之前还不能真正加载。
- 静态库不是当前架构下可直接加载的插件产物。

## 关于签名

- manifest 签名能力独立于 runtime 类型。
- 被签名的是 `extension.json`。
- 私钥保留在插件发布方。
- 宿主使用可信公钥验签，来源可以是文件模式或内联模式。
