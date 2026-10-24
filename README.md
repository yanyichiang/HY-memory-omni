<div align="center">

# HY-memory-omni

**让记忆跨越模态，让证据始终可追溯。**

面向 AI Agent 的独立记忆服务 · 文本 / 图像 / 音频 / 视频

<p>
  <a href="package.json"><img src="https://img.shields.io/badge/version-0.1.0-6366f1?style=flat-square" alt="版本 0.1.0"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-22c55e?style=flat-square" alt="许可证 Apache-2.0"></a>
  <a href="#快速开始"><img src="https://img.shields.io/badge/Node.js-22.22%2B-5fa04e?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 22.22 及以上"></a>
  <a href="memory/"><img src="https://img.shields.io/badge/TypeScript-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="engine/"><img src="https://img.shields.io/badge/Python-3776ab?style=flat-square&logo=python&logoColor=white" alt="Python"></a>
  <a href="#运行方式"><img src="https://img.shields.io/badge/Cloudflare-Workers-f38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare Workers"></a>
</p>

**简体中文** · [English](README.en.md)

[核心能力](#核心能力) · [快速开始](#快速开始) · [接入示例](#接入示例) · [API 文档](docs/API.md) · [验收记录](docs/ACCEPTANCE.md)

</div>

---

**HY-memory-omni** 基于 [Tencent Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory)，将文本、图像、音频和视频接入同一套来源管理、证据关联、冲突判断与版本治理流程。由 **YY** 开发和维护，是独立衍生项目。

原生媒体与结构化命题并存：你可以检索记忆、回看原始证据，也可以依据原件重新提取、核验和修订。服务通过 HTTP 接入 Agent，无需依赖特定 Agent 框架。

> **当前版本：0.1.0。** 已完成独立源码与 npm 源码包的安装、启动及四模态生命周期验收。当前提供源码仓库与 npm 源码包，尚未发布 npm registry 包或托管服务。验收范围见[验证与状态](#验证与状态)。

## 核心能力

| 能力 | 可以做什么 |
| --- | --- |
| 📝 **文本记忆** | 写入陈述、检索相关记忆，保留来源与修订记录 |
| 🖼️ **图像记忆** | 保留原图、提取观察结果，并依据原图核验检索命中 |
| 🎧 **音频记忆** | 保留原始声音及时间位置，检索语音与非语音证据 |
| 🎬 **视频记忆** | 联合处理画面与音轨，返回可追溯到原片的时间区间 |
| 🔎 **跨模态检索** | 使用文本或原生媒体作为查询线索，关联不同模态的证据 |
| 🧩 **知识治理** | 关联跨来源命题，识别冲突，有条件地生效修订，并在来源撤销后重算资格 |
| 📦 **独立运行** | 一个 `npm start` 启动认证入口、记忆服务与 Python 内核 |

### 原始证据与知识状态分别管理

- **证据可追溯**：媒体原件、提取结果、结构化命题与来源版本保持关联。
- **冲突可保留**：缺少覆盖依据时保留冲突；时间更新本身不构成修订权限。
- **修订可核验**：当前采用整个来源重建，旧引用失效；可基于原件重新检查记忆。
- **撤销可传播**：来源状态变化会影响依赖它的事实、检索与推理结果。

### 长视频的三个层次

| 层次 | 行为 |
| --- | --- |
| **自动切分** | 支持动态场景切分与固定时间窗口，通过分片上传处理长视频 |
| **按视频归组** | 将同一原视频的多个命中片段归组，每个片段保留独立时间戳与引用 |
| **跨片段推理** | 使用独立任务整合时间顺序与证据，区分提议、反对、定案和明确修订 |

片段归组不会自动生成跨片段结论。推理仍可能因证据不足或权限不明而保持未决。

## 快速开始

### 1. 准备环境

- **Node.js 22.22+** 与 npm。
- **[uv 0.13.4+](https://docs.astral.sh/uv/getting-started/installation/)**，用于准备锁定版本的 Python Workers 依赖。
- 自己可用的 Cloudflare Workers AI、AI Gateway 及对应模型访问配置。

本地运行面向 Linux 和 macOS；当前从零安装验收在 **Linux x64** 完成。

### 2. 安装并初始化

```sh
git clone git@github.com:yanyichiang/HY-memory-omni.git
cd HY-memory-omni
npm ci
npm run init
```

初始化生成 `.hy-memory-omni/config.json` 和独立的 Memory API token。编辑配置文件中的三个 `REPLACE_` 项：

| 配置项 | 填写内容 |
| --- | --- |
| `CF_ACCOUNT_ID` | 你的 Cloudflare Account ID |
| `MEMORY_GATEWAY_ID` | 你的 AI Gateway ID |
| `MEMORY_MODEL_TOKEN` | 限定该账户、具有 **Workers AI Read** 和 **AI Gateway Run** 权限的 **Cloudflare User API Token（CFUT）** |

原生多模态向量模型 `gemini-embedding-2` 通过 Gateway 的 Google 原生入口调用，需要在 Gateway **BYOK** 中配置 Google key；音视频理解模型使用 Gateway **Unified Billing**。这些路由需要你自己的可用访问配置。

`HY_API_TOKEN` 用于 Agent 调用本记忆服务，由初始化命令在本地生成；它与 `MEMORY_MODEL_TOKEN` 的用途不同。

### 3. 启动

```sh
npm start
```

默认入口：`http://127.0.0.1:8787`。

首次启动会安装锁定的 Python Workers 依赖并构建 TypeScript Worker；后续启动复用 Python 依赖并重新构建 TS bundle。服务运行期间保持启动进程开启，按 **Ctrl+C** 停止。

<details>
<summary><strong>从 npm 源码包安装</strong></summary>

仓库也支持 `npm pack` 生成源码包。在新目录中执行：

```sh
npm install /path/to/hy-memory-omni-0.1.0.tgz
npx --no-install hy-memory-omni init
# 编辑 .hy-memory-omni/config.json
npx --no-install hy-memory-omni start
```

源码包包含源码、npm-shrinkwrap / pylock 和许可证，运行依赖在安装后的首次启动时准备。本项目暂未发布到 npm registry。

</details>

## 接入示例

### 写入与召回文本

```js
import { readFile } from 'node:fs/promises';

const { HY_API_TOKEN } = JSON.parse(
  await readFile('.hy-memory-omni/config.json', 'utf8'),
);

async function memory(path, body) {
  const response = await fetch(`http://127.0.0.1:8787${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${HY_API_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

const written = await memory('/ingest-text', {
  operationId: 'note-001',
  sessionRef: 'chat-001',
  messageRef: 'message-001',
  text: '设计评审定在周六。',
});

const recalled = await memory('/search', {
  query: '设计评审是什么时候？',
  sessionRef: 'chat-002',
});

console.log(written.ref, recalled.items);
```

### 写入图像

继续使用上面的 `memory` 函数：

```js
const image = await readFile('example.png');
const saved = await memory('/ingest', {
  operationId: 'image-001',
  sessionRef: 'chat-001',
  messageRef: 'image-message-001',
  mimeType: 'image/png',
  dataBase64: image.toString('base64'),
});

const original = await memory('/read', { ref: saved.ref });
```

音频、视频、原生媒体查询、修订、撤销和长视频任务的完整示例见 [API 文档](docs/API.md)。自动召回的时机、何时写入及写入目标由你的 Agent 决定；记忆内容不会授予工具执行权限。

## 运行方式

| 组件 | 职责 |
| --- | --- |
| `gateway/` | Bearer 认证、固定服务端身份、公开 API 路由 |
| `memory/` | TypeScript 记忆权威层、来源与知识状态、检索、SQLite Durable Objects 与 R2 |
| `engine/` | 无状态 Python Hy Writer / Reader，包含固定版本的腾讯上游源码 |
| `scripts/` | 依赖准备、统一启动与运行时进程管理 |

`npm start` 使用 **Miniflare / workerd 在本地运行 Workers**，Python 也在 workerd 内执行。无需独立 Python 守护进程、外部数据库、Docker 或 FFmpeg 运行服务。模型请求按配置发往 Cloudflare。

### 数据与访问

- 本地持久状态位于 `.hy-memory-omni/storage`。从相同目录重启即可继续使用；备份时先停止服务，再复制完整状态目录。
- 默认仅监听本机回环地址。除 `/health` 外，业务 API 需要 Memory API token。
- 每个实例对应一个可信 Owner 和 `personal` 范围；不同 Owner 使用独立配置、状态与凭据。调用者不能自行指定另一个身份。
- 状态锁阻止多个进程同时打开同一份数据。非正常退出后，先确认原进程已停止，再处理残留 `runtime.lock`。
- 本地启动不会部署云端 Worker 或创建云端存储；仓库中的 Wrangler 配置为部署模板，云端部署需另行配置资源、绑定与密钥。

<details>
<summary><strong>配置覆盖与安装选项</strong></summary>

| 变量 / 命令 | 用途 |
| --- | --- |
| `HY_HOME` | 改变本地状态目录 |
| `HY_CONFIG` | 指定另一份配置文件 |
| `PORT` | 改变本地监听端口 |
| 配置项同名环境变量 | 覆盖配置文件中的值 |
| `npm run setup` | 显式准备运行依赖和构建，不调用模型 |
| `HY_PYODIDE_MIRROR` | 使用 uv 支持的 Python 下载镜像入口，需提供对应的官方 Pyodide 资产 |

配置与凭据应保持私密，不进入版本控制。

</details>

<details>
<summary><strong>首次安装下载失败或异常退出</strong></summary>

先单独运行 `npm run setup`，根据 uv 输出区分 Pyodide 下载、Python 包安装和构建失败。Pyodide 镜像入口已支持；`HY_PYODIDE_MIRROR` 填写替代官方 releases/download 的**基础 URL**，不是某个压缩包的完整 URL。镜像需保留官方资产的版本目录与文件名，也可以使用本地 `file:///绝对路径/镜像目录`。具体规则见 [uv 官方说明](https://docs.astral.sh/uv/reference/cli/#uv-python-install--pyodide-mirror)。本项目不自动切换到第三方镜像。

`npm start` 收到正常停止信号时，会取消正在进行的依赖准备并等待子进程退出。强制杀死启动器或断电仍可能留下 `runtime.lock`；不要仅凭文件中父 PID 不存在就删锁，先确认该实例的 runtime/workerd 子进程也已停止。正常停止使用运行终端的 `Ctrl+C`，本项目没有独立的 `npm stop` 命令。

`/health` 只表示 HTTP 入口可响应；启动探针只核验 Python 加载。它们都不证明 CFUT、BYOK 或 Unified Billing 的真实模型调用已获授权，也不证明检索语义质量。

</details>

## 验证与状态

| 验证对象 | 本版证据 |
| --- | --- |
| 从零安装 | 新目录安装、锁定 `npm ci`、Python 依赖准备、构建和类型检查通过 |
| 独立 npm 包 | 第二个空目录安装源码包，自动准备依赖并通过启动验证 |
| 统一启动 | 生产 Python 入口加载、健康检查、认证、存储访问和正常退出通过 |
| 四模态生命周期 | 文本 / 图像 / 音频 / 视频的写入、重启、召回、原件读取、修订与撤销通过 |
| 访问边界 | 认证、可信身份注入、视频分片及内部读取接口隔离通过 |

四模态生命周期验收运行真实 workerd、Hy Writer / Reader、SQLite 和 R2；**模型使用测试适配器**（TS HTTP 拦截与 Python fixture 模型适配）。这些结果证明独立安装与组件贯通，不等同于新增真实模型语义质量评测。完整范围、遇到的问题与修复见 [验收记录](docs/ACCEPTANCE.md)。

<details>
<summary><strong>开发与验证命令</strong></summary>

```sh
npm run setup
npm run build
npm run typecheck
npm test
npm run test:install
npm run test:memory
npm pack
```

`test:install` 创建隔离临时状态；`test:memory` 保留既有记忆回归测试。安装可使用工具下载缓存，验收没有声称在空操作系统或无缓存网络环境下完成。

</details>

## 当前范围

- “omni” 覆盖当前实现的**文本、图像、音频与视频**，具体媒体格式和编解码器以 API 支持为准。
- 没有应用级固定的 **2,000 条记忆总量上限**；请求分页、媒体大小、上下文窗口及底层平台容量仍有各自约束。
- 检索返回有界候选集合。没有命中不能证明相关证据不存在；按视频归组也不等于跨片段推理已经得出结论。
- 当前修改粒度是**整个来源重建**，尚未提供单条事实编辑。
- 普通媒体写入上限为原文件 8 MiB；音频最长 180 秒、短视频最长 120 秒；媒体查询上限为原文件 2 MiB。长视频使用任务接口，长音频切分尚未实现。支持格式及错误说明见 [API 文档](docs/API.md)。

## 文档与贡献

- [API 参考与使用示例](docs/API.md)：请求格式、原生媒体查询、版本治理与视频任务。
- [独立安装验收记录](docs/ACCEPTANCE.md)：已验证内容、失败与修复、验证边界。
- [项目工作约定](AGENTS.md)：组件职责、来源治理、隐私及发布边界。
- [第三方许可证说明](THIRD_PARTY_NOTICES.md)：依赖署名、许可与分发要求。

反馈问题时，请提供版本、最小复现步骤和已脱敏的错误信息。修改行为时同步更新中英文 README，并保留原始证据与测试模型的区分。

## 许可证与致谢

原创代码与文档由 **YY** 以 [Apache-2.0](LICENSE) 发布。感谢 [Tencent Hy-Memory](https://github.com/Tencent-Hunyuan/Hy-Memory) 提供记忆内核；原始署名与许可证保留在 [NOTICE](NOTICE) 和 [UPSTREAM-LICENSE](engine/UPSTREAM-LICENSE)。本项目为独立衍生项目，不代表腾讯官方产品或背书。

Mediabunny、MP3 解码组件及 Python 依赖保留各自的 MPL / LGPL / MIT 等许可证，详见 [第三方许可证说明](THIRD_PARTY_NOTICES.md)。当前分发内容为源码；预编译 WASM、容器或完整运行环境的再分发需要遵守所含组件的对应义务。

---

<div align="center">

**HY-memory-omni · Maintained by YY**

[返回顶部](#hy-memory-omni) · [English](README.en.md)

</div>
