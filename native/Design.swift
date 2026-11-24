import Cocoa
import QuartzCore
import OSLog

enum PerformanceSignpost {
    static let signposter = OSSignposter(subsystem: "local.gravitybox.app", category: "Performance")
    static func begin(_ name: StaticString) -> OSSignpostIntervalState {
        signposter.beginInterval(name, id: signposter.makeSignpostID())
    }
    static func end(_ name: StaticString, _ state: OSSignpostIntervalState) {
        signposter.endInterval(name, state)
    }
}

// The approved standalone preview is the visual contract. Native system surfaces keep OS behavior.
enum Design {
    /// Density roles, not a mandate to make menu cards and full pages equally spacious.
    enum Spacing {
        static let standard: CGFloat = 12
        static let roomy: CGFloat = 14
        static let page: CGFloat = 10
    }
    enum Radius {
        static let card: CGFloat = 14
        static let medium: CGFloat = 12
        static let popover: CGFloat = 11
        static let control: CGFloat = 8.0
        static let controlCompact: CGFloat = 7.5
        static let badge: CGFloat = 5.5
    }
    static func shouldAnimate(in view: NSView?) -> Bool {
        DesignMotion.defaultShouldAnimate(in: view)
    }
    static func color(_ light: UInt32, _ dark: UInt32) -> NSColor {
        NSColor(name: nil) { appearance in
            let n = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? dark : light
            return NSColor(srgbRed: CGFloat((n >> 16) & 255)/255, green: CGFloat((n >> 8) & 255)/255, blue: CGFloat(n & 255)/255, alpha: 1)
        }
    }
    static let dangerText = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? .systemRed
            : NSColor(srgbRed: 185.0 / 255.0, green: 28.0 / 255.0, blue: 28.0 / 255.0, alpha: 1.0)
    }
    static let warningText = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? .systemOrange
            : NSColor(srgbRed: 180.0 / 255.0, green: 83.0 / 255.0, blue: 9.0 / 255.0, alpha: 1.0)
    }
    static func dynamicAlpha(_ base: NSColor, _ lightAlpha: CGFloat, _ darkAlpha: CGFloat? = nil) -> NSColor {
        let darkValue = darkAlpha ?? lightAlpha
        return NSColor(name: nil) { appearance in
            var resolved: NSColor = base
            appearance.performAsCurrentDrawingAppearance {
                resolved = base.withAlphaComponent(
                    appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? darkValue : lightAlpha
                )
            }
            return resolved
        }
    }
    static let background = color(0xF5F6F9, 0x1C1C1E)
    static let card = color(0xFFFFFF, 0x242428)
    static let subcard = color(0xEBEDF3, 0x2C2C31)
    static let track = color(0xE2E4EC, 0x38383E)
    static let primary = color(0x1D1D1F, 0xF2F2F7)
    static let text = primary
    static let secondary = color(0x6E6E73, 0x8E8E93)
    static let border = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor.white.withAlphaComponent(0.085)
            : NSColor.black.withAlphaComponent(0.068)
    }
    static func cardShadow() -> NSShadow {
        let shadow = NSShadow()
        shadow.shadowColor = NSColor(name: nil) { appearance in
            appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor.black.withAlphaComponent(0.32)
                : NSColor(srgbRed: 0.05, green: 0.07, blue: 0.14, alpha: 0.055)
        }
        shadow.shadowOffset = NSSize(width: 0, height: -2.0)
        shadow.shadowBlurRadius = 6.5
        return shadow
    }
    static func drawSpecularBevel(in rect: NSRect, cornerRadius: CGFloat, isDark: Bool) {
        let innerRect = rect.insetBy(dx: 0.5, dy: 0.5)
        guard innerRect.width > 2 && innerRect.height > 2 else { return }
        let r = max(1, cornerRadius - 0.5)
        guard let gctx = NSGraphicsContext.current else { return }
        let ctx = gctx.cgContext
        ctx.saveGState()
        let cgPath = CGPath(roundedRect: innerRect, cornerWidth: r, cornerHeight: r, transform: nil)
        ctx.addPath(cgPath)
        ctx.setLineWidth(isDark ? 0.65 : 0.75)
        ctx.replacePathWithStrokedPath()
        ctx.clip()

        let topColor = isDark
            ? NSColor.white.withAlphaComponent(0.145)
            : NSColor.white.withAlphaComponent(0.82)
        let midColor = isDark
            ? NSColor.white.withAlphaComponent(0.045)
            : NSColor.white.withAlphaComponent(0.35)
        let bottomColor = isDark
            ? NSColor.white.withAlphaComponent(0.015)
            : NSColor.white.withAlphaComponent(0.10)

        if let grad = NSGradient(colors: [topColor, midColor, bottomColor], atLocations: [0.0, 0.45, 1.0], colorSpace: .sRGB) {
            let isFlipped = gctx.isFlipped
            let startPt = NSPoint(x: innerRect.midX, y: isFlipped ? innerRect.minY : innerRect.maxY)
            let endPt = NSPoint(x: innerRect.midX, y: isFlipped ? innerRect.maxY : innerRect.minY)
            grad.draw(from: startPt, to: endPt, options: [])
        }
        ctx.restoreGState()
    }
    static let blue = color(0x0064DC, 0x0A84FF)
    static let activeBlue = NSColor(name: nil) { appearance in
        appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.38, green: 0.68, blue: 1.0, alpha: 1.0)
            : blue
    }
    static let inactivePill = color(0x4A638C, 0x8CA6D6)
    static let inactivePillFill = NSColor(name: nil) {
        $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.34, green: 0.52, blue: 0.84, alpha: 0.14)
            : NSColor(srgbRed: 0.918, green: 0.942, blue: 0.982, alpha: 0.95)
    }
    static let inactivePillBorder = NSColor(name: nil) {
        $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
            ? NSColor(srgbRed: 0.46, green: 0.66, blue: 0.96, alpha: 0.22)
            : NSColor(srgbRed: 0.24, green: 0.45, blue: 0.78, alpha: 0.18)
    }
    static let popoverCardBackground = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.07) : NSColor.white.withAlphaComponent(0.76) }
    static let popoverCardBorder = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.095) : NSColor.black.withAlphaComponent(0.07) }
    static let popoverFooterBackground = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.04) : NSColor.black.withAlphaComponent(0.025) }
    static let menuSegmentAccent = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0.44, green: 0.72, blue: 1.0, alpha: 1.0) : Design.blue }
    static let chartTooltipFill = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 0.18, alpha: 0.94) : NSColor(white: 0.15, alpha: 0.88) }
    static let chartTooltipBorder = NSColor(name: nil) { $0.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor.white.withAlphaComponent(0.18) : NSColor.black.withAlphaComponent(0.12) }

    static func isInPopover(_ view: NSView?) -> Bool {
        var cur = view?.superview
        while let v = cur {
            if let vev = v as? NSVisualEffectView, vev.material == .popover { return true }
            cur = v.superview
        }
        return false
    }

    private static var cachedAppIcon: NSImage?
    private static var cachedBrandMark: NSImage?
    static func appIconImage() -> NSImage? {
        if let cached = cachedAppIcon { return cached }
        var candidates: [URL] = []
        if let res = Bundle.main.resourceURL {
            candidates.append(res.appendingPathComponent("AppIcon.icns"))
            candidates.append(res.appendingPathComponent("master-1024.png"))
        }
        if let envPath = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] {
            let envURL = URL(fileURLWithPath: envPath)
            candidates.append(envURL.appendingPathComponent("AppIcon.icns"))
            candidates.append(envURL.appendingPathComponent("master-1024.png"))
        }
        let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
        candidates.append(cwd.appendingPathComponent("assets/AppIcon.icns"))
        candidates.append(cwd.appendingPathComponent("assets/master-1024.png"))
        for url in candidates {
            if let img = NSImage(contentsOf: url) {
                img.isTemplate = false
                cachedAppIcon = img
                return img
            }
        }
        return NSApp?.applicationIconImage
    }

    /// Extracts the transparent rainbow double-arch mark from AppIcon without the white squircle background or white edge halo.
    static func brandMarkImage() -> NSImage? {
        if let cached = cachedBrandMark { return cached }
        guard let src = appIconImage() else { return nil }
        let dim = 256
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        let bitmapInfo = CGImageAlphaInfo.premultipliedLast.rawValue
        var pixels = [UInt8](repeating: 0, count: dim * dim * 4)
        let rendered: Bool = pixels.withUnsafeMutableBytes { ptr in
            guard let base = ptr.baseAddress,
                  let ctx = CGContext(data: base, width: dim, height: dim, bitsPerComponent: 8, bytesPerRow: dim * 4, space: colorSpace, bitmapInfo: bitmapInfo) else {
                return false
            }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
            src.draw(in: NSRect(x: 0, y: 0, width: dim, height: dim), from: .zero, operation: .copy, fraction: 1.0)
            NSGraphicsContext.restoreGraphicsState()
            return true
        }
        guard rendered else { return src }

        let minBound = Int(Double(dim) * 0.19)
        let maxBound = Int(Double(dim) * 0.81)
        var cropMinX = dim, cropMinY = dim, cropMaxX = 0, cropMaxY = 0

        for y in 0..<dim {
            for x in 0..<dim {
                let idx = (y * dim + x) * 4
                guard x >= minBound && x <= maxBound && y >= minBound && y <= maxBound, pixels[idx + 3] > 200 else {
                    pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0
                    continue
                }
                let r = Double(pixels[idx]) / 255.0
                let g = Double(pixels[idx + 1]) / 255.0
                let b = Double(pixels[idx + 2]) / 255.0
                let minC = min(r, min(g, b))
                let maxC = max(r, max(g, b))
                let sat = maxC - minC
                // White squircle background has minC > 0.93 and sat < 0.04; rainbow arch has strong color & lower minC.
                let rawAlpha = max((0.94 - minC) / 0.36, sat * 1.65)
                let alpha = min(1.0, max(0.0, rawAlpha))
                if alpha < 0.04 {
                    pixels[idx] = 0; pixels[idx + 1] = 0; pixels[idx + 2] = 0; pixels[idx + 3] = 0
                } else {
                    // Un-premultiply white background to eliminate any white fringe on dark backgrounds
                    let bgWeight = 1.0 - alpha
                    let pureR = min(1.0, max(0.0, (r - bgWeight) / alpha))
                    let pureG = min(1.0, max(0.0, (g - bgWeight) / alpha))
                    let pureB = min(1.0, max(0.0, (b - bgWeight) / alpha))
                    pixels[idx] = UInt8(round(pureR * alpha * 255.0))
                    pixels[idx + 1] = UInt8(round(pureG * alpha * 255.0))
                    pixels[idx + 2] = UInt8(round(pureB * alpha * 255.0))
                    pixels[idx + 3] = UInt8(round(alpha * 255.0))
                    if alpha > 0.12 {
                        if x < cropMinX { cropMinX = x }
                        if x > cropMaxX { cropMaxX = x }
                        if y < cropMinY { cropMinY = y }
                        if y > cropMaxY { cropMaxY = y }
                    }
                }
            }
        }

        let outImage: CGImage? = pixels.withUnsafeMutableBytes { ptr in
            guard let base = ptr.baseAddress,
                  let ctx = CGContext(data: base, width: dim, height: dim, bitsPerComponent: 8, bytesPerRow: dim * 4, space: colorSpace, bitmapInfo: bitmapInfo) else {
                return nil
            }
            return ctx.makeImage()
        }
        guard let fullCG = outImage else { return src }
        if cropMaxX > cropMinX && cropMaxY > cropMinY {
            let bw = cropMaxX - cropMinX + 1
            let bh = cropMaxY - cropMinY + 1
            let side = max(bw, bh) + 8
            let cx = (cropMinX + cropMaxX) / 2
            let cy = (cropMinY + cropMaxY) / 2
            let rx = max(0, min(dim - side, cx - side / 2))
            // CGImage cropping uses top-left origin whereas CGContext bitmap buffer row 0 is top
            let ry = max(0, min(dim - side, cy - side / 2))
            if let cropped = fullCG.cropping(to: CGRect(x: rx, y: ry, width: side, height: side)) {
                let result = NSImage(cgImage: cropped, size: NSSize(width: 64, height: 64))
                result.isTemplate = false
                cachedBrandMark = result
                return result
            }
        }
        let result = NSImage(cgImage: fullCG, size: NSSize(width: 64, height: 64))
        result.isTemplate = false
        cachedBrandMark = result
        return result
    }
    private static var activePopUpMenuDepth: Int = 0
    static var isTrackingPopUpMenu: Bool { activePopUpMenuDepth > 0 }
    static let popUpMenuDidCloseNotification = Notification.Name("GravityBox.DesignPopUpMenuDidClose")

    static func activateApplicationForcingFront() {
        #if !NATIVE_UI_TEST
        NSApp.activate(ignoringOtherApps: true)
        #endif
    }

    static func popUpOrigin(below anchor: NSView, spacing: CGFloat = 6) -> NSPoint {
        let yOffset = anchor.isFlipped ? (anchor.bounds.maxY + spacing) : (anchor.bounds.minY - spacing)
        return NSPoint(x: 0, y: yOffset)
    }

    static func isTrackedPopUpContainerWindow(_ window: NSWindow, excluding hostWindow: NSWindow) -> Bool {
        guard window.isVisible, window !== hostWindow else { return false }
        guard window.level.rawValue >= NSWindow.Level.popUpMenu.rawValue else { return false }
        let className = window.className
        if className.contains("StatusBar") { return false }
        // Liquid Glass menus render inside a child _NSGlassEffectWindow owned by NSPopupMenuWindow;
        // attach the container window so both move into the host window's space together.
        if className.contains("Glass") && window.parent != nil { return false }
        return className.contains("Popup") || className.contains("Menu") || window.parent == nil
    }

    @discardableResult
    static func anchorTrackedPopUpWindows(
        to hostWindow: NSWindow,
        in windows: [NSWindow] = NSApp.windows,
        alreadyAnchored: inout [NSWindow]
    ) -> [NSWindow] {
        var newlyAnchored: [NSWindow] = []
        for candidate in windows {
            guard isTrackedPopUpContainerWindow(candidate, excluding: hostWindow) else { continue }
            guard !alreadyAnchored.contains(where: { $0 === candidate }) else { continue }
            let targetLevel = NSWindow.Level(rawValue: max(candidate.level.rawValue, NSWindow.Level.popUpMenu.rawValue))
            let childLevels = (candidate.childWindows ?? []).map {
                ($0, NSWindow.Level(rawValue: max($0.level.rawValue, NSWindow.Level.popUpMenu.rawValue)))
            }
            if let existingParent = candidate.parent, existingParent !== hostWindow {
                existingParent.removeChildWindow(candidate)
            }
            if candidate.parent === hostWindow {
                // Re-attach once so WindowServer synchronizes child windows (e.g. _NSGlassEffectWindow) onto hostWindow's active space.
                hostWindow.removeChildWindow(candidate)
            }
            hostWindow.addChildWindow(candidate, ordered: .above)
            if candidate.level != targetLevel {
                candidate.level = targetLevel
            }
            for (child, childLevel) in childLevels where child.level != childLevel {
                child.level = childLevel
            }
            alreadyAnchored.append(candidate)
            newlyAnchored.append(candidate)
        }
        return newlyAnchored
    }

    static func detachTrackedPopUpWindows(_ windows: [NSWindow], from hostWindow: NSWindow?) {
        guard let hostWindow else { return }
        for popupWindow in windows where popupWindow.parent === hostWindow {
            hostWindow.removeChildWindow(popupWindow)
        }
    }

    static func popUpMenu(_ menu: NSMenu, below anchor: NSView, spacing: CGFloat = 6, matchAnchorWidth: Bool = false) {
        if matchAnchorWidth {
            menu.minimumWidth = max(menu.minimumWidth, anchor.bounds.width)
        }
        let hostWindow = anchor.window
        #if !NATIVE_UI_TEST
        if let panel = hostWindow as? MenuFloatingPanel {
            if !panel.isKeyWindow {
                panel.makeKey()
            }
        } else if let hostWindow, hostWindow.canBecomeKey {
            if !NSApp.isActive {
                activateApplicationForcingFront()
            }
            if !hostWindow.isKeyWindow {
                hostWindow.makeKeyAndOrderFront(nil)
            }
        }
        #else
        if let panel = hostWindow as? MenuFloatingPanel, !panel.isKeyWindow {
            panel.makeKey()
        }
        #endif
        var isTrackingThisMenu = true
        var anchoredPopUpWindows: [NSWindow] = []
        var trackingObserver: NSObjectProtocol?
        if let hostWindow {
            trackingObserver = NotificationCenter.default.addObserver(
                forName: NSMenu.didBeginTrackingNotification,
                object: nil,
                queue: .main
            ) { [weak hostWindow] _ in
                DispatchQueue.main.async {
                    guard isTrackingThisMenu, let hostWindow, hostWindow.isVisible else { return }
                    _ = anchorTrackedPopUpWindows(to: hostWindow, alreadyAnchored: &anchoredPopUpWindows)
                }
            }
        }
        activePopUpMenuDepth += 1
        defer {
            isTrackingThisMenu = false
            if let trackingObserver {
                NotificationCenter.default.removeObserver(trackingObserver)
            }
            detachTrackedPopUpWindows(anchoredPopUpWindows, from: hostWindow)
            activePopUpMenuDepth = max(0, activePopUpMenuDepth - 1)
            if let panel = anchor.window as? MenuFloatingPanel, panel.isVisible {
                panel.makeKey()
                DispatchQueue.main.async { [weak panel] in
                    guard let panel, panel.isVisible else { return }
                    panel.makeKey()
                }
            }
            if activePopUpMenuDepth == 0 {
                NotificationCenter.default.post(name: popUpMenuDidCloseNotification, object: nil)
            }
        }
        menu.popUp(positioning: nil, at: popUpOrigin(below: anchor, spacing: spacing), in: anchor)
    }

    static func fittedPopUpWidth(_ popup: NSPopUpButton, minimum: CGFloat? = nil, maxWidth: CGFloat? = nil) -> CGFloat {
        let isSmall = popup.controlSize == .small
        let fontSize: CGFloat = isSmall ? 11.5 : 12
        let drawFont = NSFont.systemFont(ofSize: fontSize, weight: .medium)
        let popUpCell = popup.cell as? DesignPopUpCell
        let fitsSelectedOnly = popUpCell?.fitsSelectedTitleOnly == true
        let itemTitles: [String]
        if popup.pullsDown {
            itemTitles = [popup.title]
        } else if fitsSelectedOnly {
            itemTitles = [popup.selectedItem?.title ?? popup.title]
        } else {
            itemTitles = (popup.menu?.items ?? []).filter { !$0.isSeparatorItem }.map(\.title)
        }
        let candidates = itemTitles.isEmpty ? [popup.title] : itemTitles
        let maxTitleW = candidates.reduce(CGFloat(0)) { acc, item in
            max(acc, ceil((item as NSString).size(withAttributes: [.font: drawFont]).width))
        }
        let hasLeadingIcon = (popUpCell?.leadingImage != nil) || (popUpCell?.leadingSymbolName?.isEmpty == false)
        let iconExtra: CGFloat = hasLeadingIcon ? 18 : 0
        // DesignPopUpCell draws text at x = minX + 11 (small: 9.5) (+ iconExtra) with chevron centered at maxX - 12.5 (small: 11.5).
        let baseChrome: CGFloat = (popUpCell?.visualStyle ?? .form) == .form ? (isSmall ? 34 : 38) : (isSmall ? 35 : 39)
        let chrome: CGFloat = baseChrome + iconExtra
        let floorWidth: CGFloat = minimum ?? (isSmall ? 58 : 64)
        let raw = max(floorWidth, maxTitleW + chrome)
        let bounded = popup.pullsDown ? min(150, raw) : raw
        if let maxWidth {
            return min(maxWidth, bounded)
        }
        return bounded
    }

    @discardableResult
    static func syncPopUpWidth(_ popup: NSPopUpButton, maxWidth: CGFloat? = nil) -> CGFloat {
        let targetWidth = fittedPopUpWidth(popup, maxWidth: maxWidth)
        if let existing = popup.constraints.first(where: { $0.identifier == "design-control-width" }) {
            existing.constant = targetWidth
        } else {
            let width = popup.widthAnchor.constraint(greaterThanOrEqualToConstant: targetWidth)
            width.identifier = "design-control-width"
            width.priority = .required
            width.isActive = true
        }
        if let maxWidth {
            if let existingMax = popup.constraints.first(where: { $0.identifier == "design-control-max-width" }) {
                existingMax.constant = maxWidth
            } else {
                let maxC = popup.widthAnchor.constraint(lessThanOrEqualToConstant: maxWidth)
                maxC.identifier = "design-control-max-width"
                maxC.priority = NSLayoutConstraint.Priority(999)
                maxC.isActive = true
            }
        } else if let existingMax = popup.constraints.first(where: { $0.identifier == "design-control-max-width" }) {
            existingMax.isActive = false
            popup.removeConstraint(existingMax)
        }
        popup.invalidateIntrinsicContentSize()
        return targetWidth
    }

    static func applyControls(_ view: NSView) {
        if let popup = view as? NSPopUpButton {
            let origControlSize = popup.controlSize
            let prevCell = popup.cell as? DesignPopUpCell
            let prevSymbol = prevCell?.leadingSymbolName
            let prevImage = prevCell?.leadingImage
            let prevFitsSelectedOnly = prevCell?.fitsSelectedTitleOnly ?? false
            let prevVisualStyle = prevCell?.visualStyle ?? .form
            let prevCustomHeight = prevCell?.customHeight
            let prevIsActiveState = prevCell?.isActiveState ?? false
            let prevMaxWidth = popup.constraints.first(where: { $0.identifier == "design-control-max-width" })?.constant
            if !(popup.cell is DesignPopUpCell) {
                let menu = popup.menu, selected = popup.indexOfSelectedItem, target = popup.target, action = popup.action, enabled = popup.isEnabled
                let cell = DesignPopUpCell(textCell: "", pullsDown: popup.pullsDown)
                cell.controlSize = origControlSize
                cell.leadingSymbolName = prevSymbol
                cell.leadingImage = prevImage
                cell.fitsSelectedTitleOnly = prevFitsSelectedOnly
                cell.visualStyle = prevVisualStyle
                cell.customHeight = prevCustomHeight
                cell.isActiveState = prevIsActiveState
                cell.menu = menu; popup.cell = cell; popup.selectItem(at: max(0, selected)); popup.target = target; popup.action = action; popup.isEnabled = enabled
                popup.controlSize = origControlSize
                popup.invalidateIntrinsicContentSize()
            } else if let cell = popup.cell as? DesignPopUpCell {
                cell.controlSize = origControlSize
                cell.leadingSymbolName = prevSymbol
                cell.leadingImage = prevImage
                cell.fitsSelectedTitleOnly = prevFitsSelectedOnly
                cell.visualStyle = prevVisualStyle
                cell.customHeight = prevCustomHeight
                cell.isActiveState = prevIsActiveState
            }
            if !popup.subviews.contains(where: { $0 is DesignPopUpHoverOverlay }) {
                let overlay = DesignPopUpHoverOverlay()
                overlay.translatesAutoresizingMaskIntoConstraints = false
                popup.addSubview(overlay)
                NSLayoutConstraint.activate([
                    overlay.leadingAnchor.constraint(equalTo: popup.leadingAnchor),
                    overlay.trailingAnchor.constraint(equalTo: popup.trailingAnchor),
                    overlay.topAnchor.constraint(equalTo: popup.topAnchor),
                    overlay.bottomAnchor.constraint(equalTo: popup.bottomAnchor)
                ])
            }
            let isSmall = origControlSize == .small
            popup.font = .systemFont(ofSize: isSmall ? 11.5 : 12, weight: .medium); popup.isBordered = false
            popup.focusRingType = .none
            popup.cell?.focusRingType = .none
            popup.translatesAutoresizingMaskIntoConstraints = false
            let targetHeight = prevCustomHeight ?? (isSmall ? 26 : 28)
            if let existingH = popup.constraints.first(where: { $0.identifier == "design-control-height" }) {
                existingH.constant = targetHeight
            } else {
                let height = popup.heightAnchor.constraint(equalToConstant: targetHeight); height.identifier = "design-control-height"; height.isActive = true
            }
            syncPopUpWidth(popup, maxWidth: prevMaxWidth)
        } else if let field = view as? NSTextField, field.isEditable {
            if field.identifier?.rawValue == "native-percent-input" { field.font = .systemFont(ofSize:12); return }
            let currentFont = field.font ?? .systemFont(ofSize: 12)
            if !(field is NSSearchField), !(field is NSComboBox), !(field is NSSecureTextField), !(field.cell is DesignTextCell) {
                let value = field.stringValue, placeholder = field.placeholderString, enabled = field.isEnabled
                let alignment = field.alignment, target = field.target, action = field.action
                let cell = DesignTextCell(textCell: value)
                cell.font = currentFont
                cell.alignment = alignment
                cell.placeholderString = placeholder
                cell.isEnabled = enabled
                cell.isEditable = true
                cell.isSelectable = true
                cell.usesSingleLineMode = true
                cell.wraps = false
                cell.isScrollable = true
                cell.sendsActionOnEndEditing = true
                cell.focusRingType = .none
                field.cell = cell
                field.stringValue = value
                field.alignment = alignment
                field.target = target
                field.action = action
                field.isEditable = true
                field.isSelectable = true
            }
            field.font = currentFont
            if !(field is NSSearchField) {
                field.isBezeled = false
                field.drawsBackground = false
                field.focusRingType = .none
                field.cell?.focusRingType = .none
            }
            if !field.constraints.contains(where: { $0.identifier == "design-input-height" }) {
                let height = field.heightAnchor.constraint(greaterThanOrEqualToConstant: 28); height.identifier = "design-input-height"; height.isActive = true
            }

        }
        for child in view.subviews { applyControls(child) }
    }
}

// DesignMotion is defined in native/DesignMotion.swift

final class MetricCardBox: NSBox {
    weak var clickTarget: AnyObject?
    var clickAction: Selector?
    var metricTitle: String = ""
    weak var titleField: NSTextField?
    weak var valueField: NSTextField?
    weak var detailField: NSTextField?
    weak var statusBadge: PillBadge?
    weak var chevronView: NSImageView?
    private var hoverTracking: NSTrackingArea?
    private let hoverMotion = DesignMotion()
    private var hoverProgress: CGFloat = 0
    override var allowsVibrancy: Bool { false }
    deinit {
        hoverMotion.cancel()
    }
    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        if window == nil { hoverMotion.cancel() }
    }
    var hovered = false {
        didSet {
            guard oldValue != hovered, clickTarget != nil, clickAction != nil else { return }
            let target: CGFloat = hovered ? 1.0 : 0.0
            hoverMotion.animate(in: self, from: hoverProgress, to: target, curve: .hover, threshold: 0.04) { [weak self] val in
                guard let self else { return }
                self.hoverProgress = val
                self.borderColor = val > 0.02 ? Design.blue.withAlphaComponent(0.12 + 0.36 * val) : Design.border
                self.chevronView?.contentTintColor = val > 0.5 ? Design.blue : Design.secondary.withAlphaComponent(0.55)
                self.needsDisplay = true
            }
        }
    }

    override var acceptsFirstResponder: Bool { clickTarget != nil && clickAction != nil }
    override var canBecomeKeyView: Bool { clickTarget != nil && clickAction != nil }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area = hoverTracking { removeTrackingArea(area) }
        guard clickTarget != nil && clickAction != nil else { return }
        let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self)
        hoverTracking = area
        addTrackingArea(area)
    }
    override func mouseEntered(with event: NSEvent) { hovered = true }
    override func mouseExited(with event: NSEvent) { hovered = false }

    func setStatusBadge(_ title: String?, tint: NSColor = accessibleWarningColor()) {
        guard let badge = statusBadge else { return }
        let clean = (title ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        badge.isHidden = clean.isEmpty
        if !clean.isEmpty {
            if badge.title != clean { badge.title = clean }
            badge.tint = tint
        }
        refreshAccessibility()
    }

    private func accessibilityHeadingText() -> String {
        guard let badge = statusBadge, !badge.isHidden else { return metricTitle }
        let badgeText = badge.title.trimmingCharacters(in: .whitespacesAndNewlines)
        return badgeText.isEmpty ? metricTitle : "\(metricTitle) · \(badgeText)"
    }

    func refreshAccessibility() {
        let val = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let det = detailField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let heading = accessibilityHeadingText()
        let sep = L10n.shared.isEnglish ? ", " : "，"
        let label = val.isEmpty ? heading : "\(heading)\(sep)\(val)"
        setAccessibilityLabel(label)
        setAccessibilityValue(det.isEmpty ? val : "\(val) · \(det)")
    }

    override func accessibilityLabel() -> String? {
        let val = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let heading = accessibilityHeadingText()
        if !heading.isEmpty {
            let sep = L10n.shared.isEnglish ? ", " : "，"
            return val.isEmpty ? heading : "\(heading)\(sep)\(val)"
        }
        return super.accessibilityLabel()
    }

    override func accessibilityValue() -> Any? {
        let val = valueField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let det = detailField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !val.isEmpty || !det.isEmpty {
            return det.isEmpty ? val : "\(val) · \(det)"
        }
        return super.accessibilityValue()
    }

    override func accessibilityPerformPress() -> Bool {
        guard let target = clickTarget, let action = clickAction else { return false }
        return NSApp.sendAction(action, to: target, from: self)
    }

    override func keyDown(with event: NSEvent) {
        if let target = clickTarget, let action = clickAction, (event.keyCode == 36 || event.keyCode == 49) { // Return or Space
            NSApp.sendAction(action, to: target, from: self)
            return
        }
        super.keyDown(with: event)
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        let isDark = effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        Design.drawSpecularBevel(in: bounds, cornerRadius: cornerRadius, isDark: isDark)
    }

    override func drawFocusRingMask() {
        let path = NSBezierPath(roundedRect: bounds, xRadius: cornerRadius, yRadius: cornerRadius)
        path.fill()
    }

    override var focusRingMaskBounds: NSRect { bounds }
}

// MARK: - KPI detail line
// A real-data detail string ("累计 Token 用量 1.1B（统计 30/331 库）· 部分库异常") must not
// contribute to the window's minimum width. This label therefore has no intrinsic width:
// it fills the card, truncates with an ellipsis, and keeps the full copy in its tooltip
// (the accessibility value still exposes the complete stringValue).
final class MetricDetailField: NSTextField {
    override var intrinsicContentSize: NSSize {
        NSSize(width: NSView.noIntrinsicMetric, height: super.intrinsicContentSize.height)
    }
    override var stringValue: String {
        get { super.stringValue }
        set {
            super.stringValue = newValue
            toolTip = nil
        }
    }
    func configureAsMetricDetail() {
        font = .systemFont(ofSize: 11)
        textColor = Design.secondary
        isEditable = false
        isSelectable = false
        isBezeled = false
        drawsBackground = false
        maximumNumberOfLines = 1
        lineBreakMode = .byTruncatingTail
        cell?.wraps = false
        cell?.isScrollable = false
        cell?.truncatesLastVisibleLine = true
        setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        setContentHuggingPriority(.defaultLow, for: .horizontal)
    }
}

func metricDetail(_ value: String) -> MetricDetailField {
    let field = MetricDetailField(labelWithString: value)
    field.configureAsMetricDetail()
    field.toolTip = nil
    return field
}

enum MetricKind {
    case tokens
    case cost
    case requests
    case general
}

func compactMetric(_ title: String, value: NSTextField, detail: NSTextField, action: NSButton? = nil, target: AnyObject? = nil, onClick: Selector? = nil, kind: MetricKind? = nil) -> NSBox {
    value.font = .monospacedDigitSystemFont(ofSize: 26, weight: .bold)
    detail.font = .systemFont(ofSize: 11)
    detail.textColor = Design.secondary
    detail.maximumNumberOfLines = 2
    detail.lineBreakMode = .byWordWrapping
    detail.cell?.wraps = true
    detail.cell?.isScrollable = false
    detail.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    detail.setContentHuggingPriority(.defaultLow, for: .horizontal)
    detail.toolTip = nil

    let resolvedKind: MetricKind = kind ?? {
        if title.contains("Token") {
            return .tokens
        } else if title.contains("费用") || title.localizedCaseInsensitiveContains("cost") {
            return .cost
        } else if title.contains("请求") || title.localizedCaseInsensitiveContains("request") {
            return .requests
        } else {
            return .general
        }
    }()
    let (symbolName, badgeTint): (String, NSColor) = {
        switch resolvedKind {
        case .tokens: return ("sparkles", Design.blue)
        case .cost: return ("dollarsign.circle.fill", .systemTeal)
        case .requests: return ("paperplane.fill", .systemIndigo)
        case .general: return ("chart.xyaxis.line", Design.blue)
        }
    }()
    let badgeBox = NSBox()
    badgeBox.boxType = .custom
    badgeBox.cornerRadius = 6
    badgeBox.fillColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return badgeTint.withAlphaComponent(isDark ? 0.18 : 0.10)
    }
    badgeBox.borderWidth = 0.5
    badgeBox.borderColor = NSColor(name: nil) { app in
        let isDark = app.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        return badgeTint.withAlphaComponent(isDark ? 0.30 : 0.16)
    }
    badgeBox.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        badgeBox.widthAnchor.constraint(equalToConstant: 22),
        badgeBox.heightAnchor.constraint(equalToConstant: 22)
    ])
    let badgeIcon = symbol(symbolName, size: 11.5, color: badgeTint)
    badgeIcon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 11, weight: .semibold)
    badgeBox.addSubview(badgeIcon)
    NSLayoutConstraint.activate([
        badgeIcon.centerXAnchor.constraint(equalTo: badgeBox.centerXAnchor),
        badgeIcon.centerYAnchor.constraint(equalTo: badgeBox.centerYAnchor)
    ])
    badgeBox.setAccessibilityElement(false)

    let heading = text(title, size: 12, weight: .medium, color: Design.secondary)
    heading.lineBreakMode = .byTruncatingTail
    heading.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
    let headingGroup = horizontal([badgeBox, heading], spacing: 6)
    headingGroup.alignment = .centerY
    let statusBadge = pillBadge("", color: accessibleWarningColor())
    statusBadge.label.font = .systemFont(ofSize: 9.5, weight: .semibold)
    statusBadge.isHidden = true
    statusBadge.setContentHuggingPriority(.required, for: .horizontal)
    statusBadge.setContentCompressionResistancePriority(.required, for: .horizontal)

    var chevron: NSImageView?
    var headerItems: [NSView] = [headingGroup, flexibleSpace(), statusBadge]
    if target != nil && onClick != nil {
        let icon = symbol("chevron.right", size: 10, color: Design.secondary.withAlphaComponent(0.55))
        icon.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 9.5, weight: .semibold)
        chevron = icon
        headerItems.append(icon)
    }
    let headerRow = horizontal(headerItems, spacing: 4)
    headerRow.alignment = .centerY
    headerRow.detachesHiddenViews = true
    let topRow: NSView = headerRow
    let rows: [NSView] = [topRow, value, detail] + (action.map { [$0] } ?? [])
    let content = vertical(rows, spacing: 6)
    for row in rows { fillWidth(row, in: content) }
    let card = MetricCardBox()
    card.metricTitle = title
    card.titleField = heading
    card.valueField = value
    card.detailField = detail
    card.statusBadge = statusBadge
    card.chevronView = chevron
    card.boxType = .custom
    card.borderWidth = 0.5
    card.cornerRadius = Design.Radius.card
    card.fillColor = Design.card
    card.borderColor = Design.border
    card.shadow = Design.cardShadow()
    card.contentViewMargins = .zero
    card.addSubview(content)
    content.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        content.leadingAnchor.constraint(equalTo:card.leadingAnchor,constant:16),
        content.trailingAnchor.constraint(equalTo:card.trailingAnchor,constant:-16),
        content.centerYAnchor.constraint(equalTo:card.centerYAnchor),
        content.topAnchor.constraint(greaterThanOrEqualTo:card.topAnchor,constant:12),
        content.bottomAnchor.constraint(lessThanOrEqualTo:card.bottomAnchor,constant:-12)
    ])
    if let target, let onClick {
        card.clickTarget = target
        card.clickAction = onClick
        card.focusRingType = .exterior
        card.setAccessibilityElement(true)
        card.setAccessibilityRole(.button)
        card.refreshAccessibility()
        let gesture = NSClickGestureRecognizer(target: target, action: onClick)
        card.addGestureRecognizer(gesture)
    } else {
        card.setAccessibilityElement(true)
        card.setAccessibilityRole(.group)
        card.refreshAccessibility()
    }
    return card
}

// Legacy NSMenu menu quota components retired in favor of MenuPanelController.

func identityHeader(identity: NSView, actions: NSView) -> NSView {
    let container = NSView(); container.identifier = NSUserInterfaceItemIdentifier("account-identity-header"); actions.identifier = NSUserInterfaceItemIdentifier("account-actions")
    for child in [identity, actions] { child.translatesAutoresizingMaskIntoConstraints = false; container.addSubview(child) }
    container.translatesAutoresizingMaskIntoConstraints = false
    NSLayoutConstraint.activate([
        container.heightAnchor.constraint(greaterThanOrEqualToConstant: 36),
        identity.trailingAnchor.constraint(equalTo: actions.leadingAnchor, constant: -12), identity.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        identity.topAnchor.constraint(greaterThanOrEqualTo: container.topAnchor), identity.bottomAnchor.constraint(lessThanOrEqualTo: container.bottomAnchor),
        actions.trailingAnchor.constraint(equalTo: container.trailingAnchor), actions.centerYAnchor.constraint(equalTo: container.centerYAnchor)
    ])
    let identityHeight = container.heightAnchor.constraint(equalTo: identity.heightAnchor)
    identityHeight.priority = .defaultHigh; identityHeight.isActive = true
    identity.leadingAnchor.constraint(equalTo: container.leadingAnchor).isActive = true
    if let stack = actions as? NSStackView {
        stack.detachesHiddenViews = true
        stack.setHuggingPriority(.required, for: .horizontal)
        stack.setContentCompressionResistancePriority(.required, for: .horizontal)
        for sub in stack.arrangedSubviews {
            sub.setContentHuggingPriority(.required, for: .horizontal)
            sub.setContentCompressionResistancePriority(.required, for: .horizontal)
        }
    }
    if let idStack = identity as? NSStackView {
        idStack.setHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    }
    identity.setContentHuggingPriority(NSLayoutConstraint.Priority(1), for: .horizontal)
    actions.setContentHuggingPriority(.required, for: .horizontal)
    actions.setContentCompressionResistancePriority(.required, for: .horizontal)
    return container
}
