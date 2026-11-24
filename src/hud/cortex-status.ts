/**
 * 官方 Antigravity (2.34.0) CortexStepStatus 单一真源枚举与状态判定集合。
 * 核验来源：vendor/antigravity/2.34.0/main.js ->
 *   CortexStepStatus={UNSPECIFIED:0,GENERATING:8,QUEUED:11,PENDING:1,RUNNING:2,WAITING:9,DONE:3,INVALID:4,CLEARED:5,CANCELED:6,ERROR:7,INTERRUPTED:12}
 */
export const CORTEX_STEP_STATUS = {
  UNSPECIFIED: 0,
  PENDING: 1,
  RUNNING: 2,
  DONE: 3,
  INVALID: 4,
  CLEARED: 5,
  CANCELED: 6,
  ERROR: 7,
  GENERATING: 8,
  WAITING: 9,
  QUEUED: 11,
  INTERRUPTED: 12,
} as const;

export type CortexStepStatusNumeric =
  (typeof CORTEX_STEP_STATUS)[keyof typeof CORTEX_STEP_STATUS];

export const KNOWN_CORTEX_STEP_STATUSES = new Set<number>(
  Object.values(CORTEX_STEP_STATUS)
);

/** 处于活动生命周期中的步骤状态（含等待用户确认 WAITING=9 与排队 QUEUED=11）。 */
export const ACTIVE_STEP_STATUSES = new Set<number>([
  CORTEX_STEP_STATUS.PENDING,
  CORTEX_STEP_STATUS.RUNNING,
  CORTEX_STEP_STATUS.GENERATING,
  CORTEX_STEP_STATUS.WAITING,
  CORTEX_STEP_STATUS.QUEUED,
]);

/** 子智能体正在运行中的步骤状态（排除 WAITING=9 避免等待审批误判为活跃执行）。 */
export const RUNNING_SUBAGENT_STEP_STATUSES = new Set<number>([
  CORTEX_STEP_STATUS.PENDING,
  CORTEX_STEP_STATUS.RUNNING,
  CORTEX_STEP_STATUS.GENERATING,
  CORTEX_STEP_STATUS.QUEUED,
]);

/** 明确中止/失败/中断的终态集合。 */
export const TERMINAL_ABORTED_STEP_STATUSES = new Set<number>([
  CORTEX_STEP_STATUS.INVALID,
  CORTEX_STEP_STATUS.CANCELED,
  CORTEX_STEP_STATUS.ERROR,
  CORTEX_STEP_STATUS.INTERRUPTED,
]);

/** 明确不再活跃的所有终态（正常完成、清除或中止/中断）。 */
export const TERMINAL_INACTIVE_STEP_STATUSES = new Set<number>([
  CORTEX_STEP_STATUS.DONE,
  CORTEX_STEP_STATUS.INVALID,
  CORTEX_STEP_STATUS.CLEARED,
  CORTEX_STEP_STATUS.CANCELED,
  CORTEX_STEP_STATUS.ERROR,
  CORTEX_STEP_STATUS.INTERRUPTED,
]);

/**
 * 将 CortexStepStatus 枚举字符串或数字归一化为内部数值 status。
 * 未知枚举值显式降级为 UNSPECIFIED (0)，绝不静默伪装为 DONE (3) 或活跃态。
 */
export function mapCortexStepStatusToNumeric(rawStatus: unknown): number {
  if (typeof rawStatus === 'number') {
    return Number.isSafeInteger(rawStatus) && KNOWN_CORTEX_STEP_STATUSES.has(rawStatus)
      ? rawStatus
      : CORTEX_STEP_STATUS.UNSPECIFIED;
  }
  if (typeof rawStatus !== 'string') {
    return CORTEX_STEP_STATUS.UNSPECIFIED;
  }
  const trimmed = rawStatus.trim();
  if (/^\d+$/.test(trimmed)) {
    const num = Number(trimmed);
    return Number.isSafeInteger(num) && KNOWN_CORTEX_STEP_STATUSES.has(num)
      ? num
      : CORTEX_STEP_STATUS.UNSPECIFIED;
  }
  const cleaned = trimmed.toUpperCase().replace(/^CORTEX_STEP_STATUS_/, '');
  switch (cleaned) {
    case 'UNSPECIFIED':
      return CORTEX_STEP_STATUS.UNSPECIFIED;
    case 'PENDING':
      return CORTEX_STEP_STATUS.PENDING;
    case 'RUNNING':
      return CORTEX_STEP_STATUS.RUNNING;
    case 'DONE':
    case 'COMPLETED':
      return CORTEX_STEP_STATUS.DONE;
    case 'INVALID':
      return CORTEX_STEP_STATUS.INVALID;
    case 'CLEARED':
      return CORTEX_STEP_STATUS.CLEARED;
    case 'CANCELED':
    case 'CANCELLED':
    case 'REJECTED':
      return CORTEX_STEP_STATUS.CANCELED;
    case 'ERROR':
    case 'FAILED':
      return CORTEX_STEP_STATUS.ERROR;
    case 'GENERATING':
    case 'STREAMING':
      return CORTEX_STEP_STATUS.GENERATING;
    case 'WAITING':
    case 'WAITING_FOR_USER':
    case 'WAITING_FOR_APPROVAL':
      return CORTEX_STEP_STATUS.WAITING;
    case 'QUEUED':
      return CORTEX_STEP_STATUS.QUEUED;
    case 'INTERRUPTED':
      return CORTEX_STEP_STATUS.INTERRUPTED;
    default:
      return CORTEX_STEP_STATUS.UNSPECIFIED;
  }
}
