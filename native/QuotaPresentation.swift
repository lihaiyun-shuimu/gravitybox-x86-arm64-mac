import Cocoa

/// Shared presentation layer for the backend quota contract.
///
/// The backend passes `familyWindows` / `argonStatus` / `carbonStatus` / `standaloneModels` /
/// `quotaWarnings` / `refreshState` at the top level of account cards and dashboard accounts.
/// Fractions are 0...1 and are converted to percent only here. Legacy percent fields remain a
/// fallback for older fixtures, but a legacy weekly value is never relabelled as a 5-hour value.
enum QuotaPresentation {
    static var staleResetText: String {
        L10n.t("quota.stale_data", fallback: "数据已过期")
    }
    static var overdueResetText: String {
        L10n.t("quota.countdown.overdue", fallback: L10n.shared.isEnglish ? "Reset overdue" : "重置时间已过")
    }
    private static let isoFormatterWithFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let isoFormatterStandard: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()
    static func parseResetDate(_ raw: String?) -> Date? {
        guard let raw else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if let d = isoFormatterWithFractional.date(from: trimmed) ?? isoFormatterStandard.date(from: trimmed) {
            return d
        }
        if let ts = Double(trimmed), ts.isFinite, ts > 0 {
            return Date(timeIntervalSince1970: ts < 1e11 ? ts : ts / 1000.0)
        }
        return nil
    }
    static func formatLocalCountdown(to resetDate: Date, now: Date = Date()) -> String {
        let diff = resetDate.timeIntervalSince(now)
        if diff <= 0 {
            return overdueResetText
        }
        if diff <= 60 {
            return L10n.t("quota.countdown.soon", fallback: L10n.shared.isEnglish ? "Resetting soon" : "即将重置")
        }
        let totalMin = Int(floor(diff / 60.0))
        let days = totalMin / (24 * 60)
        let hours = (totalMin % (24 * 60)) / 60
        let mins = totalMin % 60
        if days > 0 {
            return L10n.t(
                "quota.countdown.days_hours",
                ["days": days, "hours": hours],
                fallback: L10n.shared.isEnglish ? "Resets in \(days)d \(hours)h" : "\(days)天 \(hours)小时后重置"
            )
        }
        if hours > 0 {
            return L10n.t(
                "quota.countdown.hours_mins",
                ["hours": hours, "mins": mins],
                fallback: L10n.shared.isEnglish ? "Resets in \(hours)h \(mins)m" : "\(hours)小时 \(mins)分后重置"
            )
        }
        return L10n.t(
            "quota.countdown.mins",
            ["mins": mins],
            fallback: L10n.shared.isEnglish ? "Resets in \(mins)m" : "\(mins)分钟后重置"
        )
    }
    private static let orchestratorDisplayRegex = try? NSRegularExpression(
        pattern: "^orchestrator(?:[-_].+|\\s*\\([^)]*\\)|\\s+.+)?$",
        options: [.caseInsensitive]
    )
    private static let geminiVersionedNameRegex = try? NSRegularExpression(
        pattern: "^gemini\\s+[0-9]+(?:\\.[0-9]+)?\\s+(.+)$",
        options: [.caseInsensitive]
    )
    private static let groupMemberListRegex = try? NSRegularExpression(
        pattern: "models?\\s+(?:within|in)\\s+this\\s+group\\s*:\\s*([^\\n\\r]+)",
        options: [.caseInsensitive]
    )
    private static let genericGeminiTierTokens: Set<String> = [
        "pro", "flash", "ultra", "nano", "lite", "default", "exp", "preview", "trial"
    ]

    /// Recognizes Antigravity orchestrator meta-models (e.g. `gemini-pro-coordinator`,
    /// `gemini-pro-orchestrator`, `gemini-pro-orchestrator-*`, `Orchestrator (Neon)`).
    /// These are composite agent modes, never independent quota pools.
    static func isOrchestratorMetaModel(id: String? = nil, displayName: String? = nil) -> Bool {
        if let rawId = id?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !rawId.isEmpty {
            if rawId == "gemini-pro-coordinator"
                || rawId == "gemini-pro-orchestrator"
                || rawId.hasPrefix("gemini-pro-orchestrator-") {
                return true
            }
            if let regex = orchestratorDisplayRegex,
               regex.firstMatch(in: rawId, range: NSRange(location: 0, length: (rawId as NSString).length)) != nil {
                return true
            }
        }
        if let rawDisplay = displayName?.trimmingCharacters(in: .whitespacesAndNewlines), !rawDisplay.isEmpty {
            if let regex = orchestratorDisplayRegex,
               regex.firstMatch(in: rawDisplay, range: NSRange(location: 0, length: (rawDisplay as NSString).length)) != nil {
                return true
            }
        }
        return false
    }

    struct Window {
        var percentage: Int?
        var known: Bool
        var stale: Bool
        var resetCountdown: String
        var resetTime: String? = nil
        var observedAt: Double?
        var source: String
        var unknownReason: String
        var standbyMode: String? = nil

        var resetDate: Date? { QuotaPresentation.parseResetDate(resetTime) }
        func isResetOverdue(at now: Date = Date()) -> Bool {
            if let resetDate, resetDate <= now { return true }
            let trimmed = resetCountdown.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed == "重置时间已过" || trimmed == "已过" || trimmed.localizedCaseInsensitiveContains("overdue")
        }
        var staleText: String { staleResetText }
        func effectiveResetText(at now: Date = Date(), standbyMode: String? = nil, compact: Bool = false) -> String {
            guard known else { return "" }
            let resolvedMode = standbyMode ?? self.standbyMode
            if resolvedMode == "snapshot_cooling" || resolvedMode == "snapshot_cooldown_elapsed" {
                if isResetOverdue(at: now) {
                    return compact
                        ? L10n.t("accounts.standby.likely_reset", fallback: L10n.shared.isEnglish ? "Likely reset" : "预计已重置")
                        : L10n.t("accounts.standby.likely_reset_sync", fallback: L10n.shared.isEnglish ? "Likely reset · Syncs on switch" : "预计已重置 · 切换后更新")
                }
                if let resetDate {
                    return QuotaPresentation.formatLocalCountdown(to: resetDate, now: now)
                }
                return resetCountdown
            }
            let isStale = stale || (resetDate.map { $0 <= now } ?? false)
            let countdown = resetDate.map { QuotaPresentation.formatLocalCountdown(to: $0, now: now) } ?? resetCountdown
            if isStale {
                return countdown.isEmpty ? staleResetText : "\(countdown) · \(staleResetText)"
            }
            return countdown
        }
        var resetText: String {
            if known && stale { return resetCountdown.isEmpty ? staleResetText : "\(resetCountdown) · \(staleResetText)" }
            if known { return resetCountdown }
            return ""
        }
        var placeholder: String {
            if stale && !known { return L10n.t("quota.stale", fallback: "已过期") }
            if unknownReason.contains("失败") || unknownReason.localizedCaseInsensitiveContains("fail") {
                return L10n.t("quota.read_failed", fallback: "读取失败")
            }
            return L10n.t("common.unknown", fallback: "未知")
        }
    }

    struct GroupWindow {
        var id: String
        var period: String
        var label: String
        var known: Bool
        var remaining: Double?
        var stale: Bool
        var resetCountdown: String
        var resetTime: String? = nil
        var observedAt: Double?
        var source: String
        var unknownReason: String = ""
        var standbyMode: String? = nil

        var resetDate: Date? { QuotaPresentation.parseResetDate(resetTime) }
        func isResetOverdue(at now: Date = Date()) -> Bool {
            if let resetDate, resetDate <= now { return true }
            let trimmed = resetCountdown.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed == "重置时间已过" || trimmed == "已过" || trimmed.localizedCaseInsensitiveContains("overdue")
        }
        func effectiveStale(at now: Date = Date()) -> Bool {
            if stale { return true }
            if let resetDate, resetDate <= now { return true }
            return false
        }
        func effectiveResetText(at now: Date = Date(), standbyMode: String? = nil, compact: Bool = false) -> String {
            guard percentage != nil else { return "" }
            let resolvedMode = standbyMode ?? self.standbyMode
            if resolvedMode == "snapshot_cooling" || resolvedMode == "snapshot_cooldown_elapsed" {
                if isResetOverdue(at: now) {
                    return compact
                        ? L10n.t("accounts.standby.likely_reset", fallback: L10n.shared.isEnglish ? "Likely reset" : "预计已重置")
                        : L10n.t("accounts.standby.likely_reset_sync", fallback: L10n.shared.isEnglish ? "Likely reset · Syncs on switch" : "预计已重置 · 切换后更新")
                }
                if let resetDate {
                    return QuotaPresentation.formatLocalCountdown(to: resetDate, now: now)
                }
                return resetCountdown
            }
            let isStale = effectiveStale(at: now)
            let countdown: String
            if let resetDate {
                countdown = QuotaPresentation.formatLocalCountdown(to: resetDate, now: now)
            } else {
                countdown = resetCountdown
            }
            if isStale {
                return countdown.isEmpty ? staleResetText : "\(countdown) · \(staleResetText)"
            }
            return countdown
        }

        var percentage: Int? {
            guard known, let remaining, remaining.isFinite else { return nil }
            return Int((min(1, max(0, remaining)) * 100).rounded())
        }

        var localizedLabel: String {
            QuotaPresentation.localizedWindowLabel(period: period, label: label)
        }

        var resetText: String {
            if percentage != nil && stale {
                return resetCountdown.isEmpty ? staleResetText : "\(resetCountdown) · \(staleResetText)"
            }
            if percentage != nil {
                return resetCountdown
            }
            return ""
        }

        var placeholder: String {
            placeholder(availability: "unknown")
        }

        func placeholder(availability: String) -> String {
            if stale && percentage == nil { return L10n.t("quota.stale", fallback: "已过期") }
            if availability == "disabled" { return L10n.t("common.unavailable", fallback: "不可用") }
            if unknownReason.contains("失败") || unknownReason.localizedCaseInsensitiveContains("fail") {
                return L10n.t("quota.read_failed", fallback: "读取失败")
            }
            return L10n.t("common.unknown", fallback: "未知")
        }

        func asWindow() -> Window {
            Window(
                percentage: percentage,
                known: percentage != nil,
                stale: stale,
                resetCountdown: resetCountdown,
                resetTime: resetTime,
                observedAt: observedAt,
                source: source,
                unknownReason: unknownReason.isEmpty ? L10n.t("quota.unknown_reason.api_no_value", fallback: "接口未返回可用数值") : unknownReason
            )
        }
    }

    struct QuotaGroup {
        var key: String
        var displayName: String
        var description: String = ""
        var summaryLabel: String
        var brands: [String]
        var isStandalone: Bool
        var availability: String
        var quotaState: String
        var windows: [GroupWindow]
        var message: String
        var standbyMode: String? = nil

        var primaryWindow: GroupWindow? {
            windows.first(where: { $0.percentage != nil && !$0.stale })
                ?? windows.first(where: { $0.percentage != nil })
                ?? windows.first
        }

        var primaryPercentage: Int? {
            windows.first(where: { $0.percentage != nil && !$0.stale })?.percentage
                ?? windows.first(where: { $0.percentage != nil })?.percentage
        }

        func barTitle(for window: GroupWindow) -> String {
            let name = displayName.isEmpty ? (summaryLabel.isEmpty ? key : summaryLabel) : displayName
            if !isStandalone {
                return "\(name) · \(window.localizedLabel)"
            }
            if windows.count > 1 || window.percentage != nil || quotaState == "known" || quotaState == "stale" {
                switch window.period.lowercased() {
                case "weekly", "5h", "fivehour", "daily", "24h", "day":
                    return L10n.t("quota.model_with_period", ["model": name, "period": window.localizedLabel], fallback: "\(name) · \(window.localizedLabel)")
                default:
                    return name
                }
            }
            return name
        }

        func iconName(for window: GroupWindow) -> String {
            if isStandalone { return "hexagon" }
            if window.period == "weekly" || window.id == "weekly" { return "calendar" }
            if window.period == "daily" || window.id == "daily" { return "clock" }
            if key == "claude" { return "hourglass" }
            return "bolt.fill"
        }
    }

    struct Argon {
        var key: String = "argon"
        var modelName: String = "Gemini 4 Argon"
        var availability: String   // available | disabled | unknown
        var quotaState: String     // known | not_reported | stale
        var period: String?        // 5h | daily | weekly | unspecified | nil
        var remaining: Double?     // fraction 0...1
        var resetCountdown: String
        var resetTime: String? = nil
        var message: String
        var observedAt: Double?
        var source: String?
        var mode: String = ""
        var pooledInFamily: String = ""

        var percentage: Int? {
            guard ["known", "stale"].contains(quotaState), let remaining, remaining.isFinite else { return nil }
            return Int((min(1, max(0, remaining)) * 100).rounded())
        }
        var stale: Bool { quotaState == "stale" }
        var isDisplayableStandalone: Bool {
            mode != "unified"
                && availability != "disabled"
                && !(quotaState == "not_reported" && percentage == nil)
        }
        var periodLabel: String {
            switch period {
            case "5h": return L10n.t("common.period.5h", fallback: "5 小时")
            case "weekly": return L10n.t("common.period.weekly", fallback: "每周")
            case "daily": return L10n.t("common.period.daily", fallback: L10n.shared.isEnglish ? "Daily" : "每日")
            case "unspecified": return L10n.t("quota.model_quota", fallback: "模型配额")
            default: return ""
            }
        }
        var title: String {
            if (quotaState == "known" || quotaState == "stale") && percentage != nil {
                switch period {
                case "weekly":
                    return L10n.t("quota.model_with_period", ["model": modelName, "period": L10n.t("common.period.weekly", fallback: "每周")], fallback: "\(modelName) · 每周")
                case "5h":
                    return L10n.t("quota.model_with_period", ["model": modelName, "period": L10n.t("common.period.5h", fallback: "5 小时")], fallback: "\(modelName) · 5 小时")
                case "daily":
                    return L10n.t("quota.model_with_period", ["model": modelName, "period": L10n.t("common.period.daily", fallback: L10n.shared.isEnglish ? "Daily" : "每日")], fallback: "\(modelName) · 每日")
                case "unspecified": return modelName
                default: return modelName
                }
            }
            return modelName
        }
        var placeholder: String {
            if stale { return L10n.t("quota.stale", fallback: "已过期") }
            switch availability {
            case "disabled": return L10n.t("common.unavailable", fallback: "不可用")
            case "available": return L10n.t("quota.unknown", fallback: "配额未知")
            default: return L10n.t("common.unknown", fallback: "未知")
            }
        }
        var resetText: String {
            if stale {
                let base = resetCountdown.isEmpty ? "" : "\(resetCountdown) · "
                return base + staleResetText
            }
            if quotaState == "known" {
                return resetCountdown
            }
            switch availability {
            case "disabled": return ""
            case "available": return L10n.t("quota.unknown", fallback: "配额未知")
            default: return L10n.t("quota.unknown", fallback: "配额未知")
            }
        }
        var compactText: String {
            if stale { return L10n.t("quota.model_with_period", ["model": modelName, "period": L10n.t("quota.stale_data", fallback: "数据已过期")], fallback: "\(modelName) · 数据已过期") }
            if quotaState == "known" { return modelName }
            if key != "argon" {
                switch availability {
                case "disabled": return L10n.t("quota.model_with_period", ["model": modelName, "period": L10n.t("common.unavailable", fallback: "不可用")], fallback: "\(modelName) · 不可用")
                default: return L10n.t("quota.model_with_period", ["model": modelName, "period": L10n.t("quota.unknown", fallback: "配额未知")], fallback: "\(modelName) · 配额未知")
                }
            }
            switch availability {
            case "disabled": return L10n.t("quota.model_with_period", ["model": "Gemini 4 Argon", "period": L10n.t("common.unavailable", fallback: "不可用")], fallback: "Gemini 4 Argon · 不可用")
            default: return L10n.t("quota.model_with_period", ["model": "Gemini 4 Argon", "period": L10n.t("quota.unknown", fallback: "配额未知")], fallback: "Gemini 4 Argon · 配额未知")
            }
        }
    }

    struct Contract {
        var hasContract = false
        var quotaGroups: [QuotaGroup] = []
        var synthesizedGroups: [QuotaGroup] = []
        var gemini5h: Window?
        var geminiWeekly: Window?
        var claude5h: Window?
        var claudeWeekly: Window?
        var geminiModel: Window?
        var claudeModel: Window?
        var argon: Argon?
        var carbon: Argon?
        var standaloneModels: [Argon] = []
        var quotaWarnings: [String] = []
        var quotaWarningCodes: [String] = []
        var refreshComplete: Bool?
        var refreshMessage = ""
        var standbyMode: String? = nil
        var geminiPrimary: PrimaryWindow { primaryWindow(gemini5h, model: geminiModel) }
        var claudePrimary: PrimaryWindow { primaryWindow(claude5h, model: claudeModel) }
        var displayGroups: [QuotaGroup] {
            !quotaGroups.isEmpty ? quotaGroups : synthesizedGroups
        }
        var coreGroups: [QuotaGroup] {
            displayGroups.filter { !$0.isStandalone }
        }
        var standaloneGroups: [QuotaGroup] {
            displayGroups.filter { $0.isStandalone }
        }
        /// Extra standalone models beyond Argon and Carbon (automatically detected new models/groups)
        var extraStandaloneModels: [Argon] {
            standaloneModels.filter { $0.key != "argon" && $0.key != "carbon" }
        }
        func overdueResetSignature(at now: Date = Date()) -> String {
            var parts: [String] = []
            for grp in displayGroups {
                for win in grp.windows where win.known && win.isResetOverdue(at: now) {
                    parts.append("\(grp.key):\(win.period):\(win.resetTime ?? win.resetCountdown)")
                }
            }
            if parts.isEmpty {
                for (name, win) in [("g5h", gemini5h), ("gw", geminiWeekly), ("c5h", claude5h), ("cw", claudeWeekly)] {
                    if let win, win.known && win.isResetOverdue(at: now) {
                        parts.append("\(name):\(win.resetTime ?? win.resetCountdown)")
                    }
                }
            }
            return parts.joined(separator: "|")
        }
        func hasOverdueKnownWindow(at now: Date = Date()) -> Bool {
            !overdueResetSignature(at: now).isEmpty
        }
    }

    struct PrimaryWindow {
        var window: Window?
        var label: String
    }

    private static func primaryWindow(_ fiveHour: Window?, model: Window?) -> PrimaryWindow {
        if let fiveHour, fiveHour.known && !fiveHour.stale { return PrimaryWindow(window: fiveHour, label: L10n.t("common.period.5h", fallback: "5 小时")) }
        if let model, model.known && (!model.stale || fiveHour?.known != true) {
            return PrimaryWindow(window: model, label: L10n.t("quota.model_quota", fallback: "模型配额"))
        }
        return PrimaryWindow(window: fiveHour, label: L10n.t("common.period.5h", fallback: "5 小时"))
    }

    static func missingWindowPlaceholder(otherPercentage: Int?) -> String {
        L10n.t("common.unknown", fallback: "未知")
    }

    // MARK: - Parsing

    static func dict(_ any: Any?) -> [String: Any]? { any as? [String: Any] }

    static func number(_ any: Any?) -> Double? {
        if let n = any as? NSNumber { return n.doubleValue }
        if let d = any as? Double { return d }
        if let i = any as? Int { return Double(i) }
        if let s = any as? String, let d = Double(s) { return d }
        return nil
    }

    static func boolValue(_ any: Any?) -> Bool? {
        if let b = any as? Bool { return b }
        if let n = any as? NSNumber { return n.boolValue }
        return nil
    }

    static func text(_ any: Any?) -> String {
        (any as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    }

    /// Backend contract fractions are 0...1. Anything outside the range is rejected (no fake 100%).
    static func fraction(_ any: Any?) -> Double? {
        guard let value = number(any), value.isFinite, value >= 0, value <= 1 else { return nil }
        return value
    }

    private static func percent(_ fraction: Double?) -> Int? {
        guard let fraction, fraction.isFinite else { return nil }
        return Int((min(1, max(0, fraction)) * 100).rounded())
    }

    private static func fallbackWindow(percentValue: Int?, countdown: String, unknownReason: String) -> Window? {
        guard let percentValue else { return nil }
        return Window(percentage: max(0, min(100, percentValue)), known: true, stale: false,
                      resetCountdown: countdown, observedAt: nil, source: "legacy", unknownReason: unknownReason)
    }

    static func localizedWindowLabel(period: String, label: String) -> String {
        switch period.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() {
        case "5h", "fivehour":
            return L10n.t("common.period.5h", fallback: "5 小时")
        case "weekly":
            return L10n.t("common.period.weekly", fallback: "每周")
        case "daily", "day", "24h":
            return L10n.t("common.period.daily", fallback: L10n.shared.isEnglish ? "Daily" : "每日")
        case "unspecified":
            return L10n.t("quota.model_quota", fallback: "模型配额")
        default:
            let trimmed = label.trimmingCharacters(in: .whitespacesAndNewlines)
            switch trimmed {
            case "", "周期未知", "Unknown Cycle", "unspecified":
                return L10n.t("quota.model_quota", fallback: "模型配额")
            case "5小时", "5 小时", "5 Hours", "5h":
                return L10n.t("common.period.5h", fallback: "5 小时")
            case "每周", "Weekly":
                return L10n.t("common.period.weekly", fallback: "每周")
            case "每日", "Daily":
                return L10n.t("common.period.daily", fallback: L10n.shared.isEnglish ? "Daily" : "每日")
            case "模型配额", "Model Quota":
                return L10n.t("quota.model_quota", fallback: "模型配额")
            default:
                return trimmed
            }
        }
    }

    static func inferredBrands(for title: String) -> [String] {
        let lower = title.lowercased()
        if lower.contains("claude") && (lower.contains("gpt") || lower.contains("openai")) { return ["claude", "openai"] }
        if lower.contains("gemini") || lower.contains("orchestrator") || lower.contains("argon") || lower.contains("carbon") || lower.contains("neon") || lower.contains("hydrogen") { return ["gemini"] }
        if lower.contains("claude") { return ["claude"] }
        if lower.contains("gpt") || lower.contains("openai") { return ["openai"] }
        return []
    }

    private static func normalizeBrands(_ rawBrands: [String], fallbackTitle: String, key: String) -> [String] {
        var normalized: [String] = []
        for brand in rawBrands {
            let lower = brand.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            let mapped: [String]
            switch lower {
            case "gemini":
                mapped = ["gemini"]
            case "claude":
                mapped = ["claude"]
            case "gpt", "openai":
                mapped = ["openai"]
            default:
                mapped = inferredBrands(for: lower)
            }
            for item in mapped where !normalized.contains(item) {
                normalized.append(item)
            }
        }
        if !normalized.isEmpty { return normalized }
        return inferredBrands(for: "\(key) \(fallbackTitle)")
    }

    private static func shortSummaryLabel(key: String, displayName: String) -> String {
        switch key.lowercased() {
        case "gemini": return "Gemini"
        case "claude": return "Claude/GPT"
        case "argon": return "Argon"
        case "carbon": return "Carbon"
        default:
            let trimmed = displayName.trimmingCharacters(in: .whitespacesAndNewlines)
            return trimmed.isEmpty ? key : trimmed
        }
    }

    private static func window(_ raw: Any?, unknownReason: String) -> Window? {
        guard let raw = dict(raw) else { return nil }
        let knownFlag = boolValue(raw["known"]) ?? false
        let remaining = fraction(raw["remaining"])
        let stale = boolValue(raw["stale"]) ?? false
        let countdown = text(raw["resetCountdown"])
        let resetTime = text(raw["resetTime"])
        let observed = number(raw["observedAt"])
        let source = text(raw["source"])
        let percentage = knownFlag ? percent(remaining) : nil
        return Window(percentage: percentage, known: knownFlag && percentage != nil,
                      stale: stale, resetCountdown: countdown, resetTime: resetTime.isEmpty ? nil : resetTime,
                      observedAt: observed, source: source,
                      unknownReason: knownFlag ? L10n.t("quota.unknown_reason.api_no_value", fallback: "接口未返回可用数值") : unknownReason)
    }

    private static func groupWindow(_ raw: [String: Any]) -> GroupWindow {
        let id = text(raw["id"])
        let period = text(raw["period"]).isEmpty ? (id.isEmpty ? "unspecified" : id) : text(raw["period"])
        let label = text(raw["label"])
        let knownFlag = boolValue(raw["known"]) ?? false
        let remaining = fraction(raw["remaining"])
        let stale = boolValue(raw["stale"]) ?? false
        let countdown = text(raw["resetCountdown"])
        let resetTime = text(raw["resetTime"])
        let observed = number(raw["observedAt"])
        let source = text(raw["source"])
        let validKnown = knownFlag && remaining != nil
        return GroupWindow(
            id: id.isEmpty ? period : id,
            period: period,
            label: label,
            known: validKnown,
            remaining: validKnown ? remaining : nil,
            stale: stale,
            resetCountdown: countdown,
            resetTime: resetTime.isEmpty ? nil : resetTime,
            observedAt: observed,
            source: source,
            unknownReason: validKnown ? "" : L10n.t("quota.unknown_reason.api_no_value", fallback: "接口未返回可用数值")
        )
    }

    private static func quotaGroup(_ raw: [String: Any]) -> QuotaGroup? {
        let key = text(raw["key"])
        let rawDisplay = text(raw["displayName"])
        guard !key.isEmpty || !rawDisplay.isEmpty else { return nil }
        let resolvedKey = key.isEmpty ? rawDisplay.lowercased() : key
        let displayName: String
        if !rawDisplay.isEmpty {
            displayName = (resolvedKey == "gemini" || resolvedKey == "claude") ? rawDisplay : ModelDisplayName.name(rawDisplay)
        } else if resolvedKey == "gemini" {
            displayName = "Gemini"
        } else if resolvedKey == "claude" {
            displayName = "Claude/GPT"
        } else if resolvedKey == "argon" {
            displayName = "Gemini 4 Argon"
        } else if resolvedKey == "carbon" {
            displayName = "Gemini 4 Carbon"
        } else {
            displayName = ModelDisplayName.name(resolvedKey)
        }
        let rawSummary = text(raw["summaryLabel"])
        let summaryLabel = rawSummary.isEmpty ? shortSummaryLabel(key: resolvedKey, displayName: displayName) : rawSummary
        let isStandalone = boolValue(raw["isStandalone"]) ?? (resolvedKey != "gemini" && resolvedKey != "claude")
        if isStandalone && (isOrchestratorMetaModel(id: resolvedKey, displayName: displayName) || isOrchestratorMetaModel(id: key, displayName: rawDisplay)) {
            return nil
        }
        let availability = text(raw["availability"]).isEmpty ? "available" : text(raw["availability"])
        let quotaState = text(raw["quotaState"]).isEmpty ? "not_reported" : text(raw["quotaState"])
        let rawBrands = raw["brands"] as? [String] ?? []
        let brands = normalizeBrands(rawBrands, fallbackTitle: displayName, key: resolvedKey)
        let rawWindows = (raw["windows"] as? [[String: Any]]) ?? []
        let windows = rawWindows.map { groupWindow($0) }
        return QuotaGroup(
            key: resolvedKey,
            displayName: displayName,
            description: text(raw["description"]),
            summaryLabel: summaryLabel,
            brands: brands,
            isStandalone: isStandalone,
            availability: availability,
            quotaState: quotaState,
            windows: windows,
            message: text(raw["message"])
        )
    }

    private static func argon(_ raw: [String: Any]?, defaultKey: String = "argon", defaultModelName: String = "Gemini 4 Argon") -> Argon? {
        guard let raw else { return nil }
        let key = text(raw["key"]).isEmpty ? defaultKey : text(raw["key"])
        let rawDisplay = !text(raw["displayName"]).isEmpty ? text(raw["displayName"]) : text(raw["modelName"])
        let resolvedName: String
        if key == "argon" {
            resolvedName = "Gemini 4 Argon"
        } else if key == "carbon" {
            resolvedName = "Gemini 4 Carbon"
        } else if !rawDisplay.isEmpty {
            resolvedName = ModelDisplayName.name(rawDisplay)
        } else {
            resolvedName = ModelDisplayName.name(defaultModelName)
        }
        let availability = text(raw["availability"]).isEmpty ? "unknown" : text(raw["availability"])
        let remaining = fraction(raw["remaining"])
        let state = text(raw["quotaState"]).isEmpty ? (remaining != nil ? "known" : "not_reported") : text(raw["quotaState"])
        let resetTime = text(raw["resetTime"])
        return Argon(key: key, modelName: resolvedName, availability: availability, quotaState: state,
                     period: raw["period"] as? String, remaining: remaining,
                     resetCountdown: text(raw["resetCountdown"]),
                     resetTime: resetTime.isEmpty ? nil : resetTime,
                     message: text(raw["message"]),
                     observedAt: number(raw["observedAt"]), source: raw["source"] as? String,
                     mode: text(raw["mode"]), pooledInFamily: text(raw["pooledInFamily"]))
    }

    private static func familyWindow(_ familyWindows: [String: Any]?, family: String, key: String, label: String) -> Window? {
        guard let familyWindows = dict(familyWindows?[family]) else { return nil }
        return window(familyWindows[key], unknownReason: L10n.t("quota.unknown_reason.window_missing", ["label": label]))
    }

    private static func makeGroupWindow(id: String, period: String, label: String, window: Window?) -> GroupWindow {
        GroupWindow(
            id: id,
            period: period,
            label: label,
            known: window?.known == true,
            remaining: window?.percentage.map { Double($0) / 100.0 },
            stale: window?.stale == true,
            resetCountdown: window?.resetCountdown ?? "",
            resetTime: window?.resetTime,
            observedAt: window?.observedAt,
            source: window?.source ?? "",
            unknownReason: window?.unknownReason ?? ""
        )
    }

    private static func makeCoreGroup(key: String, displayName: String, brands: [String], primary: PrimaryWindow, weekly: Window?) -> QuotaGroup {
        let isModelPrimary = primary.window != nil && primary.label == L10n.t("quota.model_quota", fallback: "模型配额")
        let firstWindow = makeGroupWindow(
            id: isModelPrimary ? "model" : "5h",
            period: isModelPrimary ? "unspecified" : "5h",
            label: primary.label,
            window: primary.window
        )
        let weeklyWindow = makeGroupWindow(
            id: "weekly",
            period: "weekly",
            label: L10n.t("common.period.weekly", fallback: "每周"),
            window: weekly
        )
        let windows = [firstWindow, weeklyWindow]
        let hasKnown = windows.contains { $0.percentage != nil }
        let allStale = hasKnown && windows.filter { $0.percentage != nil }.allSatisfy { $0.stale }
        return QuotaGroup(
            key: key,
            displayName: displayName,
            summaryLabel: displayName,
            brands: brands,
            isStandalone: false,
            availability: hasKnown ? "available" : "unknown",
            quotaState: allStale ? "stale" : (hasKnown ? "known" : "not_reported"),
            windows: windows,
            message: ""
        )
    }

    private static func makeStandaloneGroup(from item: Argon) -> QuotaGroup {
        let period = item.period ?? "unspecified"
        let win = GroupWindow(
            id: period == "unspecified" ? "model" : period,
            period: period,
            label: item.periodLabel.isEmpty ? L10n.t("quota.model_quota", fallback: "模型配额") : item.periodLabel,
            known: item.percentage != nil,
            remaining: item.remaining,
            stale: item.stale,
            resetCountdown: item.resetCountdown,
            resetTime: item.resetTime,
            observedAt: item.observedAt,
            source: item.source ?? "",
            unknownReason: item.message
        )
        return QuotaGroup(
            key: item.key,
            displayName: item.modelName,
            summaryLabel: shortSummaryLabel(key: item.key, displayName: item.modelName),
            brands: inferredBrands(for: "\(item.key) \(item.modelName)"),
            isStandalone: true,
            availability: item.availability,
            quotaState: item.quotaState,
            windows: [win],
            message: item.message
        )
    }

    /// Parses top-level contract fields, falling back to legacy percent fields without inventing
    /// windows. Legacy sentinel `以周限额为准` explicitly means the 5-hour window was not returned.
    static func contract(_ raw: [String: Any]) -> Contract {
        var result = Contract()
        let rawStandbyMode = text(dict(raw["standbyRefreshStatus"])?["mode"])
        let activeRemoteIds = (raw["activeRemoteEnvIds"] as? [String]) ?? []
        let sourceEnvId = text(raw["quotaSourceEnvironmentId"])
        let hasRemoteSource = !activeRemoteIds.isEmpty || (!sourceEnvId.isEmpty && sourceEnvId != "local")
        let standbyMode: String? = (rawStandbyMode.isEmpty || hasRemoteSource) ? nil : rawStandbyMode
        result.standbyMode = standbyMode
        let nested = dict(raw["quota"])
        let quotaGroupsRaw = (raw["quotaGroups"] as? [[String: Any]]) ?? nested.flatMap { $0["quotaGroups"] as? [[String: Any]] }
        let familyWindows = dict(raw["familyWindows"]) ?? nested.flatMap { dict($0["familyWindows"]) }
        let modelQuota = dict(raw["familyModelQuota"]) ?? nested.flatMap { dict($0["familyModelQuota"]) }
        let argonRaw = dict(raw["argonStatus"]) ?? nested.flatMap { dict($0["argonStatus"]) }
        let carbonRaw = dict(raw["carbonStatus"]) ?? nested.flatMap { dict($0["carbonStatus"]) }
        let standaloneRaw = (raw["standaloneModels"] as? [[String: Any]]) ?? nested.flatMap { $0["standaloneModels"] as? [[String: Any]] }
        if let quotaGroupsRaw {
            result.quotaGroups = quotaGroupsRaw.compactMap { quotaGroup($0) }
        }
        result.hasContract = !result.quotaGroups.isEmpty || familyWindows != nil || argonRaw != nil || carbonRaw != nil || modelQuota != nil
        result.geminiModel = window(modelQuota?["gemini"], unknownReason: L10n.t("quota.unknown_reason.model_missing"))
        result.claudeModel = window(modelQuota?["claude"], unknownReason: L10n.t("quota.unknown_reason.model_missing"))
        result.quotaWarnings = (raw["quotaWarnings"] as? [String]) ?? nested.flatMap { $0["quotaWarnings"] as? [String] } ?? []
        result.quotaWarningCodes = (raw["quotaWarningCodes"] as? [String]) ?? nested.flatMap { $0["quotaWarningCodes"] as? [String] } ?? []
        let refreshState = dict(raw["refreshState"]) ?? nested.flatMap { dict($0["refreshState"]) }
        if let refreshState {
            result.refreshComplete = boolValue(refreshState["complete"])
            let errText = text(refreshState["error"])
            result.refreshMessage = errText.isEmpty ? text(refreshState["message"]) : errText
        }

        if let familyWindows, result.hasContract {
            result.gemini5h = familyWindow(familyWindows, family: "gemini", key: "fiveHour", label: L10n.t("quota.family.gemini_5h"))
            result.geminiWeekly = familyWindow(familyWindows, family: "gemini", key: "weekly", label: L10n.t("quota.family.gemini_weekly"))
            result.claude5h = familyWindow(familyWindows, family: "claude", key: "fiveHour", label: L10n.t("quota.family.claude_5h"))
            result.claudeWeekly = familyWindow(familyWindows, family: "claude", key: "weekly", label: L10n.t("quota.family.claude_weekly"))
        }
        let rawModels = (raw["models"] as? [[String: Any]]) ?? (nested?["models"] as? [[String: Any]]) ?? []
        if let argonRaw {
            result.argon = argon(argonRaw, defaultKey: "argon", defaultModelName: "Gemini 4 Argon")
        } else if !result.hasContract {
            let argonModels = rawModels.filter { m in
                let rawName = m["name"] as? String ?? (m["model_id"] as? String ?? "")
                let rawDisplay = m["display_name"] as? String ?? ""
                if isOrchestratorMetaModel(id: rawName, displayName: rawDisplay) { return false }
                let name = rawName.lowercased()
                let display = rawDisplay.lowercased()
                return (m["is_argon"] as? Bool == true) || name.contains("argon") || display.contains("argon")
            }
            let allArgonDisabled = !argonModels.isEmpty && argonModels.allSatisfy { m in
                let name = (m["name"] as? String ?? (m["model_id"] as? String ?? "")).lowercased()
                return (m["disabled"] as? Bool == true) || name.contains("disabled")
            }
            // Legacy fallback. `argonWeeklyRemaining` never proves a weekly period, so it is shown
            // as an unspecified-period value instead of fabricating "每周".
            let legacyArgon = (raw["argonWeeklyRemaining"] as? Int)
            if allArgonDisabled {
                result.argon = Argon(key: "argon", modelName: "Gemini 4 Argon", availability: "disabled", quotaState: "not_reported", period: nil,
                                     remaining: nil, resetCountdown: "",
                                     message: L10n.t("quota.argon.no_permission"),
                                     observedAt: nil, source: "legacy")
            } else if let legacyArgon {
                result.argon = Argon(key: "argon", modelName: "Gemini 4 Argon", availability: "unknown", quotaState: "known", period: "unspecified",
                                     remaining: Double(max(0, min(100, legacyArgon))) / 100.0,
                                     resetCountdown: text(raw["argonWeeklyResetCountdown"]),
                                     message: L10n.t("quota.argon.legacy_unspecified"),
                                     observedAt: nil, source: "legacy")
            }
        }

        if let carbonRaw {
            result.carbon = argon(carbonRaw, defaultKey: "carbon", defaultModelName: "Gemini 4 Carbon")
        } else if !result.hasContract {
            let carbonModels = rawModels.filter { m in
                let rawName = m["name"] as? String ?? (m["model_id"] as? String ?? "")
                let rawDisplay = m["display_name"] as? String ?? ""
                if isOrchestratorMetaModel(id: rawName, displayName: rawDisplay) { return false }
                let name = rawName.lowercased()
                let display = rawDisplay.lowercased()
                return (m["is_carbon"] as? Bool == true) || name.contains("carbon") || display.contains("carbon")
            }
            let allCarbonDisabled = !carbonModels.isEmpty && carbonModels.allSatisfy { m in
                let name = (m["name"] as? String ?? (m["model_id"] as? String ?? "")).lowercased()
                return (m["disabled"] as? Bool == true) || name.contains("disabled")
            }
            let legacyCarbon = (raw["carbonWeeklyRemaining"] as? Int)
            if allCarbonDisabled {
                result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "disabled", quotaState: "not_reported", period: nil,
                                      remaining: nil, resetCountdown: "",
                                      message: L10n.t("quota.carbon.no_permission"),
                                      observedAt: nil, source: "legacy")
            } else if let legacyCarbon {
                result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "unknown", quotaState: "known", period: "unspecified",
                                      remaining: Double(max(0, min(100, legacyCarbon))) / 100.0,
                                      resetCountdown: text(raw["carbonWeeklyResetCountdown"]),
                                      message: L10n.t("quota.carbon.legacy_unspecified", ["pct": legacyCarbon]),
                                      observedAt: nil, source: "legacy")
            } else if let enabledCarbon = carbonModels.first(where: { ($0["disabled"] as? Bool) != true }) {
                let ownPct = (enabledCarbon["own_percentage"] as? Int) ?? ((enabledCarbon["percentage_known"] as? Bool == true) ? (enabledCarbon["percentage"] as? Int) : nil)
                let cd = text(enabledCarbon["reset_countdown"])
                if let ownPct {
                    result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "available", quotaState: "known", period: "unspecified",
                                          remaining: Double(max(0, min(100, ownPct))) / 100.0,
                                          resetCountdown: cd,
                                          message: L10n.t("quota.carbon.available_unspecified", ["pct": ownPct]),
                                          observedAt: nil, source: "legacy")
                } else {
                    result.carbon = Argon(key: "carbon", modelName: "Gemini 4 Carbon", availability: "available", quotaState: "not_reported", period: nil,
                                          remaining: nil, resetCountdown: "",
                                          message: L10n.t("quota.carbon.available_no_value"),
                                          observedAt: nil, source: "legacy")
                }
            }
        }

        if let standaloneRaw, !standaloneRaw.isEmpty {
            result.standaloneModels = standaloneRaw.compactMap { item in
                let k = text(item["key"]).isEmpty ? "other" : text(item["key"])
                let rawDisplay = !text(item["displayName"]).isEmpty ? text(item["displayName"]) : text(item["modelName"])
                let name = rawDisplay.isEmpty ? k : rawDisplay
                if isOrchestratorMetaModel(id: k, displayName: name) {
                    return nil
                }
                guard let parsed = argon(item, defaultKey: k, defaultModelName: name),
                      !isOrchestratorMetaModel(id: parsed.key, displayName: parsed.modelName) else {
                    return nil
                }
                return parsed
            }
            if let firstArgon = result.standaloneModels.first(where: { $0.key == "argon" }) {
                result.argon = firstArgon
            }
            if let firstCarbon = result.standaloneModels.first(where: { $0.key == "carbon" }) {
                result.carbon = firstCarbon
            }
        } else {
            var list: [Argon] = []
            if let a = result.argon, !isOrchestratorMetaModel(id: a.key, displayName: a.modelName) { list.append(a) }
            if let c = result.carbon, !isOrchestratorMetaModel(id: c.key, displayName: c.modelName) { list.append(c) }
            result.standaloneModels = list
        }

        if !result.hasContract {
            let g5Countdown = text(raw["geminiFiveHourResetCountdown"])
            let gWeekCountdown = text(raw["geminiWeeklyResetCountdown"])
            let g5Raw = (raw["geminiFiveHourRemaining"] as? Int) ?? (raw["fiveHourRemaining"] as? Int)
            let gWeekRaw = (raw["geminiWeeklyRemaining"] as? Int) ?? (raw["weeklyRemaining"] as? Int)
            let c5Raw = raw["claudeFiveHourRemaining"] as? Int
            let cWeekRaw = raw["claudeWeeklyRemaining"] as? Int
            let fiveHourMode = (raw["geminiFiveHourPeriodMode"] as? String ?? "").lowercased()
            let sentinel = fiveHourMode == "weekly_only"
                || g5Countdown.contains("以周限额为准")
                || g5Countdown.localizedCaseInsensitiveContains("weekly limit")
            if sentinel {
                result.gemini5h = Window(percentage: nil, known: false, stale: false, resetCountdown: "",
                                         observedAt: nil, source: "legacy",
                                         unknownReason: L10n.t("quota.unknown_reason.weekly_only", fallback: "仅返回每周窗口，5 小时窗口未返回"))
            } else if let g5Raw {
                let cd = g5Countdown.isEmpty && gWeekRaw == nil ? text(raw["geminiResetCountdown"]) : g5Countdown
                result.gemini5h = fallbackWindow(percentValue: g5Raw, countdown: cd, unknownReason: L10n.t("quota.unknown_reason.5h_missing", fallback: "接口未返回 5 小时窗口"))
            }
            if let gWeekRaw {
                let cd = gWeekCountdown.isEmpty && g5Raw == nil ? text(raw["geminiResetCountdown"]) : gWeekCountdown
                result.geminiWeekly = fallbackWindow(percentValue: gWeekRaw, countdown: cd, unknownReason: L10n.t("quota.unknown_reason.weekly_missing", fallback: "接口未返回每周窗口"))
            }
            if let c5Raw {
                result.claude5h = fallbackWindow(percentValue: c5Raw, countdown: text(raw["claudeFiveHourResetCountdown"]),
                                                unknownReason: L10n.t("quota.unknown_reason.claude_5h_missing", fallback: "接口未返回 Claude/GPT 5 小时窗口"))
            }
            if let cWeekRaw {
                let cd = text(raw["claudeWeeklyResetCountdown"]).isEmpty && c5Raw == nil
                    ? text(raw["claudeResetCountdown"]) : text(raw["claudeWeeklyResetCountdown"])
                result.claudeWeekly = fallbackWindow(percentValue: cWeekRaw, countdown: cd, unknownReason: L10n.t("quota.unknown_reason.claude_weekly_missing", fallback: "接口未返回 Claude/GPT 每周窗口"))
            }
        }

        // Backfill Window / Argon fields when a payload supplies quotaGroups without legacy familyWindows
        if !result.quotaGroups.isEmpty {
            if let gGroup = result.quotaGroups.first(where: { $0.key.lowercased() == "gemini" }) {
                if result.gemini5h == nil, let w5 = gGroup.windows.first(where: { $0.period == "5h" || $0.period == "fiveHour" || $0.id == "5h" || $0.id == "fiveHour" || $0.id == "five_hour" }) {
                    result.gemini5h = w5.asWindow()
                }
                if result.geminiWeekly == nil, let ww = gGroup.windows.first(where: { $0.period == "weekly" || $0.id == "weekly" }) {
                    result.geminiWeekly = ww.asWindow()
                }
                if result.geminiModel == nil, let wm = gGroup.windows.first(where: { $0.period == "unspecified" || $0.id == "model" || $0.id == "model_quota" }) {
                    result.geminiModel = wm.asWindow()
                }
            }
            if let cGroup = result.quotaGroups.first(where: { let k = $0.key.lowercased(); return k == "claude" || k == "claude_gpt" }) {
                if result.claude5h == nil, let w5 = cGroup.windows.first(where: { $0.period == "5h" || $0.period == "fiveHour" || $0.id == "5h" || $0.id == "fiveHour" || $0.id == "five_hour" }) {
                    result.claude5h = w5.asWindow()
                }
                if result.claudeWeekly == nil, let ww = cGroup.windows.first(where: { $0.period == "weekly" || $0.id == "weekly" }) {
                    result.claudeWeekly = ww.asWindow()
                }
                if result.claudeModel == nil, let wm = cGroup.windows.first(where: { $0.period == "unspecified" || $0.id == "model" || $0.id == "model_quota" }) {
                    result.claudeModel = wm.asWindow()
                }
            }
            if result.standaloneModels.isEmpty {
                let standalone = result.quotaGroups.filter { $0.isStandalone }.map { grp -> Argon in
                    let w = grp.primaryWindow ?? grp.windows.first
                    return Argon(
                        key: grp.key,
                        modelName: grp.displayName,
                        availability: grp.availability,
                        quotaState: grp.quotaState,
                        period: w?.period,
                        remaining: w?.remaining,
                        resetCountdown: w?.resetCountdown ?? "",
                        resetTime: w?.resetTime,
                        message: grp.message,
                        observedAt: w?.observedAt,
                        source: w?.source,
                        mode: "standalone",
                        pooledInFamily: ""
                    )
                }
                result.standaloneModels = standalone
                if result.argon == nil { result.argon = standalone.first(where: { $0.key == "argon" }) }
                if result.carbon == nil { result.carbon = standalone.first(where: { $0.key == "carbon" }) }
            }
        } else {
            var groups: [QuotaGroup] = [
                makeCoreGroup(key: "gemini", displayName: "Gemini", brands: ["gemini"], primary: result.geminiPrimary, weekly: result.geminiWeekly),
                makeCoreGroup(key: "claude", displayName: "Claude/GPT", brands: ["claude", "openai"], primary: result.claudePrimary, weekly: result.claudeWeekly)
            ]
            var seenStandaloneKeys = Set<String>()
            var candidates = result.standaloneModels
            if let a = result.argon, !candidates.contains(where: { $0.key == a.key }) { candidates.insert(a, at: 0) }
            if let c = result.carbon, !candidates.contains(where: { $0.key == c.key }) { candidates.append(c) }
            for item in candidates {
                let k = item.key.lowercased()
                guard !k.isEmpty,
                      !seenStandaloneKeys.contains(k),
                      item.isDisplayableStandalone,
                      !isOrchestratorMetaModel(id: item.key, displayName: item.modelName) else { continue }
                seenStandaloneKeys.insert(k)
                groups.append(makeStandaloneGroup(from: item))
            }
            result.synthesizedGroups = groups
        }
        if let standbyMode {
            result.gemini5h?.standbyMode = standbyMode
            result.geminiWeekly?.standbyMode = standbyMode
            result.claude5h?.standbyMode = standbyMode
            result.claudeWeekly?.standbyMode = standbyMode
            result.geminiModel?.standbyMode = standbyMode
            result.claudeModel?.standbyMode = standbyMode
            for idx in result.quotaGroups.indices {
                result.quotaGroups[idx].standbyMode = standbyMode
                for wIdx in result.quotaGroups[idx].windows.indices {
                    result.quotaGroups[idx].windows[wIdx].standbyMode = standbyMode
                }
            }
            for idx in result.synthesizedGroups.indices {
                result.synthesizedGroups[idx].standbyMode = standbyMode
                for wIdx in result.synthesizedGroups[idx].windows.indices {
                    result.synthesizedGroups[idx].windows[wIdx].standbyMode = standbyMode
                }
            }
        }
        return result
    }

    // MARK: - Shared display helpers

    /// Menu line: still uses the "Gemini 5小时 X% · 每周 Y%" shell so existing menu layout stays,
    /// but unknown/stale windows are labelled instead of fabricated.
    static func menuQuotaText(_ raw: [String: Any]) -> String {
        let contract = contract(raw)
        let unknownTxt = L10n.t("common.unknown", fallback: "未知")
        func part(_ name: String, _ window: Window?) -> String {
            guard let window else { return "\(name) \(unknownTxt)" }
            if let percentage = window.percentage {
                return "\(name) \(percentage)%" + (window.stale ? " · \(staleResetText)" : "")
            }
            return "\(name) \(unknownTxt)"
        }
        let weeklyShort = L10n.t("quota.short.weekly", fallback: "每周")
        var line = L10n.t("quota.menu_line.prefix", [
            "primary": part(contract.geminiPrimary.label, contract.geminiPrimary.window),
            "weekly": part(weeklyShort, contract.geminiWeekly)
        ], fallback: "Gemini " + part(contract.geminiPrimary.label, contract.geminiPrimary.window) + " · " + part(weeklyShort, contract.geminiWeekly))
        if contract.quotaWarnings.isEmpty && contract.refreshComplete == false {
            line += L10n.t("quota.menu_line.partial", fallback: " · 部分刷新")
        }
        return line
    }

    static func menuAccountSummary(_ raw: [String:Any]) -> String {
        let value = contract(raw)
        let unknownTxt = L10n.t("common.unknown", fallback: "未知")
        let staleTxt = L10n.t("quota.stale", fallback: "已过期")
        let exhaustedTxt = L10n.t("quota.exhausted", fallback: "已耗尽")
        let fiveHourLabel = L10n.t("common.period.5h", fallback: "5 小时")
        var lines: [String] = []
        for group in value.displayGroups {
            let name = group.summaryLabel.isEmpty ? group.displayName : group.summaryLabel
            if !group.isStandalone {
                guard let win = group.windows.first(where: { $0.percentage != nil }) else {
                    lines.append("\(name) \(unknownTxt)")
                    continue
                }
                if win.stale {
                    lines.append("\(name) \(staleTxt)")
                    continue
                }
                guard let pct = win.percentage else {
                    lines.append("\(name) \(unknownTxt)")
                    continue
                }
                let locLabel = win.localizedLabel
                let periodShort = locLabel == fiveHourLabel
                    ? L10n.t("quota.short.5h", fallback: "5小时")
                    : locLabel.replacingOccurrences(of: " ", with: "")
                lines.append("\(name) \(periodShort) \(pct == 0 ? exhaustedTxt : "\(pct)%")")
            } else if let win = group.primaryWindow, let pct = win.percentage {
                if win.stale {
                    lines.append("\(name) \(staleTxt)")
                } else {
                    lines.append("\(name) \(pct == 0 ? exhaustedTxt : "\(pct)%")")
                }
            }
        }
        return lines.joined(separator: "\n")
    }

    struct MonitoredScopeChoice: Equatable {
        var title: String
        var key: String
        var isSeparator: Bool = false

        static var separator: MonitoredScopeChoice {
            MonitoredScopeChoice(title: "", key: "", isSeparator: true)
        }
    }

    private struct ActiveScopeProfile {
        var isUltra: Bool
        var isPro: Bool
        var isFree: Bool
        var standalones: [QuotaGroup]
        var geminiStandalones: [QuotaGroup]
        var geminiAvailable: Bool
        var claudeAvailable: Bool

        var hasStandalonePool: Bool { !standalones.isEmpty }
        var hasGeminiStandalonePool: Bool { !geminiStandalones.isEmpty }
        var hasOnlyArgonStandalone: Bool {
            geminiStandalones.count == 1 && geminiStandalones[0].key.lowercased() == "argon"
        }
    }

    private static func activeScopeProfile(_ activeAccount: [String: Any]?) -> ActiveScopeProfile {
        let tierRaw = (
            (activeAccount?["subscription_tier"] as? String)
                ?? (activeAccount?["activeTier"] as? String)
                ?? (dict(activeAccount?["quota"])?["subscription_tier"] as? String)
                ?? ""
        ).trimmingCharacters(in: .whitespacesAndNewlines)
        let upper = tierRaw.uppercased()
        let isUltra = upper.contains("ULTRA") || upper.contains("ENTERPRISE")
        let isPro = !isUltra && (upper.contains("PRO") || upper.contains("AI PREMIUM") || upper.contains("TEAM") || upper.contains("BUSINESS") || upper.contains("WORKSPACE") || upper.contains("PLUS"))
        let isFree = !isUltra && !isPro && (upper.contains("FREE") || upper.contains("STARTER") || upper.contains("TRIAL"))

        guard let activeAccount else {
            return ActiveScopeProfile(
                isUltra: false,
                isPro: false,
                isFree: false,
                standalones: [],
                geminiStandalones: [],
                geminiAvailable: true,
                claudeAvailable: true
            )
        }

        let parsed = contract(activeAccount)
        let standalones = parsed.standaloneGroups.filter { $0.availability != "disabled" }
        let geminiStandalones = standalones.filter {
            $0.brands.contains("gemini") || inferredBrands(for: "\($0.key) \($0.displayName)").contains("gemini")
        }
        let core = parsed.coreGroups
        let geminiAvailable = core.isEmpty || core.contains { $0.key.lowercased() == "gemini" && $0.availability != "disabled" }
        let claudeAvailable = core.isEmpty || core.contains {
            let k = $0.key.lowercased()
            return (k == "claude" || k == "claude_gpt") && $0.availability != "disabled"
        }

        return ActiveScopeProfile(
            isUltra: isUltra,
            isPro: isPro,
            isFree: isFree,
            standalones: standalones,
            geminiStandalones: geminiStandalones,
            geminiAvailable: geminiAvailable,
            claudeAvailable: claudeAvailable
        )
    }

    private static func normalizeMonitoredAlias(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let lower = trimmed.lowercased()
        switch lower {
        case "", "all", "全部可用模型", "all available models", "全部主力模型", "all core models":
            return "all"
        case "gemini_all", "all gemini models", "gemini 全系模型", "gemini 全系（含 argon）", "all gemini (incl. argon)":
            return "gemini_all"
        case "gemini", "gemini（基础池）", "gemini (base pool)":
            return "gemini"
        case "claude", "3p", "claude/gpt":
            return "claude"
        case "argon", "gemini 4 argon", "gemini-4-argon":
            return "argon"
        case "carbon", "gemini 4 carbon", "gemini-4-carbon":
            return "carbon"
        default:
            return trimmed
        }
    }

    static func monitoredScopeChoices(for activeAccount: [String: Any]?) -> [MonitoredScopeChoice] {
        let profile = activeScopeProfile(activeAccount)
        var choices: [MonitoredScopeChoice] = []

        let allTitle = profile.hasStandalonePool
            ? L10n.t("accounts.smart_switch.monitored.all_core", fallback: "全部主力模型")
            : L10n.t("accounts.smart_switch.monitored.all_available", fallback: "全部可用模型")
        choices.append(MonitoredScopeChoice(title: allTitle, key: "all"))

        if profile.hasGeminiStandalonePool {
            let geminiAllTitle = profile.hasOnlyArgonStandalone
                ? L10n.t("accounts.smart_switch.monitored.gemini_all_argon", fallback: "Gemini 全系（含 Argon）")
                : L10n.t("accounts.smart_switch.monitored.gemini_all", fallback: "Gemini 全系模型")
            choices.append(MonitoredScopeChoice(title: geminiAllTitle, key: "gemini_all"))
        }

        choices.append(.separator)

        if profile.geminiAvailable {
            let geminiTitle = profile.hasGeminiStandalonePool
                ? L10n.t("accounts.smart_switch.monitored.gemini_base", fallback: "Gemini（基础池）")
                : "Gemini"
            choices.append(MonitoredScopeChoice(title: geminiTitle, key: "gemini"))
        }
        if profile.claudeAvailable {
            choices.append(MonitoredScopeChoice(title: "Claude/GPT", key: "claude"))
        }

        var seenKeys = Set(choices.filter { !$0.isSeparator }.map { $0.key.lowercased() })
        var seenTitles = Set(choices.filter { !$0.isSeparator }.map { $0.title.lowercased() })
        for group in profile.standalones {
            let displayTitle = (!group.displayName.isEmpty ? group.displayName : group.key).trimmingCharacters(in: .whitespacesAndNewlines)
            let rawKey = (!group.key.isEmpty ? group.key : displayTitle).trimmingCharacters(in: .whitespacesAndNewlines)
            let keyLower = rawKey.lowercased()
            let titleLower = displayTitle.lowercased()
            guard !keyLower.isEmpty, !seenKeys.contains(keyLower), !seenTitles.contains(titleLower) else { continue }
            seenKeys.insert(keyLower)
            seenTitles.insert(titleLower)
            choices.append(MonitoredScopeChoice(title: displayTitle, key: rawKey))
        }
        return choices
    }

    static func effectiveMonitoredModelKey(_ raw: String, activeAccount: [String: Any]?) -> String {
        let normalized = normalizeMonitoredAlias(raw)
        let normLower = normalized.lowercased()
        let choices = monitoredScopeChoices(for: activeAccount).filter { !$0.isSeparator }

        if let matched = choices.first(where: { $0.key.lowercased() == normLower || $0.title.lowercased() == normLower }) {
            return matched.key
        }
        if let matchedByCodename = choices.first(where: {
            let k = $0.key.lowercased()
            let t = $0.title.lowercased()
            return k == "gemini-4-\(normLower)" || normLower == "gemini-4-\(k)" || t == "gemini 4 \(normLower)"
        }) {
            return matchedByCodename.key
        }

        if normLower == "gemini_all" || inferredBrands(for: normLower).contains("gemini") {
            if let activeAccount {
                let parsed = contract(activeAccount)
                if normLower == "argon", parsed.argon?.mode == "unified", parsed.argon?.pooledInFamily == "claude",
                   choices.contains(where: { $0.key == "claude" }) {
                    return "claude"
                }
                if normLower == "carbon", parsed.carbon?.mode == "unified", parsed.carbon?.pooledInFamily == "claude",
                   choices.contains(where: { $0.key == "claude" }) {
                    return "claude"
                }
            }
            if choices.contains(where: { $0.key == "gemini" }) {
                return "gemini"
            }
        }

        if (normLower.contains("claude") || normLower.contains("gpt") || normLower.contains("openai") || normLower.contains("anthropic")),
           choices.contains(where: { $0.key == "claude" }) {
            return "claude"
        }

        return choices.first?.key ?? "all"
    }

    private static func concisePooledGeminiLabel(from displayName: String) -> String? {
        let cleaned = ModelDisplayName.name(displayName)
            .replacingOccurrences(of: "\\s+(?:Trial|Preview|Exp)$", with: "", options: [.regularExpression, .caseInsensitive])
            .trimmingCharacters(in: CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: ".;,")))
        guard !cleaned.isEmpty else { return nil }
        guard !isOrchestratorMetaModel(id: cleaned, displayName: cleaned) else { return nil }
        let ns = cleaned as NSString
        if let match = geminiVersionedNameRegex?.firstMatch(in: cleaned, range: NSRange(location: 0, length: ns.length)) {
            let tail = ns.substring(with: match.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines)
            let tokens = tail.lowercased().split(separator: " ").map(String.init)
            if tokens.isEmpty || tokens.allSatisfy({ genericGeminiTierTokens.contains($0) }) {
                return nil
            }
            return tail
        }
        let lower = cleaned.lowercased()
        if lower == "gemini" || genericGeminiTierTokens.contains(lower) {
            return nil
        }
        return cleaned
    }

    static func extractGroupMemberLabels(from description: String) -> [String] {
        let trimmed = description.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let regex = groupMemberListRegex else { return [] }
        let ns = trimmed as NSString
        guard let match = regex.firstMatch(in: trimmed, range: NSRange(location: 0, length: ns.length)),
              match.numberOfRanges > 1 else { return [] }
        let rawList = ns.substring(with: match.range(at: 1))
            .replacingOccurrences(of: "\\.\\s+.*$", with: "", options: .regularExpression)
            .replacingOccurrences(of: "\\.+$", with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawList.isEmpty else { return [] }
        return rawList
            .replacingOccurrences(of: "，", with: ",")
            .replacingOccurrences(of: "、", with: ",")
            .replacingOccurrences(of: ";", with: ",")
            .split(separator: ",")
            .map { String($0).trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
    }

    static func pooledUltraGeminiModelNames(_ activeAccount: [String: Any]?) -> [String] {
        guard let activeAccount else { return ["Argon", "Carbon"] }
        let parsed = contract(activeAccount)
        let standaloneKeys = Set(parsed.standaloneGroups.map { $0.key.lowercased() })
        let standaloneNames = Set(parsed.standaloneGroups.map { $0.displayName.lowercased() })
        func isStandaloneCandidate(_ label: String) -> Bool {
            let lower = label.lowercased()
            return standaloneKeys.contains(lower)
                || standaloneKeys.contains("gemini-4-\(lower)")
                || standaloneNames.contains(lower)
                || standaloneNames.contains("gemini 4 \(lower)")
        }

        // 1. Prefer official Gemini QuotaSummaryGroup.description (e.g. "Models within this group: Gemini 4 Neon, ...")
        if let geminiDesc = parsed.displayGroups.first(where: { $0.key.lowercased() == "gemini" })?.description,
           !geminiDesc.isEmpty {
            let rawItems = extractGroupMemberLabels(from: geminiDesc)
            var names: [String] = []
            var seen = Set<String>()
            for item in rawItems {
                guard let label = concisePooledGeminiLabel(from: item) else { continue }
                let lower = label.lowercased()
                guard !isStandaloneCandidate(label), !seen.contains(lower) else { continue }
                seen.insert(lower)
                names.append(label)
            }
            if !names.isEmpty { return names }
        }

        // 2. Fall back to visible non-orchestrator models belonging to the Gemini group
        let nested = dict(activeAccount["quota"])
        let rawModels = (activeAccount["models"] as? [[String: Any]]) ?? (nested?["models"] as? [[String: Any]]) ?? []
        var names: [String] = []
        var seen = Set<String>()
        for m in rawModels {
            let rawId = (m["model_id"] as? String ?? (m["name"] as? String ?? "")).trimmingCharacters(in: .whitespacesAndNewlines)
            let displayName = (m["display_name"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if isOrchestratorMetaModel(id: rawId, displayName: displayName) { continue }
            let isDisabled = (m["disabled"] as? Bool == true) || rawId.lowercased().contains("disabled")
            let isInternal = (m["is_internal"] as? Bool == true) || (m["isInternal"] as? Bool == true)
            let isDeprecated = (m["deprecated"] as? Bool == true)
            let isCarried = ((m["quota_source"] as? String) ?? "").lowercased() == "carried"
            if isDisabled || isInternal || isDeprecated || isCarried { continue }

            let family = ((m["family"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            if family == "claude" || family == "openai" || family == "3p" { continue }
            if !family.isEmpty && standaloneKeys.contains(family) { continue }
            if family.isEmpty || family == "other" {
                let lowerId = rawId.lowercased()
                let lowerDisplay = displayName.lowercased()
                let isGemini = inferredBrands(for: "\(rawId) \(displayName)").contains("gemini")
                    || lowerId.hasPrefix("gemini")
                    || lowerDisplay.contains("gemini")
                if !isGemini { continue }
            }

            let candidateName = !displayName.isEmpty ? displayName : ModelDisplayName.name(ModelUsageFold.baseModelKey(for: rawId))
            guard let label = concisePooledGeminiLabel(from: candidateName) else { continue }
            let lower = label.lowercased()
            guard !isStandaloneCandidate(label), !seen.contains(lower) else { continue }
            seen.insert(lower)
            names.append(label)
        }
        return names
    }

    private static func formatJoinedModelList(_ names: [String]) -> String {
        guard names.count > 2 else {
            return L10n.shared.isEnglish ? names.joined(separator: " and ") : names.joined(separator: " 与 ")
        }
        if L10n.shared.isEnglish {
            return names.dropLast().joined(separator: ", ") + ", and " + names.last!
        }
        return names.dropLast().joined(separator: "、") + " 与 " + names.last!
    }

    static func monitoredScopeSubtitle(for selectedKey: String, activeAccount: [String: Any]?) -> String {
        let profile = activeScopeProfile(activeAccount)
        let effective = effectiveMonitoredModelKey(selectedKey, activeAccount: activeAccount)
        switch effective.lowercased() {
        case "all":
            if profile.hasStandalonePool {
                if profile.hasOnlyArgonStandalone || profile.isPro {
                    return L10n.t("policy.row.monitored.sub.pro_all", fallback: "监测 Gemini 与 Claude/GPT 主力池，不受 Argon 独立周限额影响")
                }
                return L10n.t("policy.row.monitored.sub.dyn_all", fallback: "监测核心主力配额池，不受独立子模型单项限额影响")
            }
            if profile.isUltra {
                let pooledNames = pooledUltraGeminiModelNames(activeAccount)
                if pooledNames.isEmpty {
                    return L10n.t("policy.row.monitored.sub.ultra_all_generic", fallback: "同时监测当前 Ultra 账号的 Gemini 与 Claude/GPT 配额池")
                }
                if pooledNames == ["Argon", "Carbon"] {
                    return L10n.t("policy.row.monitored.sub.ultra_all", fallback: "同时监测 Gemini（已含 Argon / Carbon）与 Claude/GPT 配额池")
                }
                let joined = pooledNames.joined(separator: " / ")
                return L10n.t("policy.row.monitored.sub.ultra_all_models", ["models": joined], fallback: "同时监测 Gemini（已含 \(joined)）与 Claude/GPT 配额池")
            }
            if profile.isFree {
                return L10n.t("policy.row.monitored.sub.free_all", fallback: "同时监测当前免费账号可用的基础 Gemini 与 Claude/GPT 配额池")
            }
            return L10n.t("policy.row.monitored.sub.generic_all", fallback: "同时监测当前账号可用的 Gemini 与 Claude/GPT 配额池")
        case "gemini_all":
            if profile.hasOnlyArgonStandalone || (profile.isPro && profile.geminiStandalones.contains(where: { $0.key.lowercased() == "argon" })) {
                return L10n.t("policy.row.monitored.sub.pro_gemini_all", fallback: "同时盯住基础 Gemini 与独立 Argon 周配额，任一偏低即提示切换")
            }
            return L10n.t("policy.row.monitored.sub.dyn_gemini_all", fallback: "同时盯住基础 Gemini 与独立 Gemini 子模型配额，任一偏低即提示切换")
        case "gemini":
            if profile.hasGeminiStandalonePool {
                if profile.hasOnlyArgonStandalone || profile.isPro {
                    return L10n.t("policy.row.monitored.sub.pro_gemini_base", fallback: "仅监测基础 Gemini 共享池，Pro 套餐下不含独立计费的 Argon")
                }
                return L10n.t("policy.row.monitored.sub.dyn_gemini_base", fallback: "仅监测基础 Gemini 共享池，不含独立计费的子模型配额")
            }
            if profile.isUltra {
                let pooledNames = pooledUltraGeminiModelNames(activeAccount)
                if pooledNames.isEmpty {
                    return L10n.t("policy.row.monitored.sub.ultra_gemini_generic", fallback: "仅监测当前 Ultra 账号的 Gemini 共享配额池")
                }
                if pooledNames == ["Argon", "Carbon"] {
                    return L10n.t("policy.row.monitored.sub.ultra_gemini", fallback: "Ultra 套餐已将 Argon 与 Carbon 并入此共享池，一并监测")
                }
                let joined = formatJoinedModelList(pooledNames)
                return L10n.t("policy.row.monitored.sub.ultra_gemini_models", ["models": joined], fallback: "Ultra 套餐已将 \(joined) 并入此共享池，一并监测")
            }
            if profile.isFree {
                return L10n.t("policy.row.monitored.sub.free_gemini", fallback: "仅监测免费套餐可用的基础 Gemini 配额池")
            }
            return L10n.t("policy.row.monitored.sub.generic_gemini", fallback: "仅监测当前账号的 Gemini 共享配额池")
        case "claude":
            return L10n.t("policy.row.monitored.sub.claude", fallback: "仅监测 Claude 与 GPT 模型共享配额池")
        case "argon":
            if profile.isPro {
                return L10n.t("policy.row.monitored.sub.pro_argon", fallback: "仅监测 Pro 套餐独立的 Gemini 4 Argon 每周配额")
            }
            return L10n.t("policy.row.monitored.sub.standalone", ["model": "Gemini 4 Argon"], fallback: "仅监测当前账号独立的 Gemini 4 Argon 配额池")
        default:
            let modelTitle = monitoredModelDisplayName(effective, activeAccount: activeAccount, accounts: activeAccount.map { [$0] } ?? [])
            return L10n.t("policy.row.monitored.sub.standalone", ["model": modelTitle], fallback: "仅监测当前账号独立的 \(modelTitle) 配额池")
        }
    }

    static func monitoredModelDisplayName(_ raw: String, activeAccount: [String: Any]?, accounts: [[String: Any]] = []) -> String {
        if let activeAccount {
            let effective = effectiveMonitoredModelKey(raw, activeAccount: activeAccount)
            let choices = monitoredScopeChoices(for: activeAccount).filter { !$0.isSeparator }
            if let matched = choices.first(where: { $0.key.lowercased() == effective.lowercased() }) {
                return matched.title
            }
            return monitoredModelDisplayName(effective, accounts: accounts)
        }
        return monitoredModelDisplayName(raw, accounts: accounts)
    }

    static func monitoredModelDisplayName(_ raw: String, accounts: [[String: Any]]) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed.lowercased() {
        case "", "all":
            return L10n.t("accounts.smart_switch.monitored.all_available", fallback: "全部可用模型")
        case "gemini_all":
            return L10n.t("accounts.smart_switch.monitored.gemini_all", fallback: "Gemini 全系模型")
        case "gemini":
            return "Gemini"
        case "claude", "3p", "claude/gpt":
            return "Claude/GPT"
        case "argon", "gemini 4 argon":
            return "Gemini 4 Argon"
        case "carbon", "gemini 4 carbon":
            return "Gemini 4 Carbon"
        default:
            let lower = trimmed.lowercased()
            for acc in accounts {
                if let matched = contract(acc).standaloneGroups.first(where: {
                    $0.key.lowercased() == lower || $0.displayName.lowercased() == lower
                }) {
                    return matched.displayName
                }
            }
            return ModelDisplayName.name(trimmed)
        }
    }

    static func warningSummary(_ contract: Contract, excluding: [String] = []) -> String {
        if !contract.quotaWarnings.isEmpty {
            var seen = Set<String>()
            let messages = contract.quotaWarnings.filter { warning in
                // Argon / Carbon already carry this explanation beside their own quota bars.
                !warning.hasPrefix("ARGON_") && !warning.hasPrefix("CARBON_")
                    && warning != contract.argon?.message && warning != contract.carbon?.message
            }.map { warning -> String in
                if let range = warning.range(of: ": ") { return String(warning[range.upperBound...]) }
                return warning
            }.filter { !excluding.contains($0) && seen.insert($0).inserted }
            if !messages.isEmpty {
                let sep = L10n.shared.isEnglish ? "; " : "；"
                let more = messages.count > 2 ? L10n.t("quota.warning.more_suffix", ["count": messages.count - 2], fallback: "；另有 \(messages.count - 2) 项配额提示") : ""
                return messages.prefix(2).joined(separator: sep) + more
            }
            if !excluding.isEmpty { return "" }
        }
        if contract.refreshComplete == false { return L10n.t("quota.warning.partial_refresh", fallback: "本轮配额刷新部分完成；未返回的窗口等待下次刷新。") }
        return ""
    }

    static func fingerprint(_ raw: [String: Any]) -> String {
        let nested = dict(raw["quota"])
        var fields = ["quotaGroups", "familyWindows", "familyModelQuota", "argonStatus", "carbonStatus", "standaloneModels", "refreshState", "quotaWarnings", "subscription_tier", "standbyRefreshStatus"].reduce(into: [String: Any]()) {
            if let value = raw[$1] { $0[$1] = value }
        }
        if fields["quotaGroups"] == nil, let qGroups = nested?["quotaGroups"] {
            fields["quotaGroups"] = qGroups
        }
        guard let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]),
              let value = String(data: data, encoding: .utf8) else { return "" }
        return value
    }
}
