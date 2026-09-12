# ExtensionsManager 安全测试报告（网络安全 / 本地木马风险）

日期：2026-09-05
范围：仅本项目（E:\0001_Work_New\013_Work_Git\0003_AI\00001_design\ExtensionsManager）。
全部测试产物位于本目录（security-tests/），未在项目外创建或修改任何内容。
性质：防御性安全评估——针对本项目自身代码与产物的攻击面验证，不涉及任何第三方系统。

---

## 0. 执行方式说明

按"先评估、再执行"的要求分两步：

1. **静态评估**（先做）：枚举全部网络外呼、进程派生、动态执行、混淆特征、
   环境变量采集、依赖生命周期钩子、本地遗留产物。
2. **动态验证**（依据评估结果执行）：对确认的攻击面写独立探针脚本
   （probes/），针对构建产物 dist/ 实测拒绝行为。

工具说明：Mimosa 深度扫描因"输出目录必须在被扫描仓库之外"的工具约束与本任务
"一切产物必须在项目内"的硬约束冲突而未使用（其早前 hook 触发的 L3 扫描发现项
已在本日修复，见 §3.5）。

## 1. 本地风险项评估结论（先评估的输出）

| 检查面 | 结果 | 定性 |
|---|---|---|
| 网络外呼点 | 仅 4 处：状态探测 ×2（ExtensionManager）、远程插件 HTTP（RemoteRuntime）、Rust 内核 remote-http | 均为**功能必需**且已有护栏（见 §2），无隐藏外呼 |
| 进程派生点 | 5 处（ProcessRuntime / RemoteRuntime process / CommandKernelBridge / CommandSecurityCore / Rust ManagedProcess） | 全部 manifest/host-config 驱动，已加路径围栏 + shell 禁用，无固定隐藏命令 |
| 动态执行 | eval / new Function / node:vm：**0 处** | 干净 |
| 混淆特征 | >200 字符 base64/hex 仅 1 处：security-core 测试向量的 RSA 签名 fixture | 测试数据，非载荷 |
| 环境变量采集 | 读取点：auth 密钥（valueEnv）、wasm fuel/缓存目录、examples 的 PATH 演示 | 仅配置用途，**无聚合、无外传** |
| npm 供应链 | 无 preinstall/postinstall/prepare 钩子；直接依赖仅 typescript + @types/node | 干净 |
| Cargo 依赖 | serde/serde_json/ed25519-dalek/rsa/sha2/time/base64/wasmtime | 均为知名 crate |
| dist 产物 | 无 exe/dll/node 意外二进制 | 干净 |
| git hooks | .git 内无自定义 hook | 干净 |
| **本地遗留** | `.tmp/spawn_repro.pdb`（早前调试遗留）| **已清理**；.tmp 现仅存测试临时目录 |

结论：**未发现木马类风险项**（无隐藏外呼、无动态执行、无混淆、无供应链钩子、
无秘密采集外传）；唯一本地遗留（调试 PDB）已清除。

## 2. 动态探针结果（对 dist 实测）

### probes/path-escape.mjs — 10/10 通过
路径逃逸与命令注入抗性：相对/深层 `../` 逃逸、绝对路径越界、NUL 字节、
launch.command 越界、cwd 越界、`shell:true` 全部被拒；合法相对路径与
PATH 裸命令名兼容性保持；探针埋设的"目录外标记文件"全程未被触碰。

### probes/runtime-hardening.mjs — 6/6 通过
- WASM 内存炸弹（300 页 > 256 页配额）拒载；无界内存声明拒载；
- **安全默认生效**：未配置策略的管理器拒绝未签名插件（错误信息含三条可行动指引），
  声明 `isDevelopment: true` 后同一插件放行；
- SSRF：manifest 状态探测指向私网 10.x 在**任何网络 I/O 之前**被护栏拦截；
- **外联审计**：全程 hook 全局 fetch，所有出站目标仅回环，私网探测目标从未触网。

### probes/daemon-flood.mjs — 3/3 通过
"敌意插件"场景（本地木马等价物：20,000 事件洪水，5 倍配额）经真实 Rust
守护进程实测：会话在有界窗口内返回（无挂死）、宿主堆增长 0.0 MB、
洪水后守护进程仍然存活可服务。

## 3. 静态评估补充发现（按严重度）

### 已修复（本日，全部有回归测试）
1. ~~默认签名策略 fail-open~~ → 已翻转为 fail-closed（require-signature-except-development）；
   未知策略串同样 fail-closed。TS 130/130、Rust 37/37 双档验证。
2. ~~ArtifactResolver 无路径围栏~~ → 已加 containment（本次探针 §2 验证）。
3. ~~shell:true 命令注入面~~ → resolver 咽喉点拒绝。
4. ~~TS WasmRuntime 无内存防护~~ → 256 页配额 + 导入内存封顶。
5. ~~事件队列无界~~ → 双侧 4096 配额（daemon-flood 探针实测）。
6. ~~状态探测 SSRF 面~~ → 默认拒绝护栏（本次探针 §2 验证）。
7. ~~远程链路无鉴权~~ → launch.auth（bearer/header，密钥仅存环境变量）+ 非回环 TLS 强制。
8. ~~Mimosa 早前 L3 发现~~（loadTrustConfig/createExtensionManagerFromConfig 路径
   解析、nodePluginLauncher、RemoteRuntime ssrf 入口）→ 已在本日加固波次处理；
   ExtensionRegistry.ts:22"命令注入"为扫描器误报（纯 Map 操作，无命令执行）。

### 遗留（已知、非木马类、按需处理）
- fuel 计算预算防护仅存在于 Rust 内核路径；Node 直连 wasm 路径无计算炸弹防护
  （JS 引擎限制，文档已注明；实时宿主应走内核数据面）。
- 签名仅覆盖 manifest，二进制完整性（artifact.integrity）可选——建议生态文档
  引导发布流程默认钉住摘要。
- 状态探测/远程端点的私网放行依赖宿主显式配置 statusProbeAllowedHosts——默认拒绝
  可能在企业内网场景产生误伤（文档已含指引）。

## 4. 总体判定

- **木马/暗藏风险**：未发现。无隐藏外呼、无动态执行、无混淆载荷、无供应链钩子、
  无秘密采集外传；本地遗留调试产物已清理。
- **攻击面状态**：评估报告（2026-09-05）列出的全部高危项已修复并经动态探针实证；
  剩余两项为已知架构性限制（JS 无 fuel、manifest 签名不覆盖二进制），均有文档
  指引且不构成木马类风险。
- 复跑方式：`node security-tests/probes/path-escape.mjs`、
  `node security-tests/probes/runtime-hardening.mjs`、
  `node security-tests/probes/daemon-flood.mjs`（需先 `cargo build -p extensionsd`）。
