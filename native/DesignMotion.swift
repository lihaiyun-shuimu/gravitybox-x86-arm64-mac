import Cocoa
import QuartzCore

// MARK: - Global Motion Engine (Unified Curve & Timing Tokens, 120Hz CADisplayLink ProMotion, 0ms in NATIVE_UI_TEST / Reduce Motion)
final class DesignMotion: NSObject {
    typealias ShouldAnimatePolicy = (NSView?) -> Bool
    typealias DisplayLinkFactory = (_ view: NSView?, _ target: Any, _ selector: Selector) -> CADisplayLink?
    typealias TimeSource = () -> CFTimeInterval

    private final class DisplayLinkTarget: NSObject {
        private weak var owner: DesignMotion?
        private var didInvalidate = false

        init(owner: DesignMotion) {
            self.owner = owner
            super.init()
        }

        func invalidateOnce(_ link: CADisplayLink?) {
            owner = nil
            guard !didInvalidate else { return }
            didInvalidate = true
            // CADisplayLink.invalidate() already removes the link from all runloop modes and releases target.
            // Calling remove(from:forMode:) after invalidate() crashes on macOS 15.1 (_NSDisplayLink).
            link?.invalidate()
        }

        @objc func step(_ sender: CADisplayLink) {
            guard !didInvalidate, let owner else {
                invalidateOnce(sender)
                return
            }
            owner.handleDisplayLink(sender)
        }
    }

    enum Curve {
        case hover      // 130ms cubic-out
        case press      // 140ms snappy critically-damped tactile press/release
        case slide      // 180ms spring-out
        case sweep      // 260ms cubic-out
        case spring     // 320ms ProMotion damped spring
        case breathe    // 1200ms gentle sinusoidal breathing pulse

        var duration: CFTimeInterval {
            switch self {
            case .hover: return 0.13
            case .press: return 0.14
            case .slide: return 0.18
            case .sweep: return 0.26
            case .spring: return 0.32
            case .breathe: return 1.20
            }
        }

        func evaluate(_ t: Double) -> CGFloat {
            let p = min(1.0, max(0.0, t))
            switch self {
            case .hover, .press, .sweep:
                return CGFloat(1.0 - pow(1.0 - p, 3.0))
            case .slide:
                return CGFloat(1.0 - pow(1.0 - p, 3.4))
            case .spring:
                return CGFloat(1.0 - exp(-6.0 * p) * cos(7.0 * p))
            case .breathe:
                return CGFloat(0.5 - 0.5 * cos(Double(p) * .pi))
            }
        }
    }

    static func defaultShouldAnimate(in view: NSView?) -> Bool {
        #if NATIVE_UI_TEST
        return false
        #else
        return !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && view?.window != nil
        #endif
    }

    static func defaultMakeDisplayLink(for view: NSView?, target: Any, selector: Selector) -> CADisplayLink? {
        if #available(macOS 14.0, *), let v = view {
            return v.displayLink(target: target, selector: selector)
        } else if #available(macOS 14.0, *), let screen = NSScreen.main {
            return screen.displayLink(target: target, selector: selector)
        }
        return nil
    }

    private let shouldAnimatePolicy: ShouldAnimatePolicy
    private let makeDisplayLink: DisplayLinkFactory
    private let now: TimeSource
    private var timer: Timer?
    private var displayLink: CADisplayLink?
    private var displayLinkTarget: DisplayLinkTarget?
    private var startTime: CFTimeInterval = 0
    private var duration: CFTimeInterval = 0
    private var startVal: CGFloat = 0
    private var targetVal: CGFloat = 0
    private var activeCurve: Curve = .hover
    private var applyBlock: ((CGFloat) -> Void)?
    private var completionBlock: (() -> Void)?
    private weak var boundView: NSView?

    override convenience init() {
        self.init(
            shouldAnimate: DesignMotion.defaultShouldAnimate,
            makeDisplayLink: DesignMotion.defaultMakeDisplayLink,
            timeSource: CACurrentMediaTime
        )
    }

    init(
        shouldAnimate: @escaping ShouldAnimatePolicy = DesignMotion.defaultShouldAnimate,
        makeDisplayLink: @escaping DisplayLinkFactory = DesignMotion.defaultMakeDisplayLink,
        timeSource: @escaping TimeSource = CACurrentMediaTime
    ) {
        self.shouldAnimatePolicy = shouldAnimate
        self.makeDisplayLink = makeDisplayLink
        self.now = timeSource
        super.init()
    }

    deinit {
        cancel()
    }

    func cancel() {
        let link = displayLink
        displayLink = nil
        let proxy = displayLinkTarget
        displayLinkTarget = nil
        if let proxy {
            proxy.invalidateOnce(link)
        } else {
            link?.invalidate()
        }

        let activeTimer = timer
        timer = nil
        activeTimer?.invalidate()

        applyBlock = nil
        completionBlock = nil
    }

    func animate(in view: NSView?, from start: CGFloat, to target: CGFloat, curve: Curve = .hover, threshold: CGFloat = 0.01, apply: @escaping (CGFloat) -> Void, completion: (() -> Void)? = nil) {
        cancel()
        guard shouldAnimatePolicy(view), abs(target - start) > threshold else {
            apply(target)
            completion?()
            return
        }
        self.boundView = view
        self.startVal = start
        self.targetVal = target
        self.activeCurve = curve
        self.applyBlock = apply
        self.completionBlock = completion
        self.startTime = now()
        self.duration = curve.duration

        let proxy = DisplayLinkTarget(owner: self)
        if let link = makeDisplayLink(view, proxy, #selector(DisplayLinkTarget.step(_:))) {
            if #available(macOS 14.0, *) {
                link.preferredFrameRateRange = CAFrameRateRange(minimum: 60, maximum: 120, preferred: 120)
            }
            link.add(to: .main, forMode: .common)
            self.displayLinkTarget = proxy
            self.displayLink = link
        } else {
            let t = Timer(timeInterval: 1.0 / 120.0, repeats: true) { [weak self] _ in
                self?.stepAnimation()
            }
            timer = t
            RunLoop.main.add(t, forMode: .common)
        }
    }

    fileprivate func handleDisplayLink(_ link: CADisplayLink) {
        guard link === displayLink else { return }
        stepAnimation()
    }

    private func stepAnimation() {
        guard shouldAnimatePolicy(boundView) else {
            let finish = targetVal
            let comp = completionBlock
            let app = applyBlock
            cancel()
            app?(finish)
            comp?()
            return
        }
        let elapsed = now() - startTime
        let progress = min(1.0, max(0.0, elapsed / duration))
        let eased = activeCurve.evaluate(progress)
        applyBlock?(startVal + (targetVal - startVal) * eased)
        if progress >= 1.0 {
            let comp = completionBlock
            let app = applyBlock
            let finish = targetVal
            cancel()
            app?(finish)
            comp?()
        }
    }
}
