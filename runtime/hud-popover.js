/**
 * 向上展开 Popover 详情卡片全向防裁切与微指示三角圆角避障几何算法
 * 遵循 GRAVITYBOX-SPEC-HUD-001 第 3.5 节
 */

/**
 * 解析当前聊天分栏在视口中的无遮挡水平可见边界 [left, right]：
 * 当右侧打开编辑器、Diff、Artifact、浏览器视图或 Overview 侧栏导致聊天区缩窄时，
 * 防止常驻 HUD 条与向上弹出卡片向右穿透分栏分隔线被右侧窗口（z-index: 10 或原生 WebContentsView）覆盖。
 * @param {HTMLElement | null | undefined} anchorEl
 * @param {Window | { innerWidth?: number } | null} [winOverride]
 * @returns {{ left: number, right: number, viewportWidth: number }}
 */
export function resolveVisibleHorizontalBounds(anchorEl, winOverride = null) {
  const win =
    winOverride ||
    (typeof window !== 'undefined' ? window : globalThis.window) || {
      innerWidth: 1024,
      innerHeight: 768,
    };
  const viewportWidth = Number(win.innerWidth) || 1024;
  let left = 0;
  let right = viewportWidth;

  if (!anchorEl || typeof anchorEl.closest !== 'function') {
    return { left, right, viewportWidth };
  }

  const clampWithPane = (el, subtractPadding = false) => {
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const r = el.getBoundingClientRect();
    if (!r || !(r.width > 0)) return;
    let pLeft = r.left;
    let pRight = r.right;
    if (subtractPadding && typeof win.getComputedStyle === 'function') {
      try {
        const cs = win.getComputedStyle(el);
        const padL = parseFloat(cs?.paddingLeft || '0') || 0;
        const padR = parseFloat(cs?.paddingRight || '0') || 0;
        if (r.width - padL - padR >= 80) {
          pLeft += padL;
          pRight -= padR;
        }
      } catch {}
    }
    left = Math.max(left, pLeft);
    right = Math.min(right, pRight);
  };

  const convView = anchorEl.closest(
    '[data-testid="conversation-view"], [data-media-drop-scope="subpane"], [data-testid="subagent-tab-conversation"], [data-testid="side-question-tab-conversation"], [data-testid="side-question-tab-content"]'
  );
  if (convView) {
    clampWithPane(convView, false);
  }
  const overviewHost = anchorEl.closest('[data-testid="overview-panel-host"]');
  if (overviewHost) {
    clampWithPane(overviewHost, true);
  }

  // 遍历外层分栏容器 ([data-split-root="true"])：夹紧到所属分栏槽位，并以右侧分栏/分隔条左边缘为硬上界
  let splitCursor = anchorEl.closest('[data-split-root="true"]');
  let guard = 0;
  while (splitCursor && guard++ < 6) {
    const children = splitCursor.children ? [...splitCursor.children] : [];
    const slotIndex = children.findIndex((child) =>
      typeof child?.contains === 'function' ? child.contains(anchorEl) : false
    );
    if (slotIndex >= 0) {
      const mySlot = children[slotIndex];
      clampWithPane(mySlot, false);
      const myRect = typeof mySlot.getBoundingClientRect === 'function' ? mySlot.getBoundingClientRect() : null;
      for (let i = slotIndex + 1; i < children.length; i++) {
        const sib = children[i];
        if (!sib || typeof sib.getBoundingClientRect !== 'function') continue;
        if (typeof win.getComputedStyle === 'function') {
          try {
            const cs = win.getComputedStyle(sib);
            if (cs?.display === 'none' || cs?.visibility === 'hidden') continue;
          } catch {}
        }
        const sibRect = sib.getBoundingClientRect();
        if (!sibRect || !(sibRect.width > 0) || !(sibRect.height > 40)) continue;
        // 仅针对横向并排右侧窗格夹紧（排除上下堆叠布局）
        const minHorizontalSpan = myRect ? myRect.left + 80 : left + 80;
        if (sibRect.left >= minHorizontalSpan && sibRect.left < right) {
          right = Math.min(right, sibRect.left);
        }
      }
    }
    splitCursor = splitCursor.parentElement?.closest?.('[data-split-root="true"]') || null;
  }

  if (!(right > left)) {
    return { left: 0, right: viewportWidth, viewportWidth };
  }
  return {
    left: Math.max(0, left),
    right: Math.min(viewportWidth, right),
    viewportWidth,
  };
}

/**
 * 计算向上弹出 Popover 的绝对屏幕坐标，实现水平与垂直全向视口防裁切及小三角圆角避障
 * @param {HTMLElement} capsuleEl 触发胶囊 DOM 元素
 * @param {number} popoverWidth Popover 卡片标准宽度 (px)
 * @param {number} [popoverHeight=190] Popover 卡片预估或实测高度 (默认 190px)
 * @param {number} [safeMargin=12] 距离视口四周边缘的安全留白 (默认 12px)
 * @param {number} [verticalGap=8] 胶囊顶边与 Popover 底边的垂直间隙 (默认 8px)
 * @param {number} [borderRadius=12] Popover 卡片圆角半径 (默认 12px)
 */
export function computeUpwardPopoverPosition(
  capsuleEl,
  popoverWidth,
  popoverHeight = 190,
  safeMargin = 12,
  verticalGap = 8,
  borderRadius = 12
) {
  const rect = capsuleEl.getBoundingClientRect();
  const win = typeof window !== 'undefined' ? window : globalThis.window || { innerWidth: 1024, innerHeight: 768 };
  const bounds = resolveVisibleHorizontalBounds(capsuleEl, win);
  const viewportHeight = Number(win.innerHeight) || 768;

  // 1. 动态有效宽度计算：当分栏或视口可用宽度不足容纳标准卡片与双向留白时，平滑收缩卡片有效宽度
  const rawSpanWidth = bounds.right - bounds.left;
  const effectiveMargin = rawSpanWidth < 180 ? Math.max(4, Math.min(safeMargin, Math.floor((rawSpanWidth - 120) / 2))) : safeMargin;
  const availablePaneWidth = rawSpanWidth - 2 * effectiveMargin;
  const effectivePopoverWidth = Math.max(120, Math.min(popoverWidth, availablePaneWidth));

  // 2. 胶囊在可见分栏中的水平中心（若胶囊自身右侧已被窄栏裁剪，则取可见交集中心）
  const visibleCapsuleLeft = Math.max(rect.left, bounds.left);
  const visibleCapsuleRight = Math.min(rect.right, bounds.right);
  const capsuleCenterX =
    visibleCapsuleRight > visibleCapsuleLeft
      ? (visibleCapsuleLeft + visibleCapsuleRight) / 2
      : Math.max(bounds.left, Math.min(rect.left + rect.width / 2, bounds.right));

  // 3. 理想水平坐标 (Popover 中心与胶囊中心对齐)
  const idealLeft = capsuleCenterX - effectivePopoverWidth / 2;

  // 4. 水平边界夹紧约束 (Clamping)，确保左右边缘严格不穿出当前聊天分栏与视口（避免被右侧窗口覆盖）
  const minLeft = bounds.left + effectiveMargin;
  const maxLeft = Math.max(minLeft, bounds.right - effectivePopoverWidth - effectiveMargin);
  const clampedLeft = Math.max(minLeft, Math.min(idealLeft, maxLeft));

  // 5. 向上/向下垂直坐标与顶部防裁切检查：当上方空间不足容纳最小卡片且下方空间更充裕时自动向下翻转
  const topAvailableSpace = rect.top - verticalGap;
  const bottomAvailableSpace = viewportHeight - rect.bottom - verticalGap;
  const direction =
    topAvailableSpace - safeMargin < popoverHeight && bottomAvailableSpace > topAvailableSpace
      ? 'down'
      : 'up';
  const bottom = Math.round(viewportHeight - rect.top + verticalGap);
  const top = Math.round(rect.bottom + verticalGap);
  const maxAllowedHeight =
    direction === 'down'
      ? Math.max(100, bottomAvailableSpace - safeMargin)
      : Math.max(100, topAvailableSpace - safeMargin);

  // 7. 指示小三角平直底边避障计算 (小三角半宽 7px, 圆角半径 borderRadius)
  const minArrow = borderRadius + 7; // 12 + 7 = 19px
  const maxArrow = Math.max(minArrow, effectivePopoverWidth - borderRadius - 7); // effectiveWidth - 19px
  const rawArrowPixel = capsuleCenterX - clampedLeft;
  const clampedArrowPixel = Math.max(minArrow, Math.min(rawArrowPixel, maxArrow));
  const arrowOffsetPercent = Number(((clampedArrowPixel / effectivePopoverWidth) * 100).toFixed(1));

  // 8. 判定对齐模式
  let alignment = 'center';
  if (clampedLeft === minLeft) {
    alignment = 'clamped-left';
  } else if (clampedLeft === maxLeft) {
    alignment = 'clamped-right';
  }

  return {
    left: Math.round(clampedLeft),
    bottom: Math.round(bottom),
    top: Math.round(top),
    direction,
    width: Math.round(effectivePopoverWidth),
    maxHeight: Math.round(maxAllowedHeight),
    arrowOffsetPercent,
    arrowPixelOffset: Math.round(clampedArrowPixel),
    alignment,
  };
}

const POPOVER_GEOMETRY_CACHE = typeof WeakMap === 'function' ? new WeakMap() : null;

/**
 * 清除指定 Popover 的布局几何缓存（应在弹窗隐藏或重新打开时调用）
 * @param {HTMLElement} popoverEl
 */
export function resetPopoverGeometryCache(popoverEl) {
  if (popoverEl && POPOVER_GEOMETRY_CACHE) {
    POPOVER_GEOMETRY_CACHE.delete(popoverEl);
  }
}

/**
 * 应用 Popover 定位并执行包含块零偏置补偿（应对宿主祖先元素存在 transform / contain 的场景）
 * @param {HTMLElement} popoverEl Popover 外层元素
 * @param {HTMLElement | null} arrowEl 小三角指示元素
 * @param {ReturnType<typeof computeUpwardPopoverPosition>} pos 计算坐标
 * @param {{ force?: boolean }} [options]
 */
export function applyPopoverGeometry(popoverEl, arrowEl, pos, options = {}) {
  if (!popoverEl || !pos) return;
  const force = Boolean(options?.force);
  const prevCached = POPOVER_GEOMETRY_CACHE?.get(popoverEl);
  if (
    !force &&
    prevCached &&
    prevCached.width === pos.width &&
    prevCached.maxHeight === pos.maxHeight &&
    prevCached.direction === pos.direction &&
    Math.abs(prevCached.left - pos.left) <= 3 &&
    Math.abs((prevCached.top ?? 0) - (pos.top ?? 0)) <= 1 &&
    Math.abs((prevCached.bottom ?? 0) - (pos.bottom ?? 0)) <= 1 &&
    Math.abs(prevCached.arrowPixelOffset - pos.arrowPixelOffset) <= 3
  ) {
    return;
  }

  popoverEl.style.width = `${pos.width}px`;
  popoverEl.style.maxHeight = `${pos.maxHeight}px`;
  popoverEl.style.left = `${pos.left}px`;
  if (pos.direction === 'down' && typeof pos.top === 'number') {
    popoverEl.style.top = `${pos.top}px`;
    popoverEl.style.bottom = 'auto';
    popoverEl.classList?.add?.('is-downward');
  } else {
    popoverEl.style.bottom = `${pos.bottom}px`;
    popoverEl.style.top = 'auto';
    popoverEl.classList?.remove?.('is-downward');
  }

  if (arrowEl) {
    arrowEl.style.left = `${pos.arrowPixelOffset}px`;
  }

  // 包含块偏置校准：若宿主父级存在 transform/filter/contain 导致 fixed 相对非视口定位，立即补偿差值
  // 测量期间临时抑制自身入场动画 transform，杜绝 translateY(4px)/scale(0.985) 被误判为祖先包含块偏移
  if (typeof popoverEl.getBoundingClientRect === 'function') {
    const win = typeof window !== 'undefined' ? window : globalThis.window;
    const vh = Number(win?.innerHeight) || 0;
    if (vh > 0) {
      const prevTransform = popoverEl.style.transform || '';
      const prevTransition = popoverEl.style.transition || '';
      popoverEl.style.transition = 'none';
      popoverEl.style.transform = 'none';
      const actualRect = popoverEl.getBoundingClientRect();
      popoverEl.style.transform = prevTransform;
      popoverEl.style.transition = prevTransition;
      if (actualRect && (actualRect.width > 0 || actualRect.height > 0)) {
        const deltaX = actualRect.left - pos.left;
        if (pos.direction === 'down' && typeof pos.top === 'number') {
          const deltaY = actualRect.top - pos.top;
          if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
            popoverEl.style.left = `${Math.round(pos.left - deltaX)}px`;
            popoverEl.style.top = `${Math.round(pos.top - deltaY)}px`;
          }
        } else {
          const expectedBottomY = vh - pos.bottom;
          const deltaY = actualRect.bottom - expectedBottomY;
          if (Math.abs(deltaX) > 1 || Math.abs(deltaY) > 1) {
            popoverEl.style.left = `${Math.round(pos.left - deltaX)}px`;
            popoverEl.style.bottom = `${Math.round(pos.bottom + deltaY)}px`;
          }
        }
      }
    }
  }

  if (POPOVER_GEOMETRY_CACHE) {
    POPOVER_GEOMETRY_CACHE.set(popoverEl, {
      width: pos.width,
      maxHeight: pos.maxHeight,
      left: pos.left,
      top: pos.top,
      bottom: pos.bottom,
      direction: pos.direction,
      arrowPixelOffset: pos.arrowPixelOffset,
    });
  }
}

globalThis.__GRAVITYBOX_HUD_POPOVER__ = {
  resolveVisibleHorizontalBounds,
  computeUpwardPopoverPosition,
  applyPopoverGeometry,
  resetPopoverGeometryCache,
};
