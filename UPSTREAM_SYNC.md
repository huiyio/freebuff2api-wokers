# 跟随上游更新

当前功能内容以本分支同步的上游提交 `7f9686708e6a4e13ed6856dea80c4de8b15c8ac1` 为基线。除 Docker/Node Web 管理、加密账号库和每账号代理层外，本分支还对 `worker.js` 保留了账号代次隔离、API 鉴权、流取消、健康信息脱敏及相关协议适配改动；后续同步不能假设只有几行补丁，必须逐段检查 `worker.js` 的冲突和行为变化。

以下部署命令面向 Bash 和 Docker Compose V2。执行前确认生产 `.env` 及其 `ACCOUNT_STORE_KEY` 已单独安全保存；数据库备份没有匹配的主密钥就无法解密。

## 仓库关系

推荐把自己的 fork 设为 `origin`，原项目设为 `upstream`：

```bash
git remote rename origin upstream
git remote add origin https://github.com/<你的账号>/<你的仓库>.git
git fetch --all --prune
```

如果不使用 fork，当前仓库的 `origin` 就作为上游使用；如果使用 fork，则按上面的方式把原项目另存为 `upstream`，并把自己的 fork 保留为 `origin`。

## 1. 同步与测试

先提交当前代理分支的有效修改，并确认没有凭据、`.env` 或 SQLite 文件进入 Git。给同步前的提交打一个本地回退标签，再合并上游：

```bash
set -eu
git status --short
test -z "$(git status --porcelain)" || {
  echo "working tree must be clean before upstream merge" >&2
  exit 1
}
upstream_remote=origin   # 使用 fork 时改为 upstream
git fetch "${upstream_remote}" --prune
git switch codex/per-account-proxy
rollback_ref="pre-upstream-$(date +%Y%m%d-%H%M%S)"
git tag "${rollback_ref}" HEAD
git merge "${upstream_remote}/main"
npm ci
npm run check
npm test
npm audit --omit=dev
git diff --check
```

遇到冲突时优先保留上游 `worker.js` 的业务变化，再逐项重放本分支少量安全补丁。不要为了完成合并直接接受整份旧 `worker.js`。测试未全部通过时不要构建生产镜像。

## 2. 发布不可变 GHCR 镜像

标签应同时包含上游版本和管理层修订号。首选推送 `v*` Git tag，由 `.github/workflows/docker-publish.yml` 在 GitHub Linux runner 上完成测试和 amd64/arm64 构建：

```bash
set -eu
release_tag="v1.9.0-admin.1"
git rev-parse "refs/tags/${release_tag}" >/dev/null 2>&1 && {
  echo "Git tag already exists: ${release_tag}" >&2
  exit 1
}
git tag -a "${release_tag}" -m "Release ${release_tag}"
git push fork "refs/tags/${release_tag}"
```

工作流进入默认分支后，也可在 Actions 的 `Build and publish Docker image` 页面手动填写尚未使用的不可变标签。工作流拒绝 `latest` 和已经存在的主标签。Actions 成功后记录构建摘要中的 digest，并在部署机验证拉取：

```bash
set -eu
new_image="ghcr.io/huiyio/freebuff2api-wokers:1.9.0-admin.1"
docker pull "${new_image}"
docker image inspect "${new_image}" >/dev/null
```

需要本地审计时可以另建本地标签，但不能用它冒充同名 GHCR 发布物。完整发布、权限和 digest 固定方法见 `DOCKER.md`。

## 3. 停服备份并升级

从包含生产 `docker-compose.yml` 的目录执行。备份目录放在仓库外，避免误提交数据库：

```bash
set -eu
new_image="ghcr.io/huiyio/freebuff2api-wokers:1.9.0-admin.1"
rollback_ref="$(git describe --tags --match 'pre-upstream-*' --abbrev=0)"
test -n "${rollback_ref}"
old_image="$(docker inspect --format '{{.Config.Image}}' freebuff2api)"
test -n "${old_image}"
grep -q '^FREEBUFF_IMAGE=' .env

backup_dir="$(cd .. && pwd)/freebuff2api-backups"
snapshot="freebuff-$(date +%Y%m%d-%H%M%S)"
mkdir -p "${backup_dir}"
chmod 700 "${backup_dir}"

docker compose stop -t 30 freebuff2api
test "$(docker inspect --format '{{.State.Running}}' freebuff2api)" = "false"
test "$(docker inspect --format '{{.State.ExitCode}}' freebuff2api)" = "0"
docker cp "freebuff2api:/app/data/freebuff.sqlite" "${backup_dir}/${snapshot}.sqlite"
chmod 600 "${backup_dir}/${snapshot}.sqlite"
printf '%s\n' "${old_image}" > "${backup_dir}/${snapshot}.image"
printf '%s\n' "${rollback_ref}" > "${backup_dir}/${snapshot}.git-ref"

sed -i.bak "s|^FREEBUFF_IMAGE=.*$|FREEBUFF_IMAGE=${new_image}|" .env
rm -f .env.bak
chmod 600 .env
grep -Fqx "FREEBUFF_IMAGE=${new_image}" .env

docker compose config --quiet
docker compose up -d --no-build
docker compose ps
docker compose logs --tail 50 freebuff2api
curl -fsS http://127.0.0.1:8877/healthz
curl -fsS http://127.0.0.1:8878/admin/ >/dev/null
```

`docker compose stop` 会让进程关闭 SQLite 和 WAL；只有确认容器停止后才复制主数据库文件。Compose 的命名卷会在容器重建时保留，不要执行 `docker compose down -v`。

升级后还必须人工验证：

- 用原管理员密码登录，确认账号数量、启停状态、代理掩码和审计记录正常。
- 调用 `/v1/models`，再用测试账号发一条真实请求。
- 对至少一个账号执行代理测试，确认严格模式没有直连回退。
- 确认当前镜像为新标签：`docker inspect --format '{{.Config.Image}}' freebuff2api`。

验证完成前保留旧镜像、本地回退 Git 标签、SQLite 备份及匹配的 `ACCOUNT_STORE_KEY`。

## 4. 回滚镜像和数据库

只回滚镜像而保留升级后的数据库，可能遇到旧程序不认识的新 schema。稳妥做法是同时恢复升级前数据库和同步前源码配置。下面流程要求工作区没有新的未提交修改；先选择上一步生成的快照名称：

```bash
set -eu
backup_dir="$(cd .. && pwd)/freebuff2api-backups"
snapshot="freebuff-YYYYMMDD-HHMMSS"
test -f "${backup_dir}/${snapshot}.sqlite"
test -f "${backup_dir}/${snapshot}.image"
test -f "${backup_dir}/${snapshot}.git-ref"

old_image="$(cat "${backup_dir}/${snapshot}.image")"
rollback_ref="$(cat "${backup_dir}/${snapshot}.git-ref")"
test -n "${old_image}"
test -n "${rollback_ref}"
docker image inspect "${old_image}" >/dev/null
test -z "$(git status --porcelain)" || {
  echo "working tree must be clean before source rollback" >&2
  exit 1
}
git switch --detach "${rollback_ref}"

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
    source_file="/backup/$1.sqlite"
    test -f "$source_file"
    temporary_file="/data/freebuff.restore.$$"
    cp "$source_file" "$temporary_file"
    chown 1000:1000 "$temporary_file"
    chmod 600 "$temporary_file"
    rm -f /data/freebuff.sqlite /data/freebuff.sqlite-wal /data/freebuff.sqlite-shm
    mv "$temporary_file" /data/freebuff.sqlite
  ' sh "${snapshot}"

grep -q '^FREEBUFF_IMAGE=' .env
sed -i.bak "s|^FREEBUFF_IMAGE=.*$|FREEBUFF_IMAGE=${old_image}|" .env
rm -f .env.bak
chmod 600 .env
grep -Fqx "FREEBUFF_IMAGE=${old_image}" .env

docker compose config --quiet
docker compose up -d --no-build
docker compose logs --tail 50 freebuff2api
curl -fsS http://127.0.0.1:8877/healthz
```

启动前必须让 `.env` 使用该快照对应的 `ACCOUNT_STORE_KEY`。如果管理员密码曾在升级后修改，恢复数据库后应使用备份时有效的旧密码。出现 `ACCOUNT_STORE_KEY verification failed` 时立即停止，不要生成新密钥或删除数据库。

上面的 `git switch --detach` 会同时恢复旧版 `docker-compose.yml`、Dockerfile 和环境变量契约，避免旧镜像被新版 Compose 配置启动。确认回滚成功后再分析升级失败原因；修复时可切回 `codex/per-account-proxy` 分支，但不要先删除失败现场、旧镜像、回退标签或备份。

## 5. 运行时更新模式

`WORKER_UPDATE_MODE=latest` 只会替换 `worker.js`，不会更新 `server.js`、Web 管理端、数据库迁移、代理依赖或 Docker 配置，而且可能暂时丢失本分支的流取消与健康信息脱敏补丁。该模式强制要求 `WORKER_SHA256`，并应让 `WORKER_URL` 指向不可变 commit；它仍只适合临时验证，不适合无人值守的生产升级。默认 `bundled` 会运行镜像内经过测试的固定版本。

如果未来上游不再使用全局 `fetch`、改用 WebSocket、增加不带 Bearer Token 的 Freebuff 请求，代理包装层需要重新审计。现有测试会覆盖 HTTP、SOCKS5、账号隔离和失败关闭，但无法替代一次真实的授权账号验证。

本项目采用 AGPL-3.0。分发或提供修改版网络服务时，应保留许可证、版权信息，并按许可证要求提供对应源码。
