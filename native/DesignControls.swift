import Cocoa
import QuartzCore

class DesignPopUpButton: NSPopUpButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

class DesignInlineButton: NSButton {
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

class DesignButton: NSButton {
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private let pressMotion = DesignMotion()
    private(set) var hoverProgress: CGFloat = 0
    private(set) var pressProgress: CGFloat = 0
    private var lastHighlighted = false
    var isQuietAccessory: Bool = false {
        didSet {
            guard oldValue != isQuietAccessory else { return }
            invalidateIntrinsicContentSize()
            needsDisplay = true
        }
    }

    var isActivitySpinning: Bool { false }

    var hovered = false {
        didSet {
            guard oldValue != hovered else { return }
            let target: CGFloat = hovered ? 1.0 : 0.0
            hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover, threshold: 0.02) { [weak self] val in
                guard let self else { return }
                self.hoverProgress = val
                self.needsDisplay = true
            }
        }
    }
    override var isHighlighted: Bool {
        didSet {
            guard isHighlighted != lastHighlighted else { return }
            lastHighlighted = isHighlighted
            let target: CGFloat = isHighlighted ? 1.0 : 0.0
            pressMotion.animate(in: self, from: pressProgress, to: target, curve: .press, threshold: 0.01) { [weak self] val in
                guard let self else { return }
                self.pressProgress = val
                self.needsDisplay = true
            }
        }
    }
    override var allowsVibrancy: Bool { false }
    // The shared renderer owns keyboard focus; suppress AppKit's second bezel-shaped ring.
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        focusRingType = .none
        isBordered = false
        bezelStyle = .rounded
    }
    required init?(coder: NSCoder) {
        super.init(coder: coder)
        focusRingType = .none
        isBordered = false
        bezelStyle = .rounded
    }
    deinit {
        hoverMotion.cancel()
        pressMotion.cancel()
    }
    override var wantsDefaultClipping: Bool { true }
    override var alignmentRectInsets: NSEdgeInsets { NSEdgeInsets() }

    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func accessibilityLabel() -> String? {
        if let explicit = super.accessibilityLabel(), !explicit.isEmpty {
            return explicit
        }
        return title.isEmpty ? nil : title
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            hoverMotion.cancel()
            pressMotion.cancel()
            if hoverProgress != 0 { hoverProgress = 0 }
            if pressProgress != 0 { pressProgress = 0 }
        } else {
            updateTrackingAreas()
        }
    }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        let activeOption: NSTrackingArea.Options = Design.isInPopover(self) ? .activeAlways : .activeInKeyWindow
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, activeOption, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { if isEnabled { hovered = true } }
    override func mouseExited(with event: NSEvent) { hovered = false }

    override var intrinsicContentSize: NSSize {
        let isSmall = controlSize == .small
        let btnHeight: CGFloat = isSmall ? 24 : 28
        if title.isEmpty, image != nil {
            return NSSize(width: isQuietAccessory ? 26 : 30, height: isQuietAccessory ? 26 : btnHeight)
        }
        let defaultFont = NSFont.systemFont(ofSize: isSmall ? 11.5 : 12, weight: .medium)
        let width = (title as NSString).size(withAttributes: [.font: font ?? defaultFont]).width
        let iconExtra: CGFloat = image != nil ? 16 : 0
        let pad: CGFloat = isQuietAccessory ? 16 : (isSmall ? 18 : 24)
        return NSSize(width: ceil(width) + pad + iconExtra, height: btnHeight)
    }

    func drawButtonChromeAndLabel(spinnerLeftInset: CGFloat? = nil, centeredSpinnerWidth: CGFloat? = nil, iconRotationRadians: CGFloat = 0) {
        let primary = bezelColor != nil
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let inPopover = Design.isInPopover(self)
        let hp = isEnabled ? hoverProgress : 0
        let pp = isHighlighted ? max(pressProgress, 0.72) : pressProgress

        // 统一轻快按压回弹：悬停不越界放大、按压优雅内缩 2.5%、松手沿 140ms 阻尼干脆回弹（异步禁用态亦不截断释放动画）
        let scale: CGFloat = 1.0 - 0.025 * pp
        let gctx = NSGraphicsContext.current
        gctx?.saveGraphicsState()
        if abs(scale - 1.0) > 0.001, let cg = gctx?.cgContext {
            let cx = bounds.midX
            let cy = bounds.midY
            cg.translateBy(x: cx, y: cy)
            cg.scaleBy(x: scale, y: scale)
            cg.translateBy(x: -cx, y: -cy)
        }

        let rect = bounds.insetBy(dx: 1.0, dy: 1.0)
        let cornerR: CGFloat = 8.5
        let path = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR)

        if primary {
            let activeLook = isEnabled || isActivitySpinning
            let topBlue = activeLook
                ? Design.color(0x1A82FF, 0x389BFF).withAlphaComponent(1.0 - 0.12 * pp + 0.04 * hp)
                : Design.color(0x4CA0FF, 0x2B7AE0)
            let botBlue = activeLook
                ? Design.blue.withAlphaComponent(0.96 - 0.12 * pp)
                : Design.color(0x2E84EB, 0x1F68C9)
            if activeLook && !inPopover {
                NSGraphicsContext.saveGraphicsState()
                let btnShadow = NSShadow()
                btnShadow.shadowColor = Design.blue.withAlphaComponent(isDark ? 0.32 : 0.22)
                btnShadow.shadowOffset = NSSize(width: 0, height: -1.0)
                btnShadow.shadowBlurRadius = 2.5
                btnShadow.set()
                botBlue.setFill()
                path.fill()
                NSGraphicsContext.restoreGraphicsState()
            } else {
                botBlue.setFill()
                path.fill()
            }
            if let grad = NSGradient(starting: topBlue, ending: botBlue) {
                grad.draw(in: path, angle: 90)
            }
            Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: true)
        } else if inPopover {
            // Pure translucent glass overlay that blends with the popover's vibrant wallpaper tint in both Light and Dark mode.
            let enableScale: CGFloat = isEnabled ? 1.0 : 0.45
            let fillColor: NSColor
            let borderColor: NSColor
            if isDark {
                let fillAlpha: CGFloat = (isHighlighted ? 0.15 : (0.08 + 0.05 * hp)) * enableScale
                let strokeAlpha: CGFloat = (0.10 + 0.06 * hp) * enableScale
                fillColor = NSColor.white.withAlphaComponent(fillAlpha)
                borderColor = NSColor.white.withAlphaComponent(strokeAlpha)
            } else {
                let fillAlpha: CGFloat = (isHighlighted ? 0.62 : (0.76 + 0.14 * hp)) * enableScale
                let strokeAlpha: CGFloat = (0.065 + 0.045 * hp) * enableScale
                fillColor = NSColor.white.withAlphaComponent(fillAlpha)
                borderColor = NSColor.black.withAlphaComponent(strokeAlpha)
            }
            fillColor.setFill()
            path.fill()
            borderColor.setStroke()
            path.lineWidth = 0.8
            path.stroke()
            if isEnabled {
                Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: isDark)
            }
        } else if isQuietAccessory {
            let activeHighlight = max(hp, pp)
            if isEnabled && activeHighlight > 0.01 {
                let fill = isDark
                    ? NSColor.white.withAlphaComponent(0.10 * hp + 0.06 * pp)
                    : NSColor.black.withAlphaComponent(0.055 * hp + 0.04 * pp)
                fill.setFill()
                NSBezierPath(roundedRect: rect.insetBy(dx: 0.5, dy: 0.5), xRadius: 7, yRadius: 7).fill()
            }
        } else {
            // 主窗口轻玻璃立体胶囊按钮（与左侧毛玻璃导航栏和菜单栏质感拉齐）
            let enableScale: CGFloat = isEnabled ? 1.0 : (isActivitySpinning ? 0.88 : 0.45)
            NSGraphicsContext.saveGraphicsState()
            if isEnabled || isActivitySpinning {
                let btnShadow = NSShadow()
                btnShadow.shadowColor = isDark
                    ? NSColor.black.withAlphaComponent(0.32 * (1.0 - 0.5 * pp))
                    : NSColor(srgbRed: 0.05, green: 0.08, blue: 0.16, alpha: (0.075 + 0.03 * hp) * (1.0 - 0.5 * pp))
                btnShadow.shadowOffset = NSSize(width: 0, height: -1.0)
                btnShadow.shadowBlurRadius = 2.2
                btnShadow.set()
            }
            let baseFill = isDark
                ? NSColor.white.withAlphaComponent((0.095 + 0.045 * hp - 0.025 * pp) * enableScale)
                : NSColor(srgbRed: 0.965, green: 0.972, blue: 0.988, alpha: (0.92 + 0.06 * hp - 0.06 * pp) * enableScale)
            baseFill.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()

            let topGlass = isDark
                ? NSColor.white.withAlphaComponent((0.13 + 0.05 * hp - 0.03 * pp) * enableScale)
                : NSColor.white.withAlphaComponent((0.96 + 0.04 * hp - 0.08 * pp) * enableScale)
            let botGlass = isDark
                ? NSColor.white.withAlphaComponent((0.07 + 0.035 * hp - 0.02 * pp) * enableScale)
                : NSColor(srgbRed: 0.935, green: 0.945, blue: 0.970, alpha: (0.86 + 0.06 * hp) * enableScale)
            if let grad = NSGradient(starting: topGlass, ending: botGlass) {
                grad.draw(in: path, angle: 90)
            }
            if isEnabled && hp > 0.01 {
                Design.blue.withAlphaComponent((isDark ? 0.08 : 0.045) * hp).setFill()
                path.fill()
            }
            let strokeColor: NSColor
            if isEnabled && hp > 0.05 {
                strokeColor = isDark
                    ? NSColor.white.withAlphaComponent(0.14 + 0.08 * hp)
                    : Design.blue.withAlphaComponent(0.18 * hp + 0.08 * (1.0 - hp))
            } else {
                strokeColor = isDark
                    ? NSColor.white.withAlphaComponent(0.12 * enableScale)
                    : NSColor.black.withAlphaComponent(0.085 * enableScale)
            }
            strokeColor.setStroke()
            path.lineWidth = 0.75
            path.stroke()
            if isEnabled {
                Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: isDark)
            }
        }

        let fgAlpha: CGFloat = primary ? ((isEnabled || isActivitySpinning) ? 1.0 : 0.88) : (isEnabled ? 1.0 : (isActivitySpinning ? 0.86 : 0.42))
        let baseFg: NSColor = primary ? .white : (isQuietAccessory ? (hp > 0.25 ? Design.primary : Design.secondary) : Design.primary)
        let fgColor = baseFg.withAlphaComponent(fgAlpha)
        let attrs: [NSAttributedString.Key: Any] = [
            .font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium),
            .foregroundColor: fgColor
        ]

        let resolvedSpinnerInset = spinnerLeftInset
        if let spinnerW = centeredSpinnerWidth {
            let textSize = title.isEmpty ? .zero : (title as NSString).size(withAttributes: attrs)
            let gap: CGFloat = title.isEmpty ? 0 : 5
            let maxTextW = max(0, bounds.width - 16 - spinnerW - gap)
            let clampedTextW = min(textSize.width, maxTextW)
            let totalW = spinnerW + gap + clampedTextW
            let startX = title.isEmpty ? round((bounds.width - spinnerW) / 2) : max(8, round((bounds.width - totalW) / 2))
            if !title.isEmpty {
                let textX = startX + spinnerW + gap
                let style = NSMutableParagraphStyle(); style.alignment = .left; style.lineBreakMode = .byTruncatingTail
                var leftAttrs = attrs; leftAttrs[.paragraphStyle] = style
                (title as NSString).draw(
                    in: NSRect(x: textX, y: (bounds.height - textSize.height) / 2, width: maxTextW, height: textSize.height),
                    withAttributes: leftAttrs
                )
            }
        } else if let leftInset = resolvedSpinnerInset {
            let style = NSMutableParagraphStyle(); style.alignment = .center; style.lineBreakMode = .byTruncatingTail
            var centeredAttrs = attrs; centeredAttrs[.paragraphStyle] = style
            let size = (title as NSString).size(withAttributes: centeredAttrs)
            let rightInset: CGFloat = 6
            (title as NSString).draw(
                in: NSRect(x: leftInset, y: (bounds.height - size.height) / 2, width: max(0, bounds.width - leftInset - rightInset), height: size.height),
                withAttributes: centeredAttrs
            )
        } else if let img = image {
            let textSize = title.isEmpty ? .zero : (title as NSString).size(withAttributes: attrs)
            let maxBox: CGFloat = title.isEmpty ? 14.0 : 13.0
            let rawSize = img.size
            let iconW: CGFloat
            let iconH: CGFloat
            if rawSize.width > 0 && rawSize.height > 0 {
                let scale = min(maxBox / rawSize.width, maxBox / rawSize.height)
                iconW = max(3.5, round(rawSize.width * scale * 2.0) / 2.0)
                iconH = max(3.5, round(rawSize.height * scale * 2.0) / 2.0)
            } else {
                iconW = maxBox
                iconH = maxBox
            }
            let gap: CGFloat = title.isEmpty ? 0 : 5
            let totalW = iconW + gap + textSize.width
            let startX = title.isEmpty ? (bounds.width - iconW) / 2 : max(8, (bounds.width - totalW) / 2)
            let iconRect = NSRect(x: startX, y: (bounds.height - iconH) / 2, width: iconW, height: iconH)
            let signedRotation = isFlipped ? iconRotationRadians : -iconRotationRadians
            let rotatedCG = (abs(signedRotation) > 0.0001) ? gctx?.cgContext : nil
            if let cg = rotatedCG {
                cg.saveGState()
                cg.translateBy(x: iconRect.midX, y: iconRect.midY)
                cg.rotate(by: signedRotation)
                cg.translateBy(x: -iconRect.midX, y: -iconRect.midY)
            }
            if img.isTemplate, let cg = gctx?.cgContext {
                cg.saveGState()
                cg.beginTransparencyLayer(in: iconRect, auxiliaryInfo: nil)
                img.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
                cg.setBlendMode(.sourceAtop)
                fgColor.setFill()
                cg.fill(iconRect)
                cg.endTransparencyLayer()
                cg.restoreGState()
            } else {
                img.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: true, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
            }
            if let cg = rotatedCG {
                cg.restoreGState()
            }
            if !title.isEmpty {
                let textX = startX + iconW + gap
                let maxTextW = max(0, bounds.width - textX - 8)
                let style = NSMutableParagraphStyle(); style.alignment = .left; style.lineBreakMode = .byTruncatingTail
                var imageTextAttrs = attrs; imageTextAttrs[.paragraphStyle] = style
                (title as NSString).draw(
                    in: NSRect(x: textX, y: (bounds.height - textSize.height) / 2, width: maxTextW, height: textSize.height),
                    withAttributes: imageTextAttrs
                )
            }
        } else {
            let textSize = (title as NSString).size(withAttributes: attrs)
            let style = NSMutableParagraphStyle(); style.alignment = .center; style.lineBreakMode = .byTruncatingTail
            var centeredAttrs = attrs; centeredAttrs[.paragraphStyle] = style
            (title as NSString).draw(in: NSRect(x: 6, y: (bounds.height - textSize.height) / 2, width: bounds.width - 12, height: textSize.height), withAttributes: centeredAttrs)
        }
        if window?.firstResponder === self { Design.blue.setStroke(); path.lineWidth = 2; path.stroke() }
        gctx?.restoreGraphicsState()
    }

    override func draw(_ dirtyRect: NSRect) {
        drawButtonChromeAndLabel(spinnerLeftInset: nil)
    }
}

final class DesignPopUpHoverOverlay: NSView {
    private var tracking: NSTrackingArea?
    private let motion = DesignMotion()

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let tracking { removeTrackingArea(tracking) }
        let activeOption: NSTrackingArea.Options = Design.isInPopover(self) ? .activeAlways : .activeInActiveApp
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, activeOption, .inVisibleRect], owner: self)
        tracking = area
        addTrackingArea(area)
    }

    private func animateHover(to target: CGFloat) {
        guard let popup = superview as? NSPopUpButton, let cell = popup.cell as? DesignPopUpCell else { return }
        guard popup.isEnabled else {
            motion.cancel()
            cell.hoverProgress = 0
            popup.needsDisplay = true
            return
        }
        motion.animate(in: popup, from: cell.hoverProgress, to: target, curve: .hover, threshold: 0.01) { [weak popup, weak cell] value in
            cell?.hoverProgress = value
            popup?.needsDisplay = true
        }
    }

    override func mouseEntered(with event: NSEvent) {
        animateHover(to: 1.0)
    }

    override func mouseExited(with event: NSEvent) {
        animateHover(to: 0.0)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            motion.cancel()
            if let popup = superview as? NSPopUpButton, let cell = popup.cell as? DesignPopUpCell {
                cell.hoverProgress = 0
            }
        } else {
            updateTrackingAreas()
        }
    }

    deinit { motion.cancel() }
}

final class DesignPopUpCell: NSPopUpButtonCell {
    enum VisualStyle {
        case form
        case headerPill
        case menuHeaderPill
    }

    var visualStyle: VisualStyle = .form
    var hoverProgress: CGFloat = 0
    var leadingSymbolName: String?
    var leadingImage: NSImage?
    var fitsSelectedTitleOnly: Bool = false
    var isActiveState: Bool = false
    var customHeight: CGFloat? = nil
    private(set) var isTrackingMenu: Bool = false

    private func presentMenuBelow(_ controlView: NSView) {
        guard isEnabled, let menu, !menu.items.isEmpty else { return }
        synchronizeTitleAndSelectedItem()
        isTrackingMenu = true
        isHighlighted = true
        controlView.needsDisplay = true
        defer {
            isTrackingMenu = false
            isHighlighted = false
            controlView.needsDisplay = true
        }
        Design.popUpMenu(menu, below: controlView, matchAnchorWidth: true)
    }

    override func trackMouse(with event: NSEvent, in cellFrame: NSRect, of controlView: NSView, untilMouseUp flag: Bool) -> Bool {
        guard isEnabled else { return false }
        presentMenuBelow(controlView)
        return true
    }

    override func performClick(withFrame cellFrame: NSRect, in controlView: NSView) {
        presentMenuBelow(controlView)
    }

    override func draw(withFrame cellFrame: NSRect, in controlView: NSView) {
        let focused = controlView.window?.firstResponder === controlView
        let isSmall = controlSize == .small
        let isDark = controlView.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let hp = hoverProgress
        let pp: CGFloat = isHighlighted ? 1.0 : 0.0
        let enableScale: CGFloat = isEnabled ? 1.0 : 0.45

        switch visualStyle {
        case .form:
            let cornerR: CGFloat = isSmall ? 7.0 : 7.5
            let rect = cellFrame.insetBy(dx: 0.75, dy: 0.75)
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR)

            NSGraphicsContext.saveGraphicsState()
            if isEnabled {
                let shadow = NSShadow()
                shadow.shadowColor = isDark
                    ? NSColor.black.withAlphaComponent(0.32 * (1.0 - 0.5 * pp))
                    : NSColor(srgbRed: 0.05, green: 0.08, blue: 0.16, alpha: (0.075 + 0.03 * hp) * (1.0 - 0.5 * pp))
                shadow.shadowOffset = NSSize(width: 0, height: -1.0)
                shadow.shadowBlurRadius = 2.2
                shadow.set()
            }
            let baseFill = isDark
                ? NSColor.white.withAlphaComponent((0.095 + 0.045 * hp - 0.025 * pp) * enableScale)
                : NSColor(srgbRed: 0.965, green: 0.972, blue: 0.988, alpha: (0.94 + 0.05 * hp - 0.06 * pp) * enableScale)
            baseFill.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()

            let topGlass = isDark
                ? NSColor.white.withAlphaComponent((0.13 + 0.05 * hp - 0.03 * pp) * enableScale)
                : NSColor.white.withAlphaComponent((0.97 + 0.03 * hp - 0.08 * pp) * enableScale)
            let botGlass = isDark
                ? NSColor.white.withAlphaComponent((0.07 + 0.035 * hp - 0.02 * pp) * enableScale)
                : NSColor(srgbRed: 0.935, green: 0.945, blue: 0.970, alpha: (0.88 + 0.06 * hp) * enableScale)
            if let grad = NSGradient(starting: topGlass, ending: botGlass) {
                grad.draw(in: path, angle: controlView.isFlipped ? -90 : 90)
            }
            if isEnabled && hp > 0.01 {
                Design.blue.withAlphaComponent((isDark ? 0.08 : 0.045) * hp).setFill()
                path.fill()
            }
            if isEnabled && isActiveState {
                let activeTintAlpha: CGFloat = isDark ? (0.18 + 0.04 * hp - 0.03 * pp) : (0.095 + 0.035 * hp - 0.02 * pp)
                Design.blue.withAlphaComponent(max(0.04, activeTintAlpha)).setFill()
                path.fill()
            }

            if focused {
                Design.blue.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            } else {
                let strokeColor: NSColor
                if isEnabled && isActiveState {
                    strokeColor = Design.blue.withAlphaComponent(isDark ? (0.46 + 0.10 * hp) : (0.34 + 0.10 * hp))
                } else if isEnabled && hp > 0.05 {
                    strokeColor = isDark
                        ? NSColor.white.withAlphaComponent(0.14 + 0.08 * hp)
                        : Design.blue.withAlphaComponent(0.18 * hp + 0.085 * (1.0 - hp))
                } else {
                    strokeColor = isDark
                        ? NSColor.white.withAlphaComponent(0.12 * enableScale)
                        : NSColor.black.withAlphaComponent(0.085 * enableScale)
                }
                strokeColor.setStroke()
                path.lineWidth = isActiveState ? 0.85 : 0.75
                path.stroke()
            }
            if isEnabled {
                Design.drawSpecularBevel(in: rect, cornerRadius: cornerR, isDark: isDark)
            }

        case .headerPill, .menuHeaderPill:
            let rect = cellFrame.insetBy(dx: 0.5, dy: 0.5)
            let isMenuPill = visualStyle == .menuHeaderPill
            let cornerR: CGFloat = isMenuPill ? Design.Radius.controlCompact : Design.Radius.control
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR)

            let fillColor: NSColor
            let strokeColor: NSColor
            if isEnabled && isActiveState {
                let lightFillAlpha: CGFloat = (isMenuPill ? 0.11 : 0.10) + 0.04 * hp + 0.02 * pp
                let darkFillAlpha: CGFloat = (isMenuPill ? 0.22 : 0.20) + 0.05 * hp + 0.03 * pp
                let lightStrokeAlpha: CGFloat = (isMenuPill ? 0.24 : 0.26) + 0.10 * hp
                let darkStrokeAlpha: CGFloat = (isMenuPill ? 0.36 : 0.38) + 0.10 * hp
                fillColor = Design.blue.withAlphaComponent(isDark ? darkFillAlpha : lightFillAlpha)
                strokeColor = Design.blue.withAlphaComponent(isDark ? darkStrokeAlpha : lightStrokeAlpha)
            } else if isDark {
                let fillAlpha = (0.08 + 0.05 * hp - 0.02 * pp) * enableScale
                let strokeAlpha = ((isMenuPill ? 0.10 : 0.12) + 0.08 * hp) * enableScale
                fillColor = NSColor.white.withAlphaComponent(fillAlpha)
                strokeColor = NSColor.white.withAlphaComponent(strokeAlpha)
            } else {
                let baseLightAlpha: CGFloat = isMenuPill ? 0.72 : 0.82
                let fillAlpha = (baseLightAlpha + 0.10 * hp - 0.08 * pp) * enableScale
                let baseStrokeAlpha: CGFloat = isMenuPill ? 0.07 : 0.09
                let strokeAlpha = (baseStrokeAlpha + 0.05 * hp) * enableScale
                fillColor = NSColor.white.withAlphaComponent(fillAlpha)
                strokeColor = NSColor.black.withAlphaComponent(strokeAlpha)
            }
            fillColor.setFill()
            path.fill()

            if focused {
                Design.blue.setStroke()
                path.lineWidth = 1.5
                path.stroke()
            } else {
                strokeColor.setStroke()
                path.lineWidth = 0.5
                path.stroke()
            }
        }

        var textLeadingOffset: CGFloat = visualStyle == .form ? (isSmall ? 9.5 : 11) : (isSmall ? 10 : 11)

        let activeAccentColor: NSColor = {
            if visualStyle == .form {
                return isDark
                    ? NSColor(srgbRed: 122/255, green: 192/255, blue: 1.0, alpha: 1.0)
                    : NSColor(srgbRed: 0.0, green: 94.0 / 255.0, blue: 196.0 / 255.0, alpha: 1.0)
            }
            return isDark ? Design.activeBlue : Design.blue
        }()

        let resolvedLeadingIcon: NSImage? = leadingImage ?? {
            guard let symbolName = leadingSymbolName, !symbolName.isEmpty else { return nil }
            return NSImage(systemSymbolName: symbolName, accessibilityDescription: nil)
        }()
        if let iconImg = resolvedLeadingIcon {
            let iconBox: CGFloat = isSmall ? 11.5 : 12.5
            let rawSz = iconImg.size
            let scale = (rawSz.width > 0 && rawSz.height > 0) ? min(iconBox / rawSz.width, iconBox / rawSz.height) : 1.0
            let iconW = max(4, round(rawSz.width * scale * 2.0) / 2.0)
            let iconH = max(4, round(rawSz.height * scale * 2.0) / 2.0)
            let iconRect = NSRect(
                x: cellFrame.minX + textLeadingOffset,
                y: cellFrame.midY - iconH / 2,
                width: iconW,
                height: iconH
            )
            let iconColor = focused
                ? Design.blue
                : (isActiveState && isEnabled
                    ? activeAccentColor
                    : (isEnabled ? (hp > 0.25 ? Design.primary : Design.secondary) : Design.secondary.withAlphaComponent(0.5)))
            if iconImg.isTemplate {
                if let cg = NSGraphicsContext.current?.cgContext {
                    cg.saveGState()
                    cg.beginTransparencyLayer(in: iconRect, auxiliaryInfo: nil)
                    iconImg.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1.0, respectFlipped: controlView.isFlipped, hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)])
                    cg.setBlendMode(.sourceAtop)
                    iconColor.setFill()
                    cg.fill(iconRect)
                    cg.endTransparencyLayer()
                    cg.restoreGState()
                }
            } else {
                iconImg.draw(
                    in: iconRect,
                    from: .zero,
                    operation: .sourceOver,
                    fraction: isEnabled ? 1.0 : 0.5,
                    respectFlipped: controlView.isFlipped,
                    hints: [.interpolation: NSNumber(value: NSImageInterpolation.high.rawValue)]
                )
            }
            textLeadingOffset += iconW + 5.0
        }

        let fontSize: CGFloat = isSmall ? 11.5 : 12
        let drawFont = NSFont.systemFont(ofSize: fontSize, weight: .medium)
        let textH = (title as NSString).size(withAttributes: [.font: drawFont]).height
        let trailingZone: CGFloat = visualStyle == .form ? (isSmall ? 22 : 24) : (isSmall ? 21 : 23)
        let titleY = round((cellFrame.midY - textH / 2.0) * 2.0) / 2.0
        let titleRect = NSRect(
            x: cellFrame.minX + textLeadingOffset,
            y: titleY,
            width: max(0, cellFrame.width - textLeadingOffset - trailingZone),
            height: ceil(textH) + 1
        )
        let style = NSMutableParagraphStyle(); style.lineBreakMode = .byTruncatingTail
        let fgColor = isEnabled
            ? (isActiveState ? activeAccentColor : Design.primary)
            : Design.secondary.withAlphaComponent(0.55)
        (title as NSString).draw(in: titleRect, withAttributes: [
            .font: drawFont,
            .foregroundColor: fgColor,
            .paragraphStyle: style
        ])

        let chevColor = focused
            ? Design.blue
            : (isActiveState && isEnabled
                ? activeAccentColor.withAlphaComponent(0.88)
                : (hp > 0.25 && isEnabled ? Design.primary : Design.secondary))
        chevColor.setStroke()

        let ySign: CGFloat = controlView.isFlipped ? 1.0 : -1.0
        let chev = NSBezierPath()
        chev.lineCapStyle = .round
        chev.lineJoinStyle = .round
        if visualStyle == .form {
            // 精细双箭头指示器（与左内边距对称）
            let cx = cellFrame.maxX - (isSmall ? 11.5 : 12.5)
            let cy = cellFrame.midY
            chev.move(to: NSPoint(x: cx - 2.6, y: cy - 1.3 * ySign))
            chev.line(to: NSPoint(x: cx, y: cy - 3.8 * ySign))
            chev.line(to: NSPoint(x: cx + 2.6, y: cy - 1.3 * ySign))
            chev.move(to: NSPoint(x: cx - 2.6, y: cy + 1.3 * ySign))
            chev.line(to: NSPoint(x: cx, y: cy + 3.8 * ySign))
            chev.line(to: NSPoint(x: cx + 2.6, y: cy + 1.3 * ySign))
            chev.lineWidth = 1.2
        } else {
            // 轻量化单向下箭头指示器（与设置页表单双箭头明确分层）
            let cx = cellFrame.maxX - (isSmall ? 11.5 : 12.5)
            let cy = cellFrame.midY
            chev.move(to: NSPoint(x: cx - 3.2, y: cy - 1.4 * ySign))
            chev.line(to: NSPoint(x: cx, y: cy + 1.8 * ySign))
            chev.line(to: NSPoint(x: cx + 3.2, y: cy - 1.4 * ySign))
            chev.lineWidth = 1.3
        }
        chev.stroke()
    }
    override func cellSize(forBounds rect: NSRect) -> NSSize {
        let isSmall = controlSize == .small
        let drawFont = NSFont.systemFont(ofSize: isSmall ? 11.5 : 12, weight: .medium)
        let candidates: [String]
        if fitsSelectedTitleOnly {
            candidates = [selectedItem?.title ?? title]
        } else if pullsDown {
            candidates = [title]
        } else {
            let itemTitles = (menu?.items ?? []).filter { !$0.isSeparatorItem }.map(\.title)
            candidates = itemTitles.isEmpty ? [title] : itemTitles
        }
        let maxTitleW = candidates.reduce(CGFloat(0)) { acc, item in
            max(acc, ceil((item as NSString).size(withAttributes: [.font: drawFont]).width))
        }
        let iconExtra: CGFloat = (leadingImage != nil || leadingSymbolName?.isEmpty == false) ? 18 : 0
        let baseChrome: CGFloat = visualStyle == .form ? (isSmall ? 34 : 38) : (isSmall ? 35 : 39)
        let chrome: CGFloat = baseChrome + iconExtra
        let minW: CGFloat = isSmall ? 58 : 64
        return NSSize(width: max(minW, maxTitleW + chrome), height: customHeight ?? (isSmall ? 26 : 28))
    }
}

func drawInput(_ rect: NSRect, focused: Bool = false) {
    let insetRect = rect.insetBy(dx: 1.5, dy: 1.5)
    let path = NSBezierPath(roundedRect: insetRect, xRadius: 6, yRadius: 6)
    Design.color(0xFFFFFF, 0x2C2C2E).setFill()
    path.fill()
    if focused {
        NSGraphicsContext.current?.saveGraphicsState()
        let glowRect = rect.insetBy(dx: 0.5, dy: 0.5)
        let glowPath = NSBezierPath(roundedRect: glowRect, xRadius: 7, yRadius: 7)
        Design.blue.withAlphaComponent(0.24).setStroke()
        glowPath.lineWidth = 2.0
        glowPath.stroke()
        let borderPath = NSBezierPath(roundedRect: insetRect, xRadius: 6, yRadius: 6)
        Design.blue.setStroke()
        borderPath.lineWidth = 1.25
        borderPath.stroke()
        NSGraphicsContext.current?.restoreGraphicsState()
    } else {
        Design.border.setStroke()
        path.lineWidth = 1
        path.stroke()
    }
}
private func inputTextRect(_ rect: NSRect, font: NSFont? = nil) -> NSRect {
    let f = font ?? .systemFont(ofSize: 12)
    let height = ceil(f.ascender - f.descender + f.leading)
    return NSRect(x: rect.minX + 6, y: rect.midY - height / 2, width: max(0, rect.width - 12), height: height)
}
final class DesignTextCell: NSTextFieldCell {
    override func drawingRect(forBounds theRect: NSRect) -> NSRect {
        inputTextRect(theRect, font: font)
    }
    override func titleRect(forBounds theRect: NSRect) -> NSRect {
        inputTextRect(theRect, font: font)
    }
    override func draw(withFrame rect: NSRect, in view: NSView) {
        let focused = (view as? NSTextField)?.currentEditor() != nil
        drawInput(rect, focused: focused)
        guard !focused else { return }
        let style = NSMutableParagraphStyle()
        style.alignment = alignment
        style.lineBreakMode = .byTruncatingTail
        let display = stringValue.isEmpty ? (placeholderString ?? "") : stringValue
        guard !display.isEmpty else { return }
        let color: NSColor = stringValue.isEmpty ? Design.secondary : (isEnabled ? NSColor.labelColor : Design.secondary)
        (display as NSString).draw(in: drawingRect(forBounds: rect), withAttributes: [
            .font: font ?? .systemFont(ofSize: 12),
            .foregroundColor: color,
            .paragraphStyle: style
        ])
    }
    override func edit(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, event: NSEvent?) {
        let textRect = drawingRect(forBounds: rect)
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.edit(withFrame: textRect, in: view, editor: editor, delegate: delegate, event: event)
    }
    override func select(withFrame rect: NSRect, in view: NSView, editor: NSText, delegate: Any?, start: Int, length: Int) {
        let textRect = drawingRect(forBounds: rect)
        editor.alignment = alignment
        if let tv = editor as? NSTextView {
            tv.drawsBackground = false
            tv.textContainerInset = .zero
            tv.textContainer?.lineFragmentPadding = 0
        }
        super.select(withFrame: textRect, in: view, editor: editor, delegate: delegate, start: start, length: length)
    }
}

// Shared feedback for quota actions in the dashboard and account cards.
final class QuotaRefreshButton: DesignButton {
    let spinner = NSProgressIndicator()
    private var spinnerLeadingConstraint: NSLayoutConstraint!
    var localBusy = false
    var lastError: String?
    private var appliedDisplayState: (busy: Bool, available: Bool, error: String)?
    override var isActivitySpinning: Bool { !spinner.isHidden }
    override var title: String {
        didSet {
            guard oldValue != title else { return }
            invalidateIntrinsicContentSize()
            needsLayout = true
            needsDisplay = true
        }
    }
    override var intrinsicContentSize: NSSize {
        let textW = ceil((title as NSString).size(withAttributes: [
            .font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium)
        ]).width)
        return NSSize(width: max(84, textW + 42), height: 28)
    }
    init(target: AnyObject?, action: Selector) {
        super.init(frame: .zero); title = L10n.t("common.refresh_quota", fallback: "刷新配额"); self.target = target; self.action = action
        bezelStyle = .rounded; isBordered = false; font = .systemFont(ofSize: 12, weight: .medium)
        spinner.style = .spinning; spinner.controlSize = .small; spinner.isDisplayedWhenStopped = false; spinner.isHidden = true
        spinner.translatesAutoresizingMaskIntoConstraints = false; addSubview(spinner)
        spinnerLeadingConstraint = spinner.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 12)
        NSLayoutConstraint.activate([spinnerLeadingConstraint, spinner.centerYAnchor.constraint(equalTo: centerYAnchor), spinner.widthAnchor.constraint(equalToConstant: 13), spinner.heightAnchor.constraint(equalToConstant: 13)])
        setAccessibilityLabel(L10n.t("common.refresh_quota", fallback: "刷新配额"))
    }
    required init?(coder: NSCoder) { fatalError() }
    private func updateSpinnerLeading() {
        let spinnerW: CGFloat = 13
        let gap: CGFloat = title.isEmpty ? 0 : 5
        let textW = title.isEmpty ? 0 : (title as NSString).size(withAttributes: [
            .font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium)
        ]).width
        let effectiveW = bounds.width > 1 ? bounds.width : intrinsicContentSize.width
        let clampedTextW = min(textW, max(0, effectiveW - 16 - spinnerW - gap))
        let totalW = spinnerW + gap + clampedTextW
        let target = title.isEmpty
            ? round((effectiveW - spinnerW) / 2)
            : max(8, round((effectiveW - totalW) / 2))
        if abs(spinnerLeadingConstraint.constant - target) > 0.5 {
            spinnerLeadingConstraint.constant = target
        }
    }
    override func layout() {
        updateSpinnerLeading()
        super.layout()
    }
    override func draw(_ dirtyRect: NSRect) {
        if spinner.isHidden {
            drawButtonChromeAndLabel(spinnerLeftInset: nil)
        } else {
            drawButtonChromeAndLabel(centeredSpinnerWidth: 13)
        }
    }
    func setRefreshState(busy: Bool, available: Bool, error: String?) {
        localBusy = busy
        lastError = error
        applyDisplayState(busy: busy, available: available, error: error)
    }
    func applyGlobalRefreshState(globalBusy: Bool, available: Bool, error: String?, cardBusy: Bool = false) {
        let effectiveBusy = globalBusy || localBusy || cardBusy
        let effectiveError = lastError ?? error
        applyDisplayState(busy: effectiveBusy, available: available, error: effectiveError)
    }
    private func applyDisplayState(busy: Bool, available: Bool, error: String?) {
        let normalizedError = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if let prev = appliedDisplayState, prev.busy == busy && prev.available == available && prev.error == normalizedError {
            return
        }
        appliedDisplayState = (busy: busy, available: available, error: normalizedError)
        isEnabled = available && !busy
        if spinner.isHidden != !busy {
            spinner.isHidden = !busy
            if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
            needsLayout = true
        }
        toolTip = nil
        setAccessibilityHelp(!normalizedError.isEmpty ? L10n.t("design.quota_refresh.incomplete", ["error": normalizedError], fallback: "刷新未完成：\(normalizedError)") : (busy ? L10n.t("design.quota_refresh.busy", fallback: "正在刷新配额") : L10n.t("design.quota_refresh.idle", fallback: "刷新账号配额")))
        needsDisplay = true
    }
}

// Fixed-width inline refresh button with embedded spinner or compact icon-only rotating arrow mode.
final class InlineRefreshButton: DesignButton {
    private final class SpinLinkTarget: NSObject {
        private weak var owner: InlineRefreshButton?
        private var didInvalidate = false

        init(owner: InlineRefreshButton) {
            self.owner = owner
            super.init()
        }

        func invalidateOnce(_ link: CADisplayLink?) {
            owner = nil
            guard !didInvalidate else { return }
            didInvalidate = true
            link?.invalidate()
        }

        @objc func step(_ sender: CADisplayLink) {
            guard !didInvalidate, let owner else {
                invalidateOnce(sender)
                return
            }
            owner.handleSpinDisplayLink(sender)
        }
    }

    let spinner = NSProgressIndicator()
    let fixedWidth: CGFloat
    let iconOnly: Bool
    let iconButtonSize: CGFloat
    private(set) var isBusy = false
    private var appliedBusyState: (busy: Bool, available: Bool, error: String)?
    private var baseAccessibilityLabel: String
    private var isUpdatingA11yLabel = false

    private var spinAngle: CGFloat = 0
    private var spinDisplayLink: CADisplayLink?
    private var spinDisplayLinkTarget: SpinLinkTarget?
    private var spinTimer: Timer?
    private var spinLastTime: CFTimeInterval = 0
    private let spinSettleMotion = DesignMotion()

    override var isActivitySpinning: Bool { iconOnly ? isBusy : !spinner.isHidden }
    override var intrinsicContentSize: NSSize {
        if iconOnly {
            return NSSize(width: iconButtonSize, height: iconButtonSize)
        }
        let textWidth = ceil((title as NSString).size(withAttributes: [
            .font: font ?? NSFont.systemFont(ofSize: 12, weight: .medium)
        ]).width)
        return NSSize(width: max(fixedWidth, textWidth + 32), height: 28)
    }

    init(
        _ buttonTitle: String = L10n.t("common.refresh", fallback: "刷新"),
        width: CGFloat = 78,
        iconOnly: Bool = false,
        size: CGFloat = 28,
        target: AnyObject? = nil,
        action: Selector
    ) {
        self.fixedWidth = width
        self.iconOnly = iconOnly
        self.iconButtonSize = max(20, size)
        let fallbackLabel = L10n.t("common.refresh", fallback: "刷新")
        let resolvedLabel = buttonTitle.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? fallbackLabel : buttonTitle
        self.baseAccessibilityLabel = resolvedLabel
        super.init(frame: .zero)
        self.target = target
        self.action = action
        bezelStyle = .rounded
        isBordered = false
        font = .systemFont(ofSize: 12, weight: .medium)
        spinner.isHidden = true
        if iconOnly {
            title = ""
            toolTip = nil
            let iconImg = NSImage(systemSymbolName: "arrow.clockwise", accessibilityDescription: nil)?
                .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: 12.5, weight: .medium))
            iconImg?.isTemplate = true
            image = iconImg
            imagePosition = .imageOnly
            setContentHuggingPriority(.required, for: .horizontal)
            setContentHuggingPriority(.required, for: .vertical)
            setContentCompressionResistancePriority(.required, for: .horizontal)
            setContentCompressionResistancePriority(.required, for: .vertical)
        } else {
            title = buttonTitle
            spinner.style = .spinning
            spinner.controlSize = .small
            spinner.isDisplayedWhenStopped = false
            spinner.translatesAutoresizingMaskIntoConstraints = false
            addSubview(spinner)
            NSLayoutConstraint.activate([
                spinner.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8),
                spinner.centerYAnchor.constraint(equalTo: centerYAnchor),
                spinner.widthAnchor.constraint(equalToConstant: 13),
                spinner.heightAnchor.constraint(equalToConstant: 13)
            ])
        }
        isUpdatingA11yLabel = true
        super.setAccessibilityLabel(resolvedLabel)
        isUpdatingA11yLabel = false
    }

    required init?(coder: NSCoder) { fatalError() }

    deinit {
        stopSpinDriver(resetAngle: false, settle: false)
    }

    override func setAccessibilityLabel(_ accessibilityLabel: String?) {
        if !isUpdatingA11yLabel, let label = accessibilityLabel?.trimmingCharacters(in: .whitespacesAndNewlines), !label.isEmpty {
            baseAccessibilityLabel = label
        }
        super.setAccessibilityLabel(accessibilityLabel)
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            stopSpinDriver(resetAngle: true, settle: false)
        } else if iconOnly && isBusy {
            startSpinDriver()
        }
    }

    override func draw(_ dirtyRect: NSRect) {
        if iconOnly {
            drawButtonChromeAndLabel(iconRotationRadians: spinAngle)
        } else {
            drawButtonChromeAndLabel(spinnerLeftInset: spinner.isHidden ? 6 : 22)
        }
    }

    func setBusy(_ busy: Bool, available: Bool = true, error: String? = nil) {
        let normalizedError = error?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let targetEnabled = available && !busy
        if let prev = appliedBusyState, prev.busy == busy && prev.available == available && prev.error == normalizedError {
            if isEnabled != targetEnabled {
                isEnabled = targetEnabled
                needsDisplay = true
            }
            return
        }
        appliedBusyState = (busy: busy, available: available, error: normalizedError)
        isBusy = busy
        isEnabled = targetEnabled
        if iconOnly {
            if !title.isEmpty {
                title = ""
            }
            if busy {
                startSpinDriver()
            } else {
                stopSpinDriver(resetAngle: true, settle: true)
            }
        } else if spinner.isHidden != !busy {
            spinner.isHidden = !busy
            if busy { spinner.startAnimation(nil) } else { spinner.stopAnimation(nil) }
        }
        let labelSource = iconOnly ? baseAccessibilityLabel : (title.isEmpty ? baseAccessibilityLabel : title)
        isUpdatingA11yLabel = true
        super.setAccessibilityLabel(busy ? L10n.t("design.inline_refresh.busy", ["title": labelSource], fallback: "\(labelSource)，刷新中") : labelSource)
        isUpdatingA11yLabel = false
        if !normalizedError.isEmpty {
            setAccessibilityHelp(L10n.t("design.quota_refresh.incomplete", ["error": normalizedError], fallback: "刷新未完成：\(normalizedError)"))
        } else if iconOnly {
            setAccessibilityHelp(busy ? L10n.t("design.inline_refresh.busy", ["title": labelSource], fallback: "\(labelSource)，刷新中") : labelSource)
        } else {
            setAccessibilityHelp(nil)
        }
        needsDisplay = true
    }

    private func startSpinDriver() {
        guard iconOnly, isBusy, Design.shouldAnimate(in: self) else { return }
        spinSettleMotion.cancel()
        guard spinDisplayLink == nil, spinTimer == nil else { return }
        spinLastTime = CACurrentMediaTime()
        let proxy = SpinLinkTarget(owner: self)
        if let link = DesignMotion.defaultMakeDisplayLink(for: self, target: proxy, selector: #selector(SpinLinkTarget.step(_:))) {
            if #available(macOS 14.0, *) {
                link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            }
            link.add(to: .main, forMode: .common)
            spinDisplayLinkTarget = proxy
            spinDisplayLink = link
        } else {
            let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
                self?.stepSpinFrame()
            }
            spinTimer = t
            RunLoop.main.add(t, forMode: .common)
        }
    }

    private func handleSpinDisplayLink(_ link: CADisplayLink) {
        guard link === spinDisplayLink else { return }
        stepSpinFrame()
    }

    private func stepSpinFrame() {
        guard iconOnly, isBusy, Design.shouldAnimate(in: self) else {
            stopSpinDriver(resetAngle: true, settle: false)
            return
        }
        let now = CACurrentMediaTime()
        let dt = max(0, min(0.05, now - spinLastTime))
        spinLastTime = now
        spinAngle = (spinAngle + CGFloat(dt) * (.pi * 2.0 / 0.85)).truncatingRemainder(dividingBy: .pi * 2.0)
        needsDisplay = true
    }

    private func stopSpinDriver(resetAngle: Bool, settle: Bool) {
        let link = spinDisplayLink
        spinDisplayLink = nil
        let proxy = spinDisplayLinkTarget
        spinDisplayLinkTarget = nil
        if let proxy {
            proxy.invalidateOnce(link)
        } else {
            link?.invalidate()
        }
        let activeTimer = spinTimer
        spinTimer = nil
        activeTimer?.invalidate()

        spinSettleMotion.cancel()
        if settle && Design.shouldAnimate(in: self) {
            let normalized = spinAngle.truncatingRemainder(dividingBy: .pi * 2.0)
            if normalized > 0.02 {
                spinSettleMotion.animate(in: self, from: normalized, to: .pi * 2.0, curve: .hover, threshold: 0.01) { [weak self] angle in
                    guard let self else { return }
                    self.spinAngle = angle >= (.pi * 2.0 - 0.01) ? 0 : angle
                    self.needsDisplay = true
                }
                return
            }
        }
        if resetAngle && spinAngle != 0 {
            spinAngle = 0
            needsDisplay = true
        }
    }
}

// Unified capsule segmented control with 120Hz sliding pill thumb and directional specular bevel, drop-in compatible with NSSegmentedControl.
final class DesignSegmentedControl: NSControl {
    override var allowsVibrancy: Bool { false }
    private(set) var labels: [String]
    private var segmentButtons: [SegmentButton] = []
    private let segmentStack = NSStackView()
    private var _selectedSegment: Int = 0
    private var slidePosition: CGFloat = 0
    private let slideMotion = DesignMotion()
    private let compact: Bool
    private let equalWidthSegments: Bool
    private let maxSegmentWidth: CGFloat?

    var segmentCount: Int { segmentButtons.count }

    func setLabel(_ label: String, forSegment segment: Int) {
        guard segmentButtons.indices.contains(segment) else { return }
        labels[segment] = label
        let btn = segmentButtons[segment]
        btn.title = label
        btn.setAccessibilityLabel(label)
        btn.updateWidthConstraints(maxWidth: maxSegmentWidth)
        btn.needsDisplay = true
        invalidateIntrinsicContentSize()
        needsLayout = true
        needsDisplay = true
    }

    func updateSegments(labels newLabels: [String], tooltips: [String?]? = nil, selectedIndex: Int, animated: Bool = false) {
        let clamped = newLabels.isEmpty ? 0 : max(0, min(newLabels.count - 1, selectedIndex))
        if newLabels == labels {
            for (idx, btn) in segmentButtons.enumerated() {
                btn.toolTip = (tooltips?.indices.contains(idx) == true) ? tooltips?[idx] : nil
            }
            if _selectedSegment != clamped || Int(round(slidePosition)) != clamped {
                setSelected(clamped, animated: animated && Design.shouldAnimate(in: self))
            }
            return
        }
        labels = newLabels
        rebuildSegments(tooltips: tooltips, selectedIndex: clamped)
    }

    var selectedSegment: Int {
        get { _selectedSegment }
        set { setSelected(newValue, animated: Design.shouldAnimate(in: self)) }
    }

    final class SegmentButton: NSButton {
        override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); needsDisplay = true; return result }
        override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); needsDisplay = true; return result }
        override var allowsVibrancy: Bool { false }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        let index: Int
        let compact: Bool
        weak var owner: DesignSegmentedControl?
        var isSelectedSegment = false { didSet { if oldValue != isSelectedSegment { needsDisplay = true } } }
        private var hoverTracking: NSTrackingArea?
        var hovered = false { didSet { if oldValue != hovered { needsDisplay = true } } }
        private var minWidthConstraint: NSLayoutConstraint?
        private var maxWidthConstraint: NSLayoutConstraint?

        var preferredSegmentWidth: CGFloat {
            let fontSize: CGFloat = compact ? 11.5 : 12
            let hPad: CGFloat = compact ? 18 : 22
            let minW: CGFloat = compact ? 44 : 54
            let textW = ceil((title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: fontSize, weight: .semibold)]).width) + hPad
            let bounded = max(minW, textW)
            if let maxW = maxWidthConstraint?.constant {
                return min(maxW, bounded)
            }
            return bounded
        }

        init(title: String, index: Int, compact: Bool, maxWidth: CGFloat?, owner: DesignSegmentedControl, action: Selector) {
            self.index = index
            self.compact = compact
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
            translatesAutoresizingMaskIntoConstraints = false
            let widthConstraint = widthAnchor.constraint(greaterThanOrEqualToConstant: 44)
            widthConstraint.isActive = true
            self.minWidthConstraint = widthConstraint
            if let maxWidth {
                let maxC = widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth)
                maxC.isActive = true
                self.maxWidthConstraint = maxC
            }
            updateWidthConstraints(maxWidth: maxWidth)
        }
        required init?(coder: NSCoder) { fatalError() }

        func updateWidthConstraints(maxWidth: CGFloat?) {
            let fontSize: CGFloat = compact ? 11.5 : 12
            let hPad: CGFloat = compact ? 18 : 22
            let minW: CGFloat = compact ? 44 : 54
            let w = ceil((title as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: fontSize, weight: .semibold)]).width) + hPad
            let resolvedMin = max(minW, w)
            minWidthConstraint?.constant = maxWidth.map { min($0, resolvedMin) } ?? resolvedMin
            if let maxWidth {
                maxWidthConstraint?.constant = maxWidth
            }
            invalidateIntrinsicContentSize()
        }

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
            let cornerR: CGFloat = compact ? 5.5 : 6
            let rect = bounds.insetBy(dx: 1, dy: 1)
            if window?.firstResponder === self { Design.blue.setStroke(); let ring = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR); ring.lineWidth = 2; ring.stroke() }
            let path = NSBezierPath(roundedRect: rect, xRadius: cornerR, yRadius: cornerR)
            if !isSelectedSegment && hovered {
                (isDark ? NSColor.white.withAlphaComponent(0.055) : NSColor.black.withAlphaComponent(0.035)).setFill()
                path.fill()
            }
            let fontSize: CGFloat = compact ? 11.5 : 12
            let weight: NSFont.Weight = isSelectedSegment ? .semibold : .medium
            let fg: NSColor = isSelectedSegment ? .labelColor : (hovered ? .labelColor : Design.secondary)
            let pStyle = NSMutableParagraphStyle()
            pStyle.alignment = .center
            pStyle.lineBreakMode = .byTruncatingTail
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.systemFont(ofSize: fontSize, weight: weight),
                .foregroundColor: fg,
                .paragraphStyle: pStyle
            ]
            let sz = (title as NSString).size(withAttributes: attrs)
            let hInset: CGFloat = compact ? 6 : 4
            let drawRect = NSRect(x: hInset, y: (bounds.height - sz.height) / 2, width: max(0, bounds.width - hInset * 2), height: sz.height)
            (title as NSString).draw(in: drawRect, withAttributes: attrs)
        }
    }

    init(
        labels: [String],
        trackingMode: NSSegmentedControl.SwitchTracking = .selectOne,
        target: AnyObject? = nil,
        action: Selector? = nil,
        compact: Bool = false,
        equalWidthSegments: Bool = true,
        maxSegmentWidth: CGFloat? = nil
    ) {
        _ = trackingMode // Retained for NSSegmentedControl drop-in compatibility; single-selection is fixed.
        self.labels = labels
        self.compact = compact
        self.equalWidthSegments = equalWidthSegments
        self.maxSegmentWidth = maxSegmentWidth
        super.init(frame: .zero)
        self.target = target
        self.action = action
        focusRingType = .none
        translatesAutoresizingMaskIntoConstraints = false
        segmentStack.orientation = .horizontal
        segmentStack.distribution = equalWidthSegments ? .fillEqually : .fill
        segmentStack.spacing = 2
        addSubview(segmentStack)
        segmentStack.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([
            segmentStack.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 3),
            segmentStack.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -3),
            segmentStack.topAnchor.constraint(equalTo: topAnchor, constant: 3),
            segmentStack.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -3)
        ])
        rebuildSegments(tooltips: nil, selectedIndex: 0)
        setAccessibilityElement(true)
        setAccessibilityRole(.tabGroup)
    }
    required init?(coder: NSCoder) { fatalError() }

    private func rebuildSegments(tooltips: [String?]?, selectedIndex: Int) {
        slideMotion.cancel()
        segmentStack.arrangedSubviews.forEach {
            segmentStack.removeArrangedSubview($0)
            $0.removeFromSuperview()
        }
        segmentButtons.removeAll()
        let clamped = labels.isEmpty ? 0 : max(0, min(labels.count - 1, selectedIndex))
        _selectedSegment = clamped
        slidePosition = CGFloat(clamped)
        let btnHeight: CGFloat = compact ? 18 : 22
        for (idx, item) in labels.enumerated() {
            let btn = SegmentButton(title: item, index: idx, compact: compact, maxWidth: maxSegmentWidth, owner: self, action: #selector(segmentClicked(_:)))
            btn.isSelectedSegment = (idx == clamped)
            btn.setAccessibilityValue(idx == clamped ? 1 : 0)
            if let tooltips, tooltips.indices.contains(idx) {
                btn.toolTip = tooltips[idx]
            }
            if !equalWidthSegments {
                btn.setContentHuggingPriority(.required, for: .horizontal)
                btn.setContentCompressionResistancePriority(.defaultHigh, for: .horizontal)
            }
            segmentButtons.append(btn)
            segmentStack.addArrangedSubview(btn)
            btn.heightAnchor.constraint(equalToConstant: btnHeight).isActive = true
        }
        invalidateIntrinsicContentSize()
        needsLayout = true
        needsDisplay = true
    }

    override var intrinsicContentSize: NSSize {
        let totalH: CGFloat = compact ? 24 : 28
        let totalW: CGFloat
        if equalWidthSegments, let maxBtnW = segmentButtons.map(\.preferredSegmentWidth).max() {
            totalW = 6 + maxBtnW * CGFloat(segmentButtons.count) + CGFloat(max(0, segmentButtons.count - 1)) * 2
        } else {
            totalW = segmentButtons.reduce(CGFloat(6)) { acc, b in
                acc + b.preferredSegmentWidth
            } + CGFloat(max(0, segmentButtons.count - 1)) * 2
        }
        return NSSize(width: totalW, height: totalH)
    }

    private func setSelected(_ index: Int, animated: Bool) {
        guard !labels.isEmpty else { return }
        let clamped = max(0, min(labels.count - 1, index))
        _selectedSegment = clamped
        for (idx, btn) in segmentButtons.enumerated() {
            btn.isSelectedSegment = (idx == clamped)
            btn.setAccessibilityValue(idx == clamped ? 1 : 0)
        }
        let targetPos = CGFloat(clamped)
        if animated {
            slideMotion.animate(in: self, from: slidePosition, to: targetPos, curve: .spring, threshold: 0.01) { [weak self] pos in
                self?.slidePosition = pos
                self?.needsDisplay = true
            }
        } else {
            slideMotion.cancel()
            slidePosition = targetPos
            needsDisplay = true
        }
    }

    @objc private func segmentClicked(_ sender: SegmentButton) {
        setSelected(sender.index, animated: Design.shouldAnimate(in: self))
        if let action {
            NSApp.sendAction(action, to: target, from: self)
        }
    }

    func moveSelection(by delta: Int) {
        guard isEnabled, !segmentButtons.isEmpty else { return }
        let next = max(0, min(segmentButtons.count - 1, _selectedSegment + delta))
        let targetBtn = segmentButtons[next]
        window?.makeFirstResponder(targetBtn)
        if next != _selectedSegment {
            setSelected(next, animated: Design.shouldAnimate(in: self))
            if let action {
                NSApp.sendAction(action, to: target, from: self)
            }
        }
    }

    override func layout() {
        super.layout()
        needsDisplay = true
    }

    private func interpolatedThumbRect() -> NSRect {
        guard !segmentButtons.isEmpty else { return .zero }
        let lowIdx = max(0, min(segmentButtons.count - 1, Int(floor(slidePosition))))
        let highIdx = max(0, min(segmentButtons.count - 1, Int(ceil(slidePosition))))
        let frac = max(0, min(1, slidePosition - CGFloat(lowIdx)))
        let r1 = convert(segmentButtons[lowIdx].bounds, from: segmentButtons[lowIdx])
        let r2 = convert(segmentButtons[highIdx].bounds, from: segmentButtons[highIdx])
        if r1.width <= 1 {
            let inset: CGFloat = 3
            let spacing: CGFloat = 2
            let count = CGFloat(max(1, labels.count))
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
        let outerRadius: CGFloat = compact ? 7.5 : 8
        let thumbRadius: CGFloat = compact ? 5.5 : 6
        let outerRect = bounds.insetBy(dx: 0.5, dy: 0.5)
        let outerPath = NSBezierPath(roundedRect: outerRect, xRadius: outerRadius, yRadius: outerRadius)
        (isDark ? NSColor.white.withAlphaComponent(0.05) : NSColor.black.withAlphaComponent(0.045)).setFill()
        outerPath.fill()
        (isDark ? NSColor.white.withAlphaComponent(0.07) : NSColor.black.withAlphaComponent(0.06)).setStroke()
        outerPath.lineWidth = 0.5
        outerPath.stroke()

        let thumbRect = interpolatedThumbRect().insetBy(dx: 0.5, dy: 0.5)
        guard thumbRect.width > 1 && thumbRect.height > 1 else { return }
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: thumbRadius, yRadius: thumbRadius)

        NSGraphicsContext.saveGraphicsState()
        let thumbShadow = NSShadow()
        thumbShadow.shadowColor = isDark
            ? NSColor.black.withAlphaComponent(0.38)
            : NSColor.black.withAlphaComponent(0.10)
        thumbShadow.shadowOffset = NSSize(width: 0, height: -1.0)
        thumbShadow.shadowBlurRadius = 2.5
        thumbShadow.set()

        let fill = isDark ? NSColor.white.withAlphaComponent(0.13) : NSColor.white.withAlphaComponent(0.95)
        fill.setFill()
        thumbPath.fill()
        NSGraphicsContext.restoreGraphicsState()

        (isDark ? NSColor.white.withAlphaComponent(0.14) : NSColor.black.withAlphaComponent(0.07)).setStroke()
        thumbPath.lineWidth = 0.6
        thumbPath.stroke()
        Design.drawSpecularBevel(in: thumbRect, cornerRadius: thumbRadius, isDark: isDark)
    }

    deinit {
        slideMotion.cancel()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            slideMotion.cancel()
        }
    }
}

// Custom macOS pill switch that preserves active blue tint when enabled even when the window is unfocused/inactive.
final class DesignSwitch: NSSwitch {
        override func becomeFirstResponder() -> Bool { let result = super.becomeFirstResponder(); needsDisplay = true; return result }
        override func resignFirstResponder() -> Bool { let result = super.resignFirstResponder(); needsDisplay = true; return result }
    private let thumbMotion = DesignMotion()
    private var thumbProgress: CGFloat = 0
    private var isPressedState = false

    override var wantsUpdateLayer: Bool { false }
    override var allowsVibrancy: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override var intrinsicContentSize: NSSize {
        NSSize(width: 34, height: 20)
    }

    override var state: NSControl.StateValue {
        get { super.state }
        set {
            let changed = super.state != newValue
            super.state = newValue
            suppressNativeLayers()
            let target: CGFloat = (newValue == .on) ? 1.0 : 0.0
            if changed && Design.shouldAnimate(in: self) {
                thumbMotion.animate(in: self, from: thumbProgress, to: target, curve: .spring, threshold: 0.01) { [weak self] val in
                    self?.thumbProgress = val
                    self?.needsDisplay = true
                }
            } else {
                thumbMotion.cancel()
                thumbProgress = target
                needsDisplay = true
            }
        }
    }

    override var isEnabled: Bool {
        didSet {
            suppressNativeLayers()
            needsDisplay = true
        }
    }

    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        focusRingType = .exterior
        thumbProgress = (super.state == .on) ? 1.0 : 0.0
        suppressNativeLayers()
    }

    required init?(coder: NSCoder) {
        super.init(coder: coder)
        focusRingType = .exterior
        thumbProgress = (super.state == .on) ? 1.0 : 0.0
        suppressNativeLayers()
    }

    deinit {
        thumbMotion.cancel()
    }

    private func suppressNativeLayers() {
        for sub in subviews {
            sub.isHidden = true
            sub.alphaValue = 0
        }
    }

    override func didAddSubview(_ subview: NSView) {
        super.didAddSubview(subview)
        subview.isHidden = true
        subview.alphaValue = 0
    }

    override func layout() {
        super.layout()
        suppressNativeLayers()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil {
            thumbMotion.cancel()
        }
        suppressNativeLayers()
        needsDisplay = true
    }

    override func performClick(_ sender: Any?) {
        guard isEnabled else { return }
        state = (state == .on) ? .off : .on
        if let action {
            NSApp.sendAction(action, to: target, from: self)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard isEnabled else { return }
        isPressedState = true; needsDisplay = true
        defer { isPressedState = false; needsDisplay = true }
        // Let AppKit own event tracking, cancellation and action delivery.
        super.mouseDown(with: event)
    }

    override func keyDown(with event: NSEvent) {
        if isEnabled && (event.keyCode == 49 || event.keyCode == 36) {
            performClick(self)
            return
        }
        super.keyDown(with: event)
    }

    private var switchTrackRect: NSRect {
        let trackW: CGFloat = 32
        let trackH: CGFloat = 18
        return NSRect(
            x: round((bounds.width - trackW) / 2),
            y: round((bounds.height - trackH) / 2),
            width: trackW,
            height: trackH
        )
    }

    override var focusRingMaskBounds: NSRect {
        switchTrackRect
    }

    override func drawFocusRingMask() {
        let rect = switchTrackRect
        let radius = rect.height / 2
        NSBezierPath(roundedRect: rect, xRadius: radius, yRadius: radius).fill()
    }

    override func draw(_ dirtyRect: NSRect) {
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let trackRect = switchTrackRect
        let trackRadius = trackRect.height / 2
        let trackPath = NSBezierPath(roundedRect: trackRect, xRadius: trackRadius, yRadius: trackRadius)

        let p = min(1.0, max(0.0, thumbProgress))
        let enableAlpha: CGFloat = isEnabled ? 1.0 : 0.45

        let offFill = isDark
            ? NSColor.white.withAlphaComponent(0.16 * enableAlpha)
            : NSColor.black.withAlphaComponent(0.12 * enableAlpha)
        let onFill = Design.blue.withAlphaComponent(enableAlpha)
        let trackFill = offFill.blended(withFraction: p, of: onFill) ?? (p >= 0.5 ? onFill : offFill)
        trackFill.setFill()
        trackPath.fill()

        let borderColor = p >= 0.5
            ? NSColor.white.withAlphaComponent((isDark ? 0.14 : 0.18) * enableAlpha)
            : (isDark ? NSColor.white.withAlphaComponent(0.10 * enableAlpha) : NSColor.black.withAlphaComponent(0.08 * enableAlpha))
        borderColor.setStroke()
        trackPath.lineWidth = 0.5
        trackPath.stroke()

        let thumbD: CGFloat = 14
        let stretch: CGFloat = (isEnabled && isPressedState) ? 2.0 : 0.0
        let thumbW = thumbD + stretch
        let minX = trackRect.minX + 2.0
        let maxX = trackRect.maxX - 2.0 - thumbW
        let thumbX = minX + (maxX - minX) * p
        let thumbRect = NSRect(x: thumbX, y: trackRect.midY - thumbD / 2, width: thumbW, height: thumbD)
        let thumbPath = NSBezierPath(roundedRect: thumbRect, xRadius: thumbD / 2, yRadius: thumbD / 2)

        NSGraphicsContext.saveGraphicsState()
        if isEnabled {
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(isDark ? 0.36 : 0.20)
            shadow.shadowOffset = NSSize(width: 0, height: -0.8)
            shadow.shadowBlurRadius = 1.8
            shadow.set()
        }
        NSColor.white.withAlphaComponent(isEnabled ? 1.0 : 0.78).setFill()
        thumbPath.fill()
        NSGraphicsContext.restoreGraphicsState()
    }
}
