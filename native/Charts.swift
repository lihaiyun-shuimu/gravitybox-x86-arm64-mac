import Cocoa
import QuartzCore

// MARK: - QuotaBarView (三层分离配额组件：名称+百分比、细轨道进度条、重置倒计时)
final class QuotaBarView: NSView {
    final class TrackView: NSView {
        var percentage: Int = 0 {
            didSet {
                guard oldValue != percentage else { return }
                animateTo(CGFloat(percentage))
            }
        }
        private var displayedPercentage: CGFloat = 0
        private let motion = DesignMotion()
        var percentageKnown: Bool = true
        var staleData: Bool = false

        deinit { motion.cancel() }

        private func animateTo(_ target: CGFloat) {
            motion.cancel()
            guard Design.shouldAnimate(in: self) else {
                displayedPercentage = target
                needsDisplay = true
                return
            }
            let start = displayedPercentage
            if abs(target - start) < 0.5 {
                displayedPercentage = target
                needsDisplay = true
                return
            }
            motion.animate(in: self, from: start, to: target, curve: .sweep, threshold: 0.5) { [weak self] val in
                self?.displayedPercentage = val
                self?.needsDisplay = true
            }
        }

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                motion.cancel()
                displayedPercentage = CGFloat(percentage)
            }
        }

        var healthyTint: NSColor = Design.blue

        override func draw(_ dirtyRect: NSRect) {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let radius: CGFloat = bounds.height / 2.0
            let trackRect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: radius, yRadius: radius)

            Design.track.setFill()
            trackPath.fill()

            NSColor(white: isDark ? 1.0 : 0.0, alpha: isDark ? 0.055 : 0.045).setStroke()
            trackPath.lineWidth = 0.5
            trackPath.stroke()

            // 填充长度对应剩余配额，低配额联动警示色/危急色，最小宽度不小于轨道高度以避免 1% 裁切变形
            if percentageKnown && percentage > 0 {
                let effectivePct = displayedPercentage > 0 ? displayedPercentage : CGFloat(percentage)
                let fillW = max(trackRect.height, min(bounds.width, bounds.width * effectivePct / 100.0))
                if fillW > 0 {
                    let fillRect = NSRect(x: 0, y: 0, width: fillW, height: bounds.height)
                    NSGraphicsContext.current?.saveGraphicsState()
                    trackPath.addClip()
                    let baseColor: NSColor
                    if percentage <= 10 {
                        baseColor = accessibleDangerColor()
                    } else if percentage <= 20 {
                        baseColor = accessibleWarningColor()
                    } else {
                        baseColor = healthyTint
                    }
                    let startTint = staleData ? baseColor.withAlphaComponent(0.35) : baseColor.withAlphaComponent(0.75)
                    let endTint = staleData ? baseColor.withAlphaComponent(0.45) : baseColor
                    let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: radius, yRadius: radius)
                    if let grad = NSGradient(starting: startTint, ending: endTint) {
                        grad.draw(in: fillPath, angle: 0)
                    } else {
                        endTint.setFill()
                        fillPath.fill()
                    }
                    NSGraphicsContext.current?.restoreGraphicsState()
                }
            }
        }
    }

    let titleLabel = text("", size: 11, weight: .regular, color: .labelColor)
    let percentageLabel = NSTextField(labelWithString: "")
    let trackView = TrackView()
    let resetLabel = text("", size: 10, color: Design.secondary)
    let iconView = NSImageView()
    let secondaryIconView = NSImageView()

    enum ResetUrgency: Equatable {
        case auto
        case normal
        case soon
        case danger
    }

    private(set) var percentage: Int = 0
    private(set) var percentageKnown: Bool = true
    private(set) var staleData: Bool = false
    var resetUrgency: ResetUrgency = .auto {
        didSet {
            if oldValue != resetUrgency { applyColor() }
        }
    }
    var unknownPlaceholder: String = L10n.t("common.pending_refresh", fallback: "待刷新")

    private var leftStack: NSStackView!
    private var topRow: NSStackView!
    private var containerStack: NSStackView!

    // 百分比文字颜色：普通用主文字色；低配额变橙/红；未知为次级灰
    private var percentageTextColor: NSColor {
        if staleData { return accessibleWarningColor() }
        guard percentageKnown else { return Design.secondary }
        if percentage <= 10 {
            return accessibleDangerColor()
        } else if percentage <= 20 {
            return accessibleWarningColor()
        } else {
            return .labelColor
        }
    }

    // 重置倒计时颜色：优先采用显式语义枚举 ResetUrgency，auto 模式下回退匹配双语倒计时文案
    private var resetTextColor: NSColor {
        switch resetUrgency {
        case .danger:
            return Design.dangerText
        case .soon:
            return Design.warningText
        case .normal:
            return staleData ? Design.warningText : Design.secondary
        case .auto:
            let text = resetLabel.stringValue
            let isDanger = text.contains("已过") || text.contains("告急") || text.localizedCaseInsensitiveContains("overdue") || text.localizedCaseInsensitiveContains("exhausted") || text.localizedCaseInsensitiveContains("passed")
            if isDanger {
                return Design.dangerText
            }
            let isSoon = text.contains("即将重置") || text.localizedCaseInsensitiveContains("soon")
            if isSoon || staleData {
                return Design.warningText
            }
            return Design.secondary
        }
    }

    init(title: String = "", percentage: Int? = nil, resetText: String = "", icon: String = "hexagon", unknownPlaceholder: String? = nil, stale: Bool = false) {
        self.percentage = max(0, min(100, percentage ?? 0))
        self.percentageKnown = percentage != nil
        self.staleData = stale
        if let unknownPlaceholder = unknownPlaceholder {
            self.unknownPlaceholder = unknownPlaceholder
        } else {
            self.unknownPlaceholder = L10n.t("common.unknown", fallback: "未知")
        }
        trackView.percentage = self.percentage
        trackView.percentageKnown = self.percentageKnown
        trackView.staleData = self.staleData

        iconView.image = icon.isEmpty ? nil : NSImage(systemSymbolName: icon, accessibilityDescription: nil)
        iconView.contentTintColor = .secondaryLabelColor
        iconView.setContentHuggingPriority(.required, for: .horizontal)
        iconView.setContentCompressionResistancePriority(.required, for: .horizontal)
        iconView.isHidden = icon.isEmpty
        secondaryIconView.isHidden = true
        for image in [iconView,secondaryIconView] {
            image.translatesAutoresizingMaskIntoConstraints = false; image.imageScaling = .scaleProportionallyUpOrDown
            NSLayoutConstraint.activate([image.widthAnchor.constraint(equalToConstant:14),image.heightAnchor.constraint(equalToConstant:14)])
            image.setAccessibilityElement(false)
        }

        leftStack = horizontal([iconView, secondaryIconView, titleLabel], spacing: 4)
        let topSpacer = flexibleSpace()
        topRow = horizontal([leftStack, topSpacer, resetLabel, percentageLabel], spacing: 4)
        topRow.setCustomSpacing(2, after: leftStack)
        topRow.setCustomSpacing(2, after: topSpacer)
        topRow.alignment = .centerY

        containerStack = vertical([topRow, trackView], spacing: 4.5)
        containerStack.alignment = .leading

        super.init(frame: .zero)

        titleLabel.stringValue = title
        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(245), for: .horizontal)
        titleLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(240), for: .horizontal)

        resetLabel.stringValue = InterfaceText.countdown(resetText)
        resetLabel.alignment = .right
        resetLabel.lineBreakMode = .byTruncatingTail
        resetLabel.setContentHuggingPriority(NSLayoutConstraint.Priority(230), for: .horizontal)
        resetLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(230), for: .horizontal)
        resetLabel.isHidden = resetLabel.stringValue.isEmpty

        percentageLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        percentageLabel.stringValue = percentageKnown ? "\(self.percentage)%" : self.unknownPlaceholder
        percentageLabel.setContentHuggingPriority(.required, for: .horizontal)
        percentageLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        addSubview(containerStack)
        containerStack.translatesAutoresizingMaskIntoConstraints = false
        trackView.translatesAutoresizingMaskIntoConstraints = false

        let bottomTie = containerStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2)
        bottomTie.priority = .defaultHigh
        NSLayoutConstraint.activate([
            containerStack.leadingAnchor.constraint(equalTo: leadingAnchor),
            containerStack.trailingAnchor.constraint(equalTo: trailingAnchor),
            containerStack.topAnchor.constraint(equalTo: topAnchor, constant: 2),
            bottomTie,
            topRow.widthAnchor.constraint(equalTo: containerStack.widthAnchor),
            trackView.widthAnchor.constraint(equalTo: containerStack.widthAnchor),
            trackView.heightAnchor.constraint(equalToConstant: 8)
        ])

        applyModelIcon(fallback: icon)
        applyColor()
        updateAccessibility()
    }

    func useComfortableLayout() {
        containerStack.spacing = 5.5
        for constraint in trackView.constraints where constraint.firstAttribute == .height { constraint.constant = 8 }
        trackView.isHidden = false
        resetLabel.isHidden = resetLabel.stringValue.isEmpty
        let minH = heightAnchor.constraint(greaterThanOrEqualToConstant: 34)
        minH.priority = .defaultHigh
        minH.isActive = true
    }
    func useCompactLayout() {
        containerStack.spacing = 4.5
        for constraint in trackView.constraints where constraint.firstAttribute == .height { constraint.constant = 8 }
        trackView.isHidden = false
        resetLabel.isHidden = resetLabel.stringValue.isEmpty
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        applyColor()
        trackView.needsDisplay = true
    }

    private func applyColor() {
        titleLabel.textColor = .labelColor
        if ModelIcons.brands(for:titleLabel.stringValue).isEmpty { iconView.contentTintColor = .secondaryLabelColor }
        trackView.healthyTint = Design.blue
        percentageLabel.textColor = percentageTextColor
        resetLabel.textColor = resetTextColor
        trackView.needsDisplay = true
        needsDisplay = true
    }

    private func updateAccessibility() {
        var desc = titleLabel.stringValue.isEmpty ? L10n.t("component.quota.remaining", fallback: "剩余配额") : titleLabel.stringValue
        desc += percentageKnown ? L10n.t("component.quota.a11y_pct", ["pct": percentage], fallback: " 剩余 \(percentage)%") : " \(unknownPlaceholder)"
        if staleData { desc += L10n.t("component.quota.a11y_stale", fallback: " · 数据已过期") }
        if !resetLabel.stringValue.isEmpty {
            desc += ", \(resetLabel.stringValue)"
        }
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel(desc)
        setAccessibilityHelp(L10n.t("component.quota.a11y_help", fallback: "显示剩余配额；轨道长度对应剩余百分比。"))
        if percentageKnown {
            setAccessibilityValue(NSNumber(value: percentage))
            setAccessibilityMinValue(NSNumber(value: 0))
            setAccessibilityMaxValue(NSNumber(value: 100))
        } else {
            setAccessibilityValue(nil)
        }
        titleLabel.setAccessibilityElement(false)
        percentageLabel.setAccessibilityElement(false)
        resetLabel.setAccessibilityElement(false)
        iconView.setAccessibilityElement(false)
    }

    private func applyModelIcon(fallback:String) {
        let brands=ModelIcons.brands(for:titleLabel.stringValue)
        if let first=brands.first,let image=ModelIcons.image(first) {
            iconView.image=image;iconView.isHidden=false;iconView.contentTintColor=ModelIcons.tintColor(for: image)
            if brands.count>1,let second=ModelIcons.image(brands[1]) { secondaryIconView.image=second;secondaryIconView.isHidden=false;secondaryIconView.contentTintColor=ModelIcons.tintColor(for: second) }
            else { secondaryIconView.isHidden=true }
        } else { iconView.image=fallback.isEmpty ? nil : NSImage(systemSymbolName:fallback,accessibilityDescription:nil);iconView.isHidden=fallback.isEmpty;secondaryIconView.isHidden=true }
    }

    func update(title: String? = nil, percentage: Int?, resetText: String = "", icon: String? = nil, unknownPlaceholder: String? = nil, stale: Bool = false, resetUrgency: ResetUrgency? = nil) {
        let nextTitle = title ?? titleLabel.stringValue
        let nextPlaceholder = unknownPlaceholder ?? self.unknownPlaceholder
        let nextPct = max(0, min(100, percentage ?? 0))
        let nextKnown = percentage != nil
        let nextReset = InterfaceText.countdown(resetText)
        let nextUrgency = resetUrgency ?? self.resetUrgency
        let titleChanged = titleLabel.stringValue != nextTitle
        if !titleChanged
            && self.unknownPlaceholder == nextPlaceholder
            && self.percentage == nextPct
            && self.percentageKnown == nextKnown
            && self.staleData == stale
            && self.resetUrgency == nextUrgency
            && resetLabel.stringValue == nextReset
            && icon == nil {
            return
        }
        if self.resetUrgency != nextUrgency {
            self.resetUrgency = nextUrgency
        }
        if titleChanged {
            titleLabel.stringValue = nextTitle
        }
        if self.unknownPlaceholder != nextPlaceholder {
            self.unknownPlaceholder = nextPlaceholder
        }
        if titleChanged || icon != nil {
            if let icon {
                iconView.image = icon.isEmpty ? nil : NSImage(systemSymbolName: icon, accessibilityDescription: nil)
                iconView.isHidden = icon.isEmpty
            }
            applyModelIcon(fallback: icon ?? "hexagon")
        }
        self.percentage = nextPct
        self.percentageKnown = nextKnown
        self.staleData = stale
        trackView.percentage = self.percentage
        trackView.percentageKnown = self.percentageKnown
        trackView.staleData = self.staleData
        let nextPctText = percentageKnown ? "\(self.percentage)%" : self.unknownPlaceholder
        if percentageLabel.stringValue != nextPctText {
            percentageLabel.stringValue = nextPctText
        }
        if resetLabel.stringValue != nextReset {
            resetLabel.stringValue = nextReset
        }
        trackView.isHidden = false
        let shouldHideReset = resetLabel.stringValue.isEmpty
        if resetLabel.isHidden != shouldHideReset {
            resetLabel.isHidden = shouldHideReset
            needsLayout = true
        }
        applyColor()
        updateAccessibility()
        trackView.needsDisplay = true
    }
}

func quotaBar(title: String = "", percentage: Int? = nil, resetText: String = "", icon: String = "hexagon", unknownPlaceholder: String? = nil, stale: Bool = false) -> QuotaBarView {
    QuotaBarView(title: title, percentage: percentage, resetText: resetText, icon: icon, unknownPlaceholder: unknownPlaceholder, stale: stale)
}

/// F12/G02: 图表与表格参考线的自适应低对比色。避免 `separatorColor` 在浅色下解析成白线不可见、
/// 在深色下却偏亮造成深浅不一致。
func designHairline() -> NSColor { designHairline(lightAlpha: 0.09, darkAlpha: 0.05) }
func designHairline(lightAlpha: CGFloat, darkAlpha: CGFloat) -> NSColor {
    NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(darkAlpha)
            : NSColor.black.withAlphaComponent(lightAlpha)
    }
}

// MARK: - UsageTrendChartView (CoreGraphics Bar Chart for Hourly/Daily Token Usage)
final class UsageTrendChartView: NSView {
    static func todayPoints(_ hourly: [[String: Any]]) -> [Point] {
        var hourMap: [String: Int] = [:]
        for h in hourly {
            if let hourStr = h["hour"] as? String, let suffix = hourStr.split(separator: " ").last {
                let t = (h["total_tokens"] as? Int) ?? (h["totalTokens"] as? Int) ?? 0
                hourMap[String(suffix), default: 0] += t
            }
        }
        let currentHour = Calendar.current.component(.hour, from: Date())
        var pts: [Point] = []
        for hr in 0..<24 {
            let lbl = String(format: "%02d:00", locale: Locale(identifier: "en_US_POSIX"), hr)
            let val = hourMap[lbl] ?? 0
            let isFuture = (val == 0 && hr > currentHour)
            let hourText = L10n.t("menu_panel.trend.hour_label", ["hour": String(format: "%02d", locale: Locale(identifier: "en_US_POSIX"), hr)], fallback: String(format: "%02d时", locale: Locale(identifier: "en_US_POSIX"), hr))
            let tipText = L10n.t("menu_panel.trend.today_key", ["time": lbl], fallback: "今日 \(lbl)")
            pts.append(.init(label: hourText, tokens: val, tooltipLabel: tipText, isFuture: isFuture))
        }
        return pts
    }

    struct Point: Equatable {
        let label: String
        let tooltipLabel: String
        let tokens: Int
        let isFuture: Bool

        init(label: String, tokens: Int, tooltipLabel: String? = nil, isFuture: Bool = false) {
            self.label = label
            self.tooltipLabel = tooltipLabel ?? label
            self.tokens = tokens
            self.isFuture = isFuture
        }
    }
    private var fixedHeightConstraint: NSLayoutConstraint?
    private var minHeightConstraint: NSLayoutConstraint?
    private var maxHeightConstraint: NSLayoutConstraint?
    private var revealProgress: CGFloat = 1.0
    private let revealMotion = DesignMotion()
    private let hoverMotion = DesignMotion()
    private var animatedHoverX: CGFloat? = nil
    var onHoverPoint: ((Point?) -> Void)?
    var points: [Point] = [] {
        didSet {
            hoveredIndex = nil
            animatedHoverX = nil
            hoverMotion.cancel()
            let activeSummary = points.filter { $0.tokens > 0 }.prefix(8).map { "\($0.label): \(compactTokens($0.tokens))" }.joined(separator: ", ")
            let peak = points.map(\.tokens).max() ?? 0
            let peakText = peak > 0 ? L10n.t("component.chart.peak_tokens", ["tokens": compactTokens(peak)], fallback: "峰值 \(compactTokens(peak)) Token") : L10n.t("component.chart.no_usage", fallback: "当前时段无消耗")
            setAccessibilityHelp(activeSummary.isEmpty ? peakText : L10n.t("component.chart.detail_a11y", ["peak": peakText, "summary": activeSummary], fallback: "\(peakText)；时段明细：\(activeSummary)"))
            guard oldValue != points else {
                needsDisplay = true
                return
            }
            startRevealAnimation()
        }
    }
    private var hoverTrackingArea: NSTrackingArea?
    private var hoveredIndex: Int? = nil {
        didSet {
            if oldValue != hoveredIndex { needsDisplay = true }
        }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        let fixedH = heightAnchor.constraint(equalToConstant: 96)
        fixedH.isActive = true
        fixedHeightConstraint = fixedH
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel(L10n.t("component.chart.bar_a11y", fallback: "Token 用量趋势柱状图"))
    }

    func useFlexibleHeight(minHeight: CGFloat = 92, maxHeight: CGFloat? = nil) {
        fixedHeightConstraint?.isActive = false
        minHeightConstraint?.isActive = false
        maxHeightConstraint?.isActive = false
        let minH = heightAnchor.constraint(greaterThanOrEqualToConstant: minHeight)
        minH.isActive = true
        minHeightConstraint = minH
        if let maxHeight {
            let maxH = heightAnchor.constraint(lessThanOrEqualToConstant: maxHeight)
            maxH.isActive = true
            maxHeightConstraint = maxH
        }
        setContentHuggingPriority(NSLayoutConstraint.Priority(200), for: .vertical)
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit {
        revealMotion.cancel()
        hoverMotion.cancel()
    }

    private func startRevealAnimation() {
        revealMotion.cancel()
        guard Design.shouldAnimate(in: self), points.contains(where: { $0.tokens > 0 }) else {
            revealProgress = 1.0
            alphaValue = 1.0
            needsDisplay = true
            return
        }
        revealProgress = 0.0
        alphaValue = 1.0
        revealMotion.animate(in: self, from: 0.0, to: 1.0, curve: .sweep, threshold: 0.01) { [weak self] val in
            self?.revealProgress = val
            self?.needsDisplay = true
        }
    }

    func resetHoverState() {
        hoverMotion.cancel()
        animatedHoverX = nil
        if hoveredIndex != nil {
            hoveredIndex = nil
            toolTip = nil
            onHoverPoint?(nil)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            revealMotion.cancel()
            hoverMotion.cancel()
            revealProgress = 1.0
            resetHoverState()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self, userInfo: nil)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        guard bounds.contains(pt), !points.isEmpty else {
            resetHoverState()
            return
        }
        let leftPad: CGFloat = axisGutter, rightPad: CGFloat = 6
        let usableWidth = max(40, bounds.width - leftPad - rightPad)
        let slotWidth = usableWidth / CGFloat(points.count)
        let idx = Int(floor((pt.x - leftPad) / slotWidth))
        if points.indices.contains(idx) {
            let targetX = leftPad + (CGFloat(idx) + 0.5) * slotWidth
            if hoveredIndex != idx {
                if let currentX = animatedHoverX, Design.shouldAnimate(in: self) {
                    hoverMotion.animate(in: self, from: currentX, to: targetX, curve: .hover, threshold: 0.5) { [weak self] val in
                        self?.animatedHoverX = val
                        self?.needsDisplay = true
                    }
                } else {
                    hoverMotion.cancel()
                    animatedHoverX = targetX
                }
                hoveredIndex = idx
            } else if animatedHoverX == nil {
                animatedHoverX = targetX
            }
            let item = points[idx]
            toolTip = nil
            onHoverPoint?(item)
        } else {
            resetHoverState()
        }
    }

    override func mouseExited(with event: NSEvent) {
        resetHoverState()
    }

    // F12: 纵轴左侧留白，放 0 / 峰值刻度；数据条整体右移但仍保留原有蓝柱样式与 108pt 高度。
    private let axisGutter: CGFloat = 46

    private func compactTokens(_ value: Int) -> String {
        InterfaceText.formatCompactTokens(value, formatSmallWithLocale: true)
    }

    override func draw(_ dirtyRect: NSRect) {
        let chartBottom: CGFloat = 20
        let chartTop: CGFloat = bounds.height - 6
        let chartHeight = max(20, chartTop - chartBottom)
        let leftPad = axisGutter
        let rightPad: CGFloat = 6
        let usableWidth = max(40, bounds.width - leftPad - rightPad)
        let axisAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: Design.secondary
        ]

        // Baseline（保留一条实线基线；无标签虚线已删除）
        let baseLine = NSBezierPath()
        baseLine.move(to: NSPoint(x: leftPad, y: chartBottom))
        baseLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartBottom))
        designHairline(lightAlpha: 0.22, darkAlpha: 0.22).setStroke()
        baseLine.lineWidth = 1
        baseLine.stroke()

        guard !points.isEmpty else {
            let emptyStr = L10n.t("component.chart.no_sessions", fallback: "暂无该时段会话记录") as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 12),
                .foregroundColor: Design.secondary
            ]
            let sz = emptyStr.size(withAttributes: attrs)
            emptyStr.draw(at: NSPoint(x: (bounds.width - sz.width) / 2, y: (bounds.height - sz.height) / 2), withAttributes: attrs)
            return
        }

        let peakVal = points.map(\.tokens).max() ?? 0
        guard peakVal > 0 else {
            let emptyStr = L10n.t("component.chart.no_distribution", fallback: "当前时段暂无消耗分布") as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11.5),
                .foregroundColor: Design.secondary
            ]
            let sz = emptyStr.size(withAttributes: attrs)
            emptyStr.draw(at: NSPoint(x: leftPad + (usableWidth - sz.width) / 2, y: chartBottom + (chartHeight - sz.height) / 2), withAttributes: attrs)
            return
        }
        let maxVal = max(peakVal, 1)

        // 纵轴刻度：默认保留 0 与峰值两个刻度；当图表纵向空间充裕（>= 88pt）时补充带明确数值标注的 50% 中位参考线。
        let peakText = compactTokens(maxVal) as NSString
        let peakSize = peakText.size(withAttributes: axisAttrs)
        peakText.draw(at: NSPoint(x: max(2, leftPad - 8 - peakSize.width), y: chartTop - peakSize.height), withAttributes: axisAttrs)

        let zeroText = "0" as NSString
        let zeroSize = zeroText.size(withAttributes: axisAttrs)
        zeroText.draw(at: NSPoint(x: max(2, leftPad - 8 - zeroSize.width), y: chartBottom - zeroSize.height / 2), withAttributes: axisAttrs)

        let peakLine = NSBezierPath()
        peakLine.move(to: NSPoint(x: leftPad, y: chartTop))
        peakLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartTop))
        peakLine.setLineDash([3, 4], count: 2, phase: 0)
        designHairline().setStroke()
        peakLine.lineWidth = 0.8
        peakLine.stroke()

        if chartHeight >= 88 && maxVal >= 2 {
            let midY = round((chartBottom + chartTop) / 2.0)
            let midVal = Int(round(Double(maxVal) / 2.0))
            let midText = compactTokens(midVal) as NSString
            let midSize = midText.size(withAttributes: axisAttrs)
            let midLabelY = midY - midSize.height / 2.0
            if midLabelY > chartBottom + zeroSize.height * 0.6 && midLabelY + midSize.height < chartTop - peakSize.height - 2 {
                midText.draw(at: NSPoint(x: max(2, leftPad - 8 - midSize.width), y: midLabelY), withAttributes: axisAttrs)
                let midLine = NSBezierPath()
                midLine.move(to: NSPoint(x: leftPad, y: midY))
                midLine.line(to: NSPoint(x: bounds.width - rightPad, y: midY))
                midLine.setLineDash([3, 4], count: 2, phase: 0)
                designHairline(lightAlpha: 0.075, darkAlpha: 0.045).setStroke()
                midLine.lineWidth = 0.8
                midLine.stroke()
            }
        }

        let count = points.count
        let slotWidth = usableWidth / CGFloat(count)
        let barWidth = min(22, max(4, slotWidth * 0.62))
        let labelAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: Design.secondary
        ]

        // U12: 动态根据可用宽度自适应抽稀刻度，并施加严格的包围盒几何防碰撞，杜绝 20时 与 23时 挤压重叠
        let minLabelGap: CGFloat = 8.0
        let effectiveStep: Int
        if usableWidth < 340 {
            effectiveStep = count > 16 ? 6 : (count > 8 ? 4 : 2)
        } else if usableWidth < 460 {
            effectiveStep = count > 16 ? 4 : (count > 8 ? 2 : 1)
        } else {
            effectiveStep = count > 16 ? 3 : (count > 8 ? 2 : 1)
        }

        var lastDrawnRight: CGFloat = -999.0
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let baseSlotFill = NSColor.labelColor.withAlphaComponent(isDark ? 0.12 : 0.08)
        let cursorFill = NSColor.labelColor.withAlphaComponent(isDark ? 0.065 : 0.045)
        let normalGrad = NSGradient(starting: Design.blue.withAlphaComponent(0.72), ending: Design.blue)
        let hoverGrad = NSGradient(starting: Design.blue.withAlphaComponent(0.90), ending: Design.blue)

        for (idx, pt) in points.enumerated() {
            let cx = leftPad + (CGFloat(idx) + 0.5) * slotWidth
            let isHovered = (hoveredIndex == idx)

            // 0 柱位浅灰基槽（未到达时段留空，对齐菜单栏表现）
            if !pt.isFuture {
                let baseH: CGFloat = 2.5
                let baseRect = NSRect(x: cx - barWidth / 2, y: chartBottom + 1, width: barWidth, height: baseH)
                let basePath = NSBezierPath(roundedRect: baseRect, xRadius: min(1.25, barWidth / 2), yRadius: min(1.25, barWidth / 2))
                baseSlotFill.setFill()
                basePath.fill()
            }

            // 悬停即时跟随微光光标
            if isHovered && !pt.isFuture {
                let cursorCenterX = animatedHoverX ?? cx
                let cursorRect = NSRect(x: cursorCenterX - slotWidth * 0.44, y: chartBottom + 1, width: slotWidth * 0.88, height: chartHeight)
                let cursorPath = NSBezierPath(roundedRect: cursorRect, xRadius: 4, yRadius: 4)
                cursorFill.setFill()
                cursorPath.fill()
            }

            if !pt.isFuture && pt.tokens > 0 {
                let ratio = max(0.06, min(1, CGFloat(pt.tokens) / CGFloat(maxVal))) * revealProgress
                let h = chartHeight * ratio
                let r = min(3.0, barWidth / 2)
                let bx = cx - barWidth / 2
                let by = chartBottom + 1
                let bh = max(r, h)

                let barPath = NSBezierPath()
                barPath.move(to: NSPoint(x: bx, y: by))
                barPath.line(to: NSPoint(x: bx, y: by + bh - r))
                barPath.appendArc(withCenter: NSPoint(x: bx + r, y: by + bh - r), radius: r, startAngle: 180, endAngle: 90, clockwise: true)
                barPath.line(to: NSPoint(x: bx + barWidth - r, y: by + bh))
                barPath.appendArc(withCenter: NSPoint(x: bx + barWidth - r, y: by + bh - r), radius: r, startAngle: 90, endAngle: 0, clockwise: true)
                barPath.line(to: NSPoint(x: bx + barWidth, y: by))
                barPath.close()

                (isHovered ? hoverGrad : normalGrad)?.draw(in: barPath, angle: 90)
            }

            // 刻度文本绘制与防撞逻辑：步长对齐，末尾点仅在空间充裕时绘制
            let isStepMatch = (idx % effectiveStep == 0)
            let isLastPoint = (idx == count - 1)
            let isNearLast = (count - 1 - idx < effectiveStep / 2)

            if isStepMatch && !isNearLast || (isLastPoint && !isStepMatch) {
                let ns = pt.label as NSString
                let sz = ns.size(withAttributes: labelAttrs)
                let drawX = max(2, min(bounds.width - sz.width - 2, cx - sz.width / 2))
                if drawX >= lastDrawnRight + minLabelGap {
                    ns.draw(at: NSPoint(x: drawX, y: 3), withAttributes: labelAttrs)
                    lastDrawnRight = drawX + sz.width
                }
            }
        }

        // 柱体即时跟随数据胶囊
        if let hIdx = hoveredIndex, points.indices.contains(hIdx) {
            let pt = points[hIdx]
            let cx = animatedHoverX ?? (leftPad + (CGFloat(hIdx) + 0.5) * slotWidth)
            let ratio = maxVal > 0 ? max(0.06, min(1, CGFloat(pt.tokens) / CGFloat(maxVal))) : 0
            let barH = (!pt.isFuture && pt.tokens > 0) ? chartHeight * ratio : 0
            let capStr: NSString = pt.isFuture
                ? (L10n.t("menu_panel.chart.future", fallback: "未到达") as NSString)
                : ("\(compactTokens(pt.tokens))" as NSString)
            let capAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.white
            ]
            let capSize = capStr.size(withAttributes: capAttrs)
            let capW = capSize.width + 12
            let capH: CGFloat = 18
            let minX = leftPad
            let maxX = max(minX, bounds.width - rightPad - capW)
            let capX = max(minX, min(maxX, cx - capW / 2))
            let capY = min(chartTop - capH, max(chartBottom + barH + 5, chartBottom + 12))
            let capRect = NSRect(x: capX, y: capY, width: capW, height: capH)
            let capPath = NSBezierPath(roundedRect: capRect, xRadius: capH / 2, yRadius: capH / 2)
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            (isDark ? NSColor(white: 0.18, alpha: 0.94) : NSColor(white: 0.15, alpha: 0.88)).setFill()
            capPath.fill()
            (isDark ? NSColor.white.withAlphaComponent(0.18) : NSColor.black.withAlphaComponent(0.12)).setStroke()
            capPath.lineWidth = 0.5
            capPath.stroke()
            capStr.draw(at: NSPoint(x: capX + (capW - capSize.width) / 2, y: capY + (capH - capSize.height) / 2), withAttributes: capAttrs)
        }
    }
}

// MARK: - ModelDonutChartView (CoreGraphics Multi-Segment Donut Chart for Model Cost Share)
final class ModelDonutChartView: NSView {
    struct Slice: Equatable {
        let model: String
        let usd: Double
        let tokens: Int
        let color: NSColor
        static func == (lhs: Slice, rhs: Slice) -> Bool {
            lhs.model == rhs.model && lhs.tokens == rhs.tokens && abs(lhs.usd - rhs.usd) < 1e-9
        }
    }
    private var revealProgress: CGFloat = 1.0
    private let revealMotion = DesignMotion()
    private let hoverMotion = DesignMotion()
    private var hoverTrackingArea: NSTrackingArea?
    private var hoveredSliceIndex: Int? = nil
    private var hoverEmphasis: CGFloat = 0.0
    var slices: [Slice] = [] {
        didSet {
            hoveredSliceIndex = nil
            hoverEmphasis = 0.0
            guard oldValue != slices else {
                needsDisplay = true
                return
            }
            startRevealAnimation()
        }
    }
    var totalUsd: Double = 0 {
        didSet { needsDisplay = true }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        widthAnchor.constraint(equalToConstant: 104).isActive = true
        heightAnchor.constraint(equalToConstant: 104).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel(L10n.t("component.donut.a11y", fallback: "模型费用占比环图"))
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit {
        revealMotion.cancel()
        hoverMotion.cancel()
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 8.5
        let dx = pt.x - center.x
        let dy = pt.y - center.y
        let dist = hypot(dx, dy)
        let validSlices = slices.filter { $0.usd > 0 }
        let sumUsd = validSlices.reduce(0.0) { $0 + $1.usd }
        guard sumUsd > 0, dist >= radius - 12 && dist <= radius + 12 else {
            clearHoveredSlice()
            return
        }
        // Convert atan2 angle (CCW from +X) into clockwise degrees starting from 90° (top)
        let degCCW = atan2(dy, dx) * 180.0 / .pi
        var cwFromTop = 90.0 - degCCW
        while cwFromTop < 0 { cwFromTop += 360.0 }
        while cwFromTop >= 360.0 { cwFromTop -= 360.0 }

        let layout = Self.computeSliceAngles(validSlices: validSlices, sumUsd: sumUsd)
        let halfGap: CGFloat = validSlices.count > 1 ? 1.5 : 0.0
        var hitIndex: Int? = nil
        for (idx, item) in layout.enumerated() {
            if cwFromTop >= item.startCW - halfGap && cwFromTop <= item.startCW + item.sweep + halfGap {
                hitIndex = idx
                break
            }
        }
        if let hitIndex {
            if hoveredSliceIndex != hitIndex {
                hoveredSliceIndex = hitIndex
                hoverMotion.animate(in: self, from: hoverEmphasis, to: 1.0, curve: .hover) { [weak self] val in
                    self?.hoverEmphasis = val
                    self?.needsDisplay = true
                }
            }
        } else {
            clearHoveredSlice()
        }
    }

    override func mouseExited(with event: NSEvent) {
        clearHoveredSlice()
    }

    static func computeSliceAngles(validSlices: [Slice], sumUsd: Double) -> [(startCW: CGFloat, sweep: CGFloat)] {
        guard !validSlices.isEmpty, sumUsd > 0 else { return [] }
        if validSlices.count == 1 {
            return [(startCW: 0, sweep: 360.0)]
        }
        let count = validSlices.count
        let gap: CGFloat = 3.0
        let minSweep: CGFloat = 2.0
        let available = max(CGFloat(count) * minSweep, 360.0 - gap * CGFloat(count))
        var sweeps = validSlices.map { CGFloat($0.usd / sumUsd) * available }
        var fixed = Array(repeating: false, count: count)
        while true {
            var deficit: CGFloat = 0
            var flexSum: CGFloat = 0
            for i in 0..<count where !fixed[i] {
                if sweeps[i] < minSweep {
                    deficit += (minSweep - sweeps[i])
                    sweeps[i] = minSweep
                    fixed[i] = true
                } else {
                    flexSum += sweeps[i]
                }
            }
            if deficit <= 0.0001 || flexSum <= 0.0001 { break }
            let scale = max(0, (flexSum - deficit) / flexSum)
            for i in 0..<count where !fixed[i] {
                sweeps[i] *= scale
            }
        }
        var out: [(startCW: CGFloat, sweep: CGFloat)] = []
        var cursorCW: CGFloat = 0
        for s in sweeps {
            out.append((startCW: cursorCW, sweep: s))
            cursorCW += s + gap
        }
        return out
    }

    private func clearHoveredSlice() {
        guard hoveredSliceIndex != nil else { return }
        hoveredSliceIndex = nil
        hoverMotion.animate(in: self, from: hoverEmphasis, to: 0.0, curve: .hover) { [weak self] val in
            self?.hoverEmphasis = val
            self?.needsDisplay = true
        }
    }

    private func startRevealAnimation() {
        revealMotion.cancel()
        guard Design.shouldAnimate(in: self), slices.contains(where: { $0.usd > 0 }) else {
            revealProgress = 1.0
            alphaValue = 1.0
            needsDisplay = true
            return
        }
        revealProgress = 0.0
        alphaValue = 1.0
        revealMotion.animate(in: self, from: 0.0, to: 1.0, curve: .sweep, threshold: 0.01) { [weak self] val in
            self?.revealProgress = val
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            revealMotion.cancel()
            hoverMotion.cancel()
            hoveredSliceIndex = nil
            hoverEmphasis = 0.0
            revealProgress = 1.0
            alphaValue = 1.0
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let center = NSPoint(x: bounds.midX, y: bounds.midY)
        let radius = min(bounds.width, bounds.height) / 2 - 8.5
        let lineWidth: CGFloat = 8.5

        // Background track ring
        let track = NSBezierPath()
        track.appendArc(withCenter: center, radius: radius, startAngle: 0, endAngle: 360)
        track.lineWidth = lineWidth
        Design.track.setStroke()
        track.stroke()

        let validSlices = slices.filter { $0.usd > 0 }
        let sumUsd = validSlices.reduce(0.0) { $0 + $1.usd }
        let layout = Self.computeSliceAngles(validSlices: validSlices, sumUsd: sumUsd)

        if sumUsd > 0 {
            for (idx, slice) in validSlices.enumerated() where idx < layout.count {
                let isSliceHovered = (hoveredSliceIndex == idx)
                let startAngle: CGFloat = 90.0 - layout[idx].startCW * revealProgress
                let effectiveSweep = layout[idx].sweep * revealProgress
                let endAngle = startAngle - effectiveSweep
                let sliceRadius = isSliceHovered ? (radius + 1.2 * hoverEmphasis) : radius
                let sliceWidth = isSliceHovered ? (lineWidth + 2.2 * hoverEmphasis) : lineWidth
                let arc = NSBezierPath()
                arc.appendArc(withCenter: center, radius: sliceRadius, startAngle: startAngle, endAngle: endAngle, clockwise: true)
                arc.lineWidth = sliceWidth
                arc.lineCapStyle = .butt
                let alpha: CGFloat = (hoveredSliceIndex == nil || isSliceHovered) ? 1.0 : max(0.45, 1.0 - 0.50 * hoverEmphasis)
                slice.color.withAlphaComponent(alpha).setStroke()
                arc.stroke()
            }
        }

        // Center text - optically and mathematically centered vertically
        let activeUsd: Double
        let subLabelString: String
        if let hIdx = hoveredSliceIndex, validSlices.indices.contains(hIdx), sumUsd > 0 {
            let hSlice = validSlices[hIdx]
            activeUsd = hSlice.usd
            let pct = Int(round((hSlice.usd / sumUsd) * 100.0))
            let pctText = (hSlice.usd > 0 && pct == 0) ? "<1" : "\(pct)"
            subLabelString = L10n.t("component.donut.share_pct", ["pct": pctText], fallback: "占比 \(pctText)%")
        } else {
            activeUsd = totalUsd
            subLabelString = L10n.t("component.donut.equivalent_bill", fallback: "等效账单")
        }

        let usdText: NSString
        if totalUsd > 0 && totalUsd < 0.001 {
            usdText = "<$0.001" as NSString
        } else {
            usdText = InterfaceText.formatUsd(activeUsd) as NSString
        }
        let mainAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 15, weight: .bold),
            .foregroundColor: NSColor.labelColor
        ]
        let subText = subLabelString as NSString
        let subAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 10, weight: .medium),
            .foregroundColor: NSColor.secondaryLabelColor
        ]
        let mSz = usdText.size(withAttributes: mainAttrs)
        let sSz = subText.size(withAttributes: subAttrs)
        let gapBetween: CGFloat = 3.0
        let totalH = mSz.height + gapBetween + sSz.height
        let bottomY = center.y - (totalH / 2)

        subText.draw(at: NSPoint(x: center.x - sSz.width / 2, y: bottomY), withAttributes: subAttrs)
        usdText.draw(at: NSPoint(x: center.x - mSz.width / 2, y: bottomY + sSz.height + gapBetween), withAttributes: mainAttrs)
    }
}
