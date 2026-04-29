#!/usr/bin/env bash
# Geo Sentinel 每日定时触发脚本
# 用法: bash daily-scan.sh [自定义查询]
# 如果不传参数，使用 DEFAULT_QUERY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VAULT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
SKILL_DIR="$VAULT_DIR/.claude/skills/geo-sentinel"
LOG_DIR="/tmp/geo-sentinel"
LOCK_FILE="$LOG_DIR/daily-scan.lock"
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR" 2>/dev/null || true

# 并发锁：防止 cron 重叠执行
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "[$(date '+%Y-%m-%d %H:%M')] 另一个扫描实例正在运行，跳过" >> "$LOG_DIR/cron.log"
  exit 0
fi
# 异常退出时释放锁
trap 'flock -u 9' EXIT INT TERM

# 默认每日查询（可修改）
DEFAULT_QUERY="查找过去24小时内发生的可能影响中国海外利益的安全事件、政治变动、经济变化。时间范围：过去24小时。地理范围：全球。"

QUERY="${1:-$DEFAULT_QUERY}"
LOG_FILE="$LOG_DIR/scan-$(date '+%Y%m%d-%H%M%S').log"

echo "=== Geo Sentinel Daily $(date '+%Y-%m-%d %H:%M') ===" | tee "$LOG_FILE"
echo "查询: $QUERY" | tee -a "$LOG_FILE"
echo "" | tee -a "$LOG_FILE"

cd "$VAULT_DIR"

# 安全传参 — 通过环境变量传递查询，避免 shell 展开
export GEO_SENTINEL_QUERY="$QUERY"
MAX_RETRIES=3
RETRY_DELAY=60
ATTEMPT=0
# 敏感内容拦截计数（连续 3 次 1301 则放弃）
SENSITIVE_COUNT=0
MAX_SENSITIVE=3

while [ $ATTEMPT -lt $MAX_RETRIES ]; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "尝试 $ATTEMPT/$MAX_RETRIES..." | tee -a "$LOG_FILE"

  OUTPUT=$(claude -p "/geo-sentinel \${GEO_SENTINEL_QUERY}" 2>&1)
  EXIT_CODE=$?
  echo "$OUTPUT" | tee -a "$LOG_FILE"

  if [ "$EXIT_CODE" -eq 0 ]; then
    echo "成功完成（尝试 $ATTEMPT）" | tee -a "$LOG_FILE"
    break
  fi

  # 检测 API 1301 敏感内容错误
  if echo "$OUTPUT" | grep -q '"code":"1301"\|"code": 1301\|不安全或敏感内容'; then
    SENSITIVE_COUNT=$((SENSITIVE_COUNT + 1))
    echo "⚠️  API 1301 敏感内容拦截（第 $SENSITIVE_COUNT 次）" | tee -a "$LOG_FILE"

    if [ "$SENSITIVE_COUNT" -ge "$MAX_SENSITIVE" ]; then
      echo "❌ 连续 $MAX_SENSITIVE 次触发敏感内容拦截，放弃本次查询" | tee -a "$LOG_FILE"
      break
    fi

    # 降级查询：尝试去敏化版本
    if [ $SENSITIVE_COUNT -eq 1 ]; then
      echo "→ 降级策略 1：使用去敏化查询" | tee -a "$LOG_FILE"
      export GEO_SENTINEL_QUERY="查找 $(date -v-7d '+%Y-%m-%d' 2>/dev/null || date -d '7 days ago' '+%Y-%m-%d') 至 $(date '+%Y-%m-%d') 期间与中国海外项目相关的风险提示和旅行建议"
    elif [ $SENSITIVE_COUNT -eq 2 ]; then
      echo "→ 降级策略 2：使用英文查询" | tee -a "$LOG_FILE"
      export GEO_SENTINEL_QUERY="Find safety alerts, policy changes, and risk updates affecting Chinese overseas interests from the past week"
    fi
  else
    # 非 1301 错误，正常重试
    SENSITIVE_COUNT=0
    if [ $ATTEMPT -lt $MAX_RETRIES ]; then
      echo "失败（退出码 $EXIT_CODE），${RETRY_DELAY} 秒后重试..." | tee -a "$LOG_FILE"
      sleep $RETRY_DELAY
    else
      echo "重试 $MAX_RETRIES 次后仍失败（退出码 $EXIT_CODE）" | tee -a "$LOG_FILE"
    fi
  fi
done

echo "" | tee -a "$LOG_FILE"
echo "=== 完成 $(date '+%Y-%m-%d %H:%M') 退出码: ${EXIT_CODE:-0} ===" | tee -a "$LOG_FILE"

# 清理超过 30 天的日志
find "$LOG_DIR" -name "scan-*.log" -mtime +30 -delete 2>/dev/null || true
