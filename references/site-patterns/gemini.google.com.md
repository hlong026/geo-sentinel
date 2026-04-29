---
domain: gemini.google.com
aliases: [Gemini, Google Gemini]
updated: 2026-04-08
---
## 平台特征
- Angular 应用，输入区域为 Quill 编辑器 contenteditable div
- Deep Research 需要从工具抽屉激活，不是模型选择器
- Deep Research 响应时间 2-5 分钟
- 可能进入"双回答对比"模式（选项 A / 选项 B）

## 有效模式
- **Deep Research 激活**: 点击 `button.toolbox-drawer-button` → 点击包含 "Deep Research" 文本的 `.mat-mdc-list-item`
- **输入**: `/clickAt .ql-editor.textarea` + `/type`
- **提交**: `/clickAt button[aria-label="发送"]`
- **响应提取**: `document.body.innerText`（全文）
- **导航**: `/navigate` 到 `https://gemini.google.com/app` 开始新对话

## 已知陷阱
- Deep Research 响应非常慢（2-5分钟），需要 sleep 120+
- 不提供可追溯的参考链接（2026-04-07 验证）
- 可能进入双回答对比模式，需要从全文中提取两个回答
- "工具"按钮的 aria-label 可能为空，需要用 class 选择器 `button.toolbox-drawer-button`
