---
name: geo-sentinel
description: 多平台情报扫描——输入自然语言查询，自动操控 Chrome 浏览器在 Gemini(Deep Research)/ChatGPT(Deep Research)/Perplexity 三平台搜索采集，Google 搜索作为第四验证源，对所有链接逐条打开验证内容与日期匹配，输出带核查状态的结构化事件报告。自包含技能，不依赖其他技能。支持每日定时触发。
origin: custom
---

# Geo Sentinel — 多平台情报扫描

情报扫描技能。不依赖其他 Claude 技能，但需要 Node.js 22+、Chrome 浏览器（开启 CDP 远程调试）、dokobot CLI 和 python3。

## 工作流总览

```
用户查询 → 解析意图 → [Gemini(DR) + ChatGPT(DR) + Perplexity 并行采集] → 日期硬过滤 → 交叉比对分级 → Google 验证 → 逐条打开链接验证 → 结构化报告
```

---

## 一、前置条件

| 依赖 | 安装/检查 | 最低版本 |
|------|----------|---------|
| Node.js | `node --version` | 22+ |
| Chrome 浏览器 | 已安装 | 任意 |
| CDP 远程调试 | `chrome://inspect/#remote-debugging` → 勾选 Allow | — |
| dokobot CLI | `npm install -g @dokobot/cli` + `dokobot install-bridge` | 任意 |
| defuddle CLI（可选） | `npm install -g defuddle-cli` | 任意 |
| python3 | 系统自带或 `brew install python3` | 3.8+ |

### 登录要求

使用前确保 Chrome 已登录以下平台（CDP 连接用户日常 Chrome，天然携带登录态）：
- https://grok.com
- https://gemini.google.com
- https://chatgpt.com
- https://www.perplexity.ai

### 启动检查

每次执行前先运行：

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/check-deps.sh
```

脚本会检查 Node.js、Chrome 调试端口，并启动 CDP Proxy（端口 3456）。Proxy 20 分钟无请求自动退出。

### 安全：Token 认证（默认启用）

CDP Proxy 自动生成 256-bit token 并存储在 `~/.config/geo-sentinel/auth-token.json`（权限 0600）。

也可通过环境变量覆盖：

```bash
export CDP_PROXY_TOKEN="$(openssl rand -hex 32)"
```

所有请求需携带 `?token=XXX` 或 `Authorization: Bearer XXX`。Token 文件首次生成后打印到日志。

---

## 二、CDP Proxy API（浏览器操控）

CDP Proxy 连接用户日常 Chrome，天然携带登录态。

### 基础端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/health` | GET | 健康检查（含托管 tab 数、认证状态） |
| `/targets` | GET | 列出所有 tab |
| `/new?url=URL` | GET | 创建新后台 tab（自动注册到托管列表） |
| `/close?target=ID` | GET | 关闭 tab（自动从托管列表移除） |
| `/navigate?target=ID&url=URL` | GET | 导航到新 URL |
| `/info?target=ID` | GET | 页面标题/URL/状态 |
| `/screenshot?target=ID&file=PATH` | GET | 截图保存到文件 |
| `/scroll?target=ID&y=N&direction=down` | GET | 滚动页面 |

### 交互端点

| 端点 | 方法 | 用途 |
|------|------|------|
| `/eval?target=ID` | POST | 执行 JS（body 为 JS 表达式） |
| `/click?target=ID` | POST | JS 层点击（body 为 CSS 选择器） |
| `/clickAt?target=ID` | POST | **CDP 级鼠标点击**（真实用户手势） |
| `/type?target=ID&clear=true` | POST | **CDP 级文本输入**（`Input.insertText`） |
| `/press?target=ID` | POST | **CDP 级按键**（如 `Enter`、`Meta+a`） |

### 可靠性端点（P0-P2）

| 端点 | 方法 | 用途 |
|------|------|------|
| `/waitReady?target=ID&check=JS&interval=5&timeout=300` | GET | **轮询等待响应完成**（替代盲 sleep） |
| `/cleanup` | GET | **关闭所有托管 tab**（防止泄漏） |

#### `/waitReady` 用法

```bash
# 等待 Grok 响应完成（.markdown 容器出现且内容 > 100 字符）
curl -s "http://localhost:3456/waitReady?target=$GROK&check=document.querySelectorAll('.markdown').length>0%26%26document.querySelectorAll('.markdown')[document.querySelectorAll('.markdown').length-1].innerText.length>100&interval=5&timeout=120"

# 等待 Gemini Deep Research 完成（出现"哪一个回答"或响应区稳定）
curl -s "http://localhost:3456/waitReady?target=$GEMINI&check=document.body.innerText.length>500%26%26!document.querySelector('[aria-label=%22停止%22]')&interval=10&timeout=300"

# 等待 ChatGPT 停止按钮消失
curl -s "http://localhost:3456/waitReady?target=$CHATGPT&check=!document.querySelector('button[aria-label=%22Stop%22]')%26%26document.querySelectorAll('.markdown').length>0&interval=10&timeout=300"

# 等待 Perplexity 响应容器出现
curl -s "http://localhost:3456/waitReady?target=$PERPLEXITY&check=document.querySelectorAll('div.prose').length>0%26%26document.querySelectorAll('div.prose')[document.querySelectorAll('div.prose').length-1].innerText.length>100&interval=5&timeout=120"
```

**返回值**：`{ready: true/false, elapsed: 秒, timedOut: true/false}`

### 关键原则

> **React 框架应用（Grok/ChatGPT/Perplexity）必须使用 CDP 级事件（`/clickAt` + `/type`），不能用 `/click` 或 `/eval` 操作 DOM。**

### 安全原则

> **每次任务开始前调用 `/cleanup` 清理上次可能残留的 tab。任务结束后关闭所有创建的 tab。进程收到 SIGTERM/SIGINT 时自动清理。**

---

## 三、网页读取工具

### dokobot（Chrome 扩展读取，支持 JS 渲染）

```bash
dokobot doko read '<URL>' --local --timeout 30
```

### defuddle（干净 markdown 提取，节省 token）

```bash
defuddle parse '<URL>' --md
```

---

## 四、平台操作指南

> 操作前读取站点经验：`ls ${CLAUDE_SKILL_DIR}/references/site-patterns/`

### P1: 选择器降级策略

每个平台定义**首选选择器**和**降级选择器**。如果首选选择器找不到元素，依次尝试降级选择器：

```bash
# 选择器探测 + 降级模板
SELECTOR=""
for sel in "$PRIMARY" "$FALLBACK1" "$FALLBACK2"; do
  FOUND=$(curl -s -X POST "http://localhost:3456/eval?target=$T" -d "!!document.querySelector('$sel')")
  if [ "$FOUND" = '{"value":true}' ]; then
    SELECTOR="$sel"
    break
  fi
done
if [ -z "$SELECTOR" ]; then
  echo "⚠️ 所有选择器失效，截图分析页面结构"
  curl -s "http://localhost:3456/screenshot?target=$T&file=/tmp/selector-debug.png"
fi
```

### P1: curl 重试包装

对所有关键 CDP 调用使用重试（最多 3 次，间隔 2 秒）：

```bash
cdp_call() {
  local url="$1" attempt=0
  shift
  while [ $attempt -lt 3 ]; do
    local result
    result=$(curl -s --connect-timeout 10 --max-time 30 "$@")
    if [ $? -eq 0 ] && echo "$result" | python3 -c "import sys,json; d=json.load(sys.stdin); sys.exit(0 if 'error' not in d else 1)" 2>/dev/null; then
      echo "$result"
      return 0
    fi
    attempt=$((attempt + 1))
    [ $attempt -lt 3 ] && sleep 2
  done
  echo '{"error":"重试3次后仍失败"}' >&2
  return 1
}
```

---

### Grok（grok.com）

| 项目 | 首选选择器 | 降级选择器 |
|------|-----------|-----------|
| 编辑器 | `.tiptap.ProseMirror` | `[contenteditable="true"]`, `[role="textbox"]` |
| 提交按钮 | `button[aria-label="提交"]` | `button[aria-label="Submit"]`, `form button[type="submit"]`, `[role="button"]` 含"提交/Submit" |
| 响应容器 | `.markdown`（最后一个） | `[role="article"]` |
| 完成检测 | `.markdown` 内容 > 100 字符 | — |

**操作流程**：
```bash
T=$GROK_ID
# 1. 先清理可能残留的 tab
curl -s "http://localhost:3456/cleanup"

# 2. 聚焦 + 输入 + 提交
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d '.tiptap.ProseMirror'
curl -s -X POST "http://localhost:3456/type?target=$T&clear=true" -d '<查询>'
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d 'button[aria-label="提交"]'

# 3. P0: 轮询等待响应完成（替代 sleep 20）
curl -s "http://localhost:3456/waitReady?target=$T&check=document.querySelectorAll('.markdown').length>0%26%26document.querySelectorAll('.markdown')[document.querySelectorAll('.markdown').length-1].innerText.length>100&interval=5&timeout=60"

# 4. 提取
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d 'document.querySelectorAll(".markdown")[document.querySelectorAll(".markdown").length-1].innerText'
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d 'JSON.stringify(Array.from(document.querySelectorAll(".markdown")[document.querySelectorAll(".markdown").length-1].querySelectorAll("a[href]")).map(a=>({text:a.textContent.trim().slice(0,80),href:a.href})))'
```

### Gemini（gemini.google.com）— 强制 Deep Research

| 项目 | 首选选择器 | 降级选择器 |
|------|-----------|-----------|
| 编辑器 | `.ql-editor.textarea` | `[contenteditable="true"].ql-editor`, `[role="textbox"]` |
| 发送按钮 | `button[aria-label="发送"]` | `button[aria-label="Send"]`, `button.send`, `[role="button"]` 含"发送/Send" |
| 工具按钮 | `button.toolbox-drawer-button` | `[aria-label*="工具"]`, `[aria-label*="Tools"]` |
| Deep Research | `.mat-mdc-list-item` 包含 "Deep Research" | `[role="option"]` 含 "Deep Research" |
| 响应容器 | `model-response` 或 `message-content` | `document.body.innerText`（降级，含噪声） |

**操作流程**：
```bash
T=$GEMINI_ID
curl -s "http://localhost:3456/navigate?target=$T&url=https://gemini.google.com/app"
sleep 5

# 激活 Deep Research
curl -s -X POST "http://localhost:3456/click?target=$T" -d 'button.toolbox-drawer-button'
sleep 2
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d 'Array.from(document.querySelectorAll(".mat-mdc-list-item")).find(el=>el.textContent.includes("Deep Research"))?.click()'
sleep 2

# 输入 + 提交
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d '.ql-editor.textarea'
curl -s -X POST "http://localhost:3456/type?target=$T" -d '<查询>'
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d 'button[aria-label="发送"]'

# 阶段一：等待方案确认页面出现（"开始研究" 按钮）
sleep 10
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d '(() => { const btns = document.querySelectorAll("button"); for (const b of btns) { if (b.textContent.includes("开始研究")) { b.click(); return "clicked 开始研究"; } } return "等待方案确认..."; })()'

# 阶段二：等待 Deep Research 完成（最长 5 分钟）
# 检测条件：不再有"正在研究"且内容长度 > 5000
curl -s "http://localhost:3456/waitReady?target=$T&check=...IIFE...&interval=15&timeout=300"
# 如果超时，再等一轮
curl -s "http://localhost:3456/waitReady?target=$T&check=...IIFE...&interval=15&timeout=300"

# P2: 精确提取 — 优先取"研究完成"后的内容，降级取"Gemini 说"后的内容
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d '(() => { const t = document.body.innerText; const i1 = t.indexOf("研究完成"); if (i1 >= 0) return t.slice(i1, i1 + 8000); const i2 = t.indexOf("Gemini 说"); return i2 >= 0 ? t.slice(i2, i2 + 8000) : t.slice(0, 8000); })()'
```

### ChatGPT（chatgpt.com）— 强制 Deep Research

| 项目 | 首选选择器 | 降级选择器 |
|------|-----------|-----------|
| DR 入口 | `a[data-testid="deep-research-sidebar-item"]` | `[role="link"]` 含 "Deep Research" |
| 编辑器 | `#prompt-textarea` | `.ProseMirror[contenteditable]`, `[role="textbox"]` |
| 发送按钮 | `button[data-testid="send-button"]` | `button[aria-label="Send"]`, `[role="button"]` 含"Send" |
| 响应容器 | **跨域 iframe**（`/evalFrame`） | `.markdown`（非 DR 模式） |
| 完成检测 | iframe 高度 > 200px | — |

**⚠️ 重要发现**：ChatGPT Deep Research 的响应内容渲染在跨域 iframe `connector_openai_deep_research.web-sandbox.oaiusercontent.com` 中。普通 `/eval` 无法读取 iframe 内容，必须使用 `/evalFrame?frameSrc=deep_research`。

**操作流程**：
```bash
T=$(curl -s "http://localhost:3456/new?url=https://chatgpt.com" | python3 -c "import sys,json;print(json.load(sys.stdin)['targetId'])")
sleep 5

# DR 页面加载后先清空旧内容再输入
curl -s -X POST "http://localhost:3456/click?target=$T" -d 'a[data-testid="deep-research-sidebar-item"]'
sleep 3
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d '#prompt-textarea'
sleep 1
# 清空旧文本
curl -s -X POST "http://localhost:3456/press?target=$T" -d 'Meta+a'
sleep 0.5
curl -s -X POST "http://localhost:3456/press?target=$T" -d 'Backspace'
sleep 1
curl -s -X POST "http://localhost:3456/type?target=$T" -d '<查询>'
sleep 2
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d 'button[data-testid="send-button"]'

# P0: 等待 DR iframe 出现且高度增长（说明内容已加载）
curl -s "http://localhost:3456/waitReady?target=$T&check=...iframe高度>200...&interval=10&timeout=300"

# 使用 /evalFrame 读取跨域 iframe 内容
curl -s -X POST "http://localhost:3456/evalFrame?target=$T&frameSrc=deep_research" \
  -d 'document.body.innerText'

# 提取 iframe 中的链接
curl -s -X POST "http://localhost:3456/evalFrame?target=$T&frameSrc=deep_research" \
  -d 'JSON.stringify(Array.from(document.querySelectorAll("a[href]")).map(a=>({text:a.textContent.trim().slice(0,80),href:a.href})))'

curl -s "http://localhost:3456/close?target=$T"
```

### Perplexity（perplexity.ai）

| 项目 | 首选选择器 | 降级选择器 |
|------|-----------|-----------|
| 编辑器 | `#ask-input` | `textarea`, `[contenteditable]`, `[role="textbox"]` |
| 提交按钮 | `button[aria-label="Submit"]` | `[role="button"]` 含"Submit", `form button[type="submit"]` |
| 响应容器 | `div.prose`（最后一个） | `[role="article"]` |

**操作流程**：
```bash
T=$(curl -s "http://localhost:3456/new?url=https://www.perplexity.ai" | python3 -c "import sys,json;print(json.load(sys.stdin)['targetId'])")
sleep 5
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d 'document.querySelectorAll("button[aria-label=Dismiss]").forEach(b=>b.click())'
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d '#ask-input'
curl -s -X POST "http://localhost:3456/type?target=$T" -d '<查询>'
curl -s -X POST "http://localhost:3456/clickAt?target=$T" -d 'button[aria-label="Submit"]'

# P0: 轮询等待
curl -s "http://localhost:3456/waitReady?target=$T&check=document.querySelectorAll('div.prose').length>0%26%26document.querySelectorAll('div.prose')[document.querySelectorAll('div.prose').length-1].innerText.length>100&interval=5&timeout=120"

curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d 'document.querySelectorAll("div.prose")[document.querySelectorAll("div.prose").length-1].innerText'
# Perplexity 引用链接不在 <a> 标签中，需从 HTML 正则提取外部 URL
curl -s -X POST "http://localhost:3456/eval?target=$T" \
  -d 'JSON.stringify((document.body.innerHTML.match(/https?:\/\/[^\s"<]+/g)||[]).filter(u=>!u.includes("perplexity.ai")&&!u.includes("w3.org")&&!u.includes("cloudflare")).slice(0,20))'
curl -s "http://localhost:3456/close?target=$T"
```

---

## 五、完整工作流

### Step 1: 解析意图

从用户输入中提取：搜索目标、事件类型、时间范围、地理范围、输出语言、搜索关键词。

#### 查询模板（强制日期约束）

将用户查询转换为平台搜索查询时，**必须**附加：

```
CRITICAL DATE FILTER: Only include events whose ACTUAL OCCURRENCE DATE is within [用户指定时间段].
Do NOT include events that happened before [起始日期], even if their effects continued into the period.

关键日期过滤：只包含事件实际发生时间在 [用户指定时间段] 内的事件。
不要包含 [起始日期] 之前发生但影响延续到该期间的事件。
```

向用户确认解析结果后再继续。

#### 敏感内容防护（API 1301 错误）

当 API 返回 **HTTP 400 + code 1301**（内容审核拦截）时，说明查询或生成内容触发了安全过滤。按以下策略处理：

**触发时机**：可能在以下环节遇到——
- 向 AI 平台发送查询时（平台自身审核）
- CDP Proxy 读取平台响应内容时（本地 API 代理审核）
- 最终生成报告时（本地 API 代理审核）

**处理流程**：

```
检测到 1301 错误
    │
    ├─ 发生在「单平台采集」阶段
    │   → 记录该平台为「⚠️ 敏感内容拦截，已跳过」
    │   → 继续其余平台采集
    │   → 该平台的事件从最终报告中排除
    │
    ├─ 发生在「链接验证」阶段
    │   → 跳过当前链接，标记「⚠️ 内容审核拦截，未验证」
    │   → 继续验证下一条链接
    │
    ├─ 发生在「最终报告生成」阶段
    │   → 尝试拆分报告为多个小节逐段输出
    │   → 识别触发拦截的具体段落，删除后重新生成
    │   → 在报告末尾标注「部分内容因安全审核已省略」
    │
    └─ 所有平台均被拦截
        → 输出降级报告：仅包含已成功采集的部分
        → 标注「大部分内容因安全审核被拦截，建议调整查询范围」
```

**查询降级策略** — 如果原始查询触发拦截，自动尝试以下降级查询：

1. **缩小范围**：将全球范围缩小到具体区域（如东南亚、非洲等）
2. **去敏化**：移除"绑架""袭击"等高风险关键词，改用"安全事件""风险提示"
3. **拆分查询**：将综合查询拆分为多个子查询分别执行（按区域/按类型）
4. **切换语言**：用英文查询替代中文查询

降级查询模板：

```
# 原始查询（可能触发拦截）
查找过去一周涉及中国海外利益的安全事件

# 降级查询 1（去敏化）
查找 2026-04-22 至 2026-04-29 期间与中国海外项目相关的风险提示和旅行建议

# 降级查询 2（缩小范围）
查找 2026-04-22 至 2026-04-29 期间东南亚地区涉及中资企业的商业环境变化

# 降级查询 3（英文）
Find safety alerts, policy changes, and risk updates affecting Chinese overseas interests from April 22-29, 2026
```

**关键原则**：宁可降级查询也不中断整个流程。任何被拦截的内容都要在报告中留下记录（「此处因安全审核已省略」），保持报告完整性。

### Step 2: 多平台采集

对 Gemini(DR)、ChatGPT(DR)、Perplexity 三平台并行采集。

> ⚠️ Grok 平台已禁用，不参与采集。

**P3: 并行限流** — 分两批执行，避免同时操作多个 tab 导致 Chrome 资源不足：
- **第一批**：Perplexity（常规搜索，30-60 秒完成）
- **第二批**（并行）：Gemini(DR) + ChatGPT(DR)（Deep Research，2-5 分钟完成）

如果某个平台失败，跳过并记录错误，用其余平台继续。

### 已禁用平台

| 平台 | 状态 | 原因 |
|------|------|------|
| Grok | ❌ 已禁用 | 无法正常使用 |

**任务开始前**调用 `/cleanup` 清理残留 tab。**任务结束后**关闭所有创建的 tab。

### Step 3: 日期硬过滤

对每条事件严格判断实际发生日期是否在用户指定范围内。

**不得包含**：影响延续类、之前签署类、长期趋势类事件。
**宁可漏报，不可误报**。

### Step 4: 交叉比对与分级（四源交叉）

> Grok 已禁用，当前信息源为 Gemini、ChatGPT、Perplexity、Google 四个。

| 级别 | 条件 | 标签 |
|------|------|------|
| A | 任意 3 个及以上平台报告 | `已验证` |
| B | 任意 2 个平台报告 | `待验证` |
| C | 仅 1 个平台报告 | `需重点核查` |

### Step 5: Google 搜索验证（第五信息源）

对所有保留的事件，用 Google 搜索交叉验证：

```bash
dokobot doko read 'https://www.google.com/search?q=<事件关键词+日期>&hl=zh-CN&tbs=qdr:m' --local --timeout 30
dokobot doko read 'https://www.google.com/search?q=<事件关键词+日期>&tbm=nws&hl=zh-CN&tbs=qdr:m' --local --timeout 30
```

Google 搜索**找不到**的事件标记 `仅 AI 平台报告，Google 未检索到`。

### Step 6: 逐条打开链接验证

> 防止 AI 幻觉的最后一道防线。

对所有平台返回的参考链接（**先去重，同一 URL 只验证一次**），逐条执行：

```bash
dokobot doko read '<URL>' --local --timeout 30
```

**P2: 并发控制** — 分批验证，最多 3 个同时读取。总超时 5 分钟，超时后标记剩余为 `未验证`。

验证四维度：链接有效性、内容匹配、日期匹配、时间范围。

判定标签：`✅ 信源已验证` / `⚠️ 内容偏差` / `⚠️ 日期偏差` / `❌ 链接失效` / `⚠️ 无信源支持`

### Step 7: 输出结构化报告

保存到 `01-收集箱/` 目录（如不存在会自动创建）。文件名格式：`情报扫描 YYYY-MM-DD.md`。模板见原报告格式。

---

## 六、重要规则

1. **绝不假设发布日期 = 事件日期**
2. **所有事件必须有验证状态标签**
3. **区分事实与推断**
4. **优先中文来源**
5. **日期必须精确**
6. **语义去重**
7. **幻觉标记**
8. **输出全中文**
9. **搜索并行执行**
10. **日期过滤是硬约束**：宁可漏报，不可误报
11. **每条链接必须实际打开验证**
12. **Gemini 和 ChatGPT 强制使用 Deep Research**
13. **任务开始前 `/cleanup`，结束后关闭所有 tab**
14. **`/waitReady` 轮询替代盲 `sleep`**
15. **选择器失效时降级或截图分析**
16. **ChatGPT Deep Research 响应在跨域 iframe 中，必须用 `/evalFrame`**
17. **ChatGPT 编辑器可能残留旧文本，提交前必须清空**
18. **Gemini Deep Research 需要手动点击"开始研究"确认方案**
19. **API 1301 敏感内容拦截时跳过当前步骤继续执行，不中断整个流程**
20. **所有被拦截的内容必须在报告中留痕（标注「因安全审核已省略」）**

---

## 七、每日定时触发

### 配置

编辑 `scripts/daily-scan.sh` 中的 `DEFAULT_QUERY`。

### 手动触发

```bash
bash ${CLAUDE_SKILL_DIR}/scripts/daily-scan.sh
```

### cron 定时触发

```bash
crontab -e
# 每天早上 8:00 执行（替换 YOUR_VAULT_PATH 为实际 vault 路径）
0 8 * * * bash YOUR_VAULT_PATH/.claude/skills/geo-sentinel/scripts/daily-scan.sh >> /tmp/geo-sentinel/cron.log 2>&1
```

---

## 八、错误处理

| 错误场景 | 处理方式 |
|----------|----------|
| CDP Proxy 无法连接 | 重新运行 check-deps.sh |
| 平台页面加载失败 | 重试 1 次；仍失败则跳过该平台 |
| Deep Research 超时 | `/waitReady` 返回 `timedOut: true`，收集已有内容标注"响应不完整" |
| 选择器失效 | 降级选择器 → 截图分析 → 更新站点经验 |
| 登录要求 | 提示用户在 Chrome 中登录 |
| CAPTCHA | 保留页面，提示用户手动处理 |
| 链接失效 | 标记 `❌ 链接失效` |
| dokobot 失败 | 回退到 defuddle 或 curl |
| Tab 泄漏 | `/cleanup` 端点 + 进程退出自动清理 |
| 全流程超时 | 15 分钟总超时，输出已完成的部分结果 |
| API 1301 敏感内容拦截（单平台） | 记录拦截，跳过该平台，继续其余平台采集 |
| API 1301 敏感内容拦截（链接验证） | 跳过当前链接，标记 `⚠️ 内容审核拦截，未验证`，继续下一条 |
| API 1301 敏感内容拦截（报告生成） | 拆分段落逐段输出，删除触发拦截的段落，标注「部分内容因安全审核已省略」 |
| API 1301 所有平台均被拦截 | 执行查询降级策略（去敏化/拆分/切换语言/缩小范围），输出降级报告 |

---

## 九、站点经验索引

| 文件 | 平台 |
|------|------|
| ~~`references/site-patterns/grok.com.md`~~ | ~~Grok~~（已禁用） |
| `references/site-patterns/gemini.google.com.md` | Gemini |
| `references/site-patterns/chatgpt.com.md` | ChatGPT |
| `references/site-patterns/perplexity.ai.md` | Perplexity |

CDP 操作完成后，如发现新的平台特征或操作模式，主动写入对应的站点经验文件。

---

## 十、P3: 增量报告与中间状态持久化

如果采集到一半失败，中间结果保存到 `/tmp/geo-sentinel/partial-<timestamp>.json`：

```json
{
  "query": "原始查询",
  "timestamp": "2026-04-08T10:00:00",
  "platforms": {
    "grok": {"status": "complete", "events": [...]},
    "gemini": {"status": "timeout", "events": [...]},
    "chatgpt": {"status": "pending", "events": []},
    "perplexity": {"status": "pending", "events": []}
  }
}
```

下次重跑时检查是否有部分结果可复用。
