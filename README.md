# freebuff2api-workers

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

> 🎉 欢迎使用与交流！有任何问题或想法欢迎提 Issue / PR。
> 开源协议：**[AGPL-3.0](#-license)**

把 **freebuff/codebuff** 的模型接口适配为 **OpenAI-compatible API**。`worker.js` 核心仍可单文件运行；Web 账号管理、加密 SQLite 和每账号代理属于 Node 多文件运行层，**推荐 Docker 容器或 Node/systemd VPS 部署**，适配常见 OpenAI SDK / 客户端（QwenPaw、Hermes、ChatGPT-Next-Web、LobeChat、one-api 等）。

> ⚖️ **使用前必读**：本项目是独立开源软件，不代表或受 Freebuff/Codebuff、Cloudflare、OpenAI、Anthropic、Docker 或 GitHub 授权。使用者必须拥有账号、Token、代理和请求数据的合法授权，并自行遵守上游条款、隐私义务和所在地法律。请先阅读 [使用与责任声明](LEGAL_NOTICE.md)、[责任划分](RESPONSIBILITIES.md)、[变更与回滚流程](CHANGE_CONTROL.md)、[安全策略](SECURITY.md) 和 [第三方归属](NOTICE.md)。

> ⚠️ **部署方式重要提示**：Freebuff 官方已检测 Cloudflare Worker 部署（识别 `cf-worker` / `cf-ray` 等边缘标记），**在 CF 上部署会显著增加账号被封禁的风险**。因此本项目**不推荐 Cloudflare 部署**，推荐使用 **Docker 容器**或自建 VPS 运行（见下方「[🐳 Docker 容器化部署](#-docker-容器化部署-推荐)」）。

## ✨ 特性

- ⭐ **完整访问模式模型**：Cloudflare Workers 默认使用美国出口，通常可获得 Freebuff 完整访问模式；其中 DeepSeek V4 Flash 和 MiMo 2.5 属于官方特殊的非 Premium 模型
- 🔒 **常规模型基础额度**：除上述两个特殊模型外，普通模型按每日 6 次 session 的基础额度理解；不会宣传为无限量
- 🔁 **多账号自动切换**：撞额度自动冷却并切换，逗号分隔即可
- 💡 **优先复用活跃 session**：一个 session 约 1 小时有效，创建 session 才扣额度；只要当前模型的 session 还活跃就钉在同一账号上，用满再换，最大化额度利用率
- 📢 **广告与 streak 流程兼容**：创建新 session 前，Worker 会按官方客户端流程请求广告，并调用 `GET /api/v1/freebuff/streak` 尝试签到；相关请求失败会静默跳过，不阻塞聊天
- 🧩 **OpenAI 兼容**：`/v1/models`、`/v1/chat/completions`、`/v1/responses`（流式/非流式视接口支持情况而定）
- 📨 **Anthropic Messages API**：支持 `/v1/messages`、`/messages` 及对应的 `count_tokens` 路由，可供 Anthropic SDK / 兼容客户端尝试接入
- ❤️ **健康检查**：`GET /healthz`（免鉴权），方便监控探活
- 📦 **两种运行层**：`worker.js` 可单文件部署；完整管理版需要 Node 24、npm 依赖和仓库内管理/迁移文件

## 📨 Anthropic Messages API 支持

主代码已加入 Anthropic Messages API 适配，当前支持：

- `POST /v1/messages`
- `POST /messages`
- `POST /v1/messages/count_tokens`
- `POST /messages/count_tokens`
- Anthropic 消息格式转换为 Worker 内部使用的 OpenAI-compatible 请求
- 文本消息、`tool_use` / `tool_result`、`tool_choice`
- 非流式响应和 Anthropic SSE 流式响应
- Anthropic 风格的错误响应

> ⚠️ **测试说明**：当前项目维护者没有实际使用 Anthropic Messages API 的客户端环境，因此暂未完成真实 Anthropic 客户端的端到端测试。主代码和本地 stub / 回归测试已经处理并验证转换逻辑，但不代表所有 Anthropic SDK、工具调用组合和客户端行为都已覆盖。
>
> 如果你有 Anthropic Messages API 的实际使用场景，欢迎在不影响现有 OpenAI API 线路的前提下进行测试，并反馈请求格式、流式响应、工具调用或模型兼容性问题。反馈时请尽量附上脱敏后的请求结构、响应状态码和错误信息。
>
> Anthropic API 是新增的协议适配层，不改变现有 OpenAI `/v1/chat/completions`、`/v1/responses`、账号轮换、session 生命周期和 Freebuff 主调用链。

## ⭐ 特殊模型：DeepSeek V4 Flash 与 MiMo 2.5

Worker 通过 Cloudflare Workers 访问 Freebuff，上游通常会将请求识别为美国/完整访问模式。官方 Desktop 在完整模式下将下面两个模型归入 **unlimited 非 Premium 类别**；这里的 `unlimited` 主要表示模型分类和并发类别，**不是对所有账号、地区、接口和时间都作绝对无限量保证**：

| 模型 | 完整模式下的说明 |
|---|---|
| `deepseek/deepseek-v4-flash` | 官方非 Premium 模型；主力推荐，当前 Worker 探测未显示基础日限额 |
| `mimo/mimo-v2.5` | 官方非 Premium 模型；当前 Worker 探测未显示基础日限额 |

> ⚠️ 受限模式官方明确为 DeepSeek V4 Flash 和 MiMo 2.5 每天 6 个一小时 session；Worker 默认走美国出口，通常不属于该受限模式。最终是否可用及实际额度仍以 Freebuff 上游返回为准，官方规则也可能调整。

除这两个特殊模型外，普通模型统一按 **每日 6 次基础 session / 太平洋日** 理解（北京时间约 15:00 重置）。`referral`、`streak`、独立共享池和上游临时限制属于额外条件，不能据此宣传为无限量。

> 💡 **关于额度**：扣额度按「创建 session」计（不是每次对话）。一次 session 约 1 小时有效，期间多轮对话不重复扣。所以 4 个账号 × 每天 6 次 ≈ 全天覆盖。
>
> 📝 **广告与 streak 说明**：创建新 session 前，Worker 会按官方客户端流程请求广告，并调用 `GET /api/v1/freebuff/streak` 尝试签到。连续使用是否获得额外额度、额度增加多少，由 freebuff 官方服务端决定；该流程不是额度保证，也不会改变 session 本身的扣额度规则。

## 🚀 快速开始

1. 兼容模式先获取 freebuff token（见下方「获取 FREEBUFF_TOKEN」）；Web 管理模式可直接在管理端完成账号授权，无需复制 Token
2. 部署服务（见下方「部署」，**推荐 Docker 容器部署**）
3. 配置环境变量：
   - 兼容模式（`ADMIN_ENABLED=false`）设置 `FREEBUFF_TOKEN`；Web 管理模式通过首次导入或管理端添加账号
   - `FREEBUFF_API_KEY`（管理模式首次启动必需；兼容模式始终必需）= 自定义随机强访问 key。管理模式完成首次初始化后，可在 Web 管理端的 **API Key** 页面查看掩码、手动设置或生成新 key。
   - Docker 管理登录使用 `ADMIN_USERNAME` + `ADMIN_PASSWORD`；`ADMIN_USERNAME` 默认是 `admin`，只在首次初始化时写入数据库
4. 用任意 OpenAI 客户端连接：
   - **Base URL**: `http://localhost:8877/v1`（Docker 部署）或 `https://你的worker名.你的子域.workers.dev/v1`（CF 部署，不推荐）
   - **API Key**: `<FREEBUFF_API_KEY 的值>`

> 🌐 **自定义域名**：如果 `*.workers.dev` 域名访问不通（部分地区被墙/受限），可给 Worker 绑定自己的域名，Base URL 改为 `https://你的域名/v1`。配置方法见下方「[自定义域名](#-自定义域名)」。

## ❤️ 健康检查

部署后可用（**无需 API key**）：

```bash
curl https://你的worker.workers.dev/healthz
# {"status":"ok","version":"1.8.9","time":"..."}
```

- `version` 是 `worker.js` 的协议版本，不足以证明 Node 管理层已升级；非 Docker 部署还应核对 `current` symlink，登录管理端后查看 `/admin/api/system` 的 `appVersion`
- 适合接入 UptimeRobot / 自建监控探活

## 🔑 获取 FREEBUFF_TOKEN

freebuff 登录凭证（authToken）通过官方 CLI 同款**授权码轮询**获取。项目自带提取工具 `freebuff_tools/extract_freebuff.py`，交互方式与 `cline_oauth.py` 一致。

### 管理端 Web 授权（管理模式优先）

`ADMIN_ENABLED=true` 时，登录管理端后在“账号”页点击“授权账号”就会自动开始生成一次性 Codebuff 授权链接；在新标签页完成你自己的账号登录后，服务端后台任务会独立轮询并把 Token 加密写入 SQLite，浏览器和审计日志不会收到 Token。关闭弹窗或管理页面不会中断任务，重新打开“授权账号”会继续同一个未完成授权，不会重复创建账号；只有“取消授权”、注销、会话失效或服务重启会终止任务。

授权完成的账号始终先以**停用**状态保存，确认配置后再启用；严格代理模式下还必须先填写 HTTP/HTTPS/SOCKS5 代理，账号才可进入请求池。授权任务状态包含“生成中、等待授权、保存中、已完成/已取消/已过期”；取消、登出或会话失效会终止未完成任务。授权链接有效期很短，只能由当前管理员会话查看；请不要截图、转发或在明文 HTTP 管理端使用。公网管理端应先配置 HTTPS。

### 方式 A：GitHub Actions 工作流（推荐，远程提取）

仓库自带工作流 `.github/workflows/extract-token.yml`，在 GitHub Actions 里跑提取，授权链接和 token 只发到你的 Telegram，日志全程掩码（`::add-mask::`），不泄露敏感信息。

**第一步：配置 Secrets**（仓库 Settings → Secrets and variables → Actions）：

| Secret | 说明 |
|---|---|
| `TG_BOT_TOKEN` | Telegram bot token（找 @BotFather 创建，如 `123456:ABC-xxx`） |
| `TG_CHAT_ID` | 你的 Telegram 数字 chat id（给 @userinfobot 发消息获取） |

**第二步：运行工作流**：

1. 仓库页面 → **Actions** → 左侧 **获取 Freebuff authToken** → **Run workflow**
2. 可选填 `poll_timeout`（授权等待秒数，默认 300）和 `fingerprint`（留空自动生成）
3. 你的 TG 会收到登录链接，浏览器打开并登录 Google 账号
4. 脚本轮询到 token 后，完整 token 直接发到你 TG（Actions 日志里只有 `***`）
5. 跑完自动清理旧运行记录，只保留最新 1 条

> 没配 `TG_BOT_TOKEN` / `TG_CHAT_ID` 时工作流第一步直接失败，不会执行提取。

### 方式 B：本地提取

```bash
cd freebuff_tools
python3 extract_freebuff.py login   # 打印授权 URL 到终端，浏览器授权后自动轮询
python3 extract_freebuff.py show    # 显示全部账号：邮箱 + token + 存活状态 + 汇总一行一个
python3 extract_freebuff.py tgsend  # 测试 TG 连通性（配了 TG 时用）
```

本地运行 `login` 时，每个账号会**分键追加**保存到 `freebuff_tools/freebuff_credentials.json`（不覆盖已有账号，支持 Google / GitHub 登录，均自动记录）。该文件已被 `.gitignore` 忽略，不会提交到 GitHub；结构参考 `freebuff_tools/freebuff_credentials.example.json`。

其他实用命令：

```bash
python3 extract_freebuff.py export           # 汇总全部账号 token，一行一个，直接复制进 CF Workers 变量
python3 extract_freebuff.py quota            # 查用量
python3 extract_freebuff.py session          # 开/查 session
python3 extract_freebuff.py chat "你好"      # 发一条消息测试模型 API
```

> 💡 `show` 内部用 `GET /api/v1/freebuff/session` 探测每个账号（**不创建 session、0 消耗**），一次显示全部状态：存活 + 额度 / token 失效 / 被封禁 / 地区受限 / 额度用完。官方对 banned 账号会在所有接口返回 `status: banned`。多账号时 `export` 输出的每行 token 直接粘贴到 Cloudflare Worker 变量 `FREEBUFF_TOKEN`（换行分隔）即可。

## 🛠️ 部署

### 🐳 Docker 容器化部署（✅ 推荐）

Docker 版本包含 Web 管理端、加密 SQLite 账号库、API Key 轮换和每账号独立 HTTP/HTTPS/SOCKS5 出口代理。预构建镜像由 GitHub Actions 测试后发布到：

```text
ghcr.io/huiyio/freebuff2api-wokers
```

当前 Compose 默认固定不可变版本 `1.8.9-admin.2`，支持 `linux/amd64` 和 `linux/arm64`。仓库不发布 `latest`；升级和回滚应使用版本标签、`sha-<提交前12位>` 标签或镜像 digest。可变的 `branch-codex-per-account-proxy` 只用于临时试用。

截至 2026-08-16，GHCR Package 已验证为 Public，可直接拉取；`1.8.9-admin.2` 的多架构 digest 为 `sha256:3ef37c0cb272a609536fb6088e60e4c59b003be85d167436a3cfea6457388a33`。如果后续可见性改变，私有包才需要 `read:packages` PAT 登录，且不要把 PAT 写入配置或日志。

#### 直接使用 GitHub 构建镜像

1. 按 [`DOCKER.md`](DOCKER.md#21-创建首次初始化密钥) 生成权限受限的 `.env`。必须分别设置随机的 `FREEBUFF_API_KEY`、`ACCOUNT_STORE_KEY`、`ADMIN_PASSWORD`，并保留空的 `FREEBUFF_TOKEN` / `FREEBUFF_PROXY_URL`。
2. 拉取并启动，不在本机编译：

   ```bash
   docker compose config --quiet
   docker compose pull freebuff2api
   docker compose up -d --no-build freebuff2api
   docker compose logs --tail 50 freebuff2api
   curl -fsS http://127.0.0.1:8877/healthz
   ```

3. 打开 `http://127.0.0.1:8878/admin/`，用首次初始化的管理员账号登录，在 Web 端添加账号和每账号代理。
4. 客户端使用 Base URL `http://127.0.0.1:8877/v1`，API Key 使用管理端 **API Key** 页面中的当前值。

Compose 默认只把 API 和管理端映射到宿主机回环地址 `127.0.0.1:8877` / `127.0.0.1:8878`。远程使用必须通过 SSH 隧道或 HTTPS 反向代理，不能把管理端明文 HTTP 直接暴露到公网。

首次从旧 `freebuff_tools/freebuff_credentials.json` 迁移时，使用一次性只读挂载导入；日常容器只挂载加密 SQLite，不挂载明文凭据。代理支持：

```text
http://username:password@host:port
https://username:password@host:port
socks5://username:password@host:port
socks5h://username:password@host:port
```

`REQUIRE_ACCOUNT_PROXY=true` 时代理缺失或连接失败会严格报错，不会回退直连。代理只改变出口，不能恢复或绕过上游标记为 `banned` 的账号。

完整文档：

- [Docker 完整部署、旧账号导入、HTTPS、备份与回滚](DOCKER.md)
- [非 Docker Node/systemd 服务器部署](NON_DOCKER.md)
- [上游同步与生产升级流程](UPSTREAM_SYNC.md)
- [责任划分](RESPONSIBILITIES.md) 和 [变更审批](CHANGE_CONTROL.md)

#### 本地源码构建

开发或审计时可显式本地构建：

```bash
npm ci
npm run check
npm test
docker compose up -d --build freebuff2api
```

本地构建与 GHCR 预构建是两条独立路径。使用 GHCR 时始终执行 `docker compose pull` 和 `docker compose up -d --no-build`，避免误用工作目录中的源码。

#### GitHub Actions 镜像发布

[Docker 发布工作流](.github/workflows/docker-publish.yml) 使用仓库 `GITHUB_TOKEN` 写入 GHCR，不需要 Docker Hub Secret：

- 推送到 `codex/per-account-proxy` 自动发布不可变 `sha-*` 标签并更新分支便利标签；
- 推送 `v*` Git tag 发布对应版本标签；
- 工作流合并到默认分支后，Actions 页面可手动填写尚未使用的不可变标签；
- 发布前运行语法检查和完整测试，再构建 amd64/arm64 镜像、SBOM 与 provenance；
- 已存在的主标签和 `latest` 都会被拒绝。

当前镜像包已验证为 Public，可匿名 `docker pull`；若 GitHub 组织策略改变可见性，详细权限说明见 [`DOCKER.md`](DOCKER.md#9-github-actions-发布流程维护者)。

### Cloudflare Worker 部署（❌ 不推荐）

> **Freebuff 官方已检测 Cloudflare Worker 部署**（识别 `cf-worker` / `cf-ray` 等边缘标记，源码中已点名类似本项目的代理模式）。在 CF 上部署会显著增加账号被封禁的风险，**不推荐作为主要部署方式**；以下步骤仅保留给熟悉风险的用户参考。

worker 是**单文件**（`worker.js`），如仍需在 CF 部署：

### 方式 A：CF 控制台粘贴代码

最简单可控，不依赖本地环境、不关联 GitHub：

1. 打开 [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages** → **创建** → **创建 Worker**
2. 名称随意（如 `freebuff2api`），点击 **部署**
3. 进入该 Worker → **编辑代码** → 把 [worker.js](worker.js) 的**全部内容**粘贴进去，覆盖默认代码 → **部署**
4. 点 **设置 → 变量和机密 → 添加**：

   | 类型 | 名称 | 值 |
   |---|---|---|
   | 机密 | `FREEBUFF_TOKEN` | 你的 freebuff token（多账号用英文逗号分隔） |
   | 机密 | `FREEBUFF_API_KEY` | 必需的随机强访问 key；缺失时 API 拒绝请求 |

5. 部署完成后访问验证：

   ```bash
   curl https://你的worker.workers.dev/healthz          # 健康检查（无需 key）
   curl https://你的worker.workers.dev/v1/models \
     -H "Authorization: Bearer ***"           # 模型列表
   ```

> 每次改代码只需重复第 3 步：编辑代码 → 粘贴新内容 → 部署。**不推荐关联 GitHub 自动部署**（见下文）。
> ⚠️ **版本约定**：每次部署前务必把代码里的版本号（healthz 的 `version` 字段 + `X-Freebuff2api-Version` 响应头）升一档，否则无法确认线上是否已更新。

### 关联 GitHub 自动部署（❌ 不推荐）

虽然 CF 支持连接 GitHub 仓库自动部署，但**不建议用**：

- 每次 push 都会触发上线，本地未验证的改动可能直接打到线上
- 需要额外配置构建命令/根目录，仓库里的 `freebuff_tools/` 等辅助文件也会被拉取
- secrets 与分支状态容易混乱，出问题不好排查
- 本仓库含 token 提取脚本，自动同步增加暴露面

**推荐做法**：本地改代码 → Docker 容器/自建 VPS 部署，或（了解风险的前提下）手动粘贴到 CF 控制台 → 自己点部署，完全可控。

> 免费模型对出口 IP 有 US 限制，Cloudflare Workers 默认美国出口，无需额外配置。

### 🌐 自定义域名

默认域名 `https://你的worker名.你的子域.workers.dev` 在部分地区可能访问不通（如被墙/GFW 限制）。如果遇到 `workers.dev` 连接超时或无法访问，可以给 Worker 绑定自己的域名：

1. **添加自定义域**：CF 控制台 → 你的 Worker → **设置 → 域和路由** → **添加** → **自定义域**
2. 输入你的域名（如 `api.你的域名.com`），CF 会自动引导添加 DNS 记录（CNAME 指向 `你的worker名.你的子域.workers.dev`）
3. 等待 DNS 生效（一般几分钟），自动签发免费 SSL 证书
4. 之后 Base URL 改为：`https://api.你的域名.com/v1`

> 要求：域名必须托管在 Cloudflare（或把 DNS 转到 CF）。workers.dev 子域无需配置，绑定自定义域只是给访问不通的地区多一条可用路径。

## 💬 调用示例

```bash
# 健康检查
curl https://你的worker.workers.dev/healthz

# 模型列表
curl https://你的worker.workers.dev/v1/models \
  -H "Authorization: Bearer <API_KEY>"

# 非流式
curl https://你的worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N https://你的worker.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer <API_KEY>" -H "Content-Type: application/json" \
  -d '{"model":"deepseek/deepseek-v4-flash","messages":[{"role":"user","content":"你好"}],"stream":true}'
```

## 📋 模型列表

> 映射来源：Freebuff Desktop 0.0.51（`orchestrator.js` 官方 `FREEBUFF_ROOT_AGENT_ID_BY_MODEL`，2026-08-07 实测同步）。
> Worker 通过 Cloudflare Workers 访问上游，默认使用美国出口，按 Freebuff 完整访问模式说明。除 Flash 和 MiMo 这两个官方特殊的非 Premium 模型外，其余模型按**每日 6 次基础 session / 太平洋日**理解（北京时间约 15:00 重置）；额度按「创建 session」扣减，一个 session 约 1 小时有效。

### ⭐ 完整模式特殊模型：非 Premium

官方 Desktop 在完整访问模式下将下面两个模型归入 `unlimited` 非 Premium 类别。这里的 `unlimited` 主要表示官方模型分类和 Desktop 并发类别，**不是任何账号、接口或时间段的绝对无限量承诺**。Worker 当前探测也未在 `rateLimitsByModel` 中看到它们的基础日限额。

| API 模型名 | session 模型 | 上游 agentId | 说明 |
|---|---|---|---|
| `deepseek/deepseek-v4-flash` | 同左 | `base2-free-deepseek-flash` | 完整模式特殊模型；主力推荐 |
| `mimo/mimo-v2.5` | 同左 | `base2-free-mimo` | 完整模式特殊模型；均衡性能 |

> ⚠️ 受限模式官方明确将这两个模型限制为每天 6 个一小时 session。Worker 默认走美国出口，通常不属于该受限模式；最终可用性和实际额度仍以 Freebuff 上游返回为准。

### 🔒 普通模型：每日 6 次基础额度

以下模型没有“无限量”说明，统一按每日 6 次基础 session 处理；实际额度可能因账号、官方 `referral` / `streak`、通道状态或上游规则变化而不同。

| API 模型名 | session 模型 | 上游 agentId |
|---|---|---|
| `minimax/minimax-m3` | 同左 | `base2-free-minimax-m3` |
| `deepseek/deepseek-v4-pro` | 同左 | `base2-free-deepseek` |
| `openai/gpt-5.6-luna` | 同左 | `base2-free-luna` |
| `poolside/laguna-s-2.1` | 同左 | `base2-free-laguna-s-2-1` |
| `openrouter/poolside/laguna-s-2.1` | 同左 | `base2-free-laguna-s-2-1-openrouter` |
| `inclusionai/ling-3.0-flash:free` | 同左 | `base2-free-ling-3-flash` |
| `crof/greg-2-ultra` | 同左 | `base2-free-greg-2-ultra` |
| `crof/greg-2-super` | 同左 | `base2-free-greg-2-super` |
| `meta/muse-spark-1.2-contributor` | 同左 | `base2-free-muse-spark` |

### 🎁 独立资格或容量限制

以下模型不属于普通模型的直接开放池，是否能创建 session 由官方资格、共享容量或上游状态决定；即使获得资格，也不代表无限量使用：

| API 模型名 | session 模型 | 上游 agentId | 限制 |
|---|---|---|---|
| `z-ai/glm-5.2` | 同左 | `base2-free-glm` | 需 referral / streak 等官方资格，使用独立额度池 |
| `anthropic/claude-fable-5` | 同左 | `base2-free-fable` | 官方容量限制试用，可能按时段开放 |

> 📝 实测补充（2026-08-08）：`ling-3.0-flash:free` 上游可能返回 404 并提示改用付费 slug；`claude-fable-5` 免费账号建 session 可能被上游拒绝（`session_model_mismatch`）。这些现象属于上游可用性问题，不代表 Worker 映射失效。

## 👥 多账号

`FREEBUFF_TOKEN` 用英文逗号分隔多个 token（`token1,token2`）。撞额度（429/空响应）时自动冷却当前账号并切下一个。

**账号选择策略**（v1.4.0 起）：

1. 优先复用**已有活跃 session 缓存**的账号——session 约 1 小时有效，创建才扣额度，复用不扣；
2. 没有活跃缓存时才轮询下一个账号。

这样 4 个账号 × 每天 6 次 ≈ 全天覆盖，额度利用率最大化。

> 注意：冷却状态存在 Worker 内存，冷启动后重置；并发多实例间不共享。日常使用影响不大。

## 🔍 上游门控说明

freebuff 免费模型不是"拿 token 直接调 chat"就行，而是有严格生命周期：

```
session(开) → agent-runs(主+context-pruner 子run) → chat/completions
```

- **session**：`POST /api/v1/freebuff/session`（带 `x-freebuff-model`）拿 `instanceId`；可能排队（queued）。
- **agent-runs**：`START` 主 agent（如 `base2-free-deepseek-flash`）+ `context-pruner` 子 run，并 `record_step` / `finish_run`。chat 校验 run_id 存在，缺了会 4xx。
- **chat**：`POST /api/v1/chat/completions`，带 `codebuff_metadata.run_id`、`x-freebuff-instance-id`、SDK UA、`stop:['"cb_easp"']`、`provider.data_collection=deny`。**上游强制流式**，非流式请求需聚合（超时已放宽至 45s）。

Worker 已自动处理以上全部生命周期，无需手动干预。另：system 消息必须以 `You are Buffy, the strategic coding assistant.` 开头（上游字节级校验），Worker 已自动注入。

### ⚠️ 单账号单会话限制（重要）

一个 Freebuff 账号同一时间**只能一个客户端在线**。因此：

- ❌ 禁止在 `/v1/models` 中查询上游 `GET /api/v1/freebuff/session` 探测额度/状态——该调用会占用 session 并顶掉正在进行的 chat（428 `waiting_room_required`）。
- ✅ `/v1/models` 返回**静态模型列表**（不额外调上游）。
- 上游请求通过**串行队列 + 300ms 间隔**执行，避免并发触发上游问题。

## 💡 使用体验

目前测试过以下方式，效果都不错：

1. **🌍 美国 IP 直连**：freebuff 免费模型对出口 IP 有 US 限制，非美区 IP 可能失败。Cloudflare Workers 默认美国出口，直连即可；本地客户端访问建议配合美国代理。

2. **🤖 Hermes Agent（美区 VPS）**：将 Hermes Agent 部署在美区 VPS 上。

3. **本地浏览器 + page-assist 插件**：配合 [page-assist](https://github.com/n4ze3m/page-assist) 浏览器插件使用，体验流畅，欢迎尝试。

## 🙏 感谢

感谢以下贡献者对本项目的支持与贡献（排名不分先后）：

- [@yjzsg](https://github.com/yjzsg)
- [@zipei-a](https://github.com/zipei-a)
- [@hknerdr](https://github.com/hknerdr)

## 📚 学习参考项目

本项目在开发过程中参考并学习了以下开源项目，特此感谢：

- [freebuff2api](https://github.com/XxxXTeam/freebuff2api) —— freebuff 桌面版/API 协议逆向与代理的原始实现（AGPL-3.0），本项目在其基础上进行二次开发与优化，并沿用 AGPL-3.0 开源。
- [freebuff](https://github.com/CodebuffAI/freebuff) —— freebuff 官方公开源码，本项目通过阅读其协议实现与更新日志进行学习研究。
- [Argo-Nezha-Service-Container](https://github.com/fscarmen/Argo-Nezha-Service-Container) —— **容器引导器模式**（Dockerfile 只做引导，业务逻辑由远程脚本/代码驱动），本项目 Docker 部署方式借鉴了该设计，实现"改代码即更新、重启即生效"的轻量管理。

## ⚠️ 免责声明

本项目仅按 [AGPL-3.0](LICENSE) 授权代码，不保证任何第三方服务的账号资格、模型、额度、响应、可用性或持续兼容。上游条款可能限制逆向、自动化、代理、共享访问或特定地区的使用；使用者必须在部署前自行核对当前条款并取得必要授权，不得使用本项目绕过封禁、风控、速率限制、地域限制或付费限制。

请求可能包含提示词、代码、文件、个人信息和上游回复。部署运营方负责数据流向、隐私告知、日志保留、秘密保管、备份、访问控制、事件通知以及向第三方提供服务时的合同和退款规则。维护者不控制上游服务，也不对部署者的账号损失、数据处理或第三方服务中断作额外保证。

具体责任角色、交接证据和变更审批见 [RESPONSIBILITIES.md](RESPONSIBILITIES.md) 与 [CHANGE_CONTROL.md](CHANGE_CONTROL.md)。这类项目说明不替代适用法域的法律审阅或双方签署的书面合同。

## 📄 License

本项目采用 [AGPL-3.0 License](LICENSE)。许可证只覆盖本仓库代码的复制、修改和再分发，不授予任何上游服务、账号、数据、模型或商标的使用许可。再分发时请同时阅读 [NOTICE.md](NOTICE.md)，保留适用的版权和许可证通知，并履行 AGPL-3.0 的对应源代码义务。


