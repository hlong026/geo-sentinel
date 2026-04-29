---
domain: perplexity.ai
aliases: [Perplexity]
updated: 2026-04-08
---
## 平台特征
- React 应用，输入区域为 contenteditable div
- 首页可能有弹窗推荐（Deep Research、Computer 等），需要点击 Dismiss 关闭
- 提交按钮在输入文字后才出现
- **引用不是 `<a>` 标签**，而是自定义 `span.citation` 组件，链接嵌入在 HTML 中

## 有效模式
- **输入**: `/clickAt #ask-input` + `/type`
- **提交**: `/clickAt button[aria-label="Submit"]`
- **响应提取**: `div.prose`（最后一个）
- **链接提取**: 正则匹配 `document.body.innerHTML` 中的外部 URL
  ```js
  const urls = (document.body.innerHTML.match(/https?:\/\/[^\s"<]+/g) || [])
    .filter(u => !u.includes("perplexity.ai") && !u.includes("w3.org") && !u.includes("cloudflare"))
  ```
- **弹窗关闭**: `button[aria-label="Dismiss"]`

## 已知陷阱
- 首次打开可能有 3 个推荐弹窗，需要连续点击 Dismiss
- Free 账户有使用次数限制
- **引用链接不在 `<a>` 标签中**，不能用 `querySelectorAll("a[href]")` 提取（2026-04-08 验证）
- 引用用 `span.citation` 组件，URL 需从 HTML 正则提取
