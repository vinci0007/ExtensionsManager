# 插件接入决策树

这份文档用于帮助插件开发方或宿主侧团队快速决定：

- 该选哪种 `runtime`
- 该选哪种 `artifact.kind`
- 该参考哪个模板
- 该选哪种签名认证模式

---

## 一、先判断插件运行语言

### 1. 如果插件本身是 JS / TS

继续判断：

#### 1.1 是否希望插件运行在宿主进程内？

- **是** → 选择：
  - `runtime: "node"`
- **否** → 选择：
  - `runtime: "process"`
  - 走 stdio 上的 JSON-RPC

#### 1.2 如果选 `runtime: "node"`，再判断产物形式

- 单文件入口 → `artifact.kind: "module"` 或 `source-file`
- 源码目录 → `artifact.kind: "source-dir"`
- 已构建包 / dist 输出 → `artifact.kind: "package"`

#### 1.3 推荐参考

- 基础 Node 模块插件：`examples/node-extension`
- 源文件插件：`examples/node-source-file-extension`
- 源目录插件：`examples/node-source-dir-extension`
- 包式插件：`examples/node-package-extension`

---

### 2. 如果插件不是 JS / TS，而是 Python / Rust / Go / C / C++ 等语言

默认优先选择：

- `runtime: "process"`
- 通过 **stdio + JSON-RPC** 接入

#### 2.1 是否能产出独立可执行文件？

- **是** → 选择：
  - `artifact.kind: "binary"`
- **否** → 继续看下面几项

#### 2.2 是否只是静态库 `.a` / `.lib`？

- **是** → 当前**不能直接作为插件产物接入**
- 处理方式：
  - 包一层独立进程可执行文件，再走 `runtime: "process"`
  - 或未来如果有专门 native adapter，再通过适配器引入

#### 2.3 是否是动态库 `.dll` / `.so` / `.dylib`？

- **是** → 当前只能做 manifest 建模：
  - `runtime: "native"`
  - `artifact.kind: "shared-library"`
- 但要注意：**当前 native runtime 仍是占位实现，还不能真正加载**

#### 2.4 是否是 WASM 产物？

- **是** → 当前可以建模：
  - `runtime: "wasm"`
  - `artifact.kind: "wasm"`
- 但要注意：**当前 wasm runtime 仍是占位实现，还不能真正加载**

#### 2.5 推荐参考模板

- Python：`examples/process-python-extension`
- Rust：`examples/rust-process-extension-template`
- Go：`examples/go-process-extension-template`
- C：`examples/c-process-extension-template`
- C++：`examples/cpp-process-extension-template`
- 编译后二进制通用模板：`examples/process-binary-extension-template`

---

## 二、再判断签名模式

### 1. 是否要求生产环境严格验签？

- **是** → 选择：
  - `signaturePolicy: "require-signature"`
- **否** → 可选：
  - `allow-unsigned`
  - `require-signature-except-development`

### 2. 公钥信任源怎么放？

#### 2.1 如果是正式环境 / 多插件 / 需要轮换密钥

推荐：

- `trustedKeyMode: "file"`
- 公钥放到：`trusted-keys/<keyId>.pem`

优点：

- 公钥和插件包分离
- 更利于运维管理
- 更利于 key rotation
- 不把公钥数据散落在多份配置里

#### 2.2 如果是演示 / 测试 / 嵌入式单文件配置

可选：

- `trustedKeyMode: "inline"`
- 在配置内直接写 PEM 公钥字符串

---

## 三、按语言直接选模板

### JS / TS 进程内插件

- 推荐 runtime：`node`
- 推荐产物：`module` / `source-file` / `source-dir` / `package`
- 推荐配置：`examples/onboarding-kit/plugin-onboarding.config.json`

### Python 插件

- 推荐 runtime：`process`
- 推荐产物：`binary`
- 推荐示例：`examples/process-python-extension`
- 推荐签名模式：`file`

### Rust 插件

- 推荐 runtime：`process`
- 推荐产物：`binary`
- 推荐模板：`examples/rust-process-extension-template`
- 推荐签名模式：`file`

### Go 插件

- 推荐 runtime：`process`
- 推荐产物：`binary`
- 推荐模板：`examples/go-process-extension-template`
- 推荐配置：
  - `plugin-onboarding.go.file.config.json`
  - `plugin-onboarding.go.inline.config.json`

### C 插件

- 推荐 runtime：`process`
- 推荐产物：`binary`
- 推荐模板：`examples/c-process-extension-template`
- 推荐配置：
  - `plugin-onboarding.c.file.config.json`
  - `plugin-onboarding.c.inline.config.json`

### C++ 插件

- 推荐 runtime：`process`
- 推荐产物：`binary`
- 推荐模板：`examples/cpp-process-extension-template`
- 推荐配置：
  - `plugin-onboarding.cpp.file.config.json`
  - `plugin-onboarding.cpp.inline.config.json`

---

## 四、最终落地建议

如果你不确定，默认按下面的顺序决策：

1. **能用 JS / TS 进程内插件吗？**
   - 能 → 用 `runtime: "node"`
2. **不能的话，能产出独立可执行文件吗？**
   - 能 → 用 `runtime: "process"` + `artifact.kind: "binary"`
3. **是否要生产可控签名？**
   - 要 → `signaturePolicy: "require-signature"`
4. **公钥怎么管理？**
   - 正式环境 → `trustedKeyMode: "file"`
   - 演示/测试 → `trustedKeyMode: "inline"`

---

## 五、与矩阵文档配合使用

如需按“语言 / artifact / 是否支持 / 对应配置”横向对比，请配合阅读：

- `PLUGIN_INTEGRATION_MATRIX.zh-CN.md`
