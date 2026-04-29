#!/usr/bin/env bash
# 选择器健康检查 — 验证各平台关键选择器是否有效
# 用法: bash health-check.sh [token]
# 返回: 每个平台的选择器状态（✅/❌）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROXY="http://localhost:3456"

# 读取 token（从安全配置目录）
TOKEN=""
if [ -n "${1:-}" ]; then
  TOKEN="$1"
else
  TOKEN=$(node -e "
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    try {
      const configDir = process.env.CDP_PROXY_CONFIG_DIR || path.join(os.homedir(), '.config', 'geo-sentinel');
      const d = JSON.parse(fs.readFileSync(path.join(configDir, 'auth-token.json'), 'utf-8'));
      console.log(d.token);
    } catch { console.log(''); }
  " 2>/dev/null)
fi

AUTH=""
[ -n "$TOKEN" ] && AUTH="token=$TOKEN"

echo "=== Intel Scan 选择器健康检查 $(date '+%Y-%m-%d %H:%M') ==="
echo ""

# 检查 proxy
HEALTH=$(curl -s --connect-timeout 3 "$PROXY/health" 2>/dev/null || echo '{"status":"down"}')
if echo "$HEALTH" | grep -q '"ok"'; then
  echo "✅ CDP Proxy: 运行中"
else
  echo "❌ CDP Proxy: 未运行（先执行 check-deps.sh）"
  exit 1
fi

# 获取 token 认证状态
AUTH_STATUS=$(echo "$HEALTH" | python3 -c "import sys,json;print(json.load(sys.stdin).get('auth','off'))" 2>/dev/null)
if [ "$AUTH_STATUS" = "enabled" ] && [ -z "$TOKEN" ]; then
  echo "❌ Token 认证已启用但未提供 token"
  exit 1
fi

# 通用函数：测试选择器
test_selector() {
  local target="$1" selector="$2" name="$3"
  local result
  result=$(curl -s -X POST "$PROXY/eval?target=$target&$AUTH" -d "!!document.querySelector('$selector')" 2>/dev/null)
  if echo "$result" | grep -q '"value":true'; then
    echo "  ✅ $name: $selector"
    return 0
  else
    echo "  ❌ $name: $selector（未找到）"
    return 1
  fi
}

# 列出所有 tab
TARGETS=$(curl -s "$PROXY/targets?$AUTH" 2>/dev/null)

# === Grok ===
echo ""
echo "--- Grok (grok.com) ---"
GROK_ID=$(echo "$TARGETS" | python3 -c "
import sys,json
ts = json.load(sys.stdin)
for t in ts:
  if 'grok.com' in t.get('url',''):
    print(t['targetId'])
    break
" 2>/dev/null)

if [ -n "$GROK_ID" ]; then
  echo "  Tab: $GROK_ID"
  test_selector "$GROK_ID" '.tiptap.ProseMirror' '编辑器' || true
  test_selector "$GROK_ID" '[contenteditable="true"]' '编辑器(降级)' || true
  test_selector "$GROK_ID" 'button[aria-label="提交"]' '提交按钮' || true
  test_selector "$GROK_ID" '.markdown' '响应容器' || true
else
  echo "  ⚠️  无 Grok tab（需要先打开 grok.com）"
fi

# === Gemini ===
echo ""
echo "--- Gemini (gemini.google.com) ---"
GEMINI_ID=$(echo "$TARGETS" | python3 -c "
import sys,json
ts = json.load(sys.stdin)
for t in ts:
  if 'gemini.google.com' in t.get('url',''):
    print(t['targetId'])
    break
" 2>/dev/null)

if [ -n "$GEMINI_ID" ]; then
  echo "  Tab: $GEMINI_ID"
  test_selector "$GEMINI_ID" '.ql-editor.textarea' '编辑器' || true
  test_selector "$GEMINI_ID" 'button.toolbox-drawer-button' '工具按钮' || true
  test_selector "$GEMINI_ID" 'button[aria-label="发送"]' '发送按钮' || true
else
  echo "  ⚠️  无 Gemini tab（需要先打开 gemini.google.com）"
fi

# === ChatGPT ===
echo ""
echo "--- ChatGPT (chatgpt.com) ---"
CHATGPT_ID=$(echo "$TARGETS" | python3 -c "
import sys,json
ts = json.load(sys.stdin)
for t in ts:
  if 'chatgpt.com' in t.get('url',''):
    print(t['targetId'])
    break
" 2>/dev/null)

if [ -n "$CHATGPT_ID" ]; then
  echo "  Tab: $CHATGPT_ID"
  test_selector "$CHATGPT_ID" 'a[data-testid="deep-research-sidebar-item"]' 'DR入口' || true
  test_selector "$CHATGPT_ID" '#prompt-textarea' '编辑器' || true
  test_selector "$CHATGPT_ID" 'button[data-testid="send-button"]' '发送按钮' || true
else
  echo "  ⚠️  无 ChatGPT tab（需要先打开 chatgpt.com）"
fi

# === Perplexity ===
echo ""
echo "--- Perplexity (perplexity.ai) ---"
PERP_ID=$(echo "$TARGETS" | python3 -c "
import sys,json
ts = json.load(sys.stdin)
for t in ts:
  if 'perplexity.ai' in t.get('url',''):
    print(t['targetId'])
    break
" 2>/dev/null)

if [ -n "$PERP_ID" ]; then
  echo "  Tab: $PERP_ID"
  test_selector "$PERP_ID" '#ask-input' '编辑器' || true
  test_selector "$PERP_ID" 'button[aria-label="Submit"]' '提交按钮' || true
  test_selector "$PERP_ID" 'div.prose' '响应容器' || true
else
  echo "  ⚠️  无 Perplexity tab（需要先打开 perplexity.ai）"
fi

echo ""
echo "=== 检查完成 ==="
