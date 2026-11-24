import Cocoa

final class SidebarRowView: NSTableRowView {
    override var allowsVibrancy: Bool { false }
    override var isEmphasized: Bool {
        get { false }
        set {}
    }
    override var interiorBackgroundStyle: NSView.BackgroundStyle { .normal }
    var navigationSelected = false { didSet { needsDisplay = true } }
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0

    deinit {
        hoverMotion.cancel()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hoverMotion.cancel()
            hovered = false
            hoverProgress = 0
        }
    }
    var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            hoverMotion.animate(in: self, from: hoverProgress, to: hovered ? 1.0 : 0.0, curve: .hover, threshold: 0.04) { [weak self] val in
                self?.hoverProgress = val
                self?.needsDisplay = true
            }
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }
    override func drawSelection(in dirtyRect: NSRect) {}
    override func drawBackground(in dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let rect = bounds.insetBy(dx: 0.5, dy: 1.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)
        if hoverProgress > 0.02 && !navigationSelected {
            let hoverFill = isDark
                ? NSColor.white.withAlphaComponent(0.065 * hoverProgress)
                : NSColor.black.withAlphaComponent(0.048 * hoverProgress)
            hoverFill.setFill()
            path.fill()
        }
    }
}

// MARK: - Refined Sidebar Bottom Launcher Button (Matches SidebarRowView geometry & vector SF Symbols)
final class SidebarLaunchButton: NSButton {
    override var allowsVibrancy: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private let pressMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    private var pressProgress: CGFloat = 0
    private var lastHighlighted = false
    private var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            hoverMotion.animate(in: self, from: hoverProgress, to: hovered ? 1.0 : 0.0, curve: .hover, threshold: 0.04) { [weak self] val in
                guard let self else { return }
                let wasActive = self.hoverProgress > 0.5
                self.hoverProgress = val
                if (val > 0.5) != wasActive {
                    self.syncForegroundColors()
                }
                self.needsDisplay = true
            }
        }
    }
    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != lastHighlighted else { return }
            lastHighlighted = isHighlighted
            syncForegroundColors()
            pressMotion.animate(in: self, from: pressProgress, to: isHighlighted ? 1.0 : 0.0, curve: .press, threshold: 0.02) { [weak self] val in
                self?.pressProgress = val
                self?.needsDisplay = true
            }
        }
    }
    deinit { hoverMotion.cancel(); pressMotion.cancel() }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hoverMotion.cancel()
            pressMotion.cancel()
            hovered = false
            hoverProgress = 0
            pressProgress = 0
            syncForegroundColors()
        }
    }

    let iconView = NSImageView()
    let titleField: NSTextField
    let badgeLabel = text("", size: 11, weight: .semibold, color: Design.blue)
    let isUpdatePrompt: Bool

    var badgeText: String {
        get { badgeLabel.stringValue }
        set {
            badgeLabel.stringValue = newValue
            badgeLabel.isHidden = newValue.isEmpty
            syncAccessibilityLabel()
            needsDisplay = true
        }
    }

    func setDisplayTitle(_ title: String) {
        self.title = title
        titleField.stringValue = title
        syncAccessibilityLabel()
    }

    private func syncAccessibilityLabel() {
        let titleText = titleField.stringValue
        let badge = badgeLabel.stringValue
        guard !badge.isEmpty else {
            setAccessibilityLabel(titleText)
            return
        }
        let separator = L10n.shared.isEnglish ? ", " : "，"
        setAccessibilityLabel("\(titleText)\(separator)\(badge)")
    }

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 36)
    }

    init(title: String? = nil, symbolName: String = "arrow.up.forward.app", isUpdatePrompt: Bool = false, target: AnyObject?, action: Selector) {
        let resolvedTitle = title ?? L10n.t("sidebar.open_antigravity", fallback: "打开 Antigravity")
        self.isUpdatePrompt = isUpdatePrompt
        self.titleField = text(resolvedTitle, size: 13, weight: isUpdatePrompt ? .semibold : .medium, color: Design.dynamicAlpha(Design.primary, 0.86))
        super.init(frame: .zero)
        self.title = resolvedTitle
        self.target = target
        self.action = action
        bezelStyle = .inline
        isBordered = false
        focusRingType = .none
        setButtonType(.momentaryChange)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 36).isActive = true
        syncAccessibilityLabel()

        iconView.image = NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 14.5, weight: isUpdatePrompt ? .semibold : .medium)
        iconView.translatesAutoresizingMaskIntoConstraints = false
        iconView.setAccessibilityElement(false)
        NSLayoutConstraint.activate([
            iconView.widthAnchor.constraint(equalToConstant: 18),
            iconView.heightAnchor.constraint(equalToConstant: 18)
        ])

        titleField.lineBreakMode = .byTruncatingTail
        titleField.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
        titleField.setAccessibilityElement(false)

        badgeLabel.font = .monospacedDigitSystemFont(ofSize: 11, weight: .semibold)
        badgeLabel.isHidden = true
        badgeLabel.setContentHuggingPriority(.required, for: .horizontal)
        badgeLabel.setContentCompressionResistancePriority(.required, for: .horizontal)
        badgeLabel.setAccessibilityElement(false)

        let spacer = flexibleSpace()
        let row = horizontal([iconView, titleField, spacer, badgeLabel], spacing: 10)
        row.setCustomSpacing(6, after: titleField)
        row.setCustomSpacing(0, after: spacer)
        row.alignment = .centerY
        row.detachesHiddenViews = true
        addSubview(row)
        row.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            row.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12),
            row.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -12),
            row.centerYAnchor.constraint(equalTo: centerYAnchor)
        ])
        syncForegroundColors()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func syncForegroundColors() {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let active = isHighlighted || hoverProgress > 0.5
        let accentTint = Design.activeBlue
        if isUpdatePrompt {
            iconView.contentTintColor = accentTint
            titleField.textColor = isDark ? .white : Design.blue
            badgeLabel.textColor = accentTint.withAlphaComponent(isDark ? 0.88 : 0.82)
        } else {
            iconView.contentTintColor = active ? accentTint : Design.secondary
            titleField.textColor = active ? (isDark ? .white : Design.blue) : Design.primary.withAlphaComponent(0.84)
        }
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        syncForegroundColors()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        super.hitTest(point) == nil ? nil : self
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInActiveApp, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) {
        hovered = true
        syncForegroundColors()
    }

    override func mouseExited(with event: NSEvent) {
        hovered = false
        syncForegroundColors()
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let pp = isHighlighted ? max(pressProgress, 0.72) : pressProgress
        let scale: CGFloat = 1.0 - 0.02 * pp
        let gctx = NSGraphicsContext.current
        gctx?.saveGraphicsState()
        if abs(scale - 1.0) > 0.001, let cg = gctx?.cgContext {
            cg.translateBy(x: bounds.midX, y: bounds.midY)
            cg.scaleBy(x: scale, y: scale)
            cg.translateBy(x: -bounds.midX, y: -bounds.midY)
        }
        let rect = bounds.insetBy(dx: 0.5, dy: 1.5)
        let path = NSBezierPath(roundedRect: rect, xRadius: 9, yRadius: 9)

        if isUpdatePrompt {
            if isHighlighted {
                Design.blue.withAlphaComponent(isDark ? 0.26 : 0.16).setFill()
                path.fill()
            } else {
                let baseAlpha: CGFloat = isDark ? 0.15 : 0.085
                let hoverBoost: CGFloat = (isDark ? 0.07 : 0.05) * hoverProgress
                Design.blue.withAlphaComponent(baseAlpha + hoverBoost).setFill()
                path.fill()
            }
            Design.inactivePillBorder.setStroke()
            path.lineWidth = 0.75
            path.stroke()
        } else {
            if isHighlighted {
                Design.blue.withAlphaComponent(isDark ? 0.20 : 0.12).setFill()
                path.fill()
            } else if hoverProgress > 0.02 {
                let hoverFill = isDark ? NSColor.white.withAlphaComponent(0.08 * hoverProgress) : NSColor.black.withAlphaComponent(0.048 * hoverProgress)
                hoverFill.setFill()
                path.fill()
            }
        }

        if window?.firstResponder === self {
            Design.blue.setStroke()
            path.lineWidth = 2
            path.stroke()
        }
        gctx?.restoreGraphicsState()
    }
}
