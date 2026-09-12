# 手工安装插件的完整性钉住指引

适用对象：不经 PluginStore（商店自动钉住）而手工放置/更新插件文件的宿主
运营者与发布者。

## 背景：签名不覆盖二进制

清单签名（`signature`）保护的是 **extension.json 本身**（经 canonical JSON
验签），而插件实际执行的代码是**清单指向的二进制/入口文件**。攻击者若能
写插件目录，可以替换 `index.js`/`plugin.wasm` 而不动清单——签名照样通过。

`artifact.integrity` 就是补这个缺口的内容钉：装载时
`verifyArtifactIntegrity` 计算入口文件的 sha256 并与清单声明的摘要比对，
不一致即拒绝装载。

## 钉住方式

### 方式一（推荐）：用 PluginStore 安装

`PluginStore.installFromDirectory` / `update` **自动**计算入口文件 sha256
并写入 `artifact.integrity`——商店路径零额外操作，更新时自动重钉。

### 方式二：手工钉住

装载前把入口文件摘要写进清单：

```bash
# 计算入口文件摘要（Windows PowerShell）
Get-FileHash .\plugin\index.js -Algorithm SHA256
# 或 Git Bash
sha256sum ./plugin/index.js
```

```json
{
  "id": "my.plugin",
  "artifact": {
    "kind": "module",
    "entry": "./index.js",
    "integrity": "<64 位十六进制 sha256>"
  }
}
```

### 方式三：宿主代码内钉住

```ts
import { computeFileSha256 } from 'extensions-manager'
// 装载前：
manifest.artifact.integrity = await computeFileSha256(entryPath)
```

## 更新流程（钉住后）

1. 替换入口文件；
2. 重算新文件摘要并更新清单的 `artifact.integrity`；
3. 重载（`manager.reinitialize` 或重启）——校验对新摘要通过。

校验失败的表现：`ExtensionLoadError`，cause 为
`Invalid artifact integrity: <id>`——这**就是**防篡改生效，不是故障。

## 边界与注意

- 完整性钉的是**内容一致性**，不是作者身份——"允许这个文件" ≠ "信任这个
  发布者"。身份仍由签名 + trust bundle 承担，两者互补；
- 多平台入口（`artifact.entry` 为平台映射）需为**每个**目标平台的入口文件
  分别钉摘要（当前 `integrity` 是单值，按部署平台钉）；
- `source-dir` 类目录入口无法哈希（无单一文件可钉）——建议发布形态使用
  单文件入口（module/wasm/binary）以获得完整性保护；
- WASM 数据面插件同理：钉 `plugin.wasm` 的摘要，防止运行时被换。
