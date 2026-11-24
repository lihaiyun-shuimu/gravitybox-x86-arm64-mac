import Cocoa

/// 状态栏弹出卡片：固定宽度的纵向信息卡，直接展示当前账号与各家族配额。
/// 只使用语义色与透明背景，叠加在系统菜单毛玻璃材质上，浅色/深色外观自动适配。
final class MenuMeterBar: NSView {
    private let motion = DesignMotion()
    private var displayedFraction: CGFloat = 0
    var fraction: CGFloat? {
        didSet {
            guard oldValue != fraction else { return }
            guard let target = fraction, target > 0 else {
                motion.cancel()
                displayedFraction = 0
                needsDisplay = true
                return
            }
            let clamped = min(1, max(0, target))
            motion.animate(in: self, from: displayedFraction, to: clamped, curve: .sweep, threshold: 0.005) { [weak self] val in
                self?.displayedFraction = val
                self?.needsDisplay = true
            }
        }
    }
    var tint: NSColor = Design.blue { didSet { needsDisplay = true } }
    override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: 6) }
    override var isOpaque: Bool { false }
    override var allowsVibrancy: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let radius = bounds.height / 2
        let track = NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius)
        NSColor.labelColor.withAlphaComponent(isDark ? 0.16 : 0.10).setFill(); track.fill()

        guard let fraction, fraction > 0 else { return }
        let effective = displayedFraction > 0 ? displayedFraction : min(1, fraction)
        let width = max(bounds.height, bounds.width * min(1, effective))
        NSGraphicsContext.current?.saveGraphicsState(); track.addClip()
        let fillRect = NSRect(x: 0, y: 0, width: width, height: bounds.height)
        let fillPath = NSBezierPath(roundedRect: fillRect, xRadius: radius, yRadius: radius)
        if let grad = NSGradient(starting: tint.withAlphaComponent(0.75), ending: tint) {
            grad.draw(in: fillPath, angle: 0)
        } else {
            tint.setFill(); fillPath.fill()
        }
        NSGraphicsContext.current?.restoreGraphicsState()
    }
    override func viewDidChangeEffectiveAppearance() { super.viewDidChangeEffectiveAppearance(); needsDisplay = true }
    deinit { motion.cancel() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { motion.cancel() }
    }
}

/// 菜单卡片与面板共用的配额展示辅助。
enum MenuQuotaHelpers {
    /// "4 小时 13 分钟后重置" -> "4小时13分后重置"，菜单内保持一行。
    static func compactReset(_ raw: String) -> String {
        let converted = InterfaceText.countdown(raw)
        if L10n.shared.isEnglish {
            return converted
        }
        return converted
            .replacingOccurrences(of: "分钟", with: "分")
            .replacingOccurrences(of: " ", with: "")
            .replacingOccurrences(of: "·", with: " · ")
    }

    static func groupHeader(_ title: String, brands: [String], fontSize: CGFloat = 11.5, iconSize: CGFloat = 13, spacing: CGFloat = 5) -> NSView {
        var views: [NSView] = brands.compactMap { brand in
            guard let image = ModelIcons.image(brand) else { return nil }
            let icon = NSImageView(image: image)
            icon.imageScaling = .scaleProportionallyUpOrDown
            icon.contentTintColor = ModelIcons.tintColor(for: image)
            icon.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: iconSize), icon.heightAnchor.constraint(equalToConstant: iconSize)])
            icon.setAccessibilityElement(false)
            return icon
        }
        if views.isEmpty, let fallback = ModelIcons.fallbackIcon(size: iconSize) {
            let icon = NSImageView(image: fallback)
            icon.imageScaling = .scaleProportionallyUpOrDown
            icon.contentTintColor = .secondaryLabelColor
            icon.translatesAutoresizingMaskIntoConstraints = false
            NSLayoutConstraint.activate([icon.widthAnchor.constraint(equalToConstant: iconSize), icon.heightAnchor.constraint(equalToConstant: iconSize)])
            icon.setAccessibilityElement(false)
            views.append(icon)
        }
        let lbl = text(title, size: fontSize, weight: .semibold, color: .secondaryLabelColor)
        lbl.alignment = .left
        views.append(lbl)
        let row = horizontal(views, spacing: spacing)
        row.alignment = .centerY
        return row
    }
}

/// 单个配额窗口：标题 + 重置时间 + 百分比，下方一条细进度条。
final class MenuMeterRow: NSView {
    override var allowsVibrancy: Bool { false }
    let titleLabel = text("", size: 12, color: .labelColor)
    let resetLabel = text("", size: 10.5, color: .secondaryLabelColor)
    let valueLabel = text("", size: 12, weight: .semibold, color: .labelColor)
    let bar = MenuMeterBar()
    private(set) var lastAppliedKey = ""

    init(title: String) {
        super.init(frame: .zero)
        titleLabel.stringValue = title
        titleLabel.alignment = .left
        if let cell = titleLabel.cell as? NSTextFieldCell { cell.lineBreakMode = .byTruncatingTail }
        valueLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        valueLabel.alignment = .right
        resetLabel.alignment = .right
        resetLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        valueLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        resetLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        let top = horizontal([titleLabel, flexibleSpace(), resetLabel, valueLabel], spacing: 6)
        top.alignment = .firstBaseline
        top.detachesHiddenViews = true
        let stack = vertical([top, bar], spacing: 4)
        stack.alignment = .leading
        addSubview(stack); pin(stack, to: self)
        fillWidth(top, in: stack); fillWidth(bar, in: stack)
        bar.heightAnchor.constraint(equalToConstant: 6).isActive = true
        valueLabel.widthAnchor.constraint(greaterThanOrEqualToConstant: 34).isActive = true
        setAccessibilityElement(true); setAccessibilityRole(.progressIndicator)
    }
    required init?(coder: NSCoder) { fatalError() }

    private var healthyTint: NSColor {
        Design.blue
    }

    /// percentage == nil 时只画灰色空轨道，并显示占位文字（未知 / 不可用 / 已过期）。
    var accessibilityGroupName = ""
    func apply(percentage: Int?, placeholder: String, reset: String, stale: Bool) {
        let compactReset = MenuQuotaHelpers.compactReset(reset)
        let titleEmpty = titleLabel.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        if titleLabel.isHidden != titleEmpty { titleLabel.isHidden = titleEmpty }
        let key = "\(titleLabel.stringValue)|\(percentage.map(String.init) ?? "nil")|\(placeholder)|\(compactReset)|\(stale)"
        guard key != lastAppliedKey else { return }
        lastAppliedKey = key
        if resetLabel.stringValue != compactReset { resetLabel.stringValue = compactReset }
        if resetLabel.isHidden != compactReset.isEmpty { resetLabel.isHidden = compactReset.isEmpty }
        if let percentage {
            let value = max(0, min(100, percentage))
            valueLabel.stringValue = "\(value)%"
            let baseTint: NSColor
            if value <= 10 {
                baseTint = accessibleDangerColor()
            } else if value <= 20 {
                baseTint = accessibleWarningColor()
            } else {
                baseTint = healthyTint
            }
            bar.tint = stale ? baseTint.withAlphaComponent(0.45) : baseTint
            bar.fraction = CGFloat(value) / 100
            valueLabel.textColor = value <= 10 ? accessibleDangerColor() : value <= 20 ? accessibleWarningColor() : .labelColor
            resetLabel.textColor = stale ? accessibleWarningColor() : .secondaryLabelColor
            setAccessibilityValue(NSNumber(value: value))
        } else {
            valueLabel.stringValue = placeholder
            valueLabel.textColor = .secondaryLabelColor
            bar.fraction = nil
            bar.tint = healthyTint
            resetLabel.textColor = .secondaryLabelColor
            setAccessibilityValue(nil)
        }
        let sep = L10n.shared.isEnglish ? ", " : "，"
        setAccessibilityLabel([accessibilityGroupName, titleLabel.stringValue, valueLabel.stringValue, compactReset].filter { !$0.isEmpty }.joined(separator: sep))
    }
}

// MARK: - Three-Tab Native Menu Panel ("用量｜配额｜账号", 424pt Popover)

final class MenuSegmentedTabsView: NSView {
    enum Style {
        case primaryTabs
        case secondaryRange
        case compactToggle
    }

    override var allowsVibrancy: Bool { false }
    let items: [String]
    let style: Style
    var onSelect: ((Int) -> Void)?
    private var buttons: [SegmentItemButton] = []
    private(set) var selectedIndex: Int = 0
    private var slidePosition: CGFloat = 0
    private let slideMotion = DesignMotion()

    final class SegmentItemButton: NSButton {
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); needsDisplay = true; return result }
        override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); needsDisplay = true; return result }
        override var allowsVibrancy: Bool { false }
        let index: Int
        let barStyle: Style
        weak var owner: MenuSegmentedTabsView?
        var isSelectedSegment = false { didSet { if oldValue != isSelectedSegment { needsDisplay = true } } }
        private var hoverTracking: NSTrackingArea?
        var hovered = false { didSet { if oldValue != hovered { needsDisplay = true } } }

        init(title: String, index: Int, style: Style, owner: MenuSegmentedTabsView, action: Selector) {
            self.index = index
            self.barStyle = style
            self.owner = owner
            super.init(frame: .zero)
            self.title = title
            self.target = owner
            self.action = action
            bezelStyle = .inline
            isBordered = false
            focusRingType = .none
            setButtonType(.momentaryChange)
            setAccessibilityElement(true)
            setAccessibilityRole(.radioButton)
            setAccessibilityLabel(title)
        }
        required init?(coder: NSCoder) { fatalError() }

        override func updateTrackingAreas() {
            super.updateTrackingAreas()
            if let area = hoverTracking { removeTrackingArea(area) }
            let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
            hoverTracking = area
            addTrackingArea(area)
        }
        override func mouseEntered(with event: NSEvent) { if isEnabled { hovered = true } }
        override func mouseExited(with event: NSEvent) { hovered = false }
        override func keyDown(with event: NSEvent) {
            if event.keyCode == 123 {
                owner?.moveSelection(by: -1)
            } else if event.keyCode == 124 {
                owner?.moveSelection(by: 1)
            } else {
                super.keyDown(with: event)
            }
        }

        override func draw(_ dirtyRect: NSRect) {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let radius: CGFloat = barStyle == .primaryTabs ? 7 : 6
            let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
            let path = NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius)

            if !isSelectedSegment && hovered {
                (isDark ? NSColor.white.withAlphaComponent(0.06) : NSColor.black.withAlphaComponent(0.04)).setFill()
                path.fill()
            }

            let fontSize: CGFloat = barStyle == .primaryTabs ? 12.5 : (barStyle == .secondaryRange ? 11.5 : 11)
            let weight: NSFont.Weight = isSelectedSegment ? .semibold : .medium
            let fg: NSColor
            if isSelectedSegment {
                switch barStyle {
                case .primaryTabs:
                    fg = .labelColor
                case .secondaryRange, .compactToggle:
                    fg = Design.menuSegmentAccent
                }
            } else {
                fg = hovered ? .labelColor : Design.secondary
            }

            let pStyle = NSMutableParagraphStyle()
            pStyle.alignment = .center
            pStyle.lineBreakMode = .byTruncatingTail
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
                .foregroundColor: fg,
                .paragraphStyle: pStyle
            ]
            let sz = (title as NSString).size(withAttributes: attrs)
            let drawRect = NSRect(x: 2, y: (bounds.height - sz.height) / 2, width: max(0, bounds.width - 4), height: sz.height)
            (title as NSString).draw(in: drawRect, withAttributes: attrs)

            if window?.firstResponder === self {
                Design.blue.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            }
        }
    }

    init(items: [String], style: Style = .primaryTabs, selected: Int = 0, accessibilityLabel: String) {
        self.items = items
        self.style = style
        let initial = max(0, min(items.count - 1, selected))
        self.selectedIndex = initial
        self.slidePosition = CGFloat(initial)
        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        let barHeight: CGFloat = style == .primaryTabs ? 32 : (style == .secondaryRange ? 28 : 24)
        heightAnchor.constraint(equalToConstant: barHeight).isActive = true

        let stack = NSStackView()
        stack.orientation = .horizontal
        stack.distribution = style == .compactToggle ? .fillProportionally : .fillEqually
        stack.spacing = 3
        for (idx, item) in items.enumerated() {
            let btn = SegmentItemButton(title: item, index: idx, style: style, owner: self, action: #selector(segmentPressed(_:)))
            btn.isSelectedSegment = (idx == self.selectedIndex)
            btn.setAccessibilityValue(idx == self.selectedIndex ? 1 : 0)
            if style == .compactToggle {
                btn.translatesAutoresizingMaskIntoConstraints = false
                let titleWidth = (item as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 11.5, weight: .medium)]).width
                btn.widthAnchor.constraint(greaterThanOrEqualToConstant: max(48, ceil(titleWidth) + 14)).isActive = true
            }
            buttons.append(btn)
            stack.addArrangedSubview(btn)
            btn.heightAnchor.constraint(equalToConstant: barHeight - 6).isActive = true
        }
        addSubview(stack)
        pin(stack, to: self, inset: 3)
        setAccessibilityElement(false)
        setAccessibilityRole(.tabGroup)
        setAccessibilityLabel(accessibilityLabel)
    }
    required init?(coder: NSCoder) { fatalError() }

    override func accessibilityChildren() -> [Any]? {
        buttons
    }

    override func layout() {
        super.layout()
        needsDisplay = true
    }

    deinit { slideMotion.cancel() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { slideMotion.cancel() }
    }

    func setSelected(_ index: Int) {
        let clamped = max(0, min(items.count - 1, index))
        selectedIndex = clamped
        for (idx, btn) in buttons.enumerated() {
            btn.isSelectedSegment = (idx == clamped)
            btn.setAccessibilityValue(idx == clamped ? 1 : 0)
        }
        let target = CGFloat(clamped)
        slideMotion.animate(in: self, from: slidePosition, to: target, curve: .spring, threshold: 0.01) { [weak self] pos in
            self?.slidePosition = pos
            self?.needsDisplay = true
        }
    }

    @objc private func segmentPressed(_ sender: SegmentItemButton) {
        guard sender.index != selectedIndex else { return }
        setSelected(sender.index)
        onSelect?(sender.index)
    }

    func moveSelection(by delta: Int) {
        guard !buttons.isEmpty else { return }
        let next = max(0, min(buttons.count - 1, selectedIndex + delta))
        let targetBtn = buttons[next]
        window?.makeFirstResponder(targetBtn)
        if next != selectedIndex {
            setSelected(next)
            onSelect?(next)
        }
    }

    private func interpolatedThumbRect() -> NSRect {
        guard !buttons.isEmpty else { return .zero }
        let lowIdx = max(0, min(buttons.count - 1, Int(floor(slidePosition))))
        let highIdx = max(0, min(buttons.count - 1, Int(ceil(slidePosition))))
        let frac = max(0, min(1, slidePosition - CGFloat(lowIdx)))
        let r1 = convert(buttons[lowIdx].bounds, from: buttons[lowIdx])
        let r2 = convert(buttons[highIdx].bounds, from: buttons[highIdx])
        if r1.width <= 1 {
            let inset: CGFloat = 3
            let spacing: CGFloat = 3
            let count = CGFloat(max(1, items.count))
            let totalW = max(0, bounds.width - inset * 2 - spacing * (count - 1))
            let itemW = totalW / count
            let x = inset + slidePosition * (itemW + spacing)
            return NSRect(x: x, y: inset, width: itemW, height: max(0, bounds.height - inset * 2))
        }
        return NSRect(
            x: r1.origin.x + (r2.origin.x - r1.origin.x) * frac,
            y: r1.origin.y + (r2.origin.y - r1.origin.y) * frac,
            width: r1.width + (r2.width - r1.width) * frac,
            height: r1.height + (r2.height - r1.height) * frac
        )
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if style != .compactToggle {
            let radius: CGFloat = style == .primaryTabs ? 9 : 8
            let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
            let bg: NSColor
            if style == .primaryTabs {
                bg = isDark ? NSColor.white.withAlphaComponent(0.05) : NSColor.black.withAlphaComponent(0.04)
            } else {
                bg = isDark ? NSColor.white.withAlphaComponent(0.035) : NSColor.black.withAlphaComponent(0.026)
            }
            bg.setFill()
            path.fill()
        }

        let thumbRect = interpolatedThumbRect().insetBy(dx: 0.5, dy: 0.5)
        guard thumbRect.width > 1 && thumbRect.height > 1 else { return }
        let thumbRadius: CGFloat = style == .primaryTabs ? 7 : 6
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: thumbRadius, yRadius: thumbRadius)

        switch style {
        case .primaryTabs:
            NSGraphicsContext.saveGraphicsState()
            // 浮雕微立体阴影
            let thumbShadow = NSShadow()
            thumbShadow.shadowColor = isDark
                ? NSColor.black.withAlphaComponent(0.40)
                : NSColor.black.withAlphaComponent(0.12)
            thumbShadow.shadowOffset = NSSize(width: 0, height: -1.0)
            thumbShadow.shadowBlurRadius = 3.0
            thumbShadow.set()

            let fill = isDark ? NSColor.white.withAlphaComponent(0.12) : NSColor.white.withAlphaComponent(0.88)
            fill.setFill()
            thumbPath.fill()
            NSGraphicsContext.restoreGraphicsState()

            (isDark ? NSColor.white.withAlphaComponent(0.13) : NSColor.black.withAlphaComponent(0.06)).setStroke()
            thumbPath.lineWidth = 0.8
            thumbPath.stroke()

            // 0.5pt 顶部镜面高光斜角
            let topHighlight = NSBezierPath(roundedRect: thumbRect.insetBy(dx: 0.5, dy: 0.5), xRadius: thumbRadius - 0.5, yRadius: thumbRadius - 0.5)
            NSColor.white.withAlphaComponent(isDark ? 0.16 : 0.45).setStroke()
            topHighlight.lineWidth = 0.5
            topHighlight.stroke()
        case .secondaryRange:
            let fill = isDark
                ? Design.blue.withAlphaComponent(0.20)
                : Design.blue.withAlphaComponent(0.10)
            fill.setFill()
            thumbPath.fill()
            Design.blue.withAlphaComponent(isDark ? 0.36 : 0.20).setStroke()
            thumbPath.lineWidth = 0.8
            thumbPath.stroke()
        case .compactToggle:
            Design.blue.withAlphaComponent(isDark ? 0.24 : 0.12).setFill()
            thumbPath.fill()
        }
    }
}

final class MenuMetricTileView: NSView {
    override var allowsVibrancy: Bool { false }
    let metricKey: String
    let iconView: NSImageView
    let titleLabel: NSTextField
    let statusBadge: PillBadge
    let valueLabel: NSTextField

    init(key: String, title: String) {
        self.metricKey = key
        self.titleLabel = text(title, size: 11.5, weight: .medium, color: Design.secondary)
        self.statusBadge = pillBadge("", color: accessibleWarningColor())
        self.valueLabel = text("—", size: 20, weight: .bold, color: Design.text)

        let iconName: String
        switch key {
        case "tokens":
            iconName = "sparkles"
        case "requests":
            iconName = "paperplane.fill"
        case "cost":
            iconName = "dollarsign.circle.fill"
        case "cache":
            iconName = "bolt.badge.clock.fill"
        default:
            iconName = "chart.xyaxis.line"
        }
        let iconTint = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor.white.withAlphaComponent(0.72)
                : NSColor.labelColor.withAlphaComponent(0.60)
        }
        let iv = NSImageView()
        iv.image = NSImage(systemSymbolName: iconName, accessibilityDescription: nil)
        iv.contentTintColor = iconTint
        iv.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
        iv.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iv.widthAnchor.constraint(equalToConstant: 13),
            iv.heightAnchor.constraint(equalToConstant: 13)
        ])
        iv.setAccessibilityElement(false)
        self.iconView = iv

        super.init(frame: .zero)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 55).isActive = true

        valueLabel.font = .monospacedDigitSystemFont(ofSize: 20, weight: .bold)
        valueLabel.lineBreakMode = .byTruncatingTail
        valueLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        titleLabel.lineBreakMode = .byTruncatingTail
        titleLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusBadge.label.font = .systemFont(ofSize: 9.5, weight: .semibold)
        statusBadge.isHidden = true
        statusBadge.setContentHuggingPriority(.required, for: .horizontal)
        statusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        statusBadge.setAccessibilityElement(false)

        let topRow = horizontal([iv, titleLabel, flexibleSpace(), statusBadge], spacing: 4.5)
        topRow.alignment = .centerY
        topRow.detachesHiddenViews = true

        let stack = vertical([topRow, valueLabel], spacing: 3.5)
        stack.alignment = .leading
        fillWidth(topRow, in: stack)
        fillWidth(valueLabel, in: stack)
        addSubview(stack)
        stack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            stack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            stack.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        titleLabel.setAccessibilityElement(false)
        valueLabel.setAccessibilityElement(false)
        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        refreshAccessibility()
    }
    required init?(coder: NSCoder) { fatalError() }

    func setValueText(
        _ text: String,
        warning: Bool = false,
        badgeText: String? = nil,
        badgeTint: NSColor = accessibleWarningColor()
    ) {
        if valueLabel.stringValue != text {
            valueLabel.stringValue = text
        }
        valueLabel.textColor = warning ? accessibleWarningColor() : Design.text
        let cleanBadge = (badgeText ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        statusBadge.isHidden = cleanBadge.isEmpty
        if !cleanBadge.isEmpty {
            if statusBadge.title != cleanBadge {
                statusBadge.title = cleanBadge
            }
            statusBadge.tint = badgeTint
        }
        refreshAccessibility()
    }

    func refreshAccessibility() {
        let sep = L10n.shared.isEnglish ? ", " : "，"
        let badgePart = (!statusBadge.isHidden && !statusBadge.title.isEmpty) ? " · \(statusBadge.title)" : ""
        setAccessibilityLabel("\(titleLabel.stringValue)\(badgePart)\(sep)\(valueLabel.stringValue)")
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 11, yRadius: 11)
        Design.popoverCardBackground.setFill()
        path.fill()
        Design.popoverCardBorder.setStroke()
        path.lineWidth = 1.0
        path.stroke()
        Design.drawSpecularBevel(in: bounds, cornerRadius: 11, isDark: isDark)
    }
}

final class MenuTrendChartView: NSView {
    override var allowsVibrancy: Bool { false }
    enum Dimension: String {
        case tokens = "tokens"
        case requests = "requests"
    }

    struct Bucket: Equatable {
        let label: String
        let tooltipLabel: String
        let value: Int
        let isFuture: Bool
    }

    var dimension: Dimension = .tokens {
        didSet {
            if oldValue != dimension {
                setAccessibilityLabel(dimension == .tokens ? L10n.t("menu_panel.chart.tokens_a11y", fallback: "菜单栏 Token 用量趋势图") : L10n.t("menu_panel.chart.requests_a11y", fallback: "菜单栏请求数趋势图"))
                needsDisplay = true
            }
        }
    }
    private var revealProgress: CGFloat = 1.0
    private let revealMotion = DesignMotion()
    private let hoverMotion = DesignMotion()
    private var animatedHoverX: CGFloat? = nil
    var onHoverBucket: ((Bucket?) -> Void)?
    private var hoverTrackingArea: NSTrackingArea?
    private var hoveredIndex: Int? = nil {
        didSet { if oldValue != hoveredIndex { needsDisplay = true } }
    }
    var buckets: [Bucket] = [] {
        didSet {
            hoveredIndex = nil
            animatedHoverX = nil
            hoverMotion.cancel()
            guard oldValue != buckets else { return }
            startRevealAnimation()
        }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 86).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.image)
        setAccessibilityLabel(L10n.t("menu_panel.chart.tokens_a11y", fallback: "菜单栏 Token 用量趋势图"))
    }
    required init?(coder: NSCoder) { fatalError() }
    deinit {
        revealMotion.cancel()
        hoverMotion.cancel()
    }

    func resetHoverState() {
        hoverMotion.cancel()
        animatedHoverX = nil
        if hoveredIndex != nil {
            hoveredIndex = nil
            toolTip = nil
            onHoverBucket?(nil)
        }
    }

    func stopAnimation() {
        revealMotion.cancel()
        revealProgress = 1.0
        alphaValue = 1.0
        resetHoverState()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { stopAnimation() }
    }

    private func startRevealAnimation() {
        revealMotion.cancel()
        guard Design.shouldAnimate(in: self), buckets.contains(where: { $0.value > 0 && !$0.isFuture }) else {
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

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseMoved, .mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    private let leftGutter: CGFloat = 42
    private let rightPad: CGFloat = 6

    override func mouseMoved(with event: NSEvent) {
        let pt = convert(event.locationInWindow, from: nil)
        guard bounds.contains(pt), !buckets.isEmpty,
              buckets.contains(where: { !$0.isFuture && $0.value > 0 }) else {
            resetHoverState()
            return
        }
        let usableWidth = max(40, bounds.width - leftGutter - rightPad)
        let slotWidth = usableWidth / CGFloat(buckets.count)
        let idx = Int(floor((pt.x - leftGutter) / slotWidth))
        if buckets.indices.contains(idx) {
            let targetX = leftGutter + (CGFloat(idx) + 0.5) * slotWidth
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
            let item = buckets[idx]
            toolTip = nil
            onHoverBucket?(item)
        } else {
            resetHoverState()
        }
    }

    override func mouseExited(with event: NSEvent) {
        resetHoverState()
    }

    private func formatAxisValue(_ value: Int) -> String {
        if dimension == .tokens {
            return InterfaceText.formatCompactTokens(value, formatSmallWithLocale: true)
        }
        return value >= 1000 ? String(format: "%.1fK", locale: Locale(identifier: "en_US_POSIX"), Double(value) / 1000.0) : "\(value)"
    }

    override func draw(_ dirtyRect: NSRect) {
        let chartBottom: CGFloat = 20
        let chartTop: CGFloat = bounds.height - 6
        let chartHeight = max(20, chartTop - chartBottom)
        let usableWidth = max(40, bounds.width - leftGutter - rightPad)
        let axisAttrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 9.5, weight: .regular),
            .foregroundColor: Design.secondary
        ]

        let baseLine = NSBezierPath()
        baseLine.move(to: NSPoint(x: leftGutter, y: chartBottom))
        baseLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartBottom))
        designHairline(lightAlpha: 0.22, darkAlpha: 0.22).setStroke()
        baseLine.lineWidth = 1
        baseLine.stroke()

        let peakVal = buckets.filter { !$0.isFuture }.map(\.value).max() ?? 0
        guard !buckets.isEmpty, peakVal > 0 else {
            let emptyStr = (buckets.isEmpty ? L10n.t("component.chart.no_sessions", fallback: "暂无该时段会话记录") : L10n.t("component.chart.no_distribution", fallback: "当前时段暂无消耗分布")) as NSString
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: 11.5),
                .foregroundColor: Design.secondary
            ]
            let sz = emptyStr.size(withAttributes: attrs)
            emptyStr.draw(at: NSPoint(x: leftGutter + (usableWidth - sz.width) / 2, y: chartBottom + (chartHeight - sz.height) / 2), withAttributes: attrs)
            return
        }

        let peakText = formatAxisValue(peakVal) as NSString
        let peakSize = peakText.size(withAttributes: axisAttrs)
        peakText.draw(at: NSPoint(x: max(2, leftGutter - 6 - peakSize.width), y: chartTop - peakSize.height), withAttributes: axisAttrs)

        let zeroText = "0" as NSString
        let zeroSize = zeroText.size(withAttributes: axisAttrs)
        zeroText.draw(at: NSPoint(x: max(2, leftGutter - 6 - zeroSize.width), y: chartBottom - zeroSize.height / 2), withAttributes: axisAttrs)

        let peakLine = NSBezierPath()
        peakLine.move(to: NSPoint(x: leftGutter, y: chartTop))
        peakLine.line(to: NSPoint(x: bounds.width - rightPad, y: chartTop))
        peakLine.setLineDash([3, 4], count: 2, phase: 0)
        designHairline().setStroke()
        peakLine.lineWidth = 0.8
        peakLine.stroke()

        let count = buckets.count
        let slotWidth = usableWidth / CGFloat(count)
        let barWidth = min(18, max(3.5, slotWidth * 0.64))
        let effectiveStep: Int = count > 20 ? 6 : (count > 10 ? 3 : (count > 6 ? 2 : 1))
        var lastDrawnRight: CGFloat = -999.0
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let baseSlotFill = NSColor.labelColor.withAlphaComponent(isDark ? 0.12 : 0.08)
        let cursorFill = NSColor.labelColor.withAlphaComponent(isDark ? 0.065 : 0.045)
        let normalGrad = NSGradient(starting: Design.blue.withAlphaComponent(0.72), ending: Design.blue)
        let hoverGrad = NSGradient(starting: Design.blue.withAlphaComponent(0.90), ending: Design.blue)

        for (idx, bucket) in buckets.enumerated() {
            let cx = leftGutter + (CGFloat(idx) + 0.5) * slotWidth
            let isHovered = (hoveredIndex == idx)

            // 0 柱位浅灰基槽
            if !bucket.isFuture {
                let baseH: CGFloat = 2.5
                let baseRect = NSRect(x: cx - barWidth / 2, y: chartBottom, width: barWidth, height: baseH)
                let basePath = NSBezierPath(roundedRect: baseRect, xRadius: min(1.25, barWidth / 2), yRadius: min(1.25, barWidth / 2))
                baseSlotFill.setFill()
                basePath.fill()
            }

            // 悬停即时跟随微光光标
            if isHovered && !bucket.isFuture {
                let cursorCenterX = animatedHoverX ?? cx
                let cursorRect = NSRect(x: cursorCenterX - slotWidth * 0.44, y: chartBottom, width: slotWidth * 0.88, height: chartHeight)
                let cursorPath = NSBezierPath(roundedRect: cursorRect, xRadius: 4, yRadius: 4)
                cursorFill.setFill()
                cursorPath.fill()
            }

            if !bucket.isFuture && bucket.value > 0 {
                let ratio = max(0.06, min(1.0, CGFloat(bucket.value) / CGFloat(peakVal))) * revealProgress
                let bh = max(3.0, chartHeight * ratio)
                let bx = cx - barWidth / 2
                let by = chartBottom
                let r = min(2.5, min(barWidth / 2, bh / 2))
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

            let isStepMatch = (idx % effectiveStep == 0)
            let isLast = (idx == count - 1)
            let isNearLast = (count - 1 - idx < effectiveStep / 2)
            if (isStepMatch && !isNearLast) || (isLast && !isStepMatch) {
                let ns = bucket.label as NSString
                let sz = ns.size(withAttributes: axisAttrs)
                let drawX = max(2, min(bounds.width - sz.width - 2, cx - sz.width / 2))
                if drawX >= lastDrawnRight + 6 {
                    ns.draw(at: NSPoint(x: drawX, y: 2), withAttributes: axisAttrs)
                    lastDrawnRight = drawX + sz.width
                }
            }
        }

        // 柱体即时跟随数据胶囊
        if let hIdx = hoveredIndex, buckets.indices.contains(hIdx) {
            let b = buckets[hIdx]
            let cx = animatedHoverX ?? (leftGutter + (CGFloat(hIdx) + 0.5) * slotWidth)
            let ratio = peakVal > 0 ? max(0.06, min(1.0, CGFloat(b.value) / CGFloat(peakVal))) : 0
            let barH = (!b.isFuture && b.value > 0) ? chartHeight * ratio : 0
            let capStr: NSString
            if b.isFuture {
                capStr = L10n.t("menu_panel.chart.future", fallback: "未到达") as NSString
            } else if dimension == .tokens {
                capStr = InterfaceText.formatCompactTokens(b.value, formatSmallWithLocale: true) as NSString
            } else {
                capStr = InterfaceText.formatInteger(b.value) as NSString
            }
            let capAttrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .semibold),
                .foregroundColor: NSColor.white
            ]
            let capSize = capStr.size(withAttributes: capAttrs)
            let capW = capSize.width + 12
            let capH: CGFloat = 18
            let minX = leftGutter
            let maxX = max(minX, bounds.width - rightPad - capW)
            let capX = max(minX, min(maxX, cx - capW / 2))
            let capY = min(chartTop - capH, max(chartBottom + barH + 4, chartBottom + 10))
            let capRect = NSRect(x: capX, y: capY, width: capW, height: capH)
            let capPath = NSBezierPath(roundedRect: capRect, xRadius: capH / 2, yRadius: capH / 2)
            Design.chartTooltipFill.setFill()
            capPath.fill()
            Design.chartTooltipBorder.setStroke()
            capPath.lineWidth = 0.5
            capPath.stroke()
            capStr.draw(at: NSPoint(x: capX + (capW - capSize.width) / 2, y: capY + (capH - capSize.height) / 2), withAttributes: capAttrs)
        }
    }
}

final class MenuPlainClickButton: NSButton {
    var focusRingCornerRadius: CGFloat = 6
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title = ""
        bezelStyle = .inline
        isBordered = false
        focusRingType = .exterior
        refusesFirstResponder = false
        wantsLayer = true
    }
    required init?(coder: NSCoder) { fatalError() }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: focusRingCornerRadius, yRadius: focusRingCornerRadius).fill()
    }
    override func draw(_ dirtyRect: NSRect) {
        // Custom container row handles its own background; suppress NSButtonCell's default highlight flash.
    }
}

final class MenuCircularFocusButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        title = ""
        bezelStyle = .inline
        isBordered = false
        focusRingType = .exterior
        setButtonType(.momentaryChange)
        refusesFirstResponder = false
    }
    required init?(coder: NSCoder) { fatalError() }
    override var focusRingMaskBounds: NSRect { bounds }
    override func drawFocusRingMask() {
        NSBezierPath(ovalIn: bounds).fill()
    }
}

/// 采用原生 .overlay 悬浮半透明滚动条且绝不挤占内容区宽度的滚动容器。
final class MenuSilentScrollView: NSScrollView {
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        hasVerticalScroller = true
        hasHorizontalScroller = false
        autohidesScrollers = true
        scrollerStyle = .overlay
        drawsBackground = false
        automaticallyAdjustsContentInsets = false
    }
    required init?(coder: NSCoder) { fatalError() }

    override var scrollerStyle: NSScroller.Style {
        get { .overlay }
        set { super.scrollerStyle = .overlay }
    }

    override func tile() {
        super.tile()
        contentView.frame = bounds
        #if NATIVE_UI_TEST
        verticalScroller?.frame = .zero
        horizontalScroller?.frame = .zero
        #endif
    }
}

final class MenuModelUsageItemView: NSView {
    let rawModel: String
    let iconView: NSImageView = {
        let view = NSImageView(
            image: NSImage(systemSymbolName: "hexagon", accessibilityDescription: nil)
                ?? NSImage(systemSymbolName: "square", accessibilityDescription: nil)
                ?? NSImage()
        )
        view.setAccessibilityElement(false)
        view.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .regular)
        view.contentTintColor = Design.secondary
        view.imageScaling = .scaleProportionallyDown
        view.translatesAutoresizingMaskIntoConstraints = false
        return view
    }()
    let nameLabel: NSTextField
    let statusBadge: PillBadge
    let tokensLabel: NSTextField
    let shareBar = MenuMeterBar()

    init(
        model: String,
        rawModelKey: String? = nil,
        tokensText: String,
        shareFraction: CGFloat,
        badgeText: String = "",
        badgeTint: NSColor = accessibleWarningColor()
    ) {
        let resolvedRawKey = (rawModelKey?.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap { $0.isEmpty ? nil : $0 } ?? model
        self.rawModel = resolvedRawKey
        let display = model
        self.nameLabel = text(display, size: 12, weight: .semibold, color: .labelColor, wrap: true)
        self.statusBadge = pillBadge(badgeText, color: badgeTint)
        self.tokensLabel = text(tokensText, size: 12, weight: .semibold, color: .labelColor)
        super.init(frame: .zero)

        nameLabel.maximumNumberOfLines = 2
        nameLabel.lineBreakMode = .byWordWrapping
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        statusBadge.label.font = .systemFont(ofSize: 9.5, weight: .semibold)
        let cleanBadge = badgeText.trimmingCharacters(in: .whitespacesAndNewlines)
        statusBadge.isHidden = cleanBadge.isEmpty
        statusBadge.setContentHuggingPriority(.required, for: .horizontal)
        statusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        statusBadge.setAccessibilityElement(false)
        tokensLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
        tokensLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        if let brand = ModelIcons.brands(for: resolvedRawKey).first, let image = ModelIcons.image(brand) {
            iconView.image = image
            iconView.contentTintColor = ModelIcons.tintColor(for: image)
        }
        iconView.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 14),
            iconView.heightAnchor.constraint(equalToConstant: 14)
        ])

        shareBar.tint = Design.blue
        shareBar.fraction = max(0.02, min(1.0, shareFraction))
        shareBar.heightAnchor.constraint(equalToConstant: 4.5).isActive = true

        let topRow = horizontal([iconView, nameLabel, statusBadge, flexibleSpace(), tokensLabel], spacing: 6)
        topRow.alignment = .centerY
        topRow.detachesHiddenViews = true

        let stack = vertical([topRow, shareBar], spacing: 4)
        fillWidth(topRow, in: stack)
        fillWidth(shareBar, in: stack)
        addSubview(stack)
        pin(stack, to: self, inset: 2)

        setAccessibilityElement(true)
        setAccessibilityRole(.group)
        setAccessibilityLabel(Self.accessibilityText(display: display, tokensText: tokensText, badgeText: cleanBadge))
    }
    required init?(coder: NSCoder) { fatalError() }

    private static func accessibilityText(display: String, tokensText: String, badgeText: String = "") -> String {
        let base = L10n.shared.isEnglish ? "\(display), \(tokensText) Tokens" : "\(display)，\(tokensText) Token"
        return badgeText.isEmpty ? base : "\(base) · \(badgeText)"
    }

    func update(
        displayName: String? = nil,
        tokensText: String,
        shareFraction: CGFloat,
        badgeText: String = "",
        badgeTint: NSColor = accessibleWarningColor()
    ) {
        let nextDisplay = displayName ?? nameLabel.stringValue
        let cleanBadge = badgeText.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayChanged = nameLabel.stringValue != nextDisplay
        let tokensChanged = tokensLabel.stringValue != tokensText
        let badgeWasHidden = statusBadge.isHidden
        let badgeTitleBefore = statusBadge.title
        if displayChanged {
            nameLabel.stringValue = nextDisplay
        }
        if tokensChanged {
            tokensLabel.stringValue = tokensText
        }
        statusBadge.isHidden = cleanBadge.isEmpty
        if !cleanBadge.isEmpty {
            if statusBadge.title != cleanBadge { statusBadge.title = cleanBadge }
            statusBadge.tint = badgeTint
        }
        let badgeChanged = badgeWasHidden != statusBadge.isHidden || badgeTitleBefore != statusBadge.title
        if displayChanged || tokensChanged || badgeChanged {
            setAccessibilityLabel(Self.accessibilityText(display: nextDisplay, tokensText: tokensText, badgeText: cleanBadge))
        }
        shareBar.fraction = max(0.02, min(1.0, shareFraction))
    }
}

typealias MenuModelUsageRow = MenuModelUsageItemView


extension SshHostTagBadge {
    /// 兼容属性：返回徽章当前展示的主机标签文本。
    var title: String { label.stringValue }
}

final class MenuExpandableAccountCardView: NSBox {
    let accountId: String
    private var fullEmail: String = ""
    private(set) var isCurrentAccount = false
    private(set) var canSwitchAccount = false
    private(set) var isAccountReachable = true
    private(set) var isSwitchInFlight = false
    let stateButton = MenuCircularFocusButton(frame: .zero)
    let headerButton = MenuPlainClickButton(frame: .zero)
    let stateIcon = symbol("circle", size: 12, color: Design.secondary)
    let nameLabel = text("", size: 12.5, weight: .semibold, color: .labelColor)
    let tierBadge = TierBadge("", scale: .compact)
    let statusBadge = pillBadge("", color: Design.blue)
    let sshPresenceBadge = SshHostTagBadge(scale: .compact)
    let chevronIcon = symbol("chevron.down", size: 10, color: Design.secondary)
    let emailLabel = text("", size: 10.5, color: .secondaryLabelColor)

    let detailContainer = NSStackView()
    let quotaRowsStack = NSStackView()
    private(set) var quotaRowViews: [MenuMeterRow] = []
    let warningLabel = text("", size: 10.5, color: accessibleWarningColor(), wrap: true)
    let timestampLabel = text("", size: 10.5, color: Design.secondary)
    let switchButton = button(L10n.t("menu_panel.account_card.switch_btn", fallback: "切换账号…"), target: nil, action: #selector(switchPressed))
    let singleRefreshButton = QuotaRefreshButton(target: nil, action: #selector(refreshSinglePressed))

    var onToggleExpand: ((String) -> Void)?
    var onSwitchAccount: ((String) -> Void)?
    var onRefreshSingle: ((String) -> Void)?
    private var hoverTrackingArea: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    private var wasExpanded: Bool? = nil

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) {
        hoverMotion.animate(in: self, from: hoverProgress, to: 1.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func mouseExited(with event: NSEvent) {
        hoverMotion.animate(in: self, from: hoverProgress, to: 0.0, curve: .hover) { [weak self] val in
            self?.hoverProgress = val
            self?.needsDisplay = true
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if hoverProgress > 0.005 {
            let hoverPath = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: cornerRadius, yRadius: cornerRadius)
            (isDark ? NSColor.white.withAlphaComponent(0.032 * hoverProgress) : NSColor.black.withAlphaComponent(0.018 * hoverProgress)).setFill()
            hoverPath.fill()
        }
        Design.drawSpecularBevel(in: bounds, cornerRadius: cornerRadius, isDark: isDark)
    }

    private static let todayFormatter: DateFormatter = InterfaceText.shortTimeFormatter
    private static let dateFormatter: DateFormatter = InterfaceText.shortDateTimeFormatter

    init(accountId: String) {
        self.accountId = accountId
        super.init(frame: .zero)
        boxType = .custom
        cornerRadius = Design.Radius.popover
        borderWidth = 1
        borderColor = Design.popoverCardBorder
        fillColor = Design.popoverCardBackground
        contentViewMargins = .zero

        nameLabel.lineBreakMode = .byTruncatingTail
        nameLabel.setContentHuggingPriority(.defaultHigh, for: .horizontal)
        nameLabel.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(600), for: .horizontal)
        tierBadge.setContentHuggingPriority(.required, for: .horizontal)
        tierBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        statusBadge.label.font = .systemFont(ofSize: 9.5, weight: .semibold)
        statusBadge.setContentHuggingPriority(.required, for: .horizontal)
        statusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)
        sshPresenceBadge.setContentHuggingPriority(.required, for: .horizontal)
        sshPresenceBadge.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(550), for: .horizontal)
        let sshMaxW = sshPresenceBadge.widthAnchor.constraint(lessThanOrEqualToConstant: 98)
        sshMaxW.priority = NSLayoutConstraint.Priority(999)
        sshMaxW.isActive = true
        sshPresenceBadge.isHidden = true
        emailLabel.font = .systemFont(ofSize: 11.5, weight: .regular)
        emailLabel.lineBreakMode = .byTruncatingMiddle
        emailLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        timestampLabel.font = .monospacedDigitSystemFont(ofSize: 10.5, weight: .regular)
        timestampLabel.lineBreakMode = .byTruncatingTail
        timestampLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        stateButton.target = self
        stateButton.action = #selector(stateIconClicked)
        stateButton.addSubview(stateIcon)
        stateIcon.translatesAutoresizingMaskIntoConstraints = false
        stateButton.translatesAutoresizingMaskIntoConstraints = false
        stateButton.setContentHuggingPriority(.required, for: .horizontal)
        stateButton.setContentCompressionResistancePriority(.required, for: .horizontal)
        NSLayoutConstraint.activate([
            stateButton.widthAnchor.constraint(equalToConstant: 18),
            stateButton.heightAnchor.constraint(equalToConstant: 18),
            stateIcon.centerXAnchor.constraint(equalTo: stateButton.centerXAnchor),
            stateIcon.centerYAnchor.constraint(equalTo: stateButton.centerYAnchor)
        ])

        let titleSpacer = flexibleSpace()
        titleSpacer.setContentCompressionResistancePriority(NSLayoutConstraint.Priority(1), for: .horizontal)
        let topTitleRow = horizontal([nameLabel, tierBadge, statusBadge, sshPresenceBadge, titleSpacer, chevronIcon], spacing: 5)
        topTitleRow.alignment = .centerY
        topTitleRow.detachesHiddenViews = true

        let headerLines = vertical([topTitleRow, emailLabel], spacing: 2)
        headerLines.alignment = .leading
        for v in headerLines.arrangedSubviews { fillWidth(v, in: headerLines) }

        headerButton.title = ""
        headerButton.bezelStyle = .inline
        headerButton.isBordered = false
        headerButton.focusRingType = .exterior
        headerButton.setButtonType(.momentaryChange)
        headerButton.target = self
        headerButton.action = #selector(headerClicked)
        headerButton.addSubview(headerLines)
        pin(headerLines, to: headerButton)
        headerButton.setContentHuggingPriority(.defaultLow, for: .horizontal)
        headerButton.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        let copyMenu = NSMenu()
        let copyItem = NSMenuItem(title: L10n.t("common.copy_full_email", fallback: "复制完整邮箱"), action: #selector(copyEmail), keyEquivalent: "")
        copyItem.target = self
        copyMenu.addItem(copyItem)
        headerButton.menu = copyMenu

        switchButton.controlSize = .small
        switchButton.target = self
        singleRefreshButton.controlSize = .small
        singleRefreshButton.identifier = NSUserInterfaceItemIdentifier(accountId)
        singleRefreshButton.target = self

        let actionRow = horizontal([timestampLabel, flexibleSpace(), switchButton, singleRefreshButton], spacing: 8)
        actionRow.alignment = .centerY
        actionRow.detachesHiddenViews = true

        quotaRowsStack.orientation = .vertical
        quotaRowsStack.alignment = .leading
        quotaRowsStack.spacing = 6
        quotaRowsStack.detachesHiddenViews = true

        let detailViews: [NSView] = [
            divider(),
            quotaRowsStack,
            warningLabel,
            actionRow
        ]
        detailContainer.orientation = .vertical
        detailContainer.alignment = .leading
        detailContainer.spacing = 6
        detailContainer.detachesHiddenViews = true
        for v in detailViews {
            detailContainer.addArrangedSubview(v)
            fillWidth(v, in: detailContainer)
        }

        let headerRow = horizontal([stateButton, headerButton], spacing: 7)
        headerRow.alignment = .top
        headerRow.detachesHiddenViews = true
        headerButton.translatesAutoresizingMaskIntoConstraints = false
        headerButton.widthAnchor.constraint(equalTo: headerRow.widthAnchor, constant: -25).isActive = true

        let root = vertical([headerRow, detailContainer], spacing: 8)
        root.detachesHiddenViews = true
        fillWidth(headerRow, in: root)
        fillWidth(detailContainer, in: root)
        addSubview(root)
        pin(root, to: self, inset: 10)
    }
    required init?(coder: NSCoder) { fatalError() }

    func apply(account: [String: Any], isCurrent: Bool, isLiveVerified: Bool, isRecommended: Bool, isExpanded: Bool, reachable: Bool, switchInFlight: Bool, globalBusy: Bool, singleBusy: Bool, singleError: String?, singleNotice: String? = nil, matchingSshHosts: [CanonicalHostEnvironment] = [], hasSshHosts: Bool = false, staleThresholdSeconds: TimeInterval = 300) {
        let email = account["email"] as? String ?? L10n.t("menu_panel.account_card.unnamed", fallback: "未命名账号")
        fullEmail = email
        let rawName = account["name"] as? String
        let display = AccountIdentity.displayName(name: rawName, email: email)
        let tier = AccountIdentity.normalizeTier(account["subscription_tier"] as? String)
        let summary = QuotaPresentation.menuAccountSummary(account).replacingOccurrences(of: "\n", with: " · ")

        self.isCurrentAccount = isCurrent
        self.isAccountReachable = reachable
        self.isSwitchInFlight = switchInFlight

        let roleCurrentTitle = L10n.t("menu_panel.quota.current_account", fallback: "当前账号")
        let switchToTitle = L10n.t("menu_panel.account_card.switch_to", fallback: "切换至该账号")
        stateIcon.image = NSImage(systemSymbolName: isCurrent ? "checkmark.circle.fill" : "circle", accessibilityDescription: isCurrent ? roleCurrentTitle : switchToTitle)
        stateIcon.contentTintColor = isCurrent ? Design.blue : Design.secondary.withAlphaComponent(0.45)
        stateButton.toolTip = nil
        stateButton.setAccessibilityLabel(isCurrent ? roleCurrentTitle : switchToTitle)
        stateButton.setAccessibilityRole(.button)
        nameLabel.stringValue = display
        emailLabel.stringValue = email
        emailLabel.toolTip = nil

        tierBadge.title = tier
        tierBadge.isHidden = tier.isEmpty

        if isCurrent {
            if hasSshHosts {
                statusBadge.title = L10n.t("ssh.presence.current_local", fallback: "本机当前")
                statusBadge.tint = Design.blue
                statusBadge.isHidden = false
            } else {
                statusBadge.title = ""
                statusBadge.isHidden = true
            }
        } else if isRecommended {
            statusBadge.title = L10n.t("menu_panel.account_card.recommended", fallback: "推荐备用")
            statusBadge.tint = .systemGreen
            statusBadge.isHidden = false
        } else {
            statusBadge.title = ""
            statusBadge.isHidden = true
        }

        let activeSshHosts = matchingSshHosts.filter { $0.state != .historicalOnly }
        sshPresenceBadge.toolTip = nil
        if let primary = activeSshHosts.first {
            let effectiveState: SshHostState = activeSshHosts.contains(where: { $0.state == .authExpired })
                ? .authExpired
                : (activeSshHosts.contains(where: { $0.state == .online }) ? .online : primary.state)
            sshPresenceBadge.update(
                hostLabel: primary.hostLabel,
                state: effectiveState,
                windowCount: primary.windowCount,
                extraCount: max(0, activeSshHosts.count - 1)
            )
            sshPresenceBadge.isHidden = false
        } else {
            sshPresenceBadge.isHidden = true
        }

        borderColor = isCurrent ? Design.dynamicAlpha(Design.blue, 0.42) : Design.popoverCardBorder
        borderWidth = isCurrent ? 1.25 : 1.0
        fillColor = Design.popoverCardBackground
        chevronIcon.image = NSImage(systemSymbolName: isExpanded ? "chevron.up" : "chevron.down", accessibilityDescription: nil)
        let animatedToggle = (wasExpanded != nil && wasExpanded != isExpanded && Design.shouldAnimate(in: self))
        wasExpanded = isExpanded
        detailContainer.isHidden = !isExpanded
        if animatedToggle && isExpanded {
            detailContainer.wantsLayer = true
            detailContainer.alphaValue = 0.0
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.18
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                detailContainer.animator().alphaValue = 1.0
            }
        } else {
            detailContainer.alphaValue = 1.0
        }
        let roleText = isCurrent ? roleCurrentTitle : L10n.t("menu_panel.account_card.backup_account", fallback: "备用账号")
        headerButton.setAccessibilityLabel(L10n.t("menu_panel.account_card.a11y", ["name": display, "email": email, "role": roleText, "summary": summary], fallback: "\(display)，\(email)，\(roleText)，\(summary)"))

        let now = Date()
        let sourceEnvId = (account["quotaSourceEnvironmentId"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let sourceHost = !sourceEnvId.isEmpty ? matchingSshHosts.first(where: { $0.environmentId == sourceEnvId }) : nil
        let hasOnlineSshHost = matchingSshHosts.contains(where: { $0.state == .online })
        let isRemoteActive = sourceHost != nil || hasOnlineSshHost
        let rawStandbyMode = ((account["standbyRefreshStatus"] as? [String: Any])?["mode"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines)
        let standbyMode = isRemoteActive ? nil : rawStandbyMode
        let contractInput: [String: Any]
        if isRemoteActive, account["standbyRefreshStatus"] != nil {
            var sanitized = account
            sanitized.removeValue(forKey: "standbyRefreshStatus")
            contractInput = sanitized
        } else {
            contractInput = account
        }
        let contract = QuotaPresentation.contract(contractInput)
        let quota = account["quota"] as? [String: Any]
        let rawStamp = QuotaPresentation.number(quota?["last_updated"]) ?? QuotaPresentation.number(account["quota_last_updated"]) ?? 0
        let stamp = rawStamp > 10_000_000_000 ? rawStamp / 1000.0 : rawStamp
        let freshness = SshEnvironmentResolver.resolveQuotaFreshness(
            forAccount: account,
            staleThresholdSeconds: staleThresholdSeconds,
            now: now
        )
        let explicitAccountFreshness = QuotaFreshness(rawValueOrNil: (account["quotaFreshness"] as? String) ?? (quota?["quotaFreshness"] as? String))
        let forceAllStale = (freshness == .offlineSnapshot || freshness == .errorFallback || freshness == .authExpired || explicitAccountFreshness == .stale || (stamp > 0 && now.timeIntervalSince1970 - stamp > staleThresholdSeconds))
        struct DynamicMeterSpec {
            let title: String
            let groupName: String
            let percentage: Int?
            let placeholder: String
            let reset: String
            let stale: Bool
        }
        var specs: [DynamicMeterSpec] = []
        for group in contract.displayGroups {
            if group.windows.isEmpty {
                let fallbackLabel = L10n.t("quota.model_quota", fallback: "模型配额")
                let ph = group.availability == "disabled" ? L10n.t("common.unavailable", fallback: "不可用") : L10n.t("common.unknown", fallback: "未知")
                specs.append(DynamicMeterSpec(
                    title: "\(group.displayName) · \(fallbackLabel)",
                    groupName: group.displayName,
                    percentage: nil,
                    placeholder: ph,
                    reset: "",
                    stale: false
                ))
            } else {
                for win in group.windows {
                    specs.append(DynamicMeterSpec(
                        title: group.barTitle(for: win),
                        groupName: group.displayName,
                        percentage: win.percentage,
                        placeholder: win.placeholder(availability: group.availability),
                        reset: win.percentage == nil ? "" : win.effectiveResetText(at: now, standbyMode: standbyMode, compact: true),
                        stale: win.effectiveStale(at: now) || forceAllStale
                    ))
                }
            }
        }
        if quotaRowViews.count != specs.count {
            quotaRowsStack.arrangedSubviews.forEach {
                quotaRowsStack.removeArrangedSubview($0)
                $0.removeFromSuperview()
            }
            quotaRowViews = specs.map { spec in
                let row = MenuMeterRow(title: spec.title)
                quotaRowsStack.addArrangedSubview(row)
                fillWidth(row, in: quotaRowsStack)
                return row
            }
        }
        for (idx, spec) in specs.enumerated() where idx < quotaRowViews.count {
            let row = quotaRowViews[idx]
            row.titleLabel.stringValue = spec.title
            row.accessibilityGroupName = spec.groupName
            row.apply(percentage: spec.percentage, placeholder: spec.placeholder, reset: spec.reset, stale: spec.stale)
        }

        var warnings: [String] = []
        if let readiness = account["credentialReadiness"] as? [String: Any], readiness["state"] as? String == "needs_authorization" {
            warnings.append(L10n.t("menu_panel.quota.reauth_needed", fallback: "登录授权已失效，请前往主界面重新授权"))
        }
        if let singleError, !singleError.isEmpty {
            warnings.append(InterfaceText.quotaMessage(singleError))
        } else if let refreshErr = account["quota_refresh_error"] as? String, !refreshErr.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, !InterfaceText.isInternalDualWindowError(refreshErr) {
            warnings.append(InterfaceText.quotaMessage(refreshErr))
        }
        if let quota = account["quota"] as? [String: Any], let staleGroups = quota["stale_groups"] as? [[String: Any]], !staleGroups.isEmpty {
            let names = staleGroups.compactMap { $0["name"] as? String }.filter { !$0.isEmpty }
            let sep = L10n.shared.isEnglish ? ", " : "、"
            let namesStr = names.isEmpty ? L10n.t("menu_panel.quota.partial_groups", fallback: "部分分组") : names.joined(separator: sep)
            warnings.append(L10n.t("menu_panel.quota.stale_groups", ["names": namesStr], fallback: "部分分组沿用上次记录：\(namesStr)"))
        }
        let contractWarn = QuotaPresentation.warningSummary(contract, excluding: warnings)
        if !contractWarn.isEmpty {
            warnings.append(contractWarn)
        }
        if !warnings.isEmpty {
            warningLabel.stringValue = warnings.joined(separator: L10n.shared.isEnglish ? "; " : "；")
            warningLabel.textColor = accessibleWarningColor()
            warningLabel.isHidden = false
        } else if let singleNotice = singleNotice?.trimmingCharacters(in: .whitespacesAndNewlines), !singleNotice.isEmpty {
            warningLabel.stringValue = singleNotice
            warningLabel.textColor = .secondaryLabelColor
            warningLabel.isHidden = false
        } else {
            warningLabel.stringValue = ""
            warningLabel.isHidden = true
        }

        if let standbyMode, standbyMode == "snapshot_cooldown_elapsed" {
            timestampLabel.stringValue = L10n.t("accounts.standby.reset_passed", fallback: "已到重置时间 · 切换后更新")
            timestampLabel.textColor = Design.blue
            timestampLabel.toolTip = nil
            timestampLabel.setAccessibilityHelp(L10n.t("accounts.standby.multi_device_hint"))
            timestampLabel.isHidden = false
        } else if let standbyMode, standbyMode == "snapshot_cooling", stamp > 0 {
            let date = Date(timeIntervalSince1970: stamp)
            let fmt = Calendar.current.isDateInToday(date) ? Self.todayFormatter : Self.dateFormatter
            timestampLabel.stringValue = L10n.t("accounts.standby.recorded_at", ["time": fmt.string(from: date)], fallback: "记录于 \(fmt.string(from: date)) · 切换后更新")
            timestampLabel.textColor = .secondaryLabelColor
            timestampLabel.toolTip = nil
            timestampLabel.setAccessibilityHelp(L10n.t("accounts.standby.multi_device_hint"))
            timestampLabel.isHidden = false
        } else if stamp > 0 {
            let date = Date(timeIntervalSince1970: stamp)
            let fmt = Calendar.current.isDateInToday(date) ? Self.todayFormatter : Self.dateFormatter
            let isStale = freshness.isStaleOrDegraded
            let timeStr = fmt.string(from: date)
            let displayRemoteHost = sourceHost ?? (!isCurrent && sourceEnvId != "local" ? matchingSshHosts.first(where: { $0.state == .online }) : nil)
            if let displayRemoteHost {
                let syncNote = L10n.t("accounts.ssh.quota_from_remote", ["host": displayRemoteHost.cleanHostLabel], fallback: "同步自 \(displayRemoteHost.cleanHostLabel)")
                timestampLabel.stringValue = "\(syncNote) · \(timeStr)"
            } else {
                timestampLabel.stringValue = L10n.t("common.updated_at", ["time": timeStr], fallback: "更新于 \(timeStr)")
            }
            timestampLabel.textColor = isStale ? accessibleWarningColor() : Design.secondary
            timestampLabel.toolTip = nil
            timestampLabel.setAccessibilityHelp(nil)
            timestampLabel.isHidden = false
        } else {
            timestampLabel.stringValue = ""
            timestampLabel.textColor = Design.secondary
            timestampLabel.toolTip = nil
            timestampLabel.setAccessibilityHelp(nil)
            timestampLabel.isHidden = true
        }

        let canSwitch = !isCurrent && account["disabled"] as? Bool != true && account["validation_blocked"] as? Bool != true
        self.canSwitchAccount = canSwitch
        stateButton.isEnabled = canSwitch && reachable && !switchInFlight
        switchButton.isHidden = isCurrent
        switchButton.isEnabled = canSwitch && reachable && !switchInFlight
        singleRefreshButton.setRefreshState(busy: globalBusy || singleBusy, available: reachable && !globalBusy, error: singleError)
    }

    @objc private func stateIconClicked() {
        guard canSwitchAccount && !isCurrentAccount && isAccountReachable && !isSwitchInFlight else { return }
        onSwitchAccount?(accountId)
    }

    @objc private func headerClicked() {
        onToggleExpand?(accountId)
    }

    @objc private func switchPressed() {
        onSwitchAccount?(accountId)
    }

    @objc private func refreshSinglePressed() {
        onRefreshSingle?(accountId)
    }

    @objc private func copyEmail() {
        guard !fullEmail.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(fullEmail, forType: .string)
    }

    deinit { hoverMotion.cancel() }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { hoverMotion.cancel() }
    }
}

/// 顶栏 brand 与 EnvironmentContextPill 之间的 1pt × 14pt 极淡竖线分割符。
final class MenuHeaderVerticalDividerView: NSView {
    override var allowsVibrancy: Bool { false }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError() }

    override var intrinsicContentSize: NSSize { NSSize(width: 1, height: 14) }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let color = isDark
            ? NSColor.white.withAlphaComponent(0.14)
            : NSColor.black.withAlphaComponent(0.10)
        color.setFill()
        bounds.fill()
    }
}

/// 统一 5.5pt SSH 状态圆点（在线=绿实心，过期=琥珀实心，离线=灰空心）。
final class MenuSshStatusDotView: NSView {
    override var allowsVibrancy: Bool { false }
    var state: SshHostState = .online {
        didSet {
            guard oldValue != state else { return }
            needsDisplay = true
        }
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 6),
            heightAnchor.constraint(equalToConstant: 6)
        ])
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        let dotRect = NSRect(x: 0.25, y: 0.25, width: 5.5, height: 5.5)
        let color = SshEnvironmentVisuals.statusDotColor(for: state, appearance: effectiveAppearance)
        if SshEnvironmentVisuals.isStatusDotFilled(for: state) {
            color.setFill()
            NSBezierPath(ovalIn: dotRect).fill()
        } else {
            color.setStroke()
            let ring = NSBezierPath(ovalIn: dotRect.insetBy(dx: 0.65, dy: 0.65))
            ring.lineWidth = 1.15
            ring.stroke()
        }
    }
}

/// Tab 2 底部紧凑「远程只读会话」单行跳转条目：[● >_ <Host> · <Email>   <主配额%>  ›]
final class MenuRemoteHostJumpRow: NSBox {
    private let clickButton = MenuPlainClickButton(frame: .zero)
    private let statusDot = MenuSshStatusDotView()
    private let iconView = NSImageView()
    let summaryLabel = text("", size: 11, color: .labelColor)
    let quotaLabel = text("—", size: 11, weight: .semibold, color: .labelColor)
    private let chevronView: NSImageView = {
        let iv = symbol("chevron.right", size: 10.5, color: Design.secondary)
        iv.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
        iv.translatesAutoresizingMaskIntoConstraints = false
        iv.setAccessibilityElement(false)
        NSLayoutConstraint.activate([
            iv.widthAnchor.constraint(equalToConstant: 8),
            iv.heightAnchor.constraint(equalToConstant: 12)
        ])
        return iv
    }()
    private(set) var environmentId: String = ""
    var onSelect: ((String) -> Void)?
    private var hoverTrackingArea: NSTrackingArea?
    private var isHovered = false { didSet { if oldValue != isHovered { needsDisplay = true } } }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        boxType = .custom
        cornerRadius = 8
        borderWidth = 1
        borderColor = Design.popoverCardBorder
        fillColor = Design.popoverCardBackground
        contentViewMargins = .zero

        iconView.image = SshTerminalIcon.image(pointSize: 12)
        iconView.imageScaling = .scaleProportionallyDown
        iconView.contentTintColor = .secondaryLabelColor
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.setAccessibilityElement(false)
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 12),
            iconView.heightAnchor.constraint(equalToConstant: 12)
        ])

        summaryLabel.lineBreakMode = .byTruncatingMiddle
        summaryLabel.maximumNumberOfLines = 1
        summaryLabel.setContentHuggingPriority(.defaultLow, for: .horizontal)
        summaryLabel.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)

        quotaLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        quotaLabel.alignment = .right
        quotaLabel.setContentHuggingPriority(.required, for: .horizontal)
        quotaLabel.setContentCompressionResistancePriority(.required, for: .horizontal)

        chevronView.setContentHuggingPriority(.required, for: .horizontal)
        chevronView.setContentCompressionResistancePriority(.required, for: .horizontal)

        let row = horizontal([statusDot, iconView, summaryLabel, flexibleSpace(), quotaLabel, chevronView], spacing: 5)
        row.alignment = .centerY

        clickButton.target = self
        clickButton.action = #selector(rowPressed)
        clickButton.addSubview(row)
        pin(row, to: clickButton, inset: 0)

        addSubview(clickButton)
        clickButton.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            heightAnchor.constraint(equalToConstant: 28),
            clickButton.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 10),
            clickButton.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -10),
            clickButton.topAnchor.constraint(equalTo: topAnchor),
            clickButton.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    required init?(coder: NSCoder) { fatalError() }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTrackingArea { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTrackingArea = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) {
        isHovered = true
    }

    override func mouseExited(with event: NSEvent) {
        isHovered = false
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if isHovered {
            let hoverPath = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: cornerRadius, yRadius: cornerRadius)
            (isDark ? NSColor.white.withAlphaComponent(0.045) : NSColor.black.withAlphaComponent(0.025)).setFill()
            hoverPath.fill()
        }
    }

    func apply(host: CanonicalHostEnvironment) {
        environmentId = host.environmentId
        statusDot.state = host.state
        let fallbackHost = host.cleanHostLabel
        let hostPart = fallbackHost.count > 14 ? String(fallbackHost.prefix(13)) + "…" : fallbackHost
        let emailPart = host.email.isEmpty ? L10n.t("common.unknown", fallback: "未知") : host.email
        summaryLabel.stringValue = "\(hostPart) · \(emailPart)"
        summaryLabel.textColor = host.state.isOfflineLike ? Design.secondary : .labelColor

        switch host.state {
        case .authExpired:
            iconView.contentTintColor = accessibleWarningColor()
        case .offlineRecent, .historicalOnly:
            iconView.contentTintColor = Design.secondary
        case .online:
            iconView.contentTintColor = .secondaryLabelColor
        }

        let contract = QuotaPresentation.contract(host.rawSession)
        let preferredGroup = contract.displayGroups.first(where: { $0.key.lowercased() == "gemini" })
            ?? contract.displayGroups.first
        let primaryPct = preferredGroup?.windows.compactMap(\.percentage).first
            ?? contract.displayGroups.flatMap(\.windows).compactMap(\.percentage).first

        if host.state == .authExpired {
            quotaLabel.stringValue = L10n.t("ssh.picker.state.auth_expired", fallback: "授权已过期")
            quotaLabel.textColor = accessibleWarningColor()
        } else if let pct = primaryPct {
            let clamped = max(0, min(100, pct))
            quotaLabel.stringValue = "\(clamped)%"
            if clamped <= 10 {
                quotaLabel.textColor = accessibleDangerColor()
            } else if clamped <= 20 {
                quotaLabel.textColor = accessibleWarningColor()
            } else {
                quotaLabel.textColor = host.state.isOfflineLike ? Design.secondary : .labelColor
            }
        } else {
            quotaLabel.stringValue = "—"
            quotaLabel.textColor = Design.secondary
        }

        toolTip = nil
        clickButton.toolTip = nil
        clickButton.setAccessibilityLabel("\(fallbackHost), \(emailPart), \(quotaLabel.stringValue)")
    }

    @objc private func rowPressed() {
        guard !environmentId.isEmpty else { return }
        onSelect?(environmentId)
    }
}

/// Tab 2 超过 2 台未保存远端主机时展示的可点击 `+N 台 ▾` 分组菜单按钮。
final class MenuRemoteMoreHostsButton: DesignButton {
    private(set) var extraHosts: [CanonicalHostEnvironment] = []
    var onSelect: ((String) -> Void)?

    init() {
        super.init(frame: .zero)
        title = ""
        bezelStyle = .rounded
        isBordered = false
        controlSize = .small
        font = .systemFont(ofSize: 11, weight: .medium)
        let chevron = NSImage(systemSymbolName: "chevron.down", accessibilityDescription: nil)?
            .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 9.5, weight: .semibold))
        chevron?.isTemplate = true
        image = chevron
        imagePosition = .imageTrailing
        target = self
        action = #selector(buttonPressed)
        toolTip = nil
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        isHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    func update(extraHosts: [CanonicalHostEnvironment]) {
        self.extraHosts = extraHosts
        guard !extraHosts.isEmpty else {
            isHidden = true
            title = ""
            toolTip = nil
            return
        }
        title = L10n.t("overview.ssh.more_hosts_menu", ["count": extraHosts.count], fallback: "+\(extraHosts.count) 台")
        toolTip = nil
        setAccessibilityLabel(
            L10n.t("usage.env.more_hosts_a11y", ["count": extraHosts.count], fallback: "更多 \(extraHosts.count) 台 SSH 主机")
        )
        isHidden = false
    }

    func buildMenu() -> NSMenu {
        let items: [EnvironmentContextPill.Item] = extraHosts.map { host in
            let contract = QuotaPresentation.contract(host.rawSession)
            let preferredGroup = contract.displayGroups.first(where: { $0.key.lowercased() == "gemini" })
                ?? contract.displayGroups.first
            let primaryPct = preferredGroup?.windows.compactMap(\.percentage).first
                ?? contract.displayGroups.flatMap(\.windows).compactMap(\.percentage).first
            let secondary: String?
            if host.state == .authExpired {
                secondary = L10n.t("ssh.picker.state.auth_expired", fallback: "授权已过期")
            } else if let pct = primaryPct {
                secondary = "\(max(0, min(100, pct)))%"
            } else {
                secondary = nil
            }
            return EnvironmentContextPill.Item(
                scope: .remote(environmentId: host.environmentId),
                hostLabel: host.cleanHostLabel,
                state: host.state,
                windowCount: host.windowCount,
                email: host.email.isEmpty ? nil : host.email,
                secondaryText: secondary
            )
        }
        let menu = SshEnvironmentVisuals.buildGroupedMenu(items: items, fontSize: 12.5, minimumWidth: 204)
        for item in menu.items where item.representedObject != nil {
            item.target = self
            item.action = #selector(menuItemSelected(_:))
        }
        return menu
    }

    @objc private func buttonPressed() {
        guard !extraHosts.isEmpty else { return }
        if let panel = window as? MenuFloatingPanel, !panel.isKeyWindow {
            panel.makeKey()
        }
        Design.popUpMenu(buildMenu(), below: self)
    }

    @objc private func menuItemSelected(_ sender: NSMenuItem) {
        guard let envId = sender.representedObject as? String, !envId.isEmpty else { return }
        onSelect?(envId)
    }
}

final class MenuPanelRimOverlayView: NSView {
    private let cornerRadius: CGFloat

    init(cornerRadius: CGFloat) {
        self.cornerRadius = cornerRadius
        super.init(frame: .zero)
        wantsLayer = true
    }

    required init?(coder: NSCoder) { fatalError() }
    override var isOpaque: Bool { false }
    override var allowsVibrancy: Bool { false }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        guard bounds.width > 2, bounds.height > 2 else { return }
        effectiveAppearance.performAsCurrentDrawingAppearance {
            let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            let outerColor = isDark
                ? NSColor.black.withAlphaComponent(0.45)
                : NSColor.black.withAlphaComponent(0.11)
            let outerRadius = max(1, cornerRadius - 0.25)
            let outerPath = NSBezierPath(
                roundedRect: bounds.insetBy(dx: 0.25, dy: 0.25),
                xRadius: outerRadius,
                yRadius: outerRadius
            )
            outerPath.lineWidth = 0.5
            outerColor.setStroke()
            outerPath.stroke()

            let innerColor = isDark
                ? NSColor.white.withAlphaComponent(0.16)
                : NSColor.white.withAlphaComponent(0.55)
            let innerRadius = max(1, cornerRadius - 0.75)
            let innerPath = NSBezierPath(
                roundedRect: bounds.insetBy(dx: 0.75, dy: 0.75),
                xRadius: innerRadius,
                yRadius: innerRadius
            )
            innerPath.lineWidth = 0.5
            innerColor.setStroke()
            innerPath.stroke()
        }
    }
}

final class MenuPanelRootView: NSVisualEffectView {
    static let cornerRadius: CGFloat = Design.Radius.card

    private static let cachedCornerMaskImage: NSImage = {
        let r = cornerRadius
        let dim = r * 2 + 2
        let img = NSImage(size: NSSize(width: dim, height: dim), flipped: false) { rect in
            NSColor.black.setFill()
            NSBezierPath(roundedRect: rect, xRadius: r, yRadius: r).fill()
            return true
        }
        img.capInsets = NSEdgeInsets(top: r, left: r, bottom: r, right: r)
        img.resizingMode = .stretch
        img.isTemplate = false
        return img
    }()

    let rimOverlay = MenuPanelRimOverlayView(cornerRadius: MenuPanelRootView.cornerRadius)

    override var allowsVibrancy: Bool { false }
    init() {
        super.init(frame: .zero)
        material = .popover
        blendingMode = .behindWindow
        state = .active
        wantsLayer = true
        maskImage = Self.cachedCornerMaskImage
    }
    required init?(coder: NSCoder) { fatalError() }
    override var isOpaque: Bool { false }

    func installRimOverlay() {
        if rimOverlay.superview === self {
            if subviews.last !== rimOverlay {
                rimOverlay.removeFromSuperview()
            } else {
                return
            }
        }
        rimOverlay.translatesAutoresizingMaskIntoConstraints = false
        addSubview(rimOverlay)
        NSLayoutConstraint.activate([
            rimOverlay.leadingAnchor.constraint(equalTo: leadingAnchor),
            rimOverlay.trailingAnchor.constraint(equalTo: trailingAnchor),
            rimOverlay.topAnchor.constraint(equalTo: topAnchor),
            rimOverlay.bottomAnchor.constraint(equalTo: bottomAnchor)
        ])
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        rimOverlay.needsDisplay = true
    }
}

final class MenuPanelFooterHostView: NSView {
    override var allowsVibrancy: Bool { false }
    override var isOpaque: Bool { false }
    override func draw(_ dirtyRect: NSRect) {
        guard bounds.width > 0, bounds.height > 0 else { return }
        NSGraphicsContext.saveGraphicsState()
        defer { NSGraphicsContext.restoreGraphicsState() }
        let r = min(MenuPanelRootView.cornerRadius, min(bounds.width / 2, bounds.height))
        if r > 0 {
            let path = NSBezierPath()
            path.move(to: NSPoint(x: bounds.minX, y: bounds.maxY))
            path.line(to: NSPoint(x: bounds.minX, y: bounds.minY + r))
            path.appendArc(
                withCenter: NSPoint(x: bounds.minX + r, y: bounds.minY + r),
                radius: r,
                startAngle: 180,
                endAngle: 270,
                clockwise: false
            )
            path.line(to: NSPoint(x: bounds.maxX - r, y: bounds.minY))
            path.appendArc(
                withCenter: NSPoint(x: bounds.maxX - r, y: bounds.minY + r),
                radius: r,
                startAngle: 270,
                endAngle: 360,
                clockwise: false
            )
            path.line(to: NSPoint(x: bounds.maxX, y: bounds.maxY))
            path.close()
            path.addClip()
        }
        Design.popoverFooterBackground.setFill()
        bounds.fill()
    }
}
