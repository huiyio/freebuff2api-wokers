# Docker 部署与镜像发布

本文是本分支 Docker 运行方式的主文档。README 只保留快速入口；账号导入、密钥、升级、回滚和 GitHub Actions 发布以本文为准。

## 1. 镜像与支持范围

- GHCR 镜像：`ghcr.io/huiyio/freebuff2api-wokers`
- 支持架构：`linux/amd64`、`linux/arm64`
- 容器端口：公开 API `8787`，Web 管理端 `8788`
- 数据目录：`/app/data`，默认 SQLite 为 `/app/data/freebuff.sqlite`
- 默认运行用户：`node`（UID/GID `1000:1000`）

可用标签分三类：

| 标签 | 是否可变 | 用途 |
|---|---:|---|
| `1.8.9-admin.5` 等版本标签 | 否 | 人工验收后的部署和回滚 |
| `sha-<提交前12位>` | 否 | 每次维护分支推送对应的精确构建 |
| `branch-codex-per-account-proxy` | 是 | 临时试用维护分支最新构建，不作为生产回滚点 |

仓库不发布 `latest`。生产应固定版本标签、`sha-*` 标签，或进一步固定 Actions 输出的镜像 digest。

当前推荐版本为 `1.8.9-admin.5`。对应 Git tag 会触发 GitHub Actions 多架构构建；在构建完成前不要假设 digest，完成后应从 Actions 输出复制实际 digest。`1.8.9-admin.4` 的已验证回退 digest 为 `sha256:3f99c7d38fde3eb06aaa831988031fe4ea51cde2c564911637e778e55814e73c`。截至 2026-08-16，GHCR Package 已验证为 Public，可直接拉取：

```bash
docker pull ghcr.io/huiyio/freebuff2api-wokers:1.8.9-admin.5
```

镜像发布完成后，从 Actions 构建摘要复制 digest，并在生产环境进一步固定为 `ghcr.io/huiyio/freebuff2api-wokers@sha256:...`。

如果后续 Package 可见性或组织策略改变，私有包需要使用仅有 `read:packages` 权限的 PAT 登录；不要把 PAT 写进 `.env`、Compose、Issue 或命令示例。

## 2. Compose 快速部署（推荐）

要求 Docker Engine 与 Docker Compose V2。以下命令从仓库根目录执行。

### 2.1 创建首次初始化密钥

`FREEBUFF_API_KEY`、`ACCOUNT_STORE_KEY` 和管理员密码用途不同，不得复用。`ACCOUNT_STORE_KEY` 丢失后，现有 SQLite 中的 Token 和代理密码无法解密。

Linux、macOS、Git Bash 或 WSL：

```bash
set -eu
umask 077
api_key="$(openssl rand -hex 32)"
store_key="$(openssl rand -hex 32)"
admin_password="$(openssl rand -hex 24)"

cat > .env <<EOF
FREEBUFF_IMAGE=ghcr.io/huiyio/freebuff2api-wokers:1.8.9-admin.5
FREEBUFF_API_KEY=${api_key}
ACCOUNT_STORE_KEY=${store_key}
ADMIN_USERNAME=admin
ADMIN_PASSWORD=${admin_password}
RELAY_KEY=
FREEBUFF_TOKEN=
FREEBUFF_PROXY_URL=
REQUIRE_ACCOUNT_PROXY=true
ADMIN_COOKIE_SECURE=false
ADMIN_TRUST_PROXY=false
WORKER_UPDATE_MODE=bundled
EOF

chmod 600 .env
unset api_key store_key admin_password
```

Windows PowerShell：

```powershell
function New-HexSecret([int]$Bytes) {
  $buffer = [byte[]]::new($Bytes)
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($buffer) } finally { $rng.Dispose() }
  return -join ($buffer | ForEach-Object { $_.ToString('x2') })
}

@(
"FREEBUFF_IMAGE=ghcr.io/huiyio/freebuff2api-wokers:1.8.9-admin.5"
  "FREEBUFF_API_KEY=$(New-HexSecret 32)"
  "ACCOUNT_STORE_KEY=$(New-HexSecret 32)"
  "ADMIN_USERNAME=admin"
  "ADMIN_PASSWORD=$(New-HexSecret 24)"
  "RELAY_KEY="
  "FREEBUFF_TOKEN="
  "FREEBUFF_PROXY_URL="
  "REQUIRE_ACCOUNT_PROXY=true"
  "ADMIN_COOKIE_SECURE=false"
  "ADMIN_TRUST_PROXY=false"
  "WORKER_UPDATE_MODE=bundled"
) | Set-Content -Encoding ascii .env
```

`.env` 只负责首次初始化管理员账号、密码、API Key，以及每次启动时提供数据库主密钥。数据库建立后，修改 `.env` 中的 `ADMIN_USERNAME`、`ADMIN_PASSWORD` 或 `FREEBUFF_API_KEY` 不会覆盖数据库当前值；密码和 API Key 应在管理端修改。

### 2.2 拉取并启动预构建镜像

```bash
docker compose config --quiet
docker compose pull freebuff2api
docker compose up -d --no-build freebuff2api
docker compose ps
docker compose logs --tail 50 freebuff2api
curl -fsS http://127.0.0.1:8877/healthz
```

`--no-build` 很重要：`docker-compose.yml` 同时保留了维护者的本地构建入口，不加该选项时 Compose 可能根据本地源码构建，而不是使用刚拉取的 GHCR 镜像。

启动后：

- Web 管理端：`http://127.0.0.1:8878/admin/`
- OpenAI-compatible Base URL：`http://127.0.0.1:8877/v1`
- API Key：首次为 `.env` 的 `FREEBUFF_API_KEY`，之后以管理端 **API Key** 页面保存的当前值为准
- 管理登录：首次为 `.env` 的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`，之后以 SQLite 中当前账号和密码哈希为准

默认两个宿主机端口都只绑定 `127.0.0.1`。远程访问应通过 SSH 隧道或 HTTPS 反向代理，不要直接把管理端明文 HTTP 暴露到公网。

## 3. 添加账号与代理

最简单的方式是登录管理端，在“账号”页面点击“授权账号”，用你自己的 Codebuff/Freebuff 账号完成一次性授权。点击后会自动生成链接，服务端后台任务独立轮询；Token 直接加密写入 SQLite，无需复制到浏览器。关闭弹窗或页面不会中断任务，重新打开会复用同一个未完成授权；只有“取消授权”、登出、会话失效或服务重启会终止任务。授权账号始终先停用，确认配置后再启用；严格代理模式下必须先补齐代理。

“导入 Token（高级）”仅保留给旧凭据迁移或故障恢复。每个账号的代理格式：

```text
http://host:port
http://username:password@host:port
https://username:password@host:port
socks5://username:password@host:port
socks5h://username:password@host:port
```

用户名或密码含 `@`、`:`、`/`、`#` 等保留字符时必须进行 URL 编码。`REQUIRE_ACCOUNT_PROXY=true` 或账号勾选“代理必需”时，每个启用账号都必须配置代理；连接失败直接报错，不会回退直连。代理只能改变出口，不能恢复或绕过上游标记为 `banned` 的账号。

### 3.1 管理端测试

账号页将两个层面明确分开：

| 操作 | 验证内容 | 不验证的内容 |
|---|---|---|
| **代理测试** | 先通过该账号配置的代理访问中立连通性目标，再通过同一个调度器访问 `https://www.codebuff.com/`；两个阶段各自返回状态、HTTP 状态和延迟 | 不携带账号 Token，不创建 session，不能说明账号未封禁、Token 有效或模型有额度 |
| **模型测试** | 仅对已停用账号的所选模型发送一次最短真实请求；返回脱敏响应摘要、HTTP 状态、延迟、封禁标记与诊断码 | 不是零消耗探测；若无法复用同模型的活动 session，创建 session 可能计入 Freebuff 上游额度 |

没有代理时，外层“代理测试”和“模型测试”按钮仍可点击，以便给出明确配置状态；代理测试会返回 `ACCOUNT_PROXY_MISSING`，不会改走服务器直连。第一阶段失败时，第二阶段会显示为跳过；收到 HTTP 响应代表网络路径到达目标，HTTP 状态仍应结合结果判断。已停用账号的模型测试在全局和账号都允许直连时可以直连；严格模式或账号“代理必需”时，模型选择框会阻止提交并提示先配置代理，直接调用接口也会得到 `ACCOUNT_PROXY_MISSING`。两种测试均不会把 Token、完整代理 URL 或密码放进响应和审计摘要。

模型测试会优先复用同模型的既有活动 session，绝不会替换或删除其他模型的活动 session。为避免影响正在服务的请求，管理 API 会拒绝对启用账号运行模型测试，先停用账号再操作。它会在结束时删除自己新建的 session，避免留下等待位，但 session 的创建仍可能已经消耗上游额度。请只在需要定位账号、模型或封禁问题时运行，不要将其当作高频健康检查。

管理 API 只面向已登录管理员，所有变更请求还要求同源 CSRF Token：

| 方法和路径 | 请求体 | 行为 |
|---|---|---|
| `GET /admin/api/test-models` | 无 | 返回管理端允许选择的模型目录 |
| `POST /admin/api/accounts/:id/test-proxy-check` | `{}` | 执行“代理连接 -> 经代理访问 Freebuff”两阶段测试 |
| `POST /admin/api/accounts/:id/test-model` | `{"model":"<模型 ID>","confirm":true}` | 执行真实模型请求；`confirm: true` 为必填确认，缺失时拒绝执行 |

模型测试会将上游 `403 {"status":"banned"}` 归类为 `FREEBUFF_BANNED` 并标记 `banned: true`；额度、Token、会话冲突和超时也会返回各自的诊断码。代理测试成功不表示模型测试也会成功，反之亦然。

Web 授权链接是短期能力凭据，只能由创建它的管理员会话查看；服务端只在“等待授权”状态的响应中返回链接，进入保存或终态后立即清除。后台轮询不依赖管理页面保持打开。不要转发链接、写入日志或在公网明文 HTTP 管理端使用；对外管理入口应由 HTTPS 反向代理保护。

服务每次启动都会清空持久化的管理员会话。容器重启或恢复 SQLite 备份后需要重新登录，这可防止旧备份中的会话记录让已经注销或改密撤销的浏览器 Cookie 再次生效。

Web 管理模式下，`.env` 中的 `FREEBUFF_TOKEN` 和 `FREEBUFF_PROXY_URL` 必须保持为空；否则容器会拒绝启动，避免出现管理端看不到的旁路账号。

## 4. 一次性导入旧账号

只在需要迁移 `freebuff_tools/freebuff_credentials.json` 时执行。日常服务不挂载该明文文件。

Linux、macOS、Git Bash 或 WSL：

```bash
docker compose pull freebuff2api
docker compose run --rm --no-deps \
  -v "$(pwd)/freebuff_tools/freebuff_credentials.json:/app/credentials/freebuff_credentials.json:ro" \
  freebuff2api npm run import:credentials
```

Windows PowerShell：

```powershell
docker compose pull freebuff2api
docker compose run --rm --no-deps `
  -v "${PWD}/freebuff_tools/freebuff_credentials.json:/app/credentials/freebuff_credentials.json:ro" `
  freebuff2api npm run import:credentials
```

导入只在账号库为空且尚未完成导入时执行一次。聚合凭据通常没有 `proxyUrl`；严格代理模式会把这些账号导入为停用，需在管理端补充代理后再启用。导入完成并核对账号数量、备份 `ACCOUNT_STORE_KEY` 后，应把明文 JSON 移到受保护位置或安全删除。

## 5. 不使用 Compose 的 `docker run`

```bash
docker volume create freebuff_data
docker pull ghcr.io/huiyio/freebuff2api-wokers:1.8.9-admin.5

docker run -d --name freebuff2api --restart unless-stopped \
  -p 127.0.0.1:8877:8787 \
  -p 127.0.0.1:8878:8788 \
  --env-file .env \
  -e PORT=8787 \
  -e HOST=0.0.0.0 \
  -e ADMIN_ENABLED=true \
  -e ADMIN_HOST=0.0.0.0 \
  -e ADMIN_PORT=8788 \
  -e ACCOUNT_DB_PATH=/app/data/freebuff.sqlite \
  --mount type=volume,src=freebuff_data,dst=/app/data \
ghcr.io/huiyio/freebuff2api-wokers:1.8.9-admin.5
```

旧账号导入也可用同一镜像运行一次性 `npm run import:credentials`；完整挂载参数参照上面的 Compose 示例。不要把明文凭据挂载到日常服务容器。

## 6. HTTPS 和远程管理

临时远程管理可建立 SSH 隧道：

```bash
ssh -L 8878:127.0.0.1:8878 user@your-server
```

长期使用应让受信任反向代理终止 HTTPS，并保留 `/admin/` 路径。Nginx 关键配置：

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

确认 HTTPS 可用且反向代理是唯一能访问管理端的入口后，设置：

```dotenv
ADMIN_COOKIE_SECURE=true
ADMIN_TRUST_PROXY=true
```

然后执行 `docker compose up -d --no-build --force-recreate`。启用 Secure Cookie 后必须从 HTTPS 登录。

## 7. 升级、固定 digest 与回滚

升级前必须同时备份：

1. `/app/data/freebuff.sqlite` 的一致性副本；
2. 与该数据库匹配的 `ACCOUNT_STORE_KEY`；
3. 当前 `FREEBUFF_IMAGE` 标签或 digest。

选择新的不可变标签后：

```bash
# 先把 .env 中 FREEBUFF_IMAGE 改成新的版本或 sha-* 标签
docker compose pull freebuff2api
docker compose up -d --no-build freebuff2api
docker compose logs --tail 50 freebuff2api
curl -fsS http://127.0.0.1:8877/healthz
```

Actions 构建摘要会输出 digest，可将 `.env` 固定为：

```dotenv
FREEBUFF_IMAGE=ghcr.io/huiyio/freebuff2api-wokers@sha256:REPLACE_WITH_PUBLISHED_DIGEST
```

回滚时恢复旧镜像引用；如果新版本包含数据库迁移，还应恢复与旧镜像匹配的 SQLite 备份和 `ACCOUNT_STORE_KEY`。完整停服备份、恢复和上游同步流程见 [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md)。不要执行 `docker compose down -v`，它会删除账号数据库卷。

## 8. 本地源码构建

只有开发、审计或尚未发布镜像时才需要本地构建：

```bash
npm ci
npm run check
npm test
docker compose up -d --build freebuff2api
```

本地镜像与 GHCR 镜像不要使用同一个不可变标签。构建上下文已排除 `.env`、SQLite、旧凭据和常见密钥文件；发布前仍应检查 Git 状态和构建日志。

## 9. GitHub Actions 发布流程（维护者）

工作流位于 [`.github/workflows/docker-publish.yml`](.github/workflows/docker-publish.yml)，使用仓库自带 `GITHUB_TOKEN` 发布到 GHCR，不需要 Docker Hub 账号或 Secret。

触发方式：

- 推送到 `codex/per-account-proxy`：自动测试并发布 `sha-<提交前12位>`，同时更新分支便利标签；
- 推送 `v*` Git tag：去掉开头 `v` 后发布为版本标签；
- 工作流合并到默认分支后，可在 Actions 页面手动运行：填写尚未使用的不可变 `image_tag`，留空则使用 `sha-<提交前12位>`。

发布前工作流执行 `npm ci`、语法检查和完整测试，再构建 amd64/arm64 镜像、SBOM 和 provenance。主标签已存在时工作流拒绝覆盖；`latest` 始终被拒绝。

仓库 Settings -> Actions -> General 中应允许 Actions；工作流文件显式声明了最小的 `contents: read` 和 `packages: write` 权限。首次发布后，在 Package settings 中确认包已连接到本仓库。当前 Package 已验证为 Public，可匿名 `docker pull`；若组织策略改变可见性，再使用最小权限 PAT。

## 10. 安全与责任边界

- 维护者负责源码、构建工作流和发布说明，不代替部署者保管密钥或操作生产环境。
- 部署运营方负责账号授权、代理来源、数据保护、访问控制、备份、监控和遵守上游条款。
- 镜像可运行不代表 Freebuff 账号有效、模型有固定额度或上游提供 SLA。
- AGPL-3.0 代码许可不等同于 Freebuff、GitHub、Docker 或其他第三方服务授权。

部署前请阅读 [`LEGAL_NOTICE.md`](LEGAL_NOTICE.md)、[`RESPONSIBILITIES.md`](RESPONSIBILITIES.md)、[`CHANGE_CONTROL.md`](CHANGE_CONTROL.md)、[`SECURITY.md`](SECURITY.md) 和 [`NOTICE.md`](NOTICE.md)。

## 11. 常见问题

- `manifest unknown`：标签尚未发布，或 `.env` 中标签拼写错误；到 Actions 构建摘要确认精确引用。
- `denied` / `unauthorized`：先核对标签和 Package 当前可见性；若组织策略已改为 private，再用仅有 `read:packages` 权限的 PAT 登录。
- `ACCOUNT_STORE_KEY verification failed`：数据库与主密钥不匹配；立即停用该实例，恢复配套密钥，不要覆盖数据库。
- 管理端登录信息没随 `.env` 改变：这是预期行为；初始化后账号、密码和 API Key 以 SQLite 当前值为准。
- 启用账号提示缺少代理：严格模式要求每个启用账号有自己的代理；也可在明确接受直连风险后设置 `REQUIRE_ACCOUNT_PROXY=false`。
- 上游返回 `403 {"status":"banned"}`：这是账号侧拒绝，换代理或重启容器不能解除。
