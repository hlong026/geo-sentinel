---
domain: chatgpt.com
aliases: [ChatGPT, GPT]
updated: 2026-04-08
---
## 平台特征
- Next.js + React 应用，使用 ProseMirror 编辑器
- Deep Research 是侧边栏独立入口，不是模型选择器中的选项
- Deep Research 响应时间 5-10 分钟（比 Gemini 更久）
- **⚠️ Deep Research 响应渲染在跨域 iframe 中**（2026-04-08 发现）

## 有效模式
- **Deep Research 激活**: 点击侧边栏 `a[data-testid="deep-research-sidebar-item"]`
- **输入**: `/clickAt #prompt-textarea` + 清空旧文本（Meta+A → Backspace） + `/type`
- **提交**: `/clickAt button[data-testid="send-button"]`
- **响应提取**: `/evalFrame?frameSrc=deep_research`（**必须**用 evalFrame，不能用 /eval）
- **链接提取**: `/evalFrame?frameSrc=deep_research` + `document.querySelectorAll("a[href]")`

## 已知陷阱
- **跨域 iframe 隔离**：DR 响应在 `connector_openai_deep_research.web-sandbox.oaiusercontent.com` 的 iframe 中
  - `/eval` 只读到 `"ChatGPT said:"` + 空，**不是响应内容为空**
  - 必须用 `/evalFrame?frameSrc=deep_research` 读取
  - Chrome `/json` 端点可以看到 type=iframe 的 target
- 编辑器可能残留旧查询文本，提交前必须 Meta+A → Backspace 清空
- 普通模式（非 Deep Research）信息密度低
- Free 账户有使用次数限制，超限后 DR 无法执行
- 历史对话列表可能很长，需要滚动才能看到侧边栏底部
