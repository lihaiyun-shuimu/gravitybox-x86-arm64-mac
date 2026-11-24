import Cocoa

private func gbSRGBLinear(_ v: CGFloat) -> CGFloat { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
private func gbLuminance(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat) -> CGFloat {
    0.2126 * gbSRGBLinear(r) + 0.7152 * gbSRGBLinear(g) + 0.0722 * gbSRGBLinear(b)
}
private func gbResolvedSRGB(_ color: NSColor, _ appearance: NSAppearance) -> NSColor {
    var resolved = color
    appearance.performAsCurrentDrawingAppearance { resolved = color.usingColorSpace(.sRGB) ?? color }
    return resolved
}

/// 胶囊 tint：浅色下按“同色 14% 胶囊底”把文字色压暗到 ≥4.5:1；深色保持原色。
func readablePillTint(_ color: NSColor, fillAlpha: CGFloat = 0.14) -> NSColor {
    NSColor(name: nil) { appearance in
        if appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua { return gbResolvedSRGB(color, appearance) }
        let base = gbResolvedSRGB(color, appearance)
        var r = base.redComponent, g = base.greenComponent, b = base.blueComponent
        let cardLuminance: CGFloat = 1.0 // Design.card 浅色 #FFFFFF
        for _ in 0..<24 {
            let luminance = gbLuminance(r, g, b)
            let background = (1 - fillAlpha) * cardLuminance + fillAlpha * luminance
            if (background + 0.05) / (luminance + 0.05) >= 4.5 { break }
            r *= 0.86; g *= 0.86; b *= 0.86
        }
        return NSColor(srgbRed: r, green: g, blue: b, alpha: 1)
    }
}

/// 浅色可读警示橙（#B45309，白底 5.1:1）；深色保持系统橙。
func accessibleWarningColor() -> NSColor {
    Design.warningText
}

/// 浅色可读错误红（#B91C1C，白底 6.4:1）；深色保持系统红。
func accessibleDangerColor() -> NSColor {
    Design.dangerText
}

final class PillBadge: NSView {
    override var allowsVibrancy: Bool { false }
    let label = text("", size: 11, weight: .semibold)
    var emphasized = false { didSet { updateLabelTextColor(); needsDisplay = true } }
    var tint: NSColor { didSet { updateLabelTextColor(); needsDisplay = true } }
    var title: String { get { label.stringValue } set { label.stringValue = newValue; setAccessibilityLabel(newValue); invalidateIntrinsicContentSize(); needsDisplay = true } }

    static func isNeutralOrInactiveTint(_ color: NSColor, in appearance: NSAppearance) -> Bool {
        if color === Design.inactivePill || color === Design.secondary || color == .secondaryLabelColor || color == .systemGray {
            return true
        }
        let srgb = gbResolvedSRGB(color, appearance)
        let maxC = max(srgb.redComponent, max(srgb.greenComponent, srgb.blueComponent))
        let minC = min(srgb.redComponent, min(srgb.greenComponent, srgb.blueComponent))
        return (maxC - minC) < 0.08
    }

    private func updateLabelTextColor() {
        if emphasized {
            label.textColor = .white
            return
        }
        let currentTint = tint
        label.textColor = NSColor(name: nil) { appearance in
            if Self.isNeutralOrInactiveTint(currentTint, in: appearance) {
                return gbResolvedSRGB(Design.inactivePill, appearance)
            }
            return gbResolvedSRGB(readablePillTint(currentTint), appearance)
        }
    }

    init(_ title: String, color: NSColor) {
        tint = color; super.init(frame: .zero)
        label.setAccessibilityElement(false); label.stringValue = title; updateLabelTextColor(); label.lineBreakMode = .byTruncatingTail
        addSubview(label); label.translatesAutoresizingMaskIntoConstraints = false
        NSLayoutConstraint.activate([label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: 8), label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -8), label.topAnchor.constraint(equalTo: topAnchor, constant: 2.5), label.bottomAnchor.constraint(equalTo: bottomAnchor, constant: -2.5)])
        setAccessibilityElement(true); setAccessibilityRole(.staticText); setAccessibilityLabel(title)
    }
    required init?(coder: NSCoder) { fatalError() }
    override var intrinsicContentSize: NSSize { NSSize(width: label.intrinsicContentSize.width + 16, height: label.intrinsicContentSize.height + 5) }
    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateLabelTextColor()
        needsDisplay = true
    }
    override func draw(_ rect: NSRect) {
        let radius = max(1.0, min(Design.Radius.badge, bounds.height / 2) - 0.25)
        let path = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5), xRadius: radius, yRadius: radius)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if !emphasized && Self.isNeutralOrInactiveTint(tint, in: effectiveAppearance) {
            Design.inactivePillFill.setFill()
            path.fill()
            Design.inactivePillBorder.setStroke()
            path.lineWidth = 0.75
            path.stroke()
            return
        }
        let display: NSColor = emphasized ? .white : readablePillTint(tint)
        display.withAlphaComponent(isDark ? 0.18 : 0.12).setFill()
        path.fill()
        display.withAlphaComponent(isDark ? 0.34 : 0.24).setStroke()
        path.lineWidth = 0.8
        path.stroke()
    }
}
func pillBadge(_ title: String, color: NSColor) -> PillBadge { PillBadge(title, color: color) }

/// 订阅等级专属徽章（方案 A · 光学晶釉）：区别于普通状态 PillBadge 的精致圆角铭牌，按昵称字号提供 regular / compact 两档比例。
final class TierBadge: NSView {
    enum Scale {
        case regular
        case compact

        var height: CGFloat { self == .regular ? 18.0 : 16.0 }
        var cornerRadius: CGFloat { self == .regular ? 5.5 : 4.8 }
        var fontSize: CGFloat { self == .regular ? 9.5 : 8.5 }
        var kern: CGFloat { self == .regular ? 0.45 : 0.35 }
        var leadingPad: CGFloat { self == .regular ? 5.5 : 4.5 }
        var trailingPad: CGFloat { self == .regular ? 6.0 : 5.0 }
        var iconGap: CGFloat { self == .regular ? 3.5 : 3.0 }
        func iconSize(for kind: Kind) -> CGFloat {
            switch kind {
            case .ultra: return self == .regular ? 9.5 : 8.5
            case .pro: return self == .regular ? 8.5 : 7.5
            case .free, .neutral: return 0
            }
        }
    }

    enum Kind: Equatable {
        case free
        case pro
        case ultra
        case neutral

        static func resolve(_ raw: String) -> Kind {
            switch AccountIdentity.normalizeTier(raw) {
            case "ULTRA", "ENTERPRISE": return .ultra
            case "PRO", "TEAM", "PLUS": return .pro
            case "FREE": return .free
            default: return .neutral
            }
        }
    }

    private struct Palette {
        let fillColors: [CGColor]
        let fillLocations: [CGFloat]
        let borderColors: [CGColor]
        let borderLocations: [CGFloat]
        let textColor: NSColor
        let topBevelAlpha: CGFloat
        let diagonalGradient: Bool
    }

    override var allowsVibrancy: Bool { false }
    let scale: Scale
    private let label = text("", size: 9.5, weight: .semibold)
    private var labelLeadingConstraint: NSLayoutConstraint!
    private var kind: Kind = .neutral

    var title: String = "" {
        didSet {
            kind = Kind.resolve(title)
            updateContent()
        }
    }

    init(_ title: String, scale: Scale = .regular) {
        self.scale = scale
        super.init(frame: .zero)
        label.setAccessibilityElement(false)
        label.lineBreakMode = .byTruncatingTail
        label.maximumNumberOfLines = 1
        label.allowsDefaultTighteningForTruncation = false
        addSubview(label)
        label.translatesAutoresizingMaskIntoConstraints = false
        labelLeadingConstraint = label.leadingAnchor.constraint(equalTo: leadingAnchor, constant: scale.leadingPad)
        NSLayoutConstraint.activate([
            labelLeadingConstraint,
            label.trailingAnchor.constraint(equalTo: trailingAnchor, constant: -scale.trailingPad),
            label.centerYAnchor.constraint(equalTo: centerYAnchor),
            heightAnchor.constraint(equalToConstant: scale.height)
        ])
        setContentHuggingPriority(.required, for: .horizontal)
        setContentCompressionResistancePriority(.required, for: .horizontal)
        setContentHuggingPriority(.required, for: .vertical)
        setContentCompressionResistancePriority(.required, for: .vertical)
        setAccessibilityElement(true)
        setAccessibilityRole(.staticText)
        self.title = title
        self.kind = Kind.resolve(title)
        updateContent()
    }

    required init?(coder: NSCoder) { fatalError() }

    private func palette(for kind: Kind, isDark: Bool) -> Palette {
        func cg(_ r: CGFloat, _ g: CGFloat, _ b: CGFloat, _ a: CGFloat) -> CGColor {
            NSColor(srgbRed: r / 255.0, green: g / 255.0, blue: b / 255.0, alpha: a).cgColor
        }
        switch kind {
        case .ultra:
            if isDark {
                return Palette(
                    fillColors: [cg(255, 179, 64, 0.16), cg(168, 85, 247, 0.25), cg(56, 189, 248, 0.19)],
                    fillLocations: [0.0, 0.52, 1.0],
                    borderColors: [cg(251, 191, 36, 0.58), cg(192, 132, 252, 0.56), cg(56, 189, 248, 0.54)],
                    borderLocations: [0.0, 0.5, 1.0],
                    textColor: NSColor(srgbRed: 226/255, green: 198/255, blue: 1.0, alpha: 1.0),
                    topBevelAlpha: 0.22,
                    diagonalGradient: true
                )
            }
            return Palette(
                fillColors: [cg(255, 159, 10, 0.09), cg(139, 92, 246, 0.14), cg(10, 132, 255, 0.13)],
                fillLocations: [0.0, 0.50, 1.0],
                borderColors: [cg(245, 158, 11, 0.52), cg(139, 92, 246, 0.50), cg(14, 165, 233, 0.46)],
                borderLocations: [0.0, 0.52, 1.0],
                textColor: NSColor(srgbRed: 93/255, green: 40/255, blue: 184/255, alpha: 1.0),
                topBevelAlpha: 0.85,
                diagonalGradient: true
            )
        case .pro:
            if isDark {
                return Palette(
                    fillColors: [cg(10, 132, 255, 0.24), cg(72, 152, 255, 0.13)],
                    fillLocations: [0.0, 1.0],
                    borderColors: [cg(105, 182, 255, 0.46), cg(10, 132, 255, 0.22)],
                    borderLocations: [0.0, 1.0],
                    textColor: NSColor(srgbRed: 109/255, green: 183/255, blue: 1.0, alpha: 1.0),
                    topBevelAlpha: 0.20,
                    diagonalGradient: true
                )
            }
            return Palette(
                fillColors: [cg(0, 100, 220, 0.09), cg(52, 120, 246, 0.17)],
                fillLocations: [0.0, 1.0],
                borderColors: [cg(0, 100, 220, 0.34), cg(75, 148, 255, 0.22)],
                borderLocations: [0.0, 1.0],
                textColor: NSColor(srgbRed: 0.0, green: 78/255, blue: 179/255, alpha: 1.0),
                topBevelAlpha: 0.78,
                diagonalGradient: true
            )
        case .free, .neutral:
            if isDark {
                return Palette(
                    fillColors: [cg(255, 255, 255, 0.095), cg(255, 255, 255, 0.045)],
                    fillLocations: [0.0, 1.0],
                    borderColors: [cg(255, 255, 255, 0.18), cg(255, 255, 255, 0.07)],
                    borderLocations: [0.0, 1.0],
                    textColor: NSColor(srgbRed: 162/255, green: 167/255, blue: 180/255, alpha: 1.0),
                    topBevelAlpha: 0.10,
                    diagonalGradient: false
                )
            }
            return Palette(
                fillColors: [cg(246, 247, 250, 1.0), cg(236, 238, 243, 1.0)],
                fillLocations: [0.0, 1.0],
                borderColors: [cg(29, 29, 31, 0.14), cg(29, 29, 31, 0.08)],
                borderLocations: [0.0, 1.0],
                textColor: NSColor(srgbRed: 86/255, green: 92/255, blue: 104/255, alpha: 1.0),
                topBevelAlpha: 0.90,
                diagonalGradient: false
            )
        }
    }

    private func updateContent() {
        let iconSize = scale.iconSize(for: kind)
        let leadingInset = iconSize > 0 ? (scale.leadingPad + iconSize + scale.iconGap) : scale.trailingPad
        labelLeadingConstraint.constant = leadingInset
        let currentKind = kind
        let textColor = NSColor(name: nil) { [weak self] appearance in
            let isDark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            return self?.palette(for: currentKind, isDark: isDark).textColor ?? .labelColor
        }
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: scale.fontSize, weight: .semibold),
            .kern: scale.kern,
            .foregroundColor: textColor
        ]
        label.attributedStringValue = NSAttributedString(string: title, attributes: attrs)
        setAccessibilityLabel(title)
        invalidateIntrinsicContentSize()
        needsDisplay = true
    }

    override var intrinsicContentSize: NSSize {
        let iconSize = scale.iconSize(for: kind)
        let leadingInset = iconSize > 0 ? (scale.leadingPad + iconSize + scale.iconGap) : scale.trailingPad
        let width = leadingInset + ceil(label.intrinsicContentSize.width) + scale.trailingPad
        return NSSize(width: width, height: scale.height)
    }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        updateContent()
    }

    private static func addSparkle(to path: CGMutablePath, center: CGPoint, radius: CGFloat) {
        let waist = radius * 0.08
        path.move(to: CGPoint(x: center.x, y: center.y + radius))
        path.addQuadCurve(to: CGPoint(x: center.x + radius, y: center.y), control: CGPoint(x: center.x + waist, y: center.y + waist))
        path.addQuadCurve(to: CGPoint(x: center.x, y: center.y - radius), control: CGPoint(x: center.x + waist, y: center.y - waist))
        path.addQuadCurve(to: CGPoint(x: center.x - radius, y: center.y), control: CGPoint(x: center.x - waist, y: center.y - waist))
        path.addQuadCurve(to: CGPoint(x: center.x, y: center.y + radius), control: CGPoint(x: center.x - waist, y: center.y + waist))
        path.closeSubpath()
    }

    override func draw(_ rect: NSRect) {
        guard bounds.width > 2 && bounds.height > 2,
              let gctx = NSGraphicsContext.current else { return }
        let ctx = gctx.cgContext
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let pal = palette(for: kind, isDark: isDark)
        let colorSpace = CGColorSpaceCreateDeviceRGB()

        let outerRect = bounds.insetBy(dx: 0.45, dy: 0.45)
        let r = max(1.0, scale.cornerRadius - 0.45)
        let outerPath = CGPath(roundedRect: outerRect, cornerWidth: r, cornerHeight: r, transform: nil)
        let startPt = pal.diagonalGradient ? CGPoint(x: outerRect.minX, y: outerRect.maxY) : CGPoint(x: outerRect.midX, y: outerRect.maxY)
        let endPt = pal.diagonalGradient ? CGPoint(x: outerRect.maxX, y: outerRect.minY) : CGPoint(x: outerRect.midX, y: outerRect.minY)

        // 1. 光学晶釉底色渐变
        ctx.saveGState()
        ctx.addPath(outerPath)
        ctx.clip()
        if let fillGrad = CGGradient(colorsSpace: colorSpace, colors: pal.fillColors as CFArray, locations: pal.fillLocations) {
            ctx.drawLinearGradient(fillGrad, start: startPt, end: endPt, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }

        // 2. 顶部 Specular Bevel 高光倒角（呼应 GravityBox 卡片倒角语言）
        let bevelRect = bounds.insetBy(dx: 0.9, dy: 0.9)
        let bevelR = max(1.0, scale.cornerRadius - 0.9)
        let bevelPath = CGPath(roundedRect: bevelRect, cornerWidth: bevelR, cornerHeight: bevelR, transform: nil)
        ctx.addPath(bevelPath)
        ctx.setLineWidth(0.75)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        let bevelColors = [
            NSColor.white.withAlphaComponent(pal.topBevelAlpha).cgColor,
            NSColor.white.withAlphaComponent(0.0).cgColor
        ] as CFArray
        if let bevelGrad = CGGradient(colorsSpace: colorSpace, colors: bevelColors, locations: [0.0, 0.55]) {
            ctx.drawLinearGradient(bevelGrad, start: CGPoint(x: bevelRect.midX, y: bevelRect.maxY), end: CGPoint(x: bevelRect.midX, y: bevelRect.minY), options: [])
        }
        ctx.restoreGState()

        // 3. 渐变描边
        ctx.saveGState()
        ctx.addPath(outerPath)
        ctx.setLineWidth(0.9)
        ctx.replacePathWithStrokedPath()
        ctx.clip()
        if let borderGrad = CGGradient(colorsSpace: colorSpace, colors: pal.borderColors as CFArray, locations: pal.borderLocations) {
            ctx.drawLinearGradient(borderGrad, start: startPt, end: endPt, options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
        }
        ctx.restoreGState()

        // 4. 等级微徽记
        let iconSize = scale.iconSize(for: kind)
        guard iconSize > 0 else { return }
        let iconRect = CGRect(x: scale.leadingPad, y: (bounds.height - iconSize) / 2.0, width: iconSize, height: iconSize)

        ctx.saveGState()
        switch kind {
        case .pro:
            let starPath = CGMutablePath()
            Self.addSparkle(to: starPath, center: CGPoint(x: iconRect.midX, y: iconRect.midY), radius: iconSize * 0.48)
            ctx.addPath(starPath)
            ctx.setFillColor(pal.textColor.cgColor)
            ctx.fillPath()
        case .ultra:
            let twinPath = CGMutablePath()
            Self.addSparkle(
                to: twinPath,
                center: CGPoint(x: iconRect.minX + iconSize * 0.43, y: iconRect.minY + iconSize * 0.43),
                radius: iconSize * 0.41
            )
            Self.addSparkle(
                to: twinPath,
                center: CGPoint(x: iconRect.minX + iconSize * 0.81, y: iconRect.minY + iconSize * 0.78),
                radius: iconSize * 0.18
            )
            ctx.addPath(twinPath)
            ctx.clip()
            let prismColors: [CGColor] = isDark
                ? [
                    NSColor(srgbRed: 251/255, green: 191/255, blue: 36/255, alpha: 1).cgColor,
                    NSColor(srgbRed: 192/255, green: 132/255, blue: 252/255, alpha: 1).cgColor,
                    NSColor(srgbRed: 56/255, green: 189/255, blue: 248/255, alpha: 1).cgColor
                ]
                : [
                    NSColor(srgbRed: 245/255, green: 158/255, blue: 11/255, alpha: 1).cgColor,
                    NSColor(srgbRed: 139/255, green: 92/255, blue: 246/255, alpha: 1).cgColor,
                    NSColor(srgbRed: 14/255, green: 165/255, blue: 233/255, alpha: 1).cgColor
                ]
            if let prismGrad = CGGradient(colorsSpace: colorSpace, colors: prismColors as CFArray, locations: [0.0, 0.52, 1.0]) {
                ctx.drawLinearGradient(
                    prismGrad,
                    start: CGPoint(x: iconRect.minX, y: iconRect.maxY),
                    end: CGPoint(x: iconRect.maxX, y: iconRect.minY),
                    options: [.drawsBeforeStartLocation, .drawsAfterEndLocation]
                )
            }
        case .free, .neutral:
            break
        }
        ctx.restoreGState()
    }
}
func tierBadge(_ title: String, scale: TierBadge.Scale = .regular) -> TierBadge { TierBadge(title, scale: scale) }

// MARK: - Apple HIG Modern Avatar View & Shared Tinted Icon Container
func tintedIconBox(
    size: CGFloat,
    cornerRadius: CGFloat,
    tint: NSColor,
    neutral: Bool = false,
    lightNeutralAlpha: CGFloat = 0.045,
    darkFillAlpha: CGFloat = 0.18,
    lightFillAlpha: CGFloat = 0.10,
    darkBorderAlpha: CGFloat = 0.32,
    lightBorderAlpha: CGFloat = 0.18
) -> NSBox {
    let box = NSBox()
    box.boxType = .custom
    box.cornerRadius = cornerRadius
    box.fillColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if neutral {
            return isDark ? NSColor.white.withAlphaComponent(0.07) : NSColor.black.withAlphaComponent(lightNeutralAlpha)
        }
        return tint.withAlphaComponent(isDark ? darkFillAlpha : lightFillAlpha)
    }
    box.borderWidth = 0.5
    box.borderColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        if neutral {
            return isDark ? NSColor.white.withAlphaComponent(0.12) : NSColor.black.withAlphaComponent(0.08)
        }
        return tint.withAlphaComponent(isDark ? darkBorderAlpha : lightBorderAlpha)
    }
    box.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        box.widthAnchor.constraint(equalToConstant: size),
        box.heightAnchor.constraint(equalToConstant: size)
    ])
    box.setAccessibilityElement(false)
    return box
}

func iconBadge(_ name: String, tint: NSColor, size: CGFloat = 24) -> NSView {
    let box = tintedIconBox(
        size: size,
        cornerRadius: round(size * 0.26 * 2.0) / 2.0,
        tint: tint,
        darkFillAlpha: 0.18,
        lightFillAlpha: 0.11,
        darkBorderAlpha: 0.34,
        lightBorderAlpha: 0.20
    )
    let ptSize: CGFloat = size == 24 ? 13 : (size >= 36 ? 17.5 : 15)
    let image = symbol(name, size: ptSize, color: tint)
    image.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: ptSize, weight: .semibold)
    box.addSubview(image)
    NSLayoutConstraint.activate([image.centerXAnchor.constraint(equalTo: box.centerXAnchor), image.centerYAnchor.constraint(equalTo: box.centerYAnchor)])
    return box
}
func settingRow(icon: String, tint: NSColor, title: String, badge: NSView? = nil, subtitle: String, control: NSView) -> NSView {
    let titleLabel = text(title, size: 13, weight: .semibold, color: .labelColor)
    let titleView: NSView
    if let badge {
        let row = horizontal([titleLabel, badge], spacing: 6)
        row.alignment = .centerY
        titleView = row
    } else {
        titleView = titleLabel
    }
    var labels: [NSView] = [titleView]
    if !subtitle.isEmpty {
        let sub = text(subtitle, size: 11, color: Design.secondary, wrap: true)
        sub.maximumNumberOfLines = 1
        sub.lineBreakMode = .byTruncatingTail
        labels.append(sub)
    }
    let captions = vertical(labels, spacing: 2)
    captions.alignment = .leading
    captions.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    control.setContentHuggingPriority(.required, for: .horizontal)
    control.setContentCompressionResistancePriority(.required, for: .horizontal)
    let iconBox = tintedIconBox(
        size: 28,
        cornerRadius: 7.5,
        tint: tint,
        neutral: icon == "app-icon",
        lightNeutralAlpha: 0.04
    )
    if icon == "app-icon", let markImg = Design.brandMarkImage() {
        let imgView = NSImageView(image: markImg)
        imgView.imageScaling = .scaleProportionallyUpOrDown
        imgView.translatesAutoresizingMaskIntoConstraints = false
        imgView.setAccessibilityElement(false)
        iconBox.addSubview(imgView)
        NSLayoutConstraint.activate([
            imgView.widthAnchor.constraint(equalToConstant: 17),
            imgView.heightAnchor.constraint(equalToConstant: 17),
            imgView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            imgView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])
    } else {
        let resolvedIcon = icon.hasSuffix(".fill") ? String(icon.dropLast(5)) : icon
        let iconView = symbol(resolvedIcon, size: 13.5, color: tint)
        iconView.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13.5, weight: .medium)
        iconBox.addSubview(iconView)
        NSLayoutConstraint.activate([
            iconView.centerXAnchor.constraint(equalTo: iconBox.centerXAnchor),
            iconView.centerYAnchor.constraint(equalTo: iconBox.centerYAnchor)
        ])
    }
    let row = horizontal([iconBox, captions, flexibleSpace(), control], spacing: 11)
    row.alignment = .centerY
    return row
}
