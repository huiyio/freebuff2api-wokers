'use strict';

const state = {
  csrfToken: '',
  username: '',
  accounts: [],
  audit: [],
  system: {},
  apiKey: {},
  currentView: 'accounts',
  editingId: null,
  deletingId: null,
  pollTimer: null,
  authorization: null,
  authorizationPollTimer: null,
  authorizationController: null,
  authorizationEpoch: 0,
  authorizationClosing: false,
  sessionEpoch: 0,
  logoutPending: false,
  resourceRequests: {
    accounts: { sequence: 0, controller: null },
    audit: { sequence: 0, controller: null },
    system: { sequence: 0, controller: null },
    apiKey: { sequence: 0, controller: null },
  },
};

const AUTHORIZATION_STATUSES = new Set([
  'starting',
  'pending',
  'completing',
  'completed',
  'cancelled',
  'expired',
  'duplicate',
  'failed',
]);

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

function toast(message, type = 'success') {
  const node = document.createElement('div');
  node.className = `toast ${type === 'error' ? 'error' : ''}`;
  node.textContent = message;
  $('#toast-region').append(node);
  setTimeout(() => node.remove(), 4200);
}

async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (state.csrfToken && !['GET', 'HEAD'].includes(options.method || 'GET')) {
    headers.set('x-csrf-token', state.csrfToken);
  }
  const response = await fetch(`/admin/api${path}`, { ...options, headers });
  let payload = {};
  try { payload = await response.json(); } catch {}
  if (!response.ok) {
    const error = new Error(payload?.error?.message || `请求失败 (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

function closeDialog(id) {
  const dialog = $('#' + id);
  if (dialog?.open) dialog.close();
}

function clearAdminPresentation() {
  invalidateResourceRequests();
  state.accounts = [];
  state.audit = [];
  state.system = {};
  state.apiKey = {};
  state.editingId = null;
  state.deletingId = null;
  state.currentView = 'accounts';
  $('#accounts-table-body').replaceChildren();
  $('#audit-table-body').replaceChildren();
  $('#accounts-empty').classList.add('hidden');
  $('#accounts-updated').textContent = '';
  $('#account-search').value = '';
  $('#account-filter').value = 'all';
  $('#sidebar-version').textContent = '管理控制台';
  ['system-version', 'worker-version', 'system-strict', 'system-accounts', 'system-routes'].forEach((id) => {
    $('#' + id).textContent = '-';
  });
  ['metric-total', 'metric-enabled', 'metric-proxy-ok', 'metric-errors'].forEach((id) => {
    $('#' + id).textContent = '0';
  });
  $('#api-key-output').value = '';
  $('#api-key-reveal').classList.add('hidden');
  ['account-dialog', 'delete-dialog', 'password-dialog', 'api-key-confirm-dialog'].forEach(closeDialog);
}

function invalidateResourceRequests() {
  for (const requestState of Object.values(state.resourceRequests)) {
    requestState.sequence += 1;
    requestState.controller?.abort();
    requestState.controller = null;
  }
}

function beginResourceRequest(name) {
  const requestState = state.resourceRequests[name];
  requestState.sequence += 1;
  requestState.controller?.abort();
  const controller = new AbortController();
  requestState.controller = controller;
  return {
    name,
    sequence: requestState.sequence,
    sessionEpoch: state.sessionEpoch,
    controller,
  };
}

function isCurrentResourceRequest(request) {
  const requestState = state.resourceRequests[request.name];
  return request.sessionEpoch === state.sessionEpoch
    && request.sequence === requestState.sequence
    && request.controller === requestState.controller;
}

function finishResourceRequest(request) {
  const requestState = state.resourceRequests[request.name];
  if (requestState.controller === request.controller) requestState.controller = null;
}

function clearAuthorizationPolling() {
  clearTimeout(state.authorizationPollTimer);
  state.authorizationPollTimer = null;
}

function advanceAuthorizationFlow({ clear = true } = {}) {
  state.authorizationEpoch += 1;
  clearAuthorizationPolling();
  state.authorizationController?.abort();
  state.authorizationController = null;
  state.authorizationClosing = false;
  if (clear) state.authorization = null;
  return state.authorizationEpoch;
}

function isAuthorizationActive(authorization) {
  return ['starting', 'pending', 'completing'].includes(authorization?.status);
}

function isCurrentAuthorizationFlow(epoch, id = null) {
  return state.authorizationEpoch === epoch
    && !state.authorizationClosing
    && (!id || state.authorization?.id === id);
}

function isCsrfFailure(error) {
  return error.status === 403 && error.payload?.error?.type === 'ADMIN_CSRF_INVALID';
}

function showLogin() {
  state.sessionEpoch += 1;
  clearInterval(state.pollTimer);
  advanceAuthorizationFlow();
  closeDialog('account-authorization-dialog');
  clearAdminPresentation();
  state.csrfToken = '';
  state.username = '';
  $('#app-shell').classList.add('hidden');
  $('#login-view').classList.remove('hidden');
  $('#login-form button[type="submit"]').disabled = state.logoutPending;
  if (state.logoutPending) $('#login-error').textContent = '正在安全退出当前会话';
  $('#login-username').focus();
}

async function showApp(session) {
  const sessionEpoch = ++state.sessionEpoch;
  advanceAuthorizationFlow();
  clearAdminPresentation();
  state.csrfToken = session.csrfToken;
  state.username = session.username || '';
  await Promise.all([loadAccounts(), loadSystem(), loadApiKey()]);
  if (sessionEpoch !== state.sessionEpoch) return;
  $('#login-view').classList.add('hidden');
  $('#app-shell').classList.remove('hidden');
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (state.currentView === 'accounts' && !document.hidden) void loadAccounts({ quiet: true });
  }, 15000);
}

async function initialize() {
  try {
    const session = await api('/session');
    await showApp(session);
  } catch {
    showLogin();
  }
}

function statusBadge(account) {
  if (!account.enabled) return '<span class="status-badge status-neutral">已停用</span>';
  if (account.upstreamState === 'banned') return '<span class="status-badge status-error">已封禁</span>';
  if (account.lastProxyStatus === 'error') return '<span class="status-badge status-error">代理异常</span>';
  if (account.lastProxyStatus === 'ok') return '<span class="status-badge status-ok">运行中</span>';
  return '<span class="status-badge status-warning">待验证</span>';
}

function upstreamBadge(account) {
  const stateValue = account.upstreamState || 'unknown';
  if (!account.enabled) return '<span class="status-badge status-neutral">未加载</span>';
  if (stateValue === 'banned') return '<span class="status-badge status-error">banned</span>';
  if (account.upstreamAlive === true) return '<span class="status-badge status-ok">正常</span>';
  if (account.upstreamAlive === false) return `<span class="status-badge status-error">${escapeHtml(stateValue)}</span>`;
  return '<span class="status-badge status-neutral">未知</span>';
}

function filteredAccounts() {
  const query = $('#account-search').value.trim().toLowerCase();
  const filter = $('#account-filter').value;
  return state.accounts.filter((account) => {
    const matchesText = !query || `${account.name} ${account.email}`.toLowerCase().includes(query);
    const hasError = account.lastProxyStatus === 'error' || account.upstreamState === 'banned' || account.upstreamAlive === false;
    const matchesFilter = filter === 'all'
      || (filter === 'enabled' && account.enabled)
      || (filter === 'disabled' && !account.enabled)
      || (filter === 'error' && hasError);
    return matchesText && matchesFilter;
  });
}

function renderMetrics() {
  const errors = state.accounts.filter((account) => (
    account.lastProxyStatus === 'error'
    || account.upstreamState === 'banned'
    || account.upstreamAlive === false
  )).length;
  $('#metric-total').textContent = state.accounts.length;
  $('#metric-enabled').textContent = state.accounts.filter((account) => account.enabled).length;
  $('#metric-proxy-ok').textContent = state.accounts.filter((account) => account.lastProxyStatus === 'ok').length;
  $('#metric-errors').textContent = errors;
}

function renderAccounts() {
  const accounts = filteredAccounts();
  $('#accounts-empty').classList.toggle('hidden', accounts.length > 0);
  $('#accounts-table-body').innerHTML = accounts.map((account) => `
    <tr data-account-id="${escapeHtml(account.id)}">
      <td data-label="状态">${statusBadge(account)}</td>
      <td data-label="账号">
        <span class="account-name">${escapeHtml(account.name)}</span>
        <span class="account-email">${escapeHtml(account.email || '-')}</span>
      </td>
      <td data-label="代理">
        <span class="proxy-value" title="${escapeHtml(account.proxyUrlMasked || '未配置')}">${escapeHtml(account.proxyUrlMasked || '未配置')}</span>
        <span class="account-email">${escapeHtml(account.proxyProtocol || '-')}</span>
      </td>
      <td data-label="上游">${upstreamBadge(account)}</td>
      <td data-label="最近代理测试">
        <span>${escapeHtml(account.lastProxyStatus === 'ok' ? `${account.lastProxyHttpStatus || '-'} · ${account.lastProxyMessage || ''}` : account.lastProxyMessage || '-')}</span>
        <span class="account-email">${formatTime(account.lastProxyTestAt)}</span>
      </td>
      <td data-label="操作">
        <div class="action-group">
          <button class="table-action" type="button" data-action="test">测试</button>
          <button class="table-action" type="button" data-action="toggle">${account.enabled ? '停用' : '启用'}</button>
          <button class="table-action" type="button" data-action="edit">编辑</button>
          <button class="table-action destructive" type="button" data-action="delete">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
  renderMetrics();
}

async function loadAccounts({ quiet = false } = {}) {
  const request = beginResourceRequest('accounts');
  try {
    const payload = await api('/accounts', { signal: request.controller.signal });
    if (!isCurrentResourceRequest(request)) return;
    state.accounts = payload.accounts || [];
    renderAccounts();
    $('#accounts-updated').textContent = `更新于 ${new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date())}`;
  } catch (error) {
    if (!isCurrentResourceRequest(request) || error.name === 'AbortError') return;
    if (error.status === 401) return showLogin();
    if (!quiet) toast(error.message, 'error');
  } finally {
    finishResourceRequest(request);
  }
}

async function loadAudit() {
  const request = beginResourceRequest('audit');
  try {
    const payload = await api('/audit?limit=100', { signal: request.controller.signal });
    if (!isCurrentResourceRequest(request)) return;
    state.audit = payload.entries || [];
    $('#audit-table-body').innerHTML = state.audit.map((entry) => `
      <tr>
        <td data-label="时间">${formatTime(entry.createdAt)}</td>
        <td data-label="操作">${escapeHtml(entry.action)}</td>
        <td data-label="账号">${escapeHtml(entry.accountId || '-')}</td>
        <td data-label="结果">${escapeHtml(entry.summary)}</td>
      </tr>
    `).join('');
  } catch (error) {
    if (!isCurrentResourceRequest(request) || error.name === 'AbortError') return;
    if (error.status === 401) return showLogin();
    toast(error.message, 'error');
  } finally {
    finishResourceRequest(request);
  }
}

async function loadSystem() {
  const request = beginResourceRequest('system');
  try {
    const payload = await api('/system', { signal: request.controller.signal });
    if (!isCurrentResourceRequest(request)) return;
    state.system = payload.system || {};
    $('#system-version').textContent = state.system.appVersion || '-';
    $('#worker-version').textContent = state.system.workerVersion || '-';
    $('#system-strict').textContent = state.system.requireProxy ? '开启' : '关闭';
    $('#system-accounts').textContent = String(state.system.accountCount ?? '-');
    const kinds = state.system.proxyKinds || {};
    $('#system-routes').textContent = `HTTP ${kinds.http || 0} · HTTPS ${kinds.https || 0} · SOCKS5 ${kinds.socks5 || 0}`;
    $('#sidebar-version').textContent = state.system.appVersion || '管理控制台';
  } catch (error) {
    if (!isCurrentResourceRequest(request) || error.name === 'AbortError') return;
    if (error.status === 401) return showLogin();
    toast(error.message, 'error');
  } finally {
    finishResourceRequest(request);
  }
}

function renderApiKeyInfo(info = {}) {
  state.apiKey = info;
  $('#api-key-state').textContent = info.configured ? '已配置' : '未配置';
  $('#api-key-masked').textContent = info.masked || '-';
  $('#api-key-updated').textContent = formatTime(info.updatedAt);
}

async function loadApiKey() {
  const request = beginResourceRequest('apiKey');
  try {
    const payload = await api('/api-key', { signal: request.controller.signal });
    if (!isCurrentResourceRequest(request)) return;
    renderApiKeyInfo(payload.apiKey || {});
  } catch (error) {
    if (!isCurrentResourceRequest(request) || error.name === 'AbortError') return;
    if (error.status === 401) return showLogin();
    toast(error.message, 'error');
  } finally {
    finishResourceRequest(request);
  }
}

function suggestedOpenAiBaseUrl() {
  const url = new URL(window.location.href);
  const publicPortByAdminPort = { '8878': '8877', '8788': '8787' };
  if (publicPortByAdminPort[url.port]) url.port = publicPortByAdminPort[url.port];
  return `${url.origin}/v1`;
}

function normalizedOpenAiBaseUrl() {
  const value = $('#integration-base-url').value.trim() || suggestedOpenAiBaseUrl();
  return value.replace(/\/+$/, '');
}

function anthropicBaseUrl(openAiBaseUrl) {
  try {
    const url = new URL(openAiBaseUrl);
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/v1') ? pathname.slice(0, -3) || '/' : pathname || '/';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return openAiBaseUrl.replace(/\/v1$/, '');
  }
}

function renderIntegrationExamples() {
  const openAiBaseUrl = normalizedOpenAiBaseUrl();
  const anthropicOrigin = anthropicBaseUrl(openAiBaseUrl);
  const model = 'mimo/mimo-v2.5';
  $('#integration-anthropic-base-url').textContent = anthropicOrigin;
  $('#integration-code-openai').textContent = `from openai import OpenAI

client = OpenAI(
    api_key="YOUR_API_KEY",
    base_url="${openAiBaseUrl}",
)

response = client.chat.completions.create(
    model="${model}",
    messages=[{"role": "user", "content": "你好"}],
)
print(response.choices[0].message.content)`;
  $('#integration-code-curl').textContent = `# 先查看当前模型目录
curl "${openAiBaseUrl}/models" \\
  -H "Authorization: Bearer YOUR_API_KEY"

# 发起一次非流式对话
curl "${openAiBaseUrl}/chat/completions" \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"model":"${model}","messages":[{"role":"user","content":"你好"}]}'`;
  $('#integration-code-anthropic').textContent = `from anthropic import Anthropic

client = Anthropic(
    api_key="YOUR_API_KEY",
    base_url="${anthropicOrigin}",
)

message = client.messages.create(
    model="${model}",
    max_tokens=256,
    messages=[{"role": "user", "content": "你好"}],
)
print(message.content[0].text)`;
}

function activateDocTab(name, { focus = false } = {}) {
  $$('[data-doc-tab]').forEach((button) => {
    const active = button.dataset.docTab === name;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
    if (active && focus) button.focus();
  });
  $$('[data-doc-panel]').forEach((panel) => {
    panel.classList.toggle('hidden', panel.dataset.docPanel !== name);
  });
}

async function copyNodeText(node, successMessage) {
  const value = 'value' in node ? node.value : node.textContent;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    if (typeof node.select === 'function') {
      node.select();
    } else {
      const range = document.createRange();
      range.selectNodeContents(node);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    }
    toast('复制失败，请手动复制', 'error');
  }
}

function initializeIntegrationDocs() {
  $('#integration-base-url').value = suggestedOpenAiBaseUrl();
  renderIntegrationExamples();
  $('#integration-base-url').addEventListener('input', renderIntegrationExamples);
  $('#integration-base-url').addEventListener('change', () => {
    $('#integration-base-url').value = normalizedOpenAiBaseUrl();
    renderIntegrationExamples();
  });
  $('#integration-docs').addEventListener('click', (event) => {
    const tab = event.target.closest('[data-doc-tab]');
    if (tab) {
      activateDocTab(tab.dataset.docTab);
      return;
    }
    const copyButton = event.target.closest('[data-copy-target]');
    if (!copyButton) return;
    const target = document.getElementById(copyButton.dataset.copyTarget);
    if (target) void copyNodeText(target, copyButton.dataset.copyTarget.includes('code-') ? '代码已复制' : '地址已复制');
  });
  $('#copy-integration-base-url').addEventListener('click', () => {
    const input = $('#integration-base-url');
    if (!input.value.trim()) {
      input.value = suggestedOpenAiBaseUrl();
      renderIntegrationExamples();
    }
    void copyNodeText(input, 'Base URL 已复制');
  });
  $('#integration-docs').addEventListener('keydown', (event) => {
    const current = event.target.closest('[data-doc-tab]');
    if (!current || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const tabs = $$('[data-doc-tab]');
    const index = tabs.indexOf(current);
    const nextIndex = event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    activateDocTab(tabs[nextIndex].dataset.docTab, { focus: true });
  });
}

function revealApiKey(value) {
  $('#api-key-output').value = value || '';
  $('#api-key-reveal').classList.toggle('hidden', !value);
  if (value) $('#api-key-output').focus();
}

async function saveApiKey(event) {
  event.preventDefault();
  const value = $('#api-key-input').value.trim();
  const button = $('#save-api-key');
  if (!value) {
    $('#api-key-form-error').textContent = '请输入 API Key';
    return;
  }
  button.disabled = true;
  $('#api-key-form-error').textContent = '';
  try {
    const payload = await api('/api-key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey: value }),
    });
    const result = payload.apiKey || {};
    renderApiKeyInfo(result.info || {});
    revealApiKey(result.apiKey);
    $('#api-key-input').value = '';
    toast('API Key 已更新');
  } catch (error) {
    if (error.status === 401) return showLogin();
    $('#api-key-form-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function confirmApiKeyRotation() {
  const dialog = $('#api-key-confirm-dialog');
  if (!dialog?.showModal) {
    return Promise.resolve(window.confirm('生成新 API Key 后，旧 Key 会立即失效。继续吗？'));
  }
  if (dialog.open) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'confirm');
    };
    dialog.addEventListener('close', onClose, { once: true });
    dialog.showModal();
  });
}

async function generateApiKey() {
  if (!await confirmApiKeyRotation()) return;
  const button = $('#generate-api-key');
  button.disabled = true;
  $('#api-key-form-error').textContent = '';
  try {
    const payload = await api('/api-key', {
      method: 'PUT',
      body: JSON.stringify({ generate: true }),
    });
    const result = payload.apiKey || {};
    renderApiKeyInfo(result.info || {});
    revealApiKey(result.apiKey);
    $('#api-key-input').value = '';
    toast('已生成新的 API Key');
  } catch (error) {
    if (error.status === 401) return showLogin();
    $('#api-key-form-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function switchView(view) {
  state.currentView = view;
  $$('.view-section').forEach((section) => section.classList.add('hidden'));
  $(`#${view}-view`).classList.remove('hidden');
  $$('.nav-button').forEach((button) => button.classList.toggle('active', button.dataset.view === view));
  if (view === 'audit') void loadAudit();
  if (view === 'system') void loadSystem();
  if (view === 'api-key') void loadApiKey();
}

function openAccountDialog(account = null) {
  state.editingId = account?.id || null;
  $('#account-dialog-title').textContent = account ? '编辑账号' : '导入已有 Token';
  $('#account-id').value = account?.id || '';
  $('#account-name').value = account?.name || '';
  $('#account-email').value = account?.email || '';
  $('#account-token').value = '';
  $('#account-token').required = !account;
  $('#account-proxy').value = '';
  $('#account-enabled').checked = account?.enabled ?? true;
  $('#account-proxy-required').checked = account?.proxyRequired ?? true;
  $('#account-remove-proxy').checked = false;
  $('#remove-proxy-row').classList.toggle('hidden', !account?.hasProxy);
  $('#account-form-error').textContent = '';
  $('#account-dialog').showModal();
  $('#account-name').focus();
}

function authorizationMessage(authorization) {
  if (!authorization) return '';
  if (authorization.status === 'starting') {
    return '正在生成一次性授权链接';
  }
  if (authorization.status === 'pending') {
    return authorization.retrying
      ? '授权服务暂时不可用，正在自动重试'
      : '等待你在授权页完成登录';
  }
  if (authorization.status === 'completing') {
    return '授权已完成，正在安全保存账号';
  }
  if (authorization.status === 'completed') {
    return '授权完成，账号已自动保存并保持停用。';
  }
  return authorization.message || '授权未完成，请重新开始。';
}

function normalizeAuthorization(value) {
  if (
    !value
    || typeof value !== 'object'
    || typeof value.id !== 'string'
    || !value.id
    || !AUTHORIZATION_STATUSES.has(value.status)
  ) {
    throw new Error('授权状态无效');
  }
  const authorization = {
    id: value.id,
    status: value.status,
    createdAt: typeof value.createdAt === 'string' ? value.createdAt : null,
  };
  if (typeof value.message === 'string') authorization.message = value.message;
  if (value.status === 'pending') {
    if (value.retrying === true) authorization.retrying = true;
    if (typeof value.loginUrl === 'string' && value.loginUrl) authorization.loginUrl = value.loginUrl;
  }
  if (value.status === 'completed' && value.account && typeof value.account === 'object') {
    authorization.account = value.account;
  }
  return authorization;
}

function renderAuthorizationDialog() {
  const authorization = state.authorization;
  const started = Boolean(authorization);
  const active = isAuthorizationActive(authorization);
  const pending = authorization?.status === 'pending';
  $('#authorization-start-state').classList.toggle('hidden', started);
  $('#authorization-progress-state').classList.toggle('hidden', !started);
  $('#authorization-error').textContent = '';
  if (!started) {
    $('#authorization-start-button').disabled = state.authorizationClosing
      || Boolean(state.authorizationController);
    $('#authorization-status').textContent = '';
    $('#authorization-link').removeAttribute('href');
    $('#authorization-link').classList.add('hidden');
    $('#authorization-cancel-button').textContent = '关闭';
    $('#authorization-cancel-button').disabled = state.authorizationClosing;
    return;
  }
  const link = $('#authorization-link');
  if (pending && authorization.loginUrl) {
    link.href = authorization.loginUrl;
    link.classList.remove('hidden');
  } else {
    link.removeAttribute('href');
    link.classList.add('hidden');
  }
  $('#authorization-status').textContent = authorizationMessage(authorization);
  $('#authorization-cancel-button').textContent = active ? '取消授权' : '关闭';
  $('#authorization-cancel-button').disabled = state.authorizationClosing;
}

function openAuthorizationDialog() {
  const shouldStart = !state.authorization && !state.authorizationController;
  if (shouldStart) advanceAuthorizationFlow();
  renderAuthorizationDialog();
  const dialog = $('#account-authorization-dialog');
  if (!dialog.open) dialog.showModal();
  $('#authorization-start-button').focus();
  if (shouldStart) void startAuthorization();
}

function hideAuthorizationDialog() {
  if (state.authorizationClosing) return;
  const continuesInBackground = isAuthorizationActive(state.authorization)
    || Boolean(state.authorizationController);
  closeDialog('account-authorization-dialog');
  if (continuesInBackground) toast('授权任务将在服务端继续');
}

function scheduleAuthorizationPoll(epoch = state.authorizationEpoch) {
  clearAuthorizationPolling();
  if (!isCurrentAuthorizationFlow(epoch) || !isAuthorizationActive(state.authorization)) return;
  const delay = state.authorization.status === 'starting' ? 750 : 5000;
  state.authorizationPollTimer = setTimeout(() => {
    void pollAuthorization(epoch);
  }, delay);
}

async function startAuthorization() {
  const epoch = state.authorizationEpoch;
  const sessionEpoch = state.sessionEpoch;
  if (!isCurrentAuthorizationFlow(epoch) || state.authorization) return;
  const button = $('#authorization-start-button');
  button.disabled = true;
  $('#authorization-error').textContent = '';
  const controller = new AbortController();
  state.authorizationController = controller;
  try {
    const payload = await api('/account-authorizations', {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    const authorization = normalizeAuthorization(payload.authorization);
    if (!isCurrentAuthorizationFlow(epoch)) {
      const dialog = $('#account-authorization-dialog');
      if (
        sessionEpoch === state.sessionEpoch
        && !dialog.open
        && isAuthorizationActive(authorization)
      ) {
        void api('/account-authorizations/' + encodeURIComponent(authorization.id), {
          method: 'DELETE',
          body: '{}',
        }).catch(() => {});
      }
      return;
    }
    state.authorization = authorization;
    renderAuthorizationDialog();
    scheduleAuthorizationPoll(epoch);
  } catch (error) {
    if (!isCurrentAuthorizationFlow(epoch) || error.name === 'AbortError') return;
    if (error.status === 401 || isCsrfFailure(error)) return showLogin();
    $('#authorization-error').textContent = error.message;
  } finally {
    if (state.authorizationController === controller) state.authorizationController = null;
    if (isCurrentAuthorizationFlow(epoch) && !state.authorization) button.disabled = false;
  }
}

async function pollAuthorization(epoch = state.authorizationEpoch) {
  const current = state.authorization;
  if (!current?.id || !isAuthorizationActive(current) || !isCurrentAuthorizationFlow(epoch, current.id)) return;
  const authorizationId = current.id;
  const controller = new AbortController();
  state.authorizationController = controller;
  try {
    const payload = await api('/account-authorizations/' + encodeURIComponent(authorizationId), {
      method: 'POST',
      body: '{}',
      signal: controller.signal,
    });
    if (!isCurrentAuthorizationFlow(epoch, authorizationId)) return;
    state.authorization = normalizeAuthorization(payload.authorization);
    if (!isAuthorizationActive(state.authorization)) {
      clearAuthorizationPolling();
      if (state.authorization.status === 'completed') {
        toast('账号授权完成并已自动保存');
      } else if (state.authorization.status === 'duplicate') {
        toast('该 Freebuff 账号已经存在', 'error');
      } else if (state.authorization.status === 'failed') {
        toast('账号授权完成，但保存失败，请重试', 'error');
      }
      await Promise.all([loadAccounts(), loadSystem()]);
      if (!isCurrentAuthorizationFlow(epoch, authorizationId)) return;
    }
    renderAuthorizationDialog();
    scheduleAuthorizationPoll(epoch);
  } catch (error) {
    if (!isCurrentAuthorizationFlow(epoch, authorizationId) || error.name === 'AbortError') return;
    if (error.status === 401 || isCsrfFailure(error)) return showLogin();
    if (error.status === 404) {
      clearAuthorizationPolling();
      state.authorization = {
        id: authorizationId,
        status: 'expired',
        createdAt: current.createdAt,
        message: '授权状态已失效，请重新开始。',
      };
      renderAuthorizationDialog();
      return;
    }
    $('#authorization-error').textContent = error.message || '无法更新授权状态';
    scheduleAuthorizationPoll(epoch);
  } finally {
    if (state.authorizationController === controller) state.authorizationController = null;
  }
}

async function cancelAuthorizationDialog() {
  if (state.authorizationClosing) return;
  const authorization = state.authorization;
  const epoch = advanceAuthorizationFlow({ clear: false });
  state.authorizationClosing = true;
  $('#authorization-cancel-button').disabled = true;
  if (authorization?.id && isAuthorizationActive(authorization)) {
    const controller = new AbortController();
    state.authorizationController = controller;
    try {
      const payload = await api('/account-authorizations/' + encodeURIComponent(authorization.id), {
        method: 'DELETE',
        body: '{}',
        signal: controller.signal,
      });
      if (state.authorizationEpoch !== epoch) return;
      const result = normalizeAuthorization(payload.authorization);
      state.authorization = result;
      if (!['cancelled', 'expired'].includes(result.status)) {
        state.authorizationClosing = false;
        renderAuthorizationDialog();
        if (result.status === 'completed') {
          toast('授权已在取消前完成，账号已保存');
        } else {
          $('#authorization-error').textContent = result.status === 'failed'
            ? '取消期间账号保存失败，请检查账号列表后重试。'
            : '授权已进入最终处理状态，请确认结果。';
        }
        if (!isAuthorizationActive(result)) await Promise.all([loadAccounts(), loadSystem()]);
        if (state.authorizationEpoch !== epoch) return;
        if (isAuthorizationActive(result)) scheduleAuthorizationPoll(epoch);
        return;
      }
    } catch (error) {
      if (state.authorizationEpoch !== epoch) return;
      if (error.status === 401 || isCsrfFailure(error)) {
        showLogin();
        return;
      }
      if (error.status !== 404) {
        state.authorization = authorization;
        state.authorizationClosing = false;
        renderAuthorizationDialog();
        $('#authorization-error').textContent = error.message || '无法取消授权，请重试';
        scheduleAuthorizationPoll(epoch);
        return;
      }
    } finally {
      if (state.authorizationController === controller) state.authorizationController = null;
    }
  }
  if (state.authorizationEpoch !== epoch) return;
  state.authorization = null;
  state.authorizationClosing = false;
  closeDialog('account-authorization-dialog');
}

async function saveAccount(event) {
  event.preventDefault();
  const id = state.editingId;
  const body = {
    name: $('#account-name').value,
    email: $('#account-email').value,
    proxyRequired: $('#account-proxy-required').checked,
    enabled: $('#account-enabled').checked,
  };
  if ($('#account-token').value) body.authToken = $('#account-token').value;
  if ($('#account-proxy').value) body.proxyUrl = $('#account-proxy').value;
  if ($('#account-remove-proxy').checked) body.removeProxy = true;
  const button = $('#save-account-button');
  button.disabled = true;
  $('#account-form-error').textContent = '';
  try {
    await api(id ? `/accounts/${encodeURIComponent(id)}` : '/accounts', {
      method: id ? 'PUT' : 'POST',
      body: JSON.stringify(body),
    });
    $('#account-dialog').close();
    toast(id ? '账号已更新' : '账号 Token 已导入');
    await Promise.all([loadAccounts(), loadSystem()]);
  } catch (error) {
    $('#account-form-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

async function accountAction(event) {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const row = button.closest('[data-account-id]');
  const account = state.accounts.find((item) => item.id === row?.dataset.accountId);
  if (!account) return;
  const action = button.dataset.action;
  if (action === 'edit') return openAccountDialog(account);
  if (action === 'delete') {
    state.deletingId = account.id;
    $('#delete-account-name').textContent = `确认删除“${account.name}”？`;
    $('#delete-dialog').showModal();
    return;
  }

  button.disabled = true;
  try {
    if (action === 'toggle') {
      await api(`/accounts/${encodeURIComponent(account.id)}`, {
        method: 'PUT',
        body: JSON.stringify({ enabled: !account.enabled }),
      });
      toast(account.enabled ? '账号已停用' : '账号已启用');
    } else if (action === 'test') {
      const payload = await api(`/accounts/${encodeURIComponent(account.id)}/test-proxy`, {
        method: 'POST',
        body: '{}',
      });
      if (payload.result.ok) toast(`代理可用，HTTP ${payload.result.httpStatus}`);
      else toast(payload.result.message || '代理测试失败', 'error');
    }
    await loadAccounts();
  } catch (error) {
    toast(error.message, 'error');
    await loadAccounts({ quiet: true });
  } finally {
    button.disabled = false;
  }
}

async function deleteAccount(event) {
  event.preventDefault();
  if (!state.deletingId) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    await api(`/accounts/${encodeURIComponent(state.deletingId)}`, { method: 'DELETE' });
    $('#delete-dialog').close();
    toast('账号已删除');
    state.deletingId = null;
    await Promise.all([loadAccounts(), loadSystem()]);
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    button.disabled = false;
  }
}

async function changePassword(event) {
  event.preventDefault();
  const currentPassword = $('#current-password').value;
  const nextPassword = $('#next-password').value;
  if (nextPassword !== $('#confirm-password').value) {
    $('#password-form-error').textContent = '两次输入的新密码不一致';
    return;
  }
  $('#password-form-error').textContent = '';
  try {
    await api('/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, nextPassword }),
    });
    $('#password-dialog').close();
    state.csrfToken = '';
    showLogin();
    toast('密码已更新，请重新登录');
  } catch (error) {
    $('#password-form-error').textContent = error.message;
  }
}

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (state.logoutPending) return;
  $('#login-error').textContent = '';
  const button = event.submitter;
  button.disabled = true;
  try {
    const session = await api('/login', {
      method: 'POST',
      body: JSON.stringify({
        username: $('#login-username').value,
        password: $('#login-password').value,
      }),
    });
    $('#login-username').value = '';
    $('#login-password').value = '';
    await showApp(session);
  } catch (error) {
    $('#login-error').textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

$('#logout-button').addEventListener('click', async () => {
  if (state.logoutPending) return;
  state.logoutPending = true;
  const logoutRequest = api('/logout', { method: 'POST', body: '{}' }).catch(() => {});
  state.csrfToken = '';
  showLogin();
  await logoutRequest;
  state.logoutPending = false;
  $('#login-error').textContent = '';
  $('#login-form button[type="submit"]').disabled = false;
});

$$('.nav-button').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
$$('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => $(`#${button.dataset.closeDialog}`).close()));
$('#add-account-button').addEventListener('click', () => openAccountDialog());
$('#authorize-account-button').addEventListener('click', openAuthorizationDialog);
$('#authorization-start-button').addEventListener('click', startAuthorization);
$('#authorization-cancel-button').addEventListener('click', () => { void cancelAuthorizationDialog(); });
$('#authorization-close-button').addEventListener('click', hideAuthorizationDialog);
$('#account-authorization-dialog').addEventListener('cancel', (event) => {
  event.preventDefault();
  hideAuthorizationDialog();
});
$('#account-form').addEventListener('submit', saveAccount);
$('#delete-form').addEventListener('submit', deleteAccount);
$('#password-form').addEventListener('submit', changePassword);
$('#api-key-form').addEventListener('submit', saveApiKey);
$('#accounts-table-body').addEventListener('click', accountAction);
$('#account-search').addEventListener('input', renderAccounts);
$('#account-filter').addEventListener('change', renderAccounts);
$('#refresh-accounts').addEventListener('click', () => loadAccounts());
$('#refresh-audit').addEventListener('click', loadAudit);
$('#change-password-button').addEventListener('click', () => {
  $('#password-form').reset();
  $('#password-form-error').textContent = '';
  $('#password-dialog').showModal();
  $('#current-password').focus();
});
$('#generate-api-key').addEventListener('click', generateApiKey);
$('#copy-api-key').addEventListener('click', async () => {
  const value = $('#api-key-output').value;
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    toast('API Key 已复制');
  } catch {
    $('#api-key-output').select();
    toast('复制失败，请手动复制', 'error');
  }
});

initializeIntegrationDocs();
void initialize();
