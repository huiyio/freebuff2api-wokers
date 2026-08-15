# freebuff2api-workers 当前项目基线

更新日期：2026-08-15（Asia/Shanghai）
项目位置：仓库根目录
当前分支：`codex/per-account-proxy`
上游远端：`https://github.com/pingmike2/freebuff2api-wokers.git`
同步基线：`origin/main` = `a01b8b9b35681a96da6cebd822ded628cc06989d`

> 当前改造维护在 `codex/per-account-proxy` 功能分支，尚未合并到 `main` 或生产部署。工作区和远端分支的真实状态以 Git 为准；不要把本文件中的示例凭据当作可用账号。

## 1. 项目定位

项目包含两条运行形态：

1. `worker.js` 是无运行时依赖的 Cloudflare Worker，负责 Freebuff session、agent-run、SSE chat 生命周期，并提供 OpenAI/Responses/Anthropic 兼容路由。
2. Docker/Node 适配层提供长期运行的账号管理控制面：加密 SQLite、Web 管理端、每账号代理、审计和一次性旧凭据导入。生产推荐 Docker/VPS；Cloudflare 仅保留为高风险兼容部署。

核心请求链：

```text
客户端请求
  -> API key 校验和请求体限制
  -> 账号池选择（健康/冷却/活跃 session）
  -> 按账号代理连接 Freebuff
  -> 获取或创建 session
  -> 创建/复用 agent run 链
  -> 注入 Buffy system 前缀与 codebuff_metadata
  -> 上游强制 SSE
  -> 流式转发或聚合为非流式响应
```

## 2. 入口与文件职责

- `worker.js`：Worker 主逻辑、动态模型注册、账号轮询、session/run/chat、SSE 和协议转换。
- `server.js`：Node HTTP 运行时；加载管理账号或兼容环境账号，把请求转给 Worker，并包装代理路由。
- `account-proxy.js`：账号配置解析、HTTP/HTTPS/SOCKS5 路由和严格代理失败策略。
- `account-manager.js`：账号生命周期、健康状态、代理热加载和运行时快照。
- `account-store.js`：SQLite schema、账号/审计/设置持久化。
- `credential-vault.js`：AES-256-GCM 加密 Token/完整代理 URL 和主密钥校验。
- `admin-auth.js`：scrypt 管理员密码、会话 Cookie、登录限流。
- `admin-server.js`、`admin-ui/`：管理 API 和 Web 管理端。
- `import-credentials.js`：一次性读取旧 `freebuff_credentials.json`，导入后只保留加密 SQLite。
- `docker-entrypoint.sh`：默认使用镜像内固定 `worker.js`；`WORKER_UPDATE_MODE=latest` 时要求 URL 和 SHA-256 校验。
- `tests/`：代理、存储、鉴权、管理端、导入器和 Worker 并发/流取消回归测试。
- `README.md`：项目入口、模型、调用和部署摘要；`DOCKER.md`：GHCR 镜像、Compose、`docker run`、导入、HTTPS 和发布主文档；`UPSTREAM_SYNC.md`：升级、备份、回滚流程；`LEGAL_NOTICE.md`、`RESPONSIBILITIES.md`、`CHANGE_CONTROL.md`、`SECURITY.md`、`NOTICE.md`：法律边界、责任交接、变更审批、安全报告和第三方归属。

## 3. API 路由

Worker 侧：

- `GET /healthz`：免鉴权，只返回聚合健康信息；带有效 API key 才返回脱敏账号状态。
- `GET /v1/models`、`GET /models`：静态/动态模型目录，不主动探测上游 session。
- `POST /v1/chat/completions`、`POST /chat/completions`：OpenAI chat，支持流式和非流式。
- `POST /v1/responses`、`POST /responses`：Responses 到 chat 的本地适配。
- `POST /v1/messages`、`POST /messages`：Anthropic Messages 适配。
- `POST /v1/messages/count_tokens`、`POST /messages/count_tokens`：本地 token 计数兼容入口。

Node 管理侧：

- 公开 API 默认监听 `8787`，Compose 宿主机默认映射 `127.0.0.1:8877`。
- 管理端默认监听 `8788`，Compose 宿主机默认映射 `127.0.0.1:8878`。
- 管理端支持管理员账号/密码登录、账号增删改、启停、搜索、代理测试、审计查看、管理员密码修改，以及 API Key 设置/轮换和 OpenAI/Anthropic 接入文档。
- `GET /admin/api/api-key` 只返回 `configured`、掩码和更新时间；`PUT /admin/api/api-key` 支持自定义值或 `{ "generate": true }`，明文只在当前响应中返回一次。

## 4. 账号、代理和状态模型

### 管理模式（默认 Docker Compose）

- `ADMIN_ENABLED=true` 时，`FREEBUFF_TOKEN` 和 `FREEBUFF_PROXY_URL` 必须为空；账号只能来自首次旧凭据导入或 Web 管理端。
- Token 和完整代理 URL 使用 AES-256-GCM 加密存入 SQLite；API 响应只返回掩码值。
- 管理员账号写入 `settings.admin_username`，首次由 `ADMIN_USERNAME` 初始化（默认 `admin`），后续环境变量不会覆盖数据库值；密码使用 scrypt 哈希。Cookie 为 HttpOnly/SameSite=Strict，可在 HTTPS 反代后启用 Secure。
- `REQUIRE_ACCOUNT_PROXY=true` 时，启用账号必须有 `http://`、`https://`、`socks5://` 或 `socks5h://` 代理；代理失败严格报错，不回退直连。
- 修改、删除、停用账号会清理健康、冷却、session、run 和行为缓存；代理更新使用请求级租约，旧请求结束前不会提前关闭旧路由。

### 兼容模式（`ADMIN_ENABLED=false`）

- `FREEBUFF_TOKEN` 支持逗号或换行分隔，也支持 `token:uid` 条目。
- `FREEBUFF_PROXY_URL` 为所有环境账号共用代理；需要每账号独立代理时使用管理模式。

### Worker 内存状态

健康快照、冷却、行为节流、session/run 缓存和 session 创建队列都在 isolate 内存中。账号代次会隔离旧请求的写入，防止修改账号后旧请求污染新配置；但 Cloudflare 多 isolate/多地域之间不共享，Docker 多进程也不共享。生产需要跨实例强协调时应另行设计 Durable Object 或单实例入口。

同一账号/代次/模型的 session 生命周期操作按键串行；并发调用会在前一个操作完成后再次检查缓存，避免重复 POST 创建 session 并互相顶掉实例。该锁只解决同一运行进程内的竞争，不能改变 Freebuff 上游的单账号单会话限制。

## 5. 安全边界

- `FREEBUFF_API_KEY` 在兼容模式必须显式设置为随机强密钥；管理模式仅首次初始化需要它，之后从加密 SQLite 读取并支持管理端热轮换。缺失或使用已知默认值时请求被拒绝。
- `ADMIN_USERNAME` 和 `ADMIN_PASSWORD` 只在首次初始化时从 Docker 环境读取；管理员账号区分大小写、不得包含空白，密码长度为 12-256 字符。
- 管理 API 使用 CSRF、HttpOnly Cookie、登录失败限流、请求体上限和安全响应头。
- `.env`、SQLite、旧凭据、`credentials.yaml` 和 `deploy.sh` 被 Git 与 Docker 构建上下文忽略；不要把 Token、代理密码或主密钥写入日志、Issue、截图或提交历史。
- `_FILE` 机密变量只读取容器内文件路径；Compose 使用时必须额外挂载文件或 Docker secret。
- 代理只改变出口，不能解除 Freebuff 上游的 `banned`、地区限制或服务端封禁。

## 6. 部署方式

### 推荐：Docker Compose

1. 生成首次使用的 `FREEBUFF_API_KEY`、`ACCOUNT_STORE_KEY`、`ADMIN_USERNAME` 和初始 `ADMIN_PASSWORD`，写入权限为 600 的 `.env`；后续 API Key 可在管理端轮换，旧值立即失效。
2. 从 `ghcr.io/huiyio/freebuff2api-wokers` 拉取固定版本或 `sha-*` 镜像；可选地运行一次性旧 JSON 导入。
3. `docker compose config --quiet && docker compose pull freebuff2api && docker compose up -d --no-build freebuff2api`。
4. 通过 SSH 隧道或 HTTPS 反向代理访问 `/admin/`；确认 HTTPS 后再启用 `ADMIN_COOKIE_SECURE=true` 和 `ADMIN_TRUST_PROXY=true`。完整命令见 `DOCKER.md`。

### 等价：Docker run

直接拉取同一 GHCR 不可变镜像并创建 `freebuff_data` volume；导入命令临时只读挂载旧 JSON，日常容器只挂载 `/app/data`。不要把分支便利标签当作回滚点。

### 兼容：Cloudflare Worker

可用 `npx wrangler deploy worker.js --name <name> --compatibility-date <date>` 或控制台粘贴单文件部署。当前项目明确不推荐把它作为主要生产入口：上游可识别边缘特征，封禁风险和 isolate 状态丢失风险更高。只需 dry-run 时加 `--dry-run`，不会上传。

## 7. 获取账号与上游限制

`freebuff_tools/extract_freebuff.py login` 打开官方授权链接，轮询完成后把凭证写入本地 JSON；该文件始终是敏感文件，不能提交。已有账号若返回 `403 {"status":"banned"}`，代理不能修复，需联系 Freebuff 官方支持或更换合法账号；不要把代理当作绕过封禁手段。

模型目录和额度属于上游动态信息。README 当前按官方完整访问模式和实测快照描述，不能作为 SLA；真实额度、地区、资格和模型开放状态必须在部署时用专用测试账号重新确认。

## 8. 验证记录（本地、未使用真实上游凭据）

截至 2026-08-15：

- `npm.cmd run check`：通过。
- `npm.cmd test`：50/50 通过，包含管理员账号初始化/旧库补齐/重启持久化、API Key 轮换、每账号代理、并发 session 创建串行化，以及 Docker/GHCR 文档契约回归。
- `npm.cmd audit --omit=dev`：0 vulnerabilities。
- `npm.cmd ci --ignore-scripts --omit=dev --dry-run`：通过。
- `git diff --check`：通过；仅有 Windows 行尾转换提示。
- Wrangler `4.123.0` dry-run：通过，约 87.7 KiB，gzip 约 20.2 KiB，无 bindings。
- 已完成真实管理端登录、账号列表和预览 UI 检查，预览使用合成账号；没有读取或发送真实 Token。
- 本机没有 Docker/Compose，因此本地未 build 或启动镜像；多架构镜像由 GitHub Actions 在 Linux runner 上构建，运行结果和 digest 应以 Actions/GHCR 记录为准。
- 没有使用真实 Freebuff 凭据做 session/chat 端到端测试；上游 `banned` 行为和额度仍未验证。

## 9. 后续操作顺序

1. 在有 Docker 的目标机拉取已发布 GHCR 镜像，执行一次性导入和 Compose 启动，验证卷权限、管理员登录和代理测试。
2. 用一个专用、获授权的测试账号做一次真实 `/v1/models`、流式 chat 和非流式 chat；记录脱敏状态码，不把 Token 放入日志。
3. 每次发布前检查 `git status --short`、`git diff --check`、敏感文件和 `package-lock.json`；给可部署提交打本地回退标签。
4. 生产升级遵循 `UPSTREAM_SYNC.md`：先备份 SQLite 和 `ACCOUNT_STORE_KEY`，使用不可变镜像标签，保留旧镜像和回滚 Git 标签。
5. 上游更新时逐段审查 `worker.js`，尤其是 session gate、模型映射、SSE、代理入口和账号代次，不要整文件覆盖本分支。

## 10. 当前未完成事项

- 功能分支尚未合并到 `main`，本次改造也未生产部署。
- 未在本机实际构建 Docker 镜像（环境缺少 Docker CLI）。
- 未实现跨 Cloudflare isolate 的全局账号协调；当前 Worker 仍是 isolate-local 状态。
- 未承诺任何模型的固定额度或绕过封禁能力。
