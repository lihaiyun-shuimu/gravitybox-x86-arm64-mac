import Cocoa

final class CacheCompositionBar: NSView {
    var safeBytes: Int64 = 0 { didSet { animateFractions() } }
    var statefulBytes: Int64 = 0 { didSet { animateFractions() } }
    var protectedBytes: Int64 = 0 { didSet { animateFractions() } }

    private var displayedSafeFrac: CGFloat = 0
    private var displayedStatefulFrac: CGFloat = 0
    private let motion = DesignMotion()

    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: 8)
    }

    override init(frame frameRect: NSRect = .zero) {
        super.init(frame: frameRect)
        translatesAutoresizingMaskIntoConstraints = false
        heightAnchor.constraint(equalToConstant: 8).isActive = true
        setAccessibilityElement(true)
        setAccessibilityRole(.progressIndicator)
        setAccessibilityLabel(L10n.t("maintenance.composition_a11y"))
        syncAccessibilityValue()
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        motion.cancel()
    }

    private func syncAccessibilityValue() {
        let total = safeBytes + statefulBytes + protectedBytes
        guard total > 0 else {
            setAccessibilityValue("0%")
            return
        }
        let clearablePercent = min(100, max(0, Int(round(Double(safeBytes + statefulBytes) / Double(total) * 100.0))))
        setAccessibilityValue("\(clearablePercent)%")
    }

    private func animateFractions() {
        syncAccessibilityValue()
        let total = max(1, safeBytes + statefulBytes + protectedBytes)
        let targetSafe = safeBytes > 0 ? CGFloat(safeBytes) / CGFloat(total) : 0
        let targetStateful = statefulBytes > 0 ? CGFloat(statefulBytes) / CGFloat(total) : 0
        motion.cancel()
        let startSafe = displayedSafeFrac
        let startStateful = displayedStatefulFrac
        guard Design.shouldAnimate(in: self),
              (abs(targetSafe - startSafe) >= 0.005 || abs(targetStateful - startStateful) >= 0.005) else {
            displayedSafeFrac = targetSafe
            displayedStatefulFrac = targetStateful
            needsDisplay = true
            return
        }
        motion.animate(in: self, from: 0.0, to: 1.0, curve: .sweep, threshold: 0.005) { [weak self] progress in
            guard let self else { return }
            self.displayedSafeFrac = startSafe + (targetSafe - startSafe) * progress
            self.displayedStatefulFrac = startStateful + (targetStateful - startStateful) * progress
            self.needsDisplay = true
        } completion: { [weak self] in
            self?.displayedSafeFrac = targetSafe
            self?.displayedStatefulFrac = targetStateful
            self?.needsDisplay = true
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            motion.cancel()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        let trackRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: radius, yRadius: radius)
        Design.track.setFill()
        trackPath.fill()

        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

        guard safeBytes > 0 || statefulBytes > 0 || protectedBytes > 0 else { return }

        NSGraphicsContext.current?.saveGraphicsState()
        trackPath.addClip()

        let usableWidth = bounds.width
        var cursorX: CGFloat = 0

        if safeBytes > 0 && displayedSafeFrac > 0 {
            let w = max(8, min(usableWidth, round(usableWidth * displayedSafeFrac)))
            let segRect = NSRect(x: cursorX, y: 0, width: w, height: bounds.height)
            if let grad = NSGradient(starting: Design.blue.withAlphaComponent(0.75), ending: Design.blue) {
                grad.draw(in: segRect, angle: 0)
            } else {
                Design.blue.setFill()
                segRect.fill()
            }
            cursorX = min(usableWidth, cursorX + w + 2)
        }

        if statefulBytes > 0 && displayedStatefulFrac > 0 && cursorX < usableWidth {
            let w = max(6, min(usableWidth - cursorX, round(usableWidth * displayedStatefulFrac)))
            Design.color(0xD97706, 0xFBBF24).withAlphaComponent(0.88).setFill()
            NSRect(x: cursorX, y: 0, width: w, height: bounds.height).fill()
            cursorX = min(usableWidth, cursorX + w + 2)
        }

        if protectedBytes > 0 && cursorX < usableWidth {
            let protWidth = max(0, usableWidth - cursorX)
            if protWidth > 0 {
                let protColor = isDark
                    ? NSColor.white.withAlphaComponent(0.26)
                    : NSColor.black.withAlphaComponent(0.18)
                protColor.setFill()
                NSRect(x: cursorX, y: 0, width: protWidth, height: bounds.height).fill()
            }
        }

        NSGraphicsContext.current?.restoreGraphicsState()
    }
}

// MARK: - Subtle HIG Info Disclosure Button & Zero-Inset Interactive Trigger Group
final class MaintenanceInfoButton: NSButton {
    override var allowsVibrancy: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
    var isActivePopover: Bool = false {
        didSet {
            if oldValue != isActivePopover { applyTint() }
        }
    }
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { applyTint() }
        }
    }
    override var isHighlighted: Bool {
        didSet { applyTint() }
    }

    init(accessibilityLabel: String, target: AnyObject?, action: Selector) {
        super.init(frame: .zero)
        self.target = target
        self.action = action
        title = ""
        imagePosition = .imageOnly
        isBordered = false
        bezelStyle = .inline
        focusRingType = .exterior
        toolTip = nil
        setButtonType(.momentaryChange)
        image = NSImage(systemSymbolName: "info.circle", accessibilityDescription: nil)
        symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11.5, weight: .medium)
        translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            widthAnchor.constraint(equalToConstant: 16),
            heightAnchor.constraint(equalToConstant: 16)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setAccessibilityLabel(accessibilityLabel)
        applyTint()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func applyTint() {
        if isActivePopover || isHighlighted {
            contentTintColor = Design.blue
        } else if hovered {
            contentTintColor = Design.blue.withAlphaComponent(0.86)
        } else {
            contentTintColor = Design.secondary.withAlphaComponent(0.68)
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { hovered = false }
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func drawFocusRingMask() {
        NSBezierPath(ovalIn: bounds).fill()
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

final class MaintenanceInteractiveGroup: NSView {
    override var allowsVibrancy: Bool { false }
    override var acceptsFirstResponder: Bool { true }
    var onActivate: ((NSView) -> Void)?
    var isActivePopover: Bool = false {
        didSet {
            if oldValue != isActivePopover { updateAppearanceState() }
        }
    }
    private var hoverTracking: NSTrackingArea?
    private var hovered = false {
        didSet {
            if oldValue != hovered { updateAppearanceState() }
        }
    }
    private var pressed = false {
        didSet {
            if oldValue != pressed { updateAppearanceState() }
        }
    }

    init(content: NSView, accessibilityLabel: String, onActivate: ((NSView) -> Void)? = nil) {
        self.onActivate = onActivate
        super.init(frame: .zero)
        focusRingType = .exterior
        translatesAutoresizingMaskIntoConstraints = false
        toolTip = nil
        addSubview(content)
        pin(content, to: self, inset: 0)
        setAccessibilityElement(true)
        setAccessibilityRole(.button)
        setAccessibilityLabel(accessibilityLabel)
    }

    required init?(coder: NSCoder) { fatalError() }

    private func updateAppearanceState() {
        if pressed {
            alphaValue = 0.72
        } else if hovered || isActivePopover {
            alphaValue = 0.88
        } else {
            alphaValue = 1.0
        }
    }

    func performClick(_ sender: Any? = nil) {
        onActivate?(self)
    }

    override func accessibilityPerformPress() -> Bool {
        guard !isHiddenOrHasHiddenAncestor, let onActivate else { return false }
        onActivate(self)
        return true
    }

    override var focusRingMaskBounds: NSRect { bounds }

    override func drawFocusRingMask() {
        NSBezierPath(roundedRect: bounds, xRadius: 6, yRadius: 6).fill()
    }

    override func hitTest(_ point: NSPoint) -> NSView? {
        let local = superview?.convert(point, to: self) ?? point
        return bounds.contains(local) ? self : nil
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }

    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false; pressed = false }

    override func mouseDown(with event: NSEvent) {
        pressed = true
    }

    override func mouseUp(with event: NSEvent) {
        let wasPressed = pressed
        pressed = false
        let pt = convert(event.locationInWindow, from: nil)
        if wasPressed && bounds.contains(pt) {
            onActivate?(self)
        }
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 49 || event.keyCode == 36 || event.keyCode == 76 {
            onActivate?(self)
        } else {
            super.keyDown(with: event)
        }
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hovered = false
            pressed = false
        }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        addCursorRect(bounds, cursor: .pointingHand)
    }
}

// MARK: - Simplified 3-Card · 2-Switch · 1-Click Storage & Maintenance Module ("存储与维护")
