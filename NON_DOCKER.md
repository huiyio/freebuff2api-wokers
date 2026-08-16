# 非 Docker 服务器部署

本方式直接在 Linux VPS 上运行 Node 源码 release，不使用 Docker。当前项目没有独立的单文件二进制构建物；运行时需要保留 `server.js`、`worker.js`、账号/管理模块、`admin-ui/`、`migrations/` 以及 `package.json`/`package-lock.json`。

## 1. 运行边界

- Node.js 24.x（以 `package.json` 的 `engines` 为准）和生产依赖由 `npm ci --omit=dev --ignore-scripts` 安装。
- 建议用专用 `freebuff` 用户运行，SQLite 数据放在 `/var/lib/freebuff2api/`，环境文件放在 `/etc/freebuff2api/freebuff2api.env` 并设为 `0600`。
- 公共 API 可以监听本机 `8787`；管理端建议只监听 `127.0.0.1:8788`。Caddy/Nginx 可提供 HTTPS，SSH 隧道则在加密隧道内访问本地 HTTP；不要把管理端以明文 HTTP 暴露到公网。
- `ADMIN_ENABLED=true` 时，点击管理页“授权账号”会自动生成一次性链接；完成授权后由服务端后台轮询并把 Token 直接加密写入 SQLite，管理页面关闭也不会中断。账号默认停用，严格代理模式下先填写代理再启用。账号页的“代理测试”和“模型测试”是不同操作：前者检查“代理连接 -> 经代理访问 Freebuff”的网络路径，不使用 Token 或 session；后者选择模型并执行一次最短真实请求，可能因新建 session 计入上游额度。完整管理 API、确认字段和结果解释见 [DOCKER.md](DOCKER.md#31-管理端测试)，该行为与 Docker 部署相同。

先按 Node.js 官方发行方式安装 Node 24，并记录实际绝对路径。systemd 不应假定自定义目录必然存在：

```bash
id freebuff >/dev/null 2>&1 || useradd --system --home /nonexistent --shell /usr/sbin/nologin freebuff
NODE_BIN=$(command -v node)
test -n "$NODE_BIN" && test -x "$NODE_BIN"
case "$NODE_BIN" in /root/*|/home/*) echo 'Node must use a system-level path' >&2; exit 1;; esac
runuser -u freebuff -- "$NODE_BIN" -e 'if (Number(process.versions.node.split(".")[0]) < 24) process.exit(1)'
npm --version
printf 'Node executable: %s\n' "$NODE_BIN"
```

## 2. 目录布局

```text
/opt/freebuff2api/
  releases/<commit>/       # 每次发布一个不可变目录
  current -> releases/...  # 当前运行版本的原子 symlink
/var/lib/freebuff2api/
  freebuff.sqlite          # 加密账号库，禁止放进 Git
/etc/freebuff2api/
  freebuff2api.env         # 机密配置，权限 0600
```

## 3. 首次安装

在构建机从已审查的 commit 生成不含工作区凭据的归档，并计算校验值：

```bash
git archive --format=tar.gz --prefix=freebuff2api/ <COMMIT> -o freebuff2api-<COMMIT>.tar.gz
sha256sum freebuff2api-<COMMIT>.tar.gz
scp freebuff2api-<COMMIT>.tar.gz <server>:/tmp/
```

在服务器上校验归档后解压、安装依赖并准备权限。以下命令中的 `<SHA256>`、`<COMMIT>` 和主机名必须替换为本次发布值：

```bash
set -euo pipefail
sha256sum -c <<< '<SHA256>  /tmp/freebuff2api-<COMMIT>.tar.gz'
test ! -e /opt/freebuff2api/releases/<COMMIT>
install -d -o freebuff -g freebuff /opt/freebuff2api/releases/<COMMIT>
tar -xzf /tmp/freebuff2api-<COMMIT>.tar.gz -C /opt/freebuff2api/releases/<COMMIT> --strip-components=1
cd /opt/freebuff2api/releases/<COMMIT>
npm ci --omit=dev --ignore-scripts
npm run check
install -d -m 0700 -o freebuff -g freebuff /var/lib/freebuff2api
chown -R freebuff:freebuff /opt/freebuff2api/releases/<COMMIT>
ln -s /opt/freebuff2api/releases/<COMMIT> /opt/freebuff2api/current.next-<COMMIT>
mv -Tf /opt/freebuff2api/current.next-<COMMIT> /opt/freebuff2api/current
```

如果先解压到 `mktemp -d` 再整体移动为 release，必须在切换前确认最终 release 根目录可被服务用户遍历，例如 `chmod 0755 /opt/freebuff2api/releases/<COMMIT>` 并执行 `runuser -u freebuff -- test -x /opt/freebuff2api/releases/<COMMIT>`。`mktemp -d` 默认的 `0700` 会导致 systemd 报 `status=200/CHDIR`。

环境文件至少应包含随机生成且只保存在服务器上的值：

```dotenv
HOST=127.0.0.1
PORT=8787
ADMIN_ENABLED=true
ADMIN_HOST=127.0.0.1
ADMIN_PORT=8788
ADMIN_USERNAME=<administrator-username>
ADMIN_PASSWORD=<administrator-password>
FREEBUFF_API_KEY=<random-api-key>
ACCOUNT_STORE_KEY=<64-hex-character-key>
ACCOUNT_DB_PATH=/var/lib/freebuff2api/freebuff.sqlite
REQUIRE_ACCOUNT_PROXY=true
FREEBUFF_TOKEN=
FREEBUFF_PROXY_URL=
ADMIN_COOKIE_SECURE=false
ADMIN_TRUST_PROXY=false
```

```bash
install -d -m 0750 /etc/freebuff2api
install -m 0600 freebuff2api.env /etc/freebuff2api/freebuff2api.env
```

不要把真实环境文件、SQLite、旧凭据 JSON 或代理密码放进 release 归档、Shell 历史、日志或聊天记录。首次启动会把管理员账号/密码和 API Key 初始化到加密 SQLite；确认可以登录后可从环境文件删除 `ADMIN_PASSWORD` 和 bootstrap `FREEBUFF_API_KEY`，但 `ACCOUNT_STORE_KEY` 必须永久保留并纳入离线备份。之后修改 `ADMIN_USERNAME` 或 `ADMIN_PASSWORD` 环境变量不会覆盖数据库中的管理员账号。

服务每次启动都会撤销数据库中的全部管理员会话。升级、重启或恢复 SQLite 后需要重新登录，以免备份中的旧会话让已注销或改密撤销的浏览器 Cookie 再次生效。

上面的 Cookie/代理信任值适用于 SSH 隧道或仅本机访问。配置可信 HTTPS 反向代理后，再把 `ADMIN_COOKIE_SECURE=true`；只有反向代理会正确清理并设置客户端地址头时才启用 `ADMIN_TRUST_PROXY=true`。

## 4. systemd

创建 `/etc/systemd/system/freebuff2api.service`：

```ini
[Unit]
Description=Freebuff2API Node service
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=freebuff
Group=freebuff
WorkingDirectory=/opt/freebuff2api/current
EnvironmentFile=/etc/freebuff2api/freebuff2api.env
ExecStart=<ABSOLUTE_NODE_PATH> /opt/freebuff2api/current/server.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/freebuff2api

[Install]
WantedBy=multi-user.target
```

把 `<ABSOLUTE_NODE_PATH>` 替换为前置检查输出的 `NODE_BIN`（例如 `/usr/local/bin/node`）；保存 unit 前必须执行 `test -x <ABSOLUTE_NODE_PATH>`。不要原样保留占位符。

启用并检查：

```bash
systemctl daemon-reload
systemctl enable --now freebuff2api.service
systemctl status --no-pager freebuff2api.service
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:8787/healthz >/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/healthz
curl -i http://127.0.0.1:8788/admin/
```

健康检查不能证明管理版本；登录管理端后查看 `/admin/api/system` 的 `appVersion`，并核对 `readlink -f /opt/freebuff2api/current`。

## 5. 升级与回滚

先停止服务并备份 SQLite、环境文件和 `ACCOUNT_STORE_KEY`（环境文件包含后者），再把新归档解压到新的 release 目录。安装依赖并通过检查后，使用原子 symlink 切换：

```bash
set -euo pipefail
stamp=$(date -u +%Y%m%dT%H%M%SZ)
previous=$(readlink -f /opt/freebuff2api/current)
test -d "$previous"
test -d /opt/freebuff2api/releases/<COMMIT>
release_ok=false
rollback_on_exit() {
  status=$?
  trap - EXIT INT TERM HUP
  if [ "$release_ok" != true ]; then
    set +e
    rm -f /opt/freebuff2api/current.rollback-$stamp
    ln -s "$previous" /opt/freebuff2api/current.rollback-$stamp
    mv -Tf /opt/freebuff2api/current.rollback-$stamp /opt/freebuff2api/current
    systemctl restart freebuff2api.service
  fi
  exit "$status"
}
trap rollback_on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
systemctl stop freebuff2api.service
install -d -m 0700 /var/backups/freebuff2api
cp -a /var/lib/freebuff2api/freebuff.sqlite /var/backups/freebuff2api/freebuff.sqlite.$stamp
cp -a /etc/freebuff2api/freebuff2api.env /var/backups/freebuff2api/freebuff2api.env.$stamp
ln -s /opt/freebuff2api/releases/<COMMIT> /opt/freebuff2api/current.next-$stamp
mv -Tf /opt/freebuff2api/current.next-$stamp /opt/freebuff2api/current
systemctl restart freebuff2api.service
systemctl is-active --quiet freebuff2api.service
for attempt in $(seq 1 30); do curl -fsS http://127.0.0.1:8787/healthz >/dev/null && break; sleep 1; done
curl -fsS http://127.0.0.1:8787/healthz
release_ok=true
trap - EXIT INT TERM HUP
```

保留旧 release。若新版本启动失败、管理登录失败、出现持续 5xx 或授权状态异常，将 symlink 切回上一个已验收目录并重启：

```bash
set -euo pipefail
ln -s /opt/freebuff2api/releases/<PREVIOUS_COMMIT> /opt/freebuff2api/current.rollback
mv -Tf /opt/freebuff2api/current.rollback /opt/freebuff2api/current
systemctl restart freebuff2api.service
systemctl is-active --quiet freebuff2api.service
curl -fsS http://127.0.0.1:8787/healthz
```

不要删除数据库或执行会清空卷的命令。数据库迁移和回滚规则以 [`UPSTREAM_SYNC.md`](UPSTREAM_SYNC.md) 与 [`CHANGE_CONTROL.md`](CHANGE_CONTROL.md) 为准。

## 6. 验收清单

1. 本地健康检查返回 200，未授权的 `/v1/models` 返回 401。
2. HTTPS 管理页可以登录，旧 Cookie 在注销/改密后立即失效。
3. 点击“授权账号”后，授权链接只在等待状态显示；完成后账号出现在列表且默认停用。
4. 为账号配置合法 HTTP/HTTPS/SOCKS5 代理，执行“代理测试”，确认两个阶段均按该账号的代理路由，代理失败时不会回退直连。
5. 仅在需要验证真实可用性时，先停用账号再执行“模型测试”，在弹窗中选择模型并确认；记录封禁、额度、Token、会话冲突或超时结果，避免把代理可达误判为账号可用。
6. 不在日志、响应、审计或备份导出中出现 Token、完整代理 URL、API Key 或密码。
