---
domain: grok.com
aliases: [Grok, xAI]
updated: 2026-04-07
---
## 平台特征
- Next.js + React 应用，使用 Tiptap/ProseMirror 富文本编辑器（contenteditable div）
- textarea 是隐藏的辅助元素，实际输入在 `.tiptap.ProseMirror` 上
- React 受控组件模式：JS 层面设置 value 不会触发 React 状态更新
- 提交按钮 `button[aria-label="提交"]` 的 disabled 状态由 React 内部状态控制

## 有效模式
- **输入**: 必须使用 CDP `Input.insertText`（`/type` 端点），不能用 JS `execCommand` 或 `nativeInputValueSetter`
- **聚焦**: 必须使用 `/clickAt`（CDP 级鼠标事件）聚焦编辑器，不能用 `/click`（JS 层 el.click()）
- **提交**: `/clickAt` 点击 `button[aria-label="提交"]`
- **完整流程**: `/clickAt .tiptap.ProseMirror` → `/type 文本` → `/clickAt button[aria-label="提交"]`
- **清空**: `/type?clear=true` 先 Meta+A 全选再 Backspace 删除

## 已知陷阱
- `document.execCommand('insertText')` 不起作用（2026-04-07 验证）
- `nativeInputValueSetter` 设置 textarea.value 不触发 React 状态（2026-04-07 验证）
- JS 层面 dispatchEvent 模拟 InputEvent/CompositionEvent 不起作用（2026-04-07 验证）
- `/click`（JS el.click()）不触发编辑器的浏览器级聚焦，必须用 `/clickAt`
