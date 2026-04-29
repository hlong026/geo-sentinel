#!/usr/bin/env node
// CDP Proxy - 通过 HTTP API 操控用户日常 Chrome
// 要求：Chrome 已开启 --remote-debugging-port
// Node.js 22+（使用原生 WebSocket）

import http from 'node:http';
import { URL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';

const PORT = parseInt(process.env.CDP_PROXY_PORT || '3456');
// 安全存储目录：~/.config/geo-sentinel/，权限 0700
const CONFIG_DIR = process.env.CDP_PROXY_CONFIG_DIR || path.join(os.homedir(), '.config', 'geo-sentinel');
const MANAGED_TABS_FILE = path.join(CONFIG_DIR, 'managed-tabs.json');
const AUTH_TOKEN_FILE = path.join(CONFIG_DIR, 'auth-token.json');
const MAX_BODY_SIZE = 1024 * 1024; // 1MB 请求体上限
const MAX_RECORDING_FRAMES = 3000; // 录屏最大帧数（约 5 分钟 @10fps）

// 确保配置目录存在且权限安全
try {
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  // 如果目录已存在（mkdir 不修改权限），显式设置
  fs.chmodSync(CONFIG_DIR, 0o700);
} catch { /* 忽略 */ }
let ws = null;
let cmdId = 0;
const pending = new Map(); // id -> {resolve, timer}
const sessions = new Map(); // targetId -> sessionId
const recordings = new Map(); // targetId -> {frames, active}
const intercepts = new Map(); // targetId -> {patterns, handler}
const managedTabs = new Set(); // P0: 由 /new 创建的 tab，用于泄漏防护

// --- P0: managedTabs 持久化（重启恢复） ---
function saveManagedTabs() {
  try { fs.writeFileSync(MANAGED_TABS_FILE, JSON.stringify([...managedTabs])); } catch { /* 忽略 */ }
}
function loadManagedTabs() {
  try {
    if (fs.existsSync(MANAGED_TABS_FILE)) {
      const ids = JSON.parse(fs.readFileSync(MANAGED_TABS_FILE, 'utf-8'));
      for (const id of ids) managedTabs.add(id);
      if (managedTabs.size > 0) console.log(`[CDP Proxy] 恢复 ${managedTabs.size} 个托管 tab`);
    }
  } catch { /* 忽略 */ }
}

// --- WebSocket 兼容层 ---
let WS;
if (typeof globalThis.WebSocket !== 'undefined') {
  // Node 22+ 原生 WebSocket（浏览器兼容 API）
  WS = globalThis.WebSocket;
} else {
  // 回退到 ws 模块
  try {
    WS = (await import('ws')).default;
  } catch {
    console.error('[CDP Proxy] 错误：Node.js 版本 < 22 且未安装 ws 模块');
    console.error('  解决方案：升级到 Node.js 22+ 或执行 npm install -g ws');
    process.exit(1);
  }
}

// --- 自动发现 Chrome 调试端口 ---
async function discoverChromePort() {
  // 1. 尝试读 DevToolsActivePort 文件
  const possiblePaths = [];
  const platform = os.platform();

  if (platform === 'darwin') {
    const home = os.homedir();
    possiblePaths.push(
      path.join(home, 'Library/Application Support/Google/Chrome/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Google/Chrome Canary/DevToolsActivePort'),
      path.join(home, 'Library/Application Support/Chromium/DevToolsActivePort'),
    );
  } else if (platform === 'linux') {
    const home = os.homedir();
    possiblePaths.push(
      path.join(home, '.config/google-chrome/DevToolsActivePort'),
      path.join(home, '.config/chromium/DevToolsActivePort'),
    );
  } else if (platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    possiblePaths.push(
      path.join(localAppData, 'Google/Chrome/User Data/DevToolsActivePort'),
      path.join(localAppData, 'Chromium/User Data/DevToolsActivePort'),
    );
  }

  for (const p of possiblePaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8').trim();
      const port = parseInt(content.split('\n')[0]);
      if (port > 0 && port < 65536) {
        const ok = await checkPort(port);
        if (ok) {
          console.log(`[CDP Proxy] 从 DevToolsActivePort 发现端口: ${port}`);
          return port;
        }
      }
    } catch { /* 文件不存在，继续 */ }
  }

  // 2. 扫描常用端口
  const commonPorts = [9222, 9229, 9333];
  for (const port of commonPorts) {
    const ok = await checkPort(port);
    if (ok) {
      console.log(`[CDP Proxy] 扫描发现 Chrome 调试端口: ${port}`);
      return port;
    }
  }

  return null;
}

// 用 TCP 探测端口是否监听——避免 WebSocket 连接触发 Chrome 安全弹窗
// （WebSocket 探测会被 Chrome 视为调试连接，弹出授权对话框）
function checkPort(port) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1');
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, 2000);
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true); });
    socket.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

async function getWebSocketUrl(chromePort) {
  // 从 /json/version 获取完整的 WebSocket URL
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${chromePort}/json/version`, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.webSocketDebuggerUrl || `ws://127.0.0.1:${chromePort}/devtools/browser`);
        } catch {
          resolve(`ws://127.0.0.1:${chromePort}/devtools/browser`);
        }
      });
    }).on('error', () => {
      resolve(`ws://127.0.0.1:${chromePort}/devtools/browser`);
    });
  });
}

// --- WebSocket 连接管理 ---
let chromePort = null;

async function connect() {
  if (ws && (ws.readyState === WS.OPEN || ws.readyState === 1)) return;

  if (!chromePort) {
    chromePort = await discoverChromePort();
    if (!chromePort) {
      throw new Error(
        'Chrome 未开启远程调试端口。请用以下方式启动 Chrome：\n' +
        '  macOS: /Applications/Google\\ Chrome.app/Contents/MacOS/Google\\ Chrome --remote-debugging-port=9222\n' +
        '  Linux: google-chrome --remote-debugging-port=9222\n' +
        '  或在 chrome://flags 中搜索 "remote debugging" 并启用'
      );
    }
  }

  const wsUrl = await getWebSocketUrl(chromePort);
  if (!wsUrl) throw new Error('无法获取 Chrome WebSocket URL');

  return new Promise((resolve, reject) => {
    ws = new WS(wsUrl);

    const onOpen = () => {
      cleanup();
      console.log(`[CDP Proxy] 已连接 Chrome (端口 ${chromePort})`);
      resolve();
    };
    const onError = (e) => {
      cleanup();
      const msg = e.message || e.error?.message || '连接失败';
      console.error('[CDP Proxy] 连接错误:', msg);
      reject(new Error(msg));
    };
    const onClose = () => {
      console.log('[CDP Proxy] 连接断开');
      ws = null;
      chromePort = null; // 重置端口缓存，下次连接重新发现
      sessions.clear();
      recordings.clear(); // 清理录制状态
      intercepts.clear(); // 清理拦截配置
      // P2: Chrome 断连时不清空 managedTabs（Chrome 可能只是休眠恢复）
      // 下次 connect 时 managedTabs 仍可用于清理
    };
    const onMessage = (evt) => {
      const data = typeof evt === 'string' ? evt : (evt.data || evt);
      const msg = JSON.parse(typeof data === 'string' ? data : data.toString());

      if (msg.method === 'Target.attachedToTarget') {
        const { sessionId, targetInfo } = msg.params;
        sessions.set(targetInfo.targetId, sessionId);
      }

      // 处理录屏帧
      if (msg.method === 'Page.screencastFrame') {
        const { sessionId, data: frameData, metadata } = msg.params;
        // 通过 sessionId 查找录制任务
        for (const [targetId, recording] of recordings.entries()) {
          if (recording.sessionId === sessionId || sessionId === undefined) {
            if (recording.active) {
              if (recording.frames.length < MAX_RECORDING_FRAMES) {
                recording.frames.push({
                  data: frameData,
                  timestamp: Date.now(),
                  metadata,
                });
              } else {
                recording.active = false;
                console.warn(`[CDP Proxy] 录屏达到 ${MAX_RECORDING_FRAMES} 帧上限，自动停止`);
              }
            }
            break;
          }
        }
        // 确认接收帧
        if (sessionId) {
          sendCDP('Page.screencastFrameAck', { sessionId }, sessionId).catch(() => {});
        }
      }

      // 处理网络请求拦截
      if (msg.method === 'Fetch.requestPaused' || msg.method === 'Network.requestIntercepted') {
        const { requestId, request, sessionId: msgSessionId } = msg.params;
        // 找到对应的拦截配置
        for (const [targetId, config] of intercepts.entries()) {
          const sessId = sessions.get(targetId);
          if (sessId === msgSessionId || msgSessionId === undefined) {
            const interceptConfig = config;
            // 根据配置处理请求
            if (interceptConfig.action === 'block') {
              sendCDP('Fetch.failRequest', {
                requestId,
                errorReason: 'Aborted',
              }, msgSessionId).catch(() => {});
            } else if (interceptConfig.action === 'redirect' && interceptConfig.newUrl) {
              sendCDP('Fetch.continueRequest', {
                requestId,
                url: interceptConfig.newUrl,
              }, msgSessionId).catch(() => {});
            } else if (interceptConfig.action === 'mockResponse' && interceptConfig.responseBody) {
              sendCDP('Fetch.fulfillRequest', {
                requestId,
                responseCode: 200,
                responseHeaders: interceptConfig.headers ? Object.entries(interceptConfig.headers).map(([k, v]) => ({ name: k, value: String(v) })) : [],
                body: Buffer.from(interceptConfig.responseBody).toString('base64'),
              }, msgSessionId).catch(() => {});
            } else {
              sendCDP('Fetch.continueRequest', { requestId }, msgSessionId).catch(() => {});
            }
            break;
          }
        }
      }

      if (msg.id && pending.has(msg.id)) {
        const { resolve, timer } = pending.get(msg.id);
        clearTimeout(timer);
        pending.delete(msg.id);
        resolve(msg);
      }
    };

    function cleanup() {
      ws.removeEventListener?.('open', onOpen);
      ws.removeEventListener?.('error', onError);
    }

    // 兼容 Node 原生 WebSocket 和 ws 模块的事件 API
    if (ws.on) {
      ws.on('open', onOpen);
      ws.on('error', onError);
      ws.on('close', onClose);
      ws.on('message', onMessage);
    } else {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      ws.addEventListener('close', onClose);
      ws.addEventListener('message', onMessage);
    }
  });
}

function sendCDP(method, params = {}, sessionId = null, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    if (!ws || (ws.readyState !== WS.OPEN && ws.readyState !== 1)) {
      return reject(new Error('WebSocket 未连接'));
    }
    const id = ++cmdId;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('CDP 命令超时: ' + method));
    }, timeoutMs);
    pending.set(id, { resolve, timer });
    ws.send(JSON.stringify(msg));
  });
}

async function ensureSession(targetId) {
  if (sessions.has(targetId)) return sessions.get(targetId);
  const resp = await sendCDP('Target.attachToTarget', { targetId, flatten: true });
  if (resp.result?.sessionId) {
    sessions.set(targetId, resp.result.sessionId);
    return resp.result.sessionId;
  }
  throw new Error('attach 失败: ' + JSON.stringify(resp.error));
}

// --- 等待页面加载 ---
async function waitForLoad(sessionId, timeoutMs = 15000) {
  // 启用 Page 域
  await sendCDP('Page.enable', {}, sessionId);

  return new Promise((resolve) => {
    let resolved = false;
    const done = (result) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(timer);
      clearInterval(checkInterval);
      resolve(result);
    };

    const timer = setTimeout(() => done('timeout'), timeoutMs);
    const checkInterval = setInterval(async () => {
      try {
        const resp = await sendCDP('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        }, sessionId);
        if (resp.result?.result?.value === 'complete') {
          done('complete');
        }
      } catch { /* 忽略 */ }
    }, 500);
  });
}

// --- 读取 POST body（带大小限制） ---
async function readBody(req, maxSize = MAX_BODY_SIZE) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxSize) {
      throw new Error(`请求体超过 ${Math.round(maxSize / 1024)}KB 限制`);
    }
  }
  return body;
}

// --- Token 认证（默认启用，自动生成 + 持久化到安全目录） ---
// 优先读环境变量，否则自动生成并写入 AUTH_TOKEN_FILE（权限 0600）
let AUTH_TOKEN = process.env.CDP_PROXY_TOKEN || null;
if (!AUTH_TOKEN) {
  try {
    if (fs.existsSync(AUTH_TOKEN_FILE)) {
      const stored = JSON.parse(fs.readFileSync(AUTH_TOKEN_FILE, 'utf-8'));
      AUTH_TOKEN = stored.token;
    }
  } catch { /* 忽略 */ }
  if (!AUTH_TOKEN) {
    const { randomBytes } = await import('node:crypto');
    AUTH_TOKEN = randomBytes(32).toString('hex'); // 256-bit token
  }
  try {
    fs.writeFileSync(AUTH_TOKEN_FILE, JSON.stringify({ token: AUTH_TOKEN, createdAt: new Date().toISOString() }), { mode: 0o600 });
  } catch { /* 忽略 */ }
}

function checkAuth(req, parsed) {
  const q = Object.fromEntries(parsed.searchParams);
  const urlToken = q.token;
  const headerAuth = req.headers['authorization'] || '';
  const bearerToken = headerAuth.startsWith('Bearer ') ? headerAuth.slice(7) : null;
  return urlToken === AUTH_TOKEN || bearerToken === AUTH_TOKEN;
}

// --- P0: Tab 泄漏防护 — 清理所有托管 tab ---
async function cleanupManagedTabs() {
  if (managedTabs.size === 0) return;
  console.log(`[CDP Proxy] 清理 ${managedTabs.size} 个托管 tab...`);
  for (const targetId of [...managedTabs]) {
    try {
      await sendCDP('Target.closeTarget', { targetId });
      sessions.delete(targetId);
    } catch { /* 忽略已关闭的 tab */ }
  }
  managedTabs.clear();
  saveManagedTabs();
}

// --- HTTP API ---
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  const q = Object.fromEntries(parsed.searchParams);

  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  try {
    // /health 不需要连接 Chrome
    if (pathname === '/health') {
      const connected = ws && (ws.readyState === WS.OPEN || ws.readyState === 1);
      res.end(JSON.stringify({ status: 'ok', connected, sessions: sessions.size, chromePort, managedTabs: managedTabs.size, auth: AUTH_TOKEN ? 'enabled' : 'off' }));
      return;
    }

    // P3: Token 认证检查（/health 端点不需要认证）
    if (!checkAuth(req, parsed)) {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: '认证失败：需要 token 参数或 Authorization header' }));
      return;
    }

    await connect();

    // GET /targets - 列出所有页面
    // ?all=true 返回所有类型（iframe, worker, service_worker 等）
    if (pathname === '/targets') {
      const resp = await sendCDP('Target.getTargets');
      if (q.all === 'true') {
        res.end(JSON.stringify(resp.result.targetInfos, null, 2));
      } else {
        const pages = resp.result.targetInfos.filter(t => t.type === 'page');
        res.end(JSON.stringify(pages, null, 2));
      }
    }

    // GET /new?url=xxx - 创建新后台 tab
    else if (pathname === '/new') {
      const targetUrl = q.url || 'about:blank';
      const resp = await sendCDP('Target.createTarget', { url: targetUrl, background: true });
      const targetId = resp.result.targetId;

      // 等待页面加载
      if (targetUrl !== 'about:blank') {
        try {
          const sid = await ensureSession(targetId);
          await waitForLoad(sid);
        } catch { /* 非致命，继续 */ }
      }

      res.end(JSON.stringify({ targetId }));
      managedTabs.add(targetId); // P0: 注册托管 tab
      saveManagedTabs();
    }

    // GET /close?target=xxx - 关闭 tab
    else if (pathname === '/close') {
      const resp = await sendCDP('Target.closeTarget', { targetId: q.target });
      sessions.delete(q.target);
      managedTabs.delete(q.target); // P0: 注销托管 tab
      saveManagedTabs();
      res.end(JSON.stringify(resp.result));
    }

    // GET /navigate?target=xxx&url=yyy - 导航（自动等待加载）
    else if (pathname === '/navigate') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Page.navigate', { url: q.url }, sid);

      // 等待页面加载完成
      await waitForLoad(sid);

      res.end(JSON.stringify(resp.result));
    }

    // GET /back?target=xxx - 后退
    else if (pathname === '/back') {
      const sid = await ensureSession(q.target);
      await sendCDP('Runtime.evaluate', { expression: 'history.back()' }, sid);
      await waitForLoad(sid);
      res.end(JSON.stringify({ ok: true }));
    }

    // POST /eval?target=xxx - 执行 JS
    else if (pathname === '/eval') {
      const sid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.title';
      // 基本危险表达式检查（防止明显的恶意代码）
      if (/(?:^|[\s;])eval\s*\(/.test(expr) || /(?:^|[\s;])Function\s*\(/.test(expr)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '不允许使用 eval() 或 Function() 构造器' }));
        return;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: resp.result.result.value }));
      } else if (resp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: resp.result.exceptionDetails.text }));
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /click?target=xxx - 点击（body 为 CSS 选择器）
    // POST /click?target=xxx — JS 层面点击（简单快速，覆盖大多数场景）
    else if (pathname === '/click') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        el.click();
        return { clicked: true, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      if (resp.result?.result?.value) {
        const val = resp.result.result.value;
        if (val.error) {
          res.statusCode = 400;
          res.end(JSON.stringify(val));
        } else {
          res.end(JSON.stringify(val));
        }
      } else {
        res.end(JSON.stringify(resp.result));
      }
    }

    // POST /clickAt?target=xxx — CDP 浏览器级真实鼠标点击（算用户手势，能触发文件对话框、绕过反自动化检测）
    else if (pathname === '/clickAt') {
      const sid = await ensureSession(q.target);
      const selector = await readBody(req);
      if (!selector) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 CSS 选择器' }));
        return;
      }
      const selectorJson = JSON.stringify(selector);
      const js = `(() => {
        const el = document.querySelector(${selectorJson});
        if (!el) return { error: '未找到元素: ' + ${selectorJson} };
        el.scrollIntoView({ block: 'center' });
        const rect = el.getBoundingClientRect();
        return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName, text: (el.textContent || '').slice(0, 100) };
      })()`;
      const coordResp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
        awaitPromise: true,
      }, sid);
      const coord = coordResp.result?.result?.value;
      if (!coord || coord.error) {
        res.statusCode = 400;
        res.end(JSON.stringify(coord || coordResp.result));
        return;
      }
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mousePressed', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      await sendCDP('Input.dispatchMouseEvent', {
        type: 'mouseReleased', x: coord.x, y: coord.y, button: 'left', clickCount: 1
      }, sid);
      res.end(JSON.stringify({ clicked: true, x: coord.x, y: coord.y, tag: coord.tag, text: coord.text }));
    }

    // POST /type?target=xxx — CDP 浏览器级文本输入（Input.insertText）
    // 模拟真实键盘输入，能正确触发 React/Vue 等框架的状态更新
    // query: clear=true 先清空已有内容
    else if (pathname === '/type') {
      const sid = await ensureSession(q.target);
      const text = await readBody(req);
      if (!text) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要输入文本' }));
        return;
      }

      // 可选：先清空现有内容（Meta+A 全选 → Backspace 删除）
      if (q.clear === 'true') {
        await sendCDP('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 // Meta (Cmd on Mac)
        }, sid);
        await sendCDP('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 0
        }, sid);
        await new Promise(r => setTimeout(r, 50));
        await sendCDP('Input.dispatchKeyEvent', {
          type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8
        }, sid);
        await sendCDP('Input.dispatchKeyEvent', {
          type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8
        }, sid);
        await new Promise(r => setTimeout(r, 50));
      }

      // 使用 CDP Input.insertText — 浏览器级文本插入，触发完整的 input 事件链
      await sendCDP('Input.insertText', { text }, sid);
      res.end(JSON.stringify({ typed: true, length: text.length, cleared: q.clear === 'true' }));
    }

    // POST /press?target=xxx — CDP 浏览器级按键（Input.dispatchKeyEvent）
    // body: key name or combo, e.g. "Enter", "Meta+a", "Control+Shift+End"
    else if (pathname === '/press') {
      const sid = await ensureSession(q.target);
      const key = await readBody(req);
      if (!key) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'POST body 需要 key 名称' }));
        return;
      }

      const parts = key.split('+');
      const mainKey = parts[parts.length - 1];
      const modifierKeys = parts.slice(0, -1);
      const modifiers = modifierKeys.reduce((acc, mod) => {
        switch (mod.toLowerCase()) {
          case 'ctrl': case 'control': return acc | 2;
          case 'alt': case 'option': return acc | 1;
          case 'meta': case 'cmd': case 'command': return acc | 4;
          case 'shift': return acc | 8;
          default: return acc;
        }
      }, 0);

      const keyMap = {
        'Enter': { key: 'Enter', code: 'Enter', keyCode: 13 },
        'Tab': { key: 'Tab', code: 'Tab', keyCode: 9 },
        'Escape': { key: 'Escape', code: 'Escape', keyCode: 27 },
        'Backspace': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
        'Delete': { key: 'Delete', code: 'Delete', keyCode: 46 },
        'ArrowUp': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
        'ArrowDown': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
        'ArrowLeft': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
        'ArrowRight': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
        'Home': { key: 'Home', code: 'Home', keyCode: 36 },
        'End': { key: 'End', code: 'End', keyCode: 35 },
        'PageUp': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
        'PageDown': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
        'Space': { key: ' ', code: 'Space', keyCode: 32 },
      };
      // 单字母键
      if (/^[a-zA-Z]$/.test(mainKey)) {
        keyMap[mainKey] = { key: mainKey, code: 'Key' + mainKey.toUpperCase(), keyCode: 65 + mainKey.toUpperCase().charCodeAt(0) - 65 };
      }

      const keyDef = keyMap[mainKey] || { key: mainKey, code: mainKey, keyCode: mainKey.charCodeAt(0) };

      await sendCDP('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.keyCode,
        modifiers,
      }, sid);

      await sendCDP('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: keyDef.key,
        code: keyDef.code,
        windowsVirtualKeyCode: keyDef.keyCode,
        modifiers,
      }, sid);

      // 释放 modifier keys
      if (modifiers) {
        const modKeyMap = { 2: { key: 'Control', code: 'ControlLeft' }, 1: { key: 'Alt', code: 'AltLeft' }, 4: { key: 'Meta', code: 'MetaLeft' }, 8: { key: 'Shift', code: 'ShiftLeft' } };
        for (const [mod, keyDef2] of Object.entries(modKeyMap)) {
          if (modifiers & Number(mod)) {
            await sendCDP('Input.dispatchKeyEvent', { type: 'keyUp', key: keyDef2.key, code: keyDef2.code, windowsVirtualKeyCode: 0, modifiers: 0 }, sid);
          }
        }
      }

      res.end(JSON.stringify({ pressed: key }));
    }

    // POST /setFiles?target=xxx — 给 file input 设置本地文件（绕过文件对话框）
    // body: JSON { "selector": "input[type=file]", "files": ["/path/to/file1.png", "/path/to/file2.png"] }
    else if (pathname === '/setFiles') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));
      if (!body.selector || !body.files) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 selector 和 files 字段' }));
        return;
      }
      // 获取 DOM 节点
      await sendCDP('DOM.enable', {}, sid);
      const doc = await sendCDP('DOM.getDocument', {}, sid);
      const node = await sendCDP('DOM.querySelector', {
        nodeId: doc.result.root.nodeId,
        selector: body.selector
      }, sid);
      if (!node.result?.nodeId) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到元素: ' + body.selector }));
        return;
      }
      // 设置文件
      await sendCDP('DOM.setFileInputFiles', {
        nodeId: node.result.nodeId,
        files: body.files
      }, sid);
      res.end(JSON.stringify({ success: true, files: body.files.length }));
    }

    // GET /scroll?target=xxx&y=3000 - 滚动
    else if (pathname === '/scroll') {
      const sid = await ensureSession(q.target);
      const y = parseInt(q.y || '3000');
      const direction = q.direction || 'down'; // down | up | top | bottom
      let js;
      if (direction === 'top') {
        js = 'window.scrollTo(0, 0); "scrolled to top"';
      } else if (direction === 'bottom') {
        js = 'window.scrollTo(0, document.body.scrollHeight); "scrolled to bottom"';
      } else if (direction === 'up') {
        js = `window.scrollBy(0, -${Math.abs(y)}); "scrolled up ${Math.abs(y)}px"`;
      } else {
        js = `window.scrollBy(0, ${Math.abs(y)}); "scrolled down ${Math.abs(y)}px"`;
      }
      const resp = await sendCDP('Runtime.evaluate', {
        expression: js,
        returnByValue: true,
      }, sid);
      // 等待懒加载触发
      await new Promise(r => setTimeout(r, 800));
      res.end(JSON.stringify({ value: resp.result?.result?.value }));
    }

    // GET /screenshot?target=xxx&file=/tmp/x.png - 截图
    else if (pathname === '/screenshot') {
      const sid = await ensureSession(q.target);
      const format = q.format || 'png';
      const resp = await sendCDP('Page.captureScreenshot', {
        format,
        quality: format === 'jpeg' ? 80 : undefined,
      }, sid);
      if (q.file) {
        fs.writeFileSync(q.file, Buffer.from(resp.result.data, 'base64'));
        res.end(JSON.stringify({ saved: q.file }));
      } else {
        res.setHeader('Content-Type', 'image/' + format);
        res.end(Buffer.from(resp.result.data, 'base64'));
      }
    }

    // GET /saveSession?target=xxx&file=/path/to/session.json - 保存会话（Cookie + LocalStorage）
    else if (pathname === '/saveSession') {
      const sid = await ensureSession(q.target);
      const file = q.file || `/tmp/session_${q.target}.json`;

      // 获取 Cookie
      const cookieResp = await sendCDP('Network.getCookies', {}, sid);
      const cookies = cookieResp.result?.cookies || [];

      // 获取 LocalStorage
      const lsResp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify(Object.assign({}, localStorage))',
        returnByValue: true,
      }, sid);
      const localStorage = JSON.parse(lsResp.result?.result?.value || '{}');

      // 获取 sessionStorage
      const ssResp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify(Object.assign({}, sessionStorage))',
        returnByValue: true,
      }, sid);
      const sessionStorage = JSON.parse(ssResp.result?.result?.value || '{}');

      // 获取 URL
      const urlResp = await sendCDP('Runtime.evaluate', {
        expression: 'location.href',
        returnByValue: true,
      }, sid);
      const url = urlResp.result?.result?.value || '';

      const sessionData = {
        url,
        cookies,
        localStorage,
        sessionStorage,
        savedAt: new Date().toISOString()
      };

      fs.writeFileSync(file, JSON.stringify(sessionData, null, 2));
      res.end(JSON.stringify({ saved: file, cookies: cookies.length, localStorage: Object.keys(localStorage).length }));
    }

    // GET /loadSession?target=xxx&file=/path/to/session.json - 恢复会话
    else if (pathname === '/loadSession') {
      const sid = await ensureSession(q.target);
      const file = q.file || `/tmp/session_${q.target}.json`;

      if (!fs.existsSync(file)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: '会话文件不存在：' + file }));
        return;
      }

      const sessionData = JSON.parse(fs.readFileSync(file, 'utf-8'));
      let loaded = { cookies: 0, localStorage: 0 };

      // 恢复 Cookie
      if (sessionData.cookies && sessionData.cookies.length > 0) {
        for (const cookie of sessionData.cookies) {
          try {
            await sendCDP('Network.setCookie', {
              name: cookie.name,
              value: cookie.value,
              domain: cookie.domain,
              path: cookie.path || '/',
              secure: cookie.secure,
              httpOnly: cookie.httpOnly,
            }, sid);
            loaded.cookies++;
          } catch { /* 忽略失败的 Cookie */ }
        }
      }

      // 恢复 LocalStorage
      if (sessionData.localStorage && Object.keys(sessionData.localStorage).length > 0) {
        const lsEntries = Object.entries(sessionData.localStorage);
        for (const [key, value] of lsEntries) {
          await sendCDP('Runtime.evaluate', {
            expression: `localStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
          }, sid);
        }
        loaded.localStorage = lsEntries.length;
      }

      // 恢复 sessionStorage
      if (sessionData.sessionStorage && Object.keys(sessionData.sessionStorage).length > 0) {
        const ssEntries = Object.entries(sessionData.sessionStorage);
        for (const [key, value] of ssEntries) {
          await sendCDP('Runtime.evaluate', {
            expression: `sessionStorage.setItem(${JSON.stringify(key)}, ${JSON.stringify(value)})`,
          }, sid);
        }
        loaded.sessionStorage = ssEntries.length;
      }

      // 导航到保存的 URL
      if (sessionData.url) {
        await sendCDP('Page.navigate', { url: sessionData.url }, sid);
        await waitForLoad(sid);
      }

      res.end(JSON.stringify({ loaded, restoredUrl: sessionData.url }));
    }

    // GET /startRecord?target=xxx&format=jpeg&quality=80 - 开始录屏
    else if (pathname === '/startRecord') {
      const targetId = q.target;
      const format = q.format || 'jpeg';
      const quality = parseInt(q.quality || '80');

      // 获取或创建 session
      const sid = await ensureSession(targetId);

      // 启用 Page 域
      await sendCDP('Page.enable', {}, sid);

      // 开始截帧 - 使用 flatten: true 确保事件正确发送
      await sendCDP('Page.startScreencast', {
        format,
        quality,
        maxWidth: parseInt(q.maxWidth || '1280'),
        maxHeight: parseInt(q.maxHeight || '720'),
        everyNthFrame: parseInt(q.everyNthFrame || '1'),
      }, sid);

      recordings.set(targetId, {
        active: true,
        frames: [],
        format,
        startTime: Date.now(),
        sessionId: sid,
      });

      res.end(JSON.stringify({ recording: true, target: targetId, format, quality }));
    }

    // GET /stopRecord?target=xxx&output=/path/to/output.json - 停止录屏并保存帧
    else if (pathname === '/stopRecord') {
      const sid = await ensureSession(q.target);
      const output = q.output || `/tmp/recording_${q.target}.json`;

      const recording = recordings.get(q.target);
      if (!recording) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '未找到活动的录制' }));
        return;
      }

      // 停止截帧
      await sendCDP('Page.stopScreencast', {}, sid);

      const duration = Date.now() - recording.startTime;

      // 保存录制数据
      const recordingData = {
        target: q.target,
        format: recording.format,
        startTime: recording.startTime,
        duration,
        frameCount: recording.frames.length,
        frames: recording.frames,
      };

      fs.writeFileSync(output, JSON.stringify(recordingData, null, 2));
      recordings.delete(q.target);

      res.end(JSON.stringify({ saved: output, frameCount: recordingData.frameCount, duration }));
    }

    // POST /setIntercept?target=xxx - 设置请求拦截
    // body: JSON { "urlPattern": "https://api.example.com/*", "action": "block" | "modify", "newUrl": "...", "headers": {...} }
    else if (pathname === '/setIntercept') {
      const sid = await ensureSession(q.target);
      const body = JSON.parse(await readBody(req));

      if (!body.urlPattern) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 urlPattern 字段' }));
        return;
      }

      // 启用 Network 域
      await sendCDP('Network.enable', {}, sid);

      // 设置请求拦截
      await sendCDP('Network.setRequestInterception', {
        patterns: [{ urlPattern: body.urlPattern }],
      }, sid);

      intercepts.set(q.target, {
        urlPattern: body.urlPattern,
        action: body.action || 'block',
        newUrl: body.newUrl,
        headers: body.headers,
        responseBody: body.responseBody,
      });

      res.end(JSON.stringify({ intercepting: true, pattern: body.urlPattern, action: body.action }));
    }

    // GET /removeIntercept?target=xxx - 移除请求拦截
    else if (pathname === '/removeIntercept') {
      const sid = await ensureSession(q.target);

      intercepts.delete(q.target);

      // 禁用请求拦截
      await sendCDP('Network.setRequestInterception', {
        patterns: [],
      }, sid);

      res.end(JSON.stringify({ removed: true, target: q.target }));
    }

    // POST /evalFrame?target=xxx&frameSrc=deep_research — 在跨域 iframe 中执行 JS
    // 用于读取 ChatGPT Deep Research 等跨域 iframe 内容
    // body: JS 表达式
    // frameSrc: iframe URL 子串匹配（如 "deep_research"）
    // 方法：从 Chrome /json 端点发现 iframe target → attach → evaluate
    else if (pathname === '/evalFrame') {
      const parentSid = await ensureSession(q.target);
      const body = await readBody(req);
      const expr = body || q.expr || 'document.body.innerText';
      const frameSrc = q.frameSrc || '';

      // 安全检查：与 /eval 一致
      if (/(?:^|[\s;])eval\s*\(/.test(expr) || /(?:^|[\s;])Function\s*\(/.test(expr)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '不允许使用 eval() 或 Function() 构造器' }));
        return;
      }

      // 1. 从 Chrome HTTP 端点获取所有 targets（包括跨域 iframe）
      const allTargets = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${chromePort}/json`, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            try { resolve(JSON.parse(data)); } catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });

      // 2. 查找匹配的 iframe target（优先精确匹配路径组件，降级子串匹配）
      let iframeTargets = allTargets.filter(t => {
        if (t.type !== 'iframe' || !t.url) return false;
        try { return new URL(t.url).pathname.includes(frameSrc); } catch { return false; }
      });
      if (iframeTargets.length === 0) {
        iframeTargets = allTargets.filter(t => t.type === 'iframe' && t.url && t.url.includes(frameSrc));
      }

      if (iframeTargets.length === 0) {
        res.statusCode = 400;
        res.end(JSON.stringify({
          error: '未找到匹配的 iframe',
          frameSrc,
          availableIframes: allTargets.filter(t => t.type === 'iframe').map(t => ({ id: t.id, url: t.url?.slice(0, 100) })),
        }));
        return;
      }

      const iframeTarget = iframeTargets[0];
      const iframeTargetId = iframeTarget.id;

      // 3. Attach 到 iframe target
      let iframeSessionId = sessions.get(iframeTargetId);
      if (!iframeSessionId) {
        const attachResp = await sendCDP('Target.attachToTarget', { targetId: iframeTargetId, flatten: true });
        if (attachResp.result?.sessionId) {
          iframeSessionId = attachResp.result.sessionId;
          sessions.set(iframeTargetId, iframeSessionId);
        } else {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: '无法 attach 到 iframe', targetId: iframeTargetId, cdpResponse: attachResp }));
          return;
        }
      }

      // 4. 在 iframe 中执行 JS
      const ctxResp = await sendCDP('Runtime.evaluate', {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      }, iframeSessionId);

      if (ctxResp.result?.result?.value !== undefined) {
        res.end(JSON.stringify({ value: ctxResp.result.result.value, iframeTargetId, iframeUrl: iframeTarget.url?.slice(0, 100) }));
      } else if (ctxResp.result?.exceptionDetails) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: ctxResp.result.exceptionDetails.exception?.description || ctxResp.result.exceptionDetails.text, iframeTargetId }));
      } else {
        res.end(JSON.stringify({ result: ctxResp.result, iframeTargetId }));
      }
    }

    // GET /info?target=xxx - 获取页面信息
    else if (pathname === '/info') {
      const sid = await ensureSession(q.target);
      const resp = await sendCDP('Runtime.evaluate', {
        expression: 'JSON.stringify({title: document.title, url: location.href, ready: document.readyState})',
        returnByValue: true,
      }, sid);
      res.end(resp.result?.result?.value || '{}');
    }

    // P0: GET /waitReady?target=xxx&check=JS_EXPRESSION&interval=5&timeout=300 — 轮询等待响应完成
    // check 为 JS 表达式，返回 truthy 时表示完成
    // 支持流式进度（stream=true）：每轮输出一行 JSON 进度
    // 例: /waitReady?target=ID&check=...&interval=5&timeout=300&stream=true
    else if (pathname === '/waitReady') {
      if (!q.target || !q.check) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: '需要 target 和 check 参数' }));
        return;
      }
      const sid = await ensureSession(q.target);
      const interval = parseInt(q.interval || '5') * 1000;
      const timeout = parseInt(q.timeout || '300') * 1000;
      const checkExpr = q.check;
      const useStream = q.stream === 'true';
      const startTime = Date.now();
      let ready = false;
      let lastValue = null;
      let attempts = 0;

      if (useStream) {
        // 流式模式：每轮检查后发送一行 JSON
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.setHeader('Transfer-Encoding', 'chunked');
      }

      while (Date.now() - startTime < timeout) {
        attempts++;
        try {
          const resp = await sendCDP('Runtime.evaluate', {
            expression: checkExpr,
            returnByValue: true,
          }, sid);
          lastValue = resp.result?.result?.value;
          if (lastValue) {
            ready = true;
            break;
          }
        } catch { /* 忽略临时错误 */ }

        if (useStream) {
          const elapsed = Math.round((Date.now() - startTime) / 1000);
          const remaining = Math.max(0, Math.round((timeout - (Date.now() - startTime)) / 1000));
          res.write(JSON.stringify({ waiting: true, elapsed, remaining, attempts, lastValue }) + '\n');
        }

        await new Promise(r => setTimeout(r, interval));
      }

      const finalResult = {
        ready,
        elapsed: Math.round((Date.now() - startTime) / 1000),
        lastValue: lastValue ?? null,
        timedOut: !ready,
        attempts,
      };

      if (useStream) {
        res.write(JSON.stringify(finalResult) + '\n');
        res.end();
      } else {
        res.end(JSON.stringify(finalResult));
      }
    }

    // P0: GET /cleanup — 关闭所有托管 tab（防止泄漏）
    else if (pathname === '/cleanup') {
      await cleanupManagedTabs();
      res.end(JSON.stringify({ cleaned: true }));
    }

    else {
      res.statusCode = 404;
      res.end(JSON.stringify({
        error: '未知端点',
        endpoints: {
          '/health': 'GET - 健康检查',
          '/targets': 'GET - 列出所有页面 tab',
          '/new?url=': 'GET - 创建新后台 tab（自动等待加载）',
          '/close?target=': 'GET - 关闭 tab',
          '/navigate?target=&url=': 'GET - 导航（自动等待加载）',
          '/back?target=': 'GET - 后退',
          '/info?target=': 'GET - 页面标题/URL/状态',
          '/eval?target=': 'POST body=JS表达式 - 执行 JS',
          '/click?target=': 'POST body=CSS选择器 - 点击元素',
          '/scroll?target=&y=&direction=': 'GET - 滚动页面',
          '/screenshot?target=&file=': 'GET - 截图',
          '/clickAt?target=': 'POST body=CSS 选择器 - 真实鼠标点击',
          '/type?target=&clear=': 'POST body=文本 - CDP 级文本输入（触发 React 状态更新）',
          '/press?target=': 'POST body=key - CDP 级按键（Enter/Meta+a 等）',
          '/setFiles?target=': 'POST body=JSON - 文件上传',
          // 新增增强功能
          '/saveSession?target=&file=': 'GET - 保存会话（Cookie+LocalStorage）',
          '/loadSession?target=&file=': 'GET - 恢复会话',
          '/startRecord?target=&format=&quality=': 'GET - 开始录屏',
          '/stopRecord?target=&output=': 'GET - 停止录屏并保存',
          '/setIntercept?target=': 'POST body=JSON - 设置请求拦截',
          '/removeIntercept?target=': 'GET - 移除请求拦截',
          '/evalFrame?target=&frameIndex=': 'POST body=JS - 在跨域 iframe 中执行 JS（ChatGPT DR 等）',
          '/waitReady?target=&check=': 'GET - 轮询等待 JS 表达式为 truthy（P0）',
          '/cleanup': 'GET - 关闭所有托管 tab（P0 防泄漏）',
        },
      }));
    }
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: e.message }));
  }
});

// 检查端口是否被占用
function checkPortAvailable(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => { s.close(); resolve(true); });
    s.listen(port, '127.0.0.1');
  });
}

async function main() {
  // P0: 恢复上次的托管 tab 列表
  loadManagedTabs();

  // 检查是否已有 proxy 在运行
  const available = await checkPortAvailable(PORT);
  if (!available) {
    // 验证已有实例是否健康
    try {
      const ok = await new Promise((resolve) => {
        http.get(`http://127.0.0.1:${PORT}/health`, { timeout: 2000 }, (res) => {
          let d = '';
          res.on('data', c => d += c);
          res.on('end', () => resolve(d.includes('"ok"')));
        }).on('error', () => resolve(false));
      });
      if (ok) {
        console.log(`[CDP Proxy] 已有实例运行在端口 ${PORT}，退出`);
        process.exit(0);
      }
    } catch { /* 端口占用但非 proxy，继续报错 */ }
    console.error(`[CDP Proxy] 端口 ${PORT} 已被占用`);
    process.exit(1);
  }

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`[CDP Proxy] 运行在 http://localhost:${PORT}`);
    console.log(`[CDP Proxy] Token 文件: ${AUTH_TOKEN_FILE}（认证已启用）`);
    // 启动时连接 Chrome 并恢复托管 tab（非阻塞）
    (async () => {
      try {
        await connect();
        console.log('[CDP Proxy] 已连接 Chrome');
      } catch (e) {
        console.error('[CDP Proxy] 初始连接失败:', e.message, '（将在首次请求时重试）');
      }
    })();
  });
}

// 未捕获异常：记录后退出，让进程管理器重启
process.on('uncaughtException', (e) => {
  console.error('[CDP Proxy] 未捕获异常（进程将退出）:', e.message);
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('[CDP Proxy] 未处理拒绝:', e?.message || e);
  process.exit(1);
});

// P0: 进程退出时清理托管 tab
// SIGTERM/SIGINT（正常关闭）：清理 tab + 清空持久化
// 异常崩溃：持久化文件保留，下次启动恢复
async function gracefulShutdown(signal) {
  console.log(`[CDP Proxy] 收到 ${signal}，清理托管 tab...`);
  try { await cleanupManagedTabs(); } catch { /* 忽略 */ }
  process.exit(0);
}
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

main();
