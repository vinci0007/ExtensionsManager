# ExtensionsManager（中文说明）

ExtensionsManager 是一个面向 Node.js Host 的多运行时插件管理模块，用于统一插件的加载、激活、调用与停用，并向上游提供稳定的扩展管理接口。

## 嵌入式实时内核（Rust / C ABI）

自 2026-08 起，内核以可嵌入的 cdylib 形态发布（`extensions_kernel.dll` /
`libextensions_kernel.so`），任何语言都可以在宿主进程内直接加载，无需 Node。

- 管理面：`emk_request` 承载 JSON 内核信封（load / activate / invoke / 生命周期），
  与 `extensionsd` 守护进程同一套协议
- 数据面：基于 wasm 线性内存的字节通道（`emk_handle_resolve`、`emk_invoke_ptr`、
  `emk_tick_ptr`、`emk_handle_release`），面向逐 tick 驱动的实时宿主
- 进程内 WASM（wasmtime）：数值契约（能力名导出，兼容 `wasm-extension-template`）、
  可选字节快速路径（`memory` + `ext_call`）、可选 `ext_tick` 批量入口
- 隔离：每插件 16 MiB 内存配额；确定性每次调用 fuel 预算（默认 2 亿指令，
  可用 `EXTENSIONS_KERNEL_WASM_FUEL` 覆盖）——失控插件在预算处确定性陷阱，
  不会挂死宿主
- 实测数据面单次税（release）：**P99 约 300 纳秒**——满足 240 FPS 以上游戏循环
  与 1000 Hz tick 调度器
- C 头文件：`rust/extensions-kernel/capi/extensions_kernel.h`
- C++ 宿主示例：`examples/cpp-embedder-demo`（MinGW g++ 构建，产物留在项目内；
  `-Release` 档查看延迟数字，release 实测 P99 = 300–400 纳秒）
- 数据面 guest 契约与宿主指引：`docs/embedded-kernel-data-plane.md`
- Rust WASM 数据面插件模板：`examples/rust-wasm-dataplane-template`
- 路线图与验收结果：`docs/superpowers/plans/2026-08-29-embedded-realtime-kernel.md`

wasmtime 模块缓存为可选：将 `EXTENSIONS_KERNEL_WASM_CACHE_DIR` 指向宿主项目内的
目录即可（缓存配置文件生成于该目录内）。

### 性能策略引擎

声明一份性能预算，内核即自动推导并强制每插件限额（无需环境变量）：

```json
{
  "policy": {
    "frame": { "tickHz": 500, "pluginSharePct": 5 },
    "memory": { "totalMb": 512, "tiers": { "realtimeMb": 64, "interactiveMb": 128, "batchMb": 256 } }
  }
}
```

- 帧预算 → 一次性机器标定后自动推导每调用 fuel（失控客体在声明切片内被确定性陷阱）；
- 内存分级门控清单声明的 `resourceBudget.memoryMb`，并驱动每插件 soft/hard
  双层 limiter（soft 内自由 / pressure 计数 / hard 拒绝）；
- `extensionClass: "resident"`（逐帧关键 + 大内存）要求从 `memory.totalMb`
  预留声明峰值 + 声明 `fuelPerTick` 摊销契约（持续超切片 → 审计违约事件）；
- 可例外溢出以 `KERNEL_CONSENT_REQUIRED` 呈现，经 `onPolicyConsent` 钩子批准
  （无钩子 = fail-closed）；
- 全链路可审计：`kernel.audit.query`（有界环）+ 按插件记账
  （调用数/耗时/fuel 消耗/内存高水位）。

完整策略参考见 `docs/embedded-kernel-data-plane.md`。

## 支持的扩展形式

- Node 包 / 模块型插件
- 外部进程型插件
- 通过 manifest 解析的源文件与源目录
- 通过启动元数据描述的平台相关二进制入口
- WASM 模块（经 Rust 内核进程内执行；数值或字节两种契约）

## Manifest

每个扩展都通过一个 `extension.json` manifest 描述。

- `artifact.kind`：描述扩展产物形式
- `artifact.entry`：指向入口文件或平台映射
- `artifact.launch`：配置进程型扩展的启动方式
- `artifact.integrity`：可选，用于固定产物摘要
- `signature`：可选，用于保护 manifest 本身
- `runtime`：选择运行时适配器
- `capabilities`：声明暴露的能力列表

## Node 扩展

Node 扩展需要导出一个 `capabilities` 映射。

```js
export default {
  capabilities: {
    'demo.hello': async () => ({ message: 'hello' }),
  },
}
```

## 进程扩展

进程型插件通过 stdio 上的 JSON-RPC 进行通信。

## 多种插件模式示例

仓库中现在包含了多种语言、多种插件格式的接入示例。

跨语言兼容性与接入方式的专用表格请参考 `PLUGIN_INTEGRATION_MATRIX.zh-CN.md`。

如果希望按问题一步步判断该接入哪种模式，请参考 `PLUGIN_ONBOARDING_DECISION_TREE.zh-CN.md`。

### 当前实现可直接运行的示例

- `examples/node-extension` - 基础 Node 模块插件
- `examples/node-source-file-extension` - `artifact.kind: "source-file"` 的 Node 源文件插件
- `examples/node-source-dir-extension` - `artifact.kind: "source-dir"` 的 Node 源目录插件
- `examples/node-package-extension` - `artifact.kind: "package"` 的 Node 包式插件
- `examples/process-extension` - 基于 JSON-RPC over stdio 的 Node 子进程插件
- `examples/process-python-extension` - 基于 JSON-RPC over stdio 的 Python 子进程插件

可以通过下面的命令统一演示多种格式：

```bash
npm run demo:formats
```

### 当前可用或适合外部构建的模板

- `examples/process-binary-extension-template` - 编译后可执行文件插件模板
- `examples/rust-process-extension-template` - Rust 进程插件模板
- `examples/go-process-extension-template` - Go 进程插件模板
- `examples/c-process-extension-template` - C 进程插件模板
- `examples/cpp-process-extension-template` - C++ 进程插件模板
- `examples/native-shared-library-template` - native bridge 进程 + 动态库插件模板
- `examples/wasm-extension-template` - WASM 插件模板

### 选型建议

- JS / TS 插件优先使用 `runtime: "node"`，由宿主进程内加载。
- Python、Rust、Go、C++ 等语言优先使用 `runtime: "process"`，通过 stdio 上的 JSON-RPC 接入。
- 编译后的独立可执行文件使用 `artifact.kind: "binary"`。
- 动态库 `.dll` / `.so` / `.dylib` 使用 `runtime: "native"`，并通过 bridge 进程方式加载。
- 静态库不是当前架构下可直接加载的插件产物；它需要被链接进宿主程序，或再包一层可执行进程 / 其他 runtime 适配器。

## 专用接入套件

仓库提供了一套可直接复用的插件接入套件，位于 `examples/onboarding-kit`。

它的目标是：新插件接入时，通常只需要修改一个配置文件，或少量几个字段，就可以直接接入并验证签名。

包含内容：

- `PLUGIN_ONBOARDING_GUIDE.md` - 专用接入说明文档
- `plugin-onboarding.config.json` - 默认可复用接入配置
- `plugin-onboarding.file.config.json` - 基于文件公钥的配置示例
- `plugin-onboarding.inline.config.json` - 基于内联公钥字符串的配置示例
- `plugin-onboarding.go.file.config.json` - Go 进程插件的文件模式接入配置
- `plugin-onboarding.go.inline.config.json` - Go 进程插件的内联模式接入配置
- `plugin-onboarding.c.file.config.json` - C 进程插件的文件模式接入配置
- `plugin-onboarding.c.inline.config.json` - C 进程插件的内联模式接入配置
- `plugin-onboarding.cpp.file.config.json` - C++ 进程插件的文件模式接入配置
- `plugin-onboarding.cpp.inline.config.json` - C++ 进程插件的内联模式接入配置
- `plugin-onboarding.native.file.config.json` - native bridge 插件的文件模式接入配置
- `plugin-onboarding.native.inline.config.json` - native bridge 插件的内联模式接入配置
- `plugin-onboarding.wasm.file.config.json` - WASM 插件的文件模式接入配置
- `plugin-onboarding.wasm.inline.config.json` - WASM 插件的内联模式接入配置
- `extension.template.json` - 可直接复制修改的 manifest 模板
- `trusted-keys/` - 放置签名公钥文件的目录

可以通过下面命令演示整套接入流程：

```bash
npm run demo:onboarding
```

该演示现在会同时准备并验证 Node、native bridge、WASM 三类插件的已签名接入流程。

## 签名与可信 Key

你可以生成密钥对、对 manifest 签名，并在加载时使用可信 key 验签。

```ts
import {
  generateSigningKeyPair,
  signManifest,
  PublicKeySignatureVerifier,
  InMemoryTrustedKeyStore,
  FileTrustedKeyStore,
} from './dist/index.js'
```

### 签名策略

`ExtensionManagerOptions.signaturePolicy` 当前支持三种策略：

- `allow-unsigned`：允许未签名扩展
- `require-signature`：要求所有扩展都必须带签名
- `require-signature-except-development`：开发模式下允许未签名，其余环境要求签名

### 签名认证到底是用什么方式

当前接入方案明确支持两种宿主侧验签方式：

- `trustedKeyMode: "file"`：从 `trusted-keys/<keyId>.pem` 读取**公钥文件**进行验签
- `trustedKeyMode: "inline"`：从配置中的 PEM **公钥字符串**进行验签

默认推荐使用：`trustedKeyMode: "file"`。

也就是说，当前推荐的签名认证方式是：**使用公钥文件验签**；不是私钥文件，也不是共享密钥字符串。

如果是演示、测试、或想做成单文件配置，也支持把**公钥 PEM 字符串**直接写进配置。

### 最小签名示例

```ts
import {
  generateSigningKeyPair,
  signManifest,
  PublicKeySignatureVerifier,
  InMemoryTrustedKeyStore,
} from './dist/index.js'

const keyPair = generateSigningKeyPair('ed25519')

const manifest = {
  id: 'demo.signed-extension',
  version: '1.0.0',
  protocolVersion: '1',
  artifact: { kind: 'module', entry: './index.js' },
  runtime: 'node',
  capabilities: [{ name: 'demo.hello' }],
}

const signature = signManifest(manifest, {
  algorithm: 'ed25519',
  keyId: 'demo-key',
  privateKeyPem: keyPair.privateKeyPem,
})

const verifier = new PublicKeySignatureVerifier(
  new InMemoryTrustedKeyStore({
    'demo-key': keyPair.publicKeyPem,
  }),
)

verifier.verify({
  ...manifest,
  signature,
})
```

这个流程对应的可运行示例脚本位于 `examples/sign-manifest.mjs`：

```bash
npm run sign:manifest
```

### 新插件接入时，签名如何分发与验证

在严格签名策略下接入新插件时，推荐按下面这条链路分发和验证签名：

1. 插件作者生成签名密钥对，私钥只保留在插件发布方，不进入宿主环境。
2. 插件作者对 `extension.json` 签名，并将已签名 manifest 与插件产物一起分发。
3. 宿主侧运维或发布系统将作者公钥放入 `trusted-keys/<keyId>.pem`；如果明确采用 inline 模式，也可以把 PEM 公钥字符串写入宿主配置。
4. `ExtensionManager.loadManifestFile()` 在实际加载运行时前，使用该可信公钥验证 manifest 签名。

也就是说，跟着插件一起分发的是“已签名 manifest + 插件产物”；公钥通过宿主的可信 key 目录单独分发，或内联在宿主配置中；私钥不随插件分发。

如果后续要扩展到官方远程签发、官方与第三方隔离、第三方自动颁发等能力，请参考 `SIGNING_SERVICE_EVALUATION.zh-CN.md`。

### Trust Bundle 与吊销列表

当前已支持在 manifest 中建模插件信任元数据：

```json
{
  "trust": {
    "publisherId": "publisher.demo",
    "trustDomain": "third-party",
    "issuedBy": "third-party-issuer",
    "signingIdentityId": "signing-identity.demo"
  }
}
```

宿主可以在 `ExtensionManager` 中传入：

- `trustBundle`：声明可信 issuer、所属 trust domain、允许的 publisher、是否已获官方授权
- `revocationList`：吊销签名 key、issuer 或 publisher

这一步是本地增强层，用于把官方 / 第三方 / 私有插件的来源域和吊销策略先接入加载链路；它还不是远程签发服务，也不包含在线审批、证书链同步或远程策略拉取。

### 插件安全状态

当前插件加载后的安全状态分为三类：

- `authorized-safe`：签名有效，且 issuer 在 trust bundle 中被标记为 `authorization: "authorized"`
- `third-party-untrusted`：签名有效，但没有官方授权，默认按第三方不安全插件处理
- `unsigned`：未签名插件

也就是说：**签名有效不等于安全**。默认情况下，未拿到官方授权的插件即使签名可验证，仍然只是 `third-party-untrusted`。

加载后可以直接读取：

```ts
const extension = await manager.loadManifestFile('./plugins/demo-plugin')

console.log(extension.security.status)
console.log(extension.security.reason)
```

### Trust Bundle JSON 示例

```json
{
  "version": "1",
  "issuers": [
    {
      "id": "official-issuer",
      "trustDomain": "official",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "authorization": "authorized",
      "allowedPublisherIds": ["publisher.official"]
    },
    {
      "id": "third-party-issuer",
      "trustDomain": "third-party",
      "publicKeyPem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----",
      "authorization": "untrusted"
    }
  ]
}
```

### Revocation List JSON 示例

```json
{
  "version": "1",
  "revokedSignatureKeys": [
    { "keyId": "demo-key" }
  ],
  "revokedIssuers": [
    { "issuerId": "third-party-issuer" }
  ],
  "revokedPublishers": [
    { "publisherId": "publisher.revoked" }
  ]
}
```

### 从 JSON 文件加载 trust 配置

```ts
import {
  ExtensionManager,
  NodeRuntime,
  FileTrustedKeyStore,
  PublicKeySignatureVerifier,
  loadTrustBundleFile,
  loadRevocationListFile,
} from './dist/index.js'

const trustBundle = await loadTrustBundleFile('./trust-bundle.json')
const revocationList = await loadRevocationListFile('./revocation-list.json')

const manager = new ExtensionManager({
  signaturePolicy: 'require-signature',
  signatureVerifier: new PublicKeySignatureVerifier(
    new FileTrustedKeyStore('./trusted-keys'),
  ),
  trustBundle,
  revocationList,
})

manager.registerRuntime(new NodeRuntime())
```

### 基于文件目录的可信 Key

如果你希望按生产方式加载扩展，可以将严格签名策略与基于目录的可信 key store 组合使用：

```ts
import {
  ExtensionManager,
  NodeRuntime,
  PublicKeySignatureVerifier,
  FileTrustedKeyStore,
} from './dist/index.js'

const manager = new ExtensionManager({
  signaturePolicy: 'require-signature',
  signatureVerifier: new PublicKeySignatureVerifier(
    new FileTrustedKeyStore('./trusted-keys'),
  ),
})

manager.registerRuntime(new NodeRuntime())
```

`FileTrustedKeyStore` 会按 `<keyId>.pem` 的规则在指定目录内查找公钥文件。

例如，当 manifest 中的签名 `keyId` 为 `demo-key` 时，管理器会查找：

- `./trusted-keys/demo-key.pem`

这个流程对应的端到端可运行示例脚本位于 `examples/load-signed-extension.mjs`：

```bash
npm run demo:signed
```

## 不同类型插件是否需要本机运行环境

不是所有插件都“不需要安装对应环境”就能运行，取决于插件类型：

- `runtime: "node"`
  - JS / TS 插件：**需要宿主本身有 Node.js**
  - 但通常**不需要再额外安装该插件自己的独立语言运行时**
- `runtime: "process"` + `artifact.kind: "binary"`
  - 如果插件是**已编译好的独立可执行文件**，并且目标平台匹配：通常**不需要额外安装语言环境**
  - 例如编译好的 Go / Rust / C / C++ 可执行文件
- Python 进程插件
  - 如果入口本质上依赖 `python` / `python3`：**需要目标机器安装 Python**
- Rust / Go / C / C++ 进程插件模板
  - 仓库里的模板只是模板
  - **是否需要额外环境**取决于你分发的到底是“源码”还是“已编译产物”
  - 如果分发的是已编译可执行文件，一般不需要再安装对应语言工具链
- `runtime: "wasm"`
  - 现在已经支持最小可用的 WASM 模块加载
  - **不需要目标机器安装额外语言解释器**
  - 当前更适合纯计算类 capability；输入目前建议使用数字或 `{ value: number }`
- `runtime: "native"`
  - 当前采用**bridge 进程方式**支持共享库接入
  - 不是直接把 `.dll/.so/.dylib` 进程内加载到宿主，而是要求通过 `artifact.launch.command` 指定桥接进程
  - 这样更可控，也更适合跨语言桥接

### 三种“尽量不依赖宿主环境”方案对比

| 方案 | 核心思路 | 是否依赖宿主机预装解释器 | 安全边界 | 能力上限 | 跨平台分发 | 最适合的场景 |
| --- | --- | --- | --- | --- | --- | --- |
| A. WASM | 在宿主内置的 WASM runtime 中运行插件 | 不依赖 | 三者中最好控制 | 三者中最低 | 通常最好 | 纯计算、规则、转换、受限执行场景 |
| B. 自带运行时的 process 插件 | 把解释器和依赖一起打进插件包 | 不依赖宿主预装解释器，但插件自身携带运行时 | 依赖进程隔离，弱于 WASM | 高 | 通常要分平台打包 | 现有 Python 等解释型生态，且希望少改代码 |
| C. 编译型独立二进制 | 直接分发原生可执行产物 | 通常不依赖额外运行时 | 依赖进程隔离，运行时部件最少 | 最高 | 通常要分平台构建 | 面向生产、强调稳定性和交付一致性的插件 |

实际推荐顺序可以这样理解：

- 优先选 **C**：最稳，最像正式产品交付物
- 其次选 **A**：最接近“插件管理器自己就能跑”
- 再选 **B**：最适合保留现有解释型代码资产


## 宿主项目一键装配示例

现在可以直接用：

- `createExtensionManagerFromConfig()`
- `createConfiguredExtensionManager()`
- `createExtensionManagerFromHostConfig()`
- `loadPluginsDirectory()`

```ts
import {
  createExtensionManagerFromConfig,
} from './dist/index.js'

const { manager, loaded } = await createExtensionManagerFromConfig({
  workspacePath: process.cwd(),
  signaturePolicy: 'require-signature',
  trustedKeyDirectory: './trusted-keys',
  trustBundlePath: './trust-bundle.json',
  revocationListPath: './revocation-list.json',
  pluginsDirectory: './plugins',
  pluginsRecursive: true,
})
```

或者直接读取一个完整的 `host.config.json`：

```ts
import { createExtensionManagerFromHostConfig } from './dist/index.js'

const { manager, loaded } = await createExtensionManagerFromHostConfig('./host.config.json')
```

- `trustedKeyDirectory`：加载 `trusted-keys/<keyId>.pem`
- `trustBundlePath`：加载 issuer 授权配置
- `revocationListPath`：加载吊销列表
- `pluginsDirectory`：启动时自动扫描并加载插件
- 默认会注册 `NodeRuntime`、`ProcessRuntime`、`NativeRuntime`、`WasmRuntime`

自动扫描示例见：

- `examples/host-autoload-demo.mjs`
- `examples/host-config-demo.mjs`
- `examples/onboarding-kit/host.config.example.json`

对应命令：

```bash
npm run demo:host-autoload
npm run demo:host-config
```

## 基本使用
```ts
import { ExtensionManager, NodeRuntime, ProcessRuntime } from './dist/index.js'

const manager = new ExtensionManager()
manager.registerRuntime(new NodeRuntime())
manager.registerRuntime(new ProcessRuntime())

await manager.loadManifestFile('./examples/node-extension')
await manager.loadManifestFile('./examples/process-extension')

const result = await manager.invoke('demo.node-extension', 'demo.hello', {})
```

## 脚本

- `npm run build`
- `npm run check`
- `npm run demo`
- `npm run demo:formats`
- `npm run demo:rust-security-core`
- `npm run demo:onboarding`
- `npm run demo:signed`
- `npm run sign:manifest`
- `npm run smoke`
- `npm test`

## Rust kernel daemon demo

Repository now includes a Rust kernel workspace:

- `rust/extensions-security-core`
- `rust/extensions-kernel`
- `rust/extensionsd`

`examples/rust-security-core-host` 保留为面向 host 的打包与演示目录。

- Reads framed kernel request envelopes from stdin
- Returns kernel response/event envelopes on stdout
- Performs manifest admission using Rust signature and trust evaluation
- Normalizes legacy host manifests into canonical runtime specs
- Activates and invokes process-backed plugins
- Supports unary-session compatibility for `openSession()`

Run:

```bash
npm run demo:rust-security-core
```

Build a distributable host bundle:

```bash
npm run package:rust-security-core
```

That command writes `examples/rust-security-core-host/dist-package/extensions-manager-rust-security-core/` with `bin/`, `config/host.config.example.json`, trust-config templates, `package-manifest.json`, `trusted-keys/`, `plugins/`, and a package README.

## host.config kernel

`host.config.json` now supports a `kernel` block for the Rust daemon path.

Example:

```json
{
  "pluginsDirectory": "./plugins",
  "signaturePolicy": "require-signature",
  "trustedKeyDirectory": "./trusted-keys",
  "trustBundlePath": "./trust-bundle.json",
  "revocationListPath": "./revocation-list.json",
  "kernel": {
    "mode": "daemon",
    "transport": "pipe",
    "command": "./security-core/extensionsd.exe",
    "timeoutMs": 5000
  }
}
```

Legacy `commandSecurityCore` config is still accepted as a compatibility input and is normalized into the new kernel daemon settings.
For a ready-to-copy Rust example host package layout, run `npm run package:rust-security-core` and start from `examples/rust-security-core-host/dist-package/extensions-manager-rust-security-core/config/host.config.example.json`.
