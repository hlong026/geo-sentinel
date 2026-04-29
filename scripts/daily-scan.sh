#!/usr/bin/env bash
# Geo Sentinel 每日定时触发脚本
# 用法: bash daily-scan.sh [自定义查询]
# 如果不传参数，使用 DEFAULT_QUERY
# P1: 安全修复 — 查询通过 stdin 传递，避免 shell 注入

set -euo pipefail

VAULT_DIR="/Users/honor.pei/Obsidian/mind"
SKILL_DIR="$VAULT_DIR/.claude/skills/geo-sentinel"
LOG_DIR="/tmp/geo-sentinel"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true # P3: 限制日志目录权限

# 默认每日查询（可修改）
DEFAULT_QUERY="查找过去24小时内发生的可能影响中国海外利益的安全事件、政治变动、经济变化。时间范围：过去24小时。地理范围：全球。"

QUERY="${1:-$DEFAULT_QUERY}"
LOG_FILE="$LOG_DIR/scan-$(date '+%Y%m%d-%H%M%S').log"

echo "=== Geo Sentinel Daily $(date '+%Y-%m-%d %H:%M') ===" | tee "$LOG_FILE"
echo "查询: $QUERY" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

cd "$VAULT_DIR"

# P1: 安全传参 — 通过 heredoc 传递，避免 shell 特殊字符注入
# P2: 结构化日志 — 输出到带日期的日志文件
# P1: 自动重试（最多 3 次，间隔 60 秒）
MAX_RETRIES=3
RETRY_DELAY=60
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_RETRIES ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "尝试 $ATTEMPT/$MAX_RETRIES..." | tee -a "$LOG_FILE"

  claude -p "$(cat <<PROMPT
/geo-sentinel ${QUERY}
PROMPT
  )" 2>&1 | tee -a "$LOG_FILE"

  EXIT_CODE=${PIPESTATUS[0]:-0}

  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "成功完成（尝试 $ATTEMPT）" | tee -a "$LOG_FILE"
    break
  fi

  if [ $ATTEMPT -lt $MAX_RETRIES ]; then
    echo "失败（退出码 $EXIT_CODE），${RETRY_DELAY} 秒后重试..." | tee -a "$LOG_FILE"
    sleep $RETRY_DELAY
  else
    echo "重试 $MAX_RETRIES 次后仍失败（退出码 $EXIT_CODE）" | tee -a "$LOG_FILE"
  fi
done

echo "" | tee -a "$LOG_FILE"
echo "=== 完成 $(date '+%Y-%m-%d %H:%M') 退出码: ${EXIT_CODE:-0} ===" | tee -a "$LOG_FILE"

# P2: 清理超过 30 天的日志
find "$LOG_DIR" -name "scan-*.log" -mtime +30 -delete 2>/dev/null || true
