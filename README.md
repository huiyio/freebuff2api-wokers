# freebuff2api-workers

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)

> 🎉 欢迎使用与交流！有任何问题或想法欢迎提 Issue / PR。
> 开源协议：**[AGPL-3.0](#-license)**

把 **freebuff/codebuff** 的免费模型暴露成 **OpenAI-compatible API**。单文件无依赖，**推荐 Docker 容器部署**（或自建 VPS 运行），适配任意 OpenAI SDK / 客户端（QwenPaw、Hermes、ChatGPT-Next-Web、LobeChat、one-api 等）。

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
- 📦 **单文件部署**：无依赖，`worker.js` 一处代码，CF / Docker / VPS 通用

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

1. 兼容模式先获取 freebuff token（见下方「获取 FREEBUFF_TOKEN」）；Docker Web 管理模式可跳过，稍后从管理端添加账号
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
# {"status":"ok","version":"1.4.0","time":"..."}
```

- `version` 字段=当前部署的版本号，**每次部署版本号都会变化**，用于确认线上是否已更新（CF 边缘缓存有延迟，验证时等几秒或加随机参数）
- 适合接入 UptimeRobot / 自建监控探活

## 🔑 获取 FREEBUFF_TOKEN

freebuff 登录凭证（authToken）通过官方 CLI 同款**授权码轮询**获取。项目自带提取工具 `freebuff_tools/extract_freebuff.py`，交互方式与 `cline_oauth.py` 一致。

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

Docker 版本包含独立的 Web 管理端、加密 SQLite 账号库和每账号固定出口代理。公开 API 监听容器 `8787`，管理端监听容器 `8788`；Compose 默认把两个端口分别只映射到宿主机回环地址 `127.0.0.1:8877` 和 `127.0.0.1:8878`。

代理支持 `http://`、`https://`、`socks5://` 和 `socks5h://`。账号池选中哪个 Token，对 Freebuff 的请求就使用该账号的 `proxyUrl`。严格模式下代理缺失或连接失败都会直接报错，**不会回退直连**。代理只改变网络出口，不能恢复或绕过上游已经标记为 `banned` 的账号。

> 上游公开镜像 `pingmike/freebuff2api:latest` 不包含本分支的 Web 管理和代理适配层。请从本分支构建自己的不可变版本标签，不要用 `latest` 覆盖可回滚镜像。

#### 可选：准备旧账号导入文件

没有旧账号时跳过本节，启动后直接从 Web 端添加。需要导入提取工具生成的 `freebuff_tools/freebuff_credentials.json` 时，它支持聚合格式：

```json
{
  "accounts": {
    "account-id-1": {
      "email": "account1@example.com",
      "authToken": "replace-with-this-accounts-auth-token"
    },
    "account-id-2": {
      "email": "account2@example.com",
      "authToken": "replace-with-this-accounts-auth-token"
    }
  }
}
```

也支持同一路径放一个单账号对象：

```json
{
  "email": "account1@example.com",
  "name": "account-1",
  "authToken": "replace-with-this-accounts-auth-token",
  "proxyUrl": "socks5://user:password@proxy.example.com:1080",
  "proxyRequired": true,
  "enabled": true
}
```

导入规则如下：

- 只在 SQLite 账号库为空且尚未完成旧凭据导入时执行一次；源 JSON 不会被修改或删除。
- 导入成功后，SQLite 是 Web 管理账号的唯一数据源；继续编辑 JSON 不会热更新账号，删除全部账号也不会触发再次导入。后续启动会先检查导入标记，已完成时不再读取旧 JSON。
- Compose 默认 `REQUIRE_ACCOUNT_PROXY=true`。聚合文件通常没有 `proxyUrl`，这类账号会被安全地导入为停用；登录管理端补充代理并启用即可。
- Web 管理模式下 `.env` 中的 `FREEBUFF_TOKEN` 和 `FREEBUFF_PROXY_URL` 必须保持为空；账号只能通过首次导入或 Web 端进入 SQLite，避免出现管理端看不到的旁路账号。

代理用户名或密码含 `@`、`:`、`/`、`#` 等保留字符时必须进行 URL 编码。凭据文件已被 `.gitignore` 和 `.dockerignore` 排除，仍需限制宿主机权限。一次性导入容器以 UID/GID `1000:1000` 运行；Linux 上要确保该用户能读取临时挂载文件：

```bash
sudo chown 1000:1000 freebuff_tools/freebuff_credentials.json
sudo chmod 600 freebuff_tools/freebuff_credentials.json
```

Rootless Docker 或自定义 UID 映射环境应使用对应的 `chown` 或 ACL。不要为了省事把凭据文件设为全局可读。

默认 Compose 不挂载任何明文凭据。完成下方一次性导入后，日常容器只挂载加密 SQLite；先在 Web 端确认账号数量并备份主密钥，再移走或安全删除宿主机明文 JSON。

#### 1. 生成密钥和 `.env`

下面四项用途不同；API Key、数据库主密钥和管理员密码不得互相复用：

- `FREEBUFF_API_KEY`：客户端调用公开 API 时使用。管理模式首次启动用它初始化加密 SQLite；之后可在 `http://127.0.0.1:8878/admin/` 的 **API Key** 页面轮换。页面只返回掩码，保存或生成后的明文仅在当前响应中显示一次；旧 key 会立即失效。
- `ACCOUNT_STORE_KEY`：32 字节主密钥，用 AES-256-GCM 加密 SQLite 中的 Token 和完整代理 URL。**丢失或换错后现有数据库无法解密。**
- `ADMIN_USERNAME`：首次启动初始化的管理员账号，默认 `admin`；区分大小写，3-128 个字符且不得包含任何空白。写入 SQLite 后，后续重启不会被环境变量覆盖。
- `ADMIN_PASSWORD`：首次启动时初始化管理员密码，长度必须为 12-256 字符；之后可在 Web 管理端修改。

Linux、macOS、Git Bash 或 WSL 可执行：

```bash
set -eu
umask 077
api_key="$(openssl rand -hex 32)"
store_key="$(openssl rand -hex 32)"
admin_password="$(openssl rand -hex 24)"
admin_username="admin"

cat > .env <<EOF
FREEBUFF_API_KEY=${api_key}
ACCOUNT_STORE_KEY=${store_key}
ADMIN_USERNAME=${admin_username}
ADMIN_PASSWORD=${admin_password}
FREEBUFF_IMAGE=freebuff2api:1.8.9-admin.1
RELAY_KEY=
FREEBUFF_TOKEN=
FREEBUFF_PROXY_URL=
REQUIRE_ACCOUNT_PROXY=true
ADMIN_COOKIE_SECURE=false
ADMIN_TRUST_PROXY=false
WORKER_UPDATE_MODE=bundled
EOF

chmod 600 .env
unset api_key store_key admin_username admin_password
```

Windows PowerShell 可使用系统加密随机数生成器：

```powershell
function New-HexSecret([int]$Bytes) {
  $buffer = [byte[]]::new($Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

@(
  "FREEBUFF_API_KEY=$(New-HexSecret 32)"
  "ACCOUNT_STORE_KEY=$(New-HexSecret 32)"
  "ADMIN_USERNAME=admin"
  "ADMIN_PASSWORD=$(New-HexSecret 24)"
  "FREEBUFF_IMAGE=freebuff2api:1.8.9-admin.1"
  "RELAY_KEY="
  "FREEBUFF_TOKEN="
  "FREEBUFF_PROXY_URL="
  "REQUIRE_ACCOUNT_PROXY=true"
  "ADMIN_COOKIE_SECURE=false"
  "ADMIN_TRUST_PROXY=false"
  "WORKER_UPDATE_MODE=bundled"
) | Set-Content -Encoding ascii .env
```

`.env` 含 API 密钥、数据库主密钥、管理员账号和初始管理员密码，不能提交、截图或发送。把 `ACCOUNT_STORE_KEY` 另存到受保护的密码管理器；数据库备份必须与创建它时使用的同一把密钥配套保存。管理员账号只在首次初始化时读取，改动 `.env` 后需通过数据库迁移或重新初始化才会改变。

#### 2. 可选：一次性导入旧账号

只在需要迁移现有 `freebuff_credentials.json` 时执行。该命令临时只读挂载明文文件，写入加密 SQLite 后立即退出；它不会开放端口，也不会让后续日常容器继续看到源文件：

Linux、macOS、Git Bash 或 WSL：

```bash
set -eu
docker compose build
docker compose run --rm --no-deps \
  -v "$(pwd)/freebuff_tools/freebuff_credentials.json:/app/credentials/freebuff_credentials.json:ro" \
  freebuff2api npm run import:credentials
```

Windows PowerShell：

```powershell
docker compose build
docker compose run --rm --no-deps `
  -v "${PWD}/freebuff_tools/freebuff_credentials.json:/app/credentials/freebuff_credentials.json:ro" `
  freebuff2api npm run import:credentials
```

重复运行不会再次导入；账号库已有账号或已经完成导入时会安全跳过。导入文件不存在、格式错误或主密钥不匹配时命令以非零状态退出。

#### 3. 启动 Compose

```bash
set -eu
docker compose config --quiet
docker compose up -d --build
docker compose ps
docker compose logs --tail 50 freebuff2api
curl -fsS http://127.0.0.1:8877/healthz
```

启动后访问：

- Web 管理端：`http://127.0.0.1:8878/admin/`
- OpenAI-compatible Base URL：`http://127.0.0.1:8877/v1`
- 管理登录：首次初始化使用 `.env` 中的 `ADMIN_USERNAME` 和 `ADMIN_PASSWORD`；之后以 SQLite 保存的账号和密码哈希为准，在 Web 端修改密码后旧环境变量密码不会恢复生效
- API Key：首次启动使用 `.env` 中的 `FREEBUFF_API_KEY`；后续以管理端 **API Key** 页面中保存的值为准

正常日志只显示账号和代理计数，不显示 Token、完整代理 URL、代理密码或 API Key。在管理端可以新增、编辑、启停和删除账号，设置/轮换 API Key，并可对固定目标 `https://www.codebuff.com/` 做代理连通性测试；保存后账号路由和 API Key 会热加载，无需重启容器。

若不用 Compose，等价的 `docker run` 示例为：

```bash
set -eu
docker build -t freebuff2api:1.8.9-admin.1 .
docker volume create freebuff_data

# 可选旧账号导入（只运行一次；不需要时跳过）
docker run --rm \
  --env-file .env \
  -e ACCOUNT_DB_PATH=/app/data/freebuff.sqlite \
  -e CREDENTIALS_DIR=/app/credentials \
  --mount type=bind,src="$(pwd)/freebuff_tools/freebuff_credentials.json",dst=/app/credentials/freebuff_credentials.json,readonly \
  --mount type=volume,src=freebuff_data,dst=/app/data \
  --entrypoint npm \
  freebuff2api:1.8.9-admin.1 run import:credentials

# 日常服务不挂载明文凭据
docker run -d --name freebuff2api --restart unless-stopped \
  -p 127.0.0.1:8877:8787 \
  -p 127.0.0.1:8878:8788 \
  --env-file .env \
  -e ADMIN_ENABLED=true \
  -e ADMIN_HOST=0.0.0.0 \
  -e ADMIN_PORT=8788 \
  --mount type=volume,src=freebuff_data,dst=/app/data \
  freebuff2api:1.8.9-admin.1
```

#### 4. 远程访问与 HTTPS

不要把公开 API 或管理端的明文 HTTP 端口直接暴露到公网：API Key、提示词和回复都可能被窃听。临时远程管理可使用 SSH 隧道：

```bash
ssh -L 8878:127.0.0.1:8878 user@your-server
```

然后在本机访问 `http://127.0.0.1:8878/admin/`。长期使用应通过 HTTPS 反向代理，并保持 `/admin/` 路径不被剥离。例如 Nginx TLS 站点中的位置配置：

```nginx
location /admin/ {
    proxy_pass http://127.0.0.1:8878;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $remote_addr;
}

location /v1/ {
    proxy_pass http://127.0.0.1:8877;
    proxy_http_version 1.1;
    proxy_buffering off;
    proxy_read_timeout 3600s;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

确认 HTTPS 可用且 Nginx 是唯一能访问管理端的反向代理后，把 `.env` 改为 `ADMIN_COOKIE_SECURE=true` 和 `ADMIN_TRUST_PROXY=true`，再重建容器配置：

```bash
docker compose up -d --force-recreate
```

管理会话 Cookie 使用 `HttpOnly`、`SameSite=Strict`，写操作还要求 CSRF Token。`ADMIN_COOKIE_SECURE=true` 会额外添加 `Secure`；启用后必须通过 HTTPS 访问，否则浏览器不会发送会话 Cookie。

#### 5. SQLite 备份与恢复

SQLite 位于 Compose 命名卷的 `/app/data/freebuff.sqlite`。为得到一致的单文件备份，先让服务正常停止并关闭 WAL，再从已停止的容器复制：

```bash
set -eu
backup_dir="$(cd .. && pwd)/freebuff2api-backups"
mkdir -p "${backup_dir}"
chmod 700 "${backup_dir}"
docker compose stop -t 30 freebuff2api
test "$(docker inspect --format '{{.State.ExitCode}}' freebuff2api)" = "0"

backup_file="freebuff-$(date +%Y%m%d-%H%M%S).sqlite"
docker cp "freebuff2api:/app/data/freebuff.sqlite" "${backup_dir}/${backup_file}"
chmod 600 "${backup_dir}/${backup_file}"

docker compose start freebuff2api
```

恢复前先确认 `.env` 中是该备份对应的 `ACCOUNT_STORE_KEY`，然后停止服务。下面命令通过检查容器挂载来取得 Compose 的真实卷名，不依赖容易写错的项目名前缀：

```bash
set -eu
backup_file="freebuff-YYYYMMDD-HHMMSS.sqlite"
backup_dir="$(cd .. && pwd)/freebuff2api-backups"
test -f "${backup_dir}/${backup_file}"

docker compose stop -t 30 freebuff2api
test "$(docker inspect --format '{{.State.Running}}' freebuff2api)" = "false"
data_volume="$(docker inspect \
  --format '{{range .Mounts}}{{if eq .Destination "/app/data"}}{{.Name}}{{end}}{{end}}' \
  freebuff2api)"
test -n "${data_volume}"

docker run --rm \
  -v "${data_volume}:/data" \
  -v "${backup_dir}:/backup:ro" \
  alpine:3.22 sh -eu -c '
    source_file="/backup/$1"
    test -f "$source_file"
    temporary_file="/data/freebuff.restore.$$"
    cp "$source_file" "$temporary_file"
    chown 1000:1000 "$temporary_file"
    chmod 600 "$temporary_file"
    rm -f /data/freebuff.sqlite /data/freebuff.sqlite-wal /data/freebuff.sqlite-shm
    mv "$temporary_file" /data/freebuff.sqlite
  ' sh "${backup_file}"

docker compose up -d
docker compose logs --tail 50 freebuff2api
```

数据库含加密账号、管理员密码哈希、会话和审计记录，备份仍应按敏感数据保护。恢复后出现 `ACCOUNT_STORE_KEY verification failed`，说明主密钥与备份不匹配；不要生成新密钥覆盖原值。

#### 6. 主要环境变量

| 变量 | 说明 |
|---|---|
| `PORT` / `HOST` | 公开 API 监听端口/地址，默认 `8787` / `0.0.0.0` |
| `FREEBUFF_API_KEY` | 公开 API 的访问密钥；兼容模式始终显式设置，管理模式仅在加密 SQLite 尚未初始化时设置，之后可由管理端轮换 |
| `ACCOUNT_STORE_KEY` | 管理账号库主密钥；必须是 32 字节对应的 64 位十六进制或 base64url |
| `ADMIN_USERNAME` | 首次启动管理员账号，区分大小写，3-128 个字符且不能包含空白；默认 `admin`，数据库已有账号名后不会覆盖 |
| `ADMIN_PASSWORD` | 首次启动初始化密码，12-256 字符；数据库已有密码哈希后不会用它覆盖 |
| `FREEBUFF_IMAGE` | Compose 使用的不可变镜像标签；升级和回滚时同步修改，避免下次重建漂移 |
| `PUBLIC_BIND_HOST` / `PUBLIC_BIND_PORT` | Compose 公开 API 宿主机映射，默认 `127.0.0.1:8877` |
| `ADMIN_HOST` / `ADMIN_PORT` | 管理服务监听地址/端口；Compose 为 `0.0.0.0:8788`，宿主机只映射回环地址 |
| `ADMIN_COOKIE_SECURE` | HTTPS 反代时设为 `true`；本地 HTTP 调试保持 `false` |
| `ADMIN_TRUST_PROXY` | 只有管理端仅受信任反向代理可访问时设为 `true`，用于按转发 IP 限制登录 |
| `ADMIN_SESSION_TTL_SECONDS` | 管理会话有效期，默认 `43200`（12 小时） |
| `ADMIN_MAX_REQUEST_BODY_BYTES` | 管理 API 请求体上限，默认 `262144`（256 KiB） |
| `ACCOUNT_DB_PATH` | SQLite 路径；Compose 固定为 `/app/data/freebuff.sqlite` |
| `REQUIRE_ACCOUNT_PROXY` | `true` 为严格模式：所有启用账号必须配置代理，代理失败不允许直连回退 |
| `ACCOUNT_PROXY_TARGET_HOSTS` | 受保护的上游主机，默认 `www.codebuff.com,codebuff.com` |
| `ACCOUNT_PROXY_CONNECT_TIMEOUT_MS` | 代理 TCP/TLS/CONNECT 建连上限，默认 `10000` 毫秒 |
| `ACCOUNT_PROXY_RETIRE_MS` | 热加载后旧代理连接池的排空时间，默认 `300000` 毫秒 |
| `FREEBUFF_TOKEN` / `FREEBUFF_PROXY_URL` | 仅供 `ADMIN_ENABLED=false` 兼容模式；Web 管理模式必须留空 |
| `FREEBUFF_DEBUG` | `true` 开启请求级调试日志 |
| `MAX_REQUEST_BODY_BYTES` | 公开 API 请求体上限，默认 `10485760`（10 MiB），超限返回 `413` |
| `WORKER_UPDATE_MODE` | `bundled`（默认、固定版本）或 `latest`（重启时拉取） |
| `WORKER_URL` / `WORKER_SHA256` | `latest` 模式的下载地址和 SHA-256；该模式强制要求校验值 |
| `CODEBUFF_API` / `RELAY_KEY` | 上游兼容预留；当前上游 `worker.js` 仍固定使用官方地址 |

`FREEBUFF_API_KEY_FILE`、`ACCOUNT_STORE_KEY_FILE` 和 `ADMIN_PASSWORD_FILE` 也可从只读文件读取对应秘密；同名直接环境变量非空时优先。使用 Compose 时，这些变量只负责把**容器内路径**传给程序，必须同时用 Docker secrets、只读 bind mount 或等价方式把文件放进容器；仅在宿主机设置一个文件路径而不挂载文件会导致启动失败。默认 `.env` 示例使用直接值，因此不需要额外挂载。

#### 7. 更新策略

生产保持 `WORKER_UPDATE_MODE=bundled`，容器运行构建时通过测试的固定 `worker.js`。`latest` 模式只替换 `worker.js`，必须同时设置 `WORKER_SHA256`，最好让 `WORKER_URL` 指向不可变 commit；它仍无法更新 Web 管理、数据库迁移或代理依赖，不适合无人值守升级。

完整的上游同步、测试、数据库备份和镜像回滚流程见 [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md)。代理补丁位于 Docker/Node 适配层，正常合并上游业务更新时通常不会产生核心文件冲突。

#### 维护者：发布新镜像到 Docker Hub

仓库已配置 `.github/workflows/docker-publish.yml`（手动触发，多架构 amd64/arm64）。在 GitHub Secrets 配置 `DOCKERHUB_USERNAME` 与 `DOCKERHUB_TOKEN` 后，到 Actions 页面选择代理分支、填写不可变 `image_tag` 再运行。工作流拒绝 `latest` 和已经存在的标签。

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


