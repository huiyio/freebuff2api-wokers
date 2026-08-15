import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const read = (name) => readFileSync(resolve(root, name), 'utf8');

test('project responsibility and security documents are present and linked', () => {
  const required = [
    'LEGAL_NOTICE.md',
    'RESPONSIBILITIES.md',
    'CHANGE_CONTROL.md',
    'SECURITY.md',
    'NOTICE.md',
    'NON_DOCKER.md',
    'LICENSE',
    '.github/pull_request_template.md',
  ];
  for (const file of required) assert.equal(existsSync(resolve(root, file)), true, file);

  const readme = read('README.md');
  for (const link of required.slice(0, 5)) assert.match(readme, new RegExp(`\\(${link.replace('.', '\\.') }\\)`));
  assert.match(readme, /使用前必读/);
  assert.match(readme, /独立开源软件/);
});

test('legal and responsibility documents define role boundaries and secret handling', () => {
  const legal = read('LEGAL_NOTICE.md');
  const responsibilities = read('RESPONSIBILITIES.md');
  const changeControl = read('CHANGE_CONTROL.md');
  const security = read('SECURITY.md');
  assert.match(legal, /不授予任何第三方服务/);
  assert.match(legal, /不使用本项目绕过封禁/);
  assert.match(responsibilities, /部署运营方/);
  assert.match(responsibilities, /上游服务方/);
  assert.match(changeControl, /回滚/);
  assert.match(security, /不要在公开 Issue/);
  assert.match(read('.github/pull_request_template.md'), /变更负责人|上线批准人/);
});

test('Docker documentation and GHCR publishing contract stay aligned', () => {
  const readme = read('README.md');
  const dockerGuide = read('DOCKER.md');
  const compose = read('docker-compose.yml');
  const workflow = read('.github/workflows/docker-publish.yml');

  assert.match(readme, /\(DOCKER\.md\)/);
  assert.match(dockerGuide, /ghcr\.io\/huiyio\/freebuff2api-wokers/);
  assert.match(dockerGuide, /docker compose pull freebuff2api/);
  assert.match(dockerGuide, /docker compose up -d --no-build/);
  assert.match(dockerGuide, /ACCOUNT_STORE_KEY/);
  assert.match(dockerGuide, /Package settings/);
  assert.match(dockerGuide, /授权账号/);
  assert.match(readme, /管理端 Web 授权/);
  assert.match(readme, /\(NON_DOCKER\.md\)/);

  const nonDockerGuide = read('NON_DOCKER.md');
  assert.match(nonDockerGuide, /set -euo pipefail/);
  assert.match(nonDockerGuide, /FREEBUFF_TOKEN=/);
  assert.match(nonDockerGuide, /ADMIN_COOKIE_SECURE=false/);
  assert.match(nonDockerGuide, /current\.next/);
  assert.match(nonDockerGuide, /rollback_on_error/);

  assert.match(compose, /ghcr\.io\/huiyio\/freebuff2api-wokers:1\.8\.9-admin\.2/);
  assert.match(workflow, /packages: write/);
  assert.match(workflow, /secrets\.GITHUB_TOKEN/);
  assert.match(workflow, /linux\/amd64,linux\/arm64/);
  assert.match(workflow, /sbom: true/);
  assert.doesNotMatch(workflow, /DOCKERHUB_/);
});
