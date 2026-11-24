import Cocoa

struct LiveStatus {
    var bundleCacheHit = false
    var connectionError = ""
    var working = false
    var taskRevision = 0
    var languageMode = "zh"
    var locale = "zh-Hans"
    var configuredLanguage = "zh-Hans"
    var mode = "starting"
    var translationEnabled: Bool? = nil
    var hudEnabled: Bool? = nil
    var appVersion = ""
    var entries = 0
    var windows = 0
    var message = L10n.t("assistant.starting_service", fallback: "正在连接本机服务…")
    var dictionaryVersion = ""
    var dictionaryError = ""
    var baseVersion = ""
    var rss: Double = 0
    var updatedAt = ""
    var pending = 0
    var activeAccountEmail = ""
    var activeFiveHourQuota: Int? = nil
    var activeSubscriptionTier = "FREE"
    var accountsRevision = ""
    var pricingRevision = ""
    var liveAccountEmail = ""
    var oauthClientConfigured = false
    var sshWindowsCount = 0
    var activeSshHosts: [String] = []
    var focusedContextKey = "local"
    var remoteObservedVersion = 0
    var remoteSyncRevision = 0
    var remoteSessions: [[String: Any]] = []

    init(_ raw: [String: Any] = [:]) {
        working = (raw["healing"] as? Bool == true) || (raw["runningTasks"] as? Int ?? 0) > 0
        taskRevision = raw["taskRevision"] as? Int ?? 0
        bundleCacheHit = raw["bundleCacheHit"] as? Bool ?? false
        languageMode = raw["languageMode"] as? String ?? "zh"
        locale = raw["locale"] as? String ?? (languageMode == "en" ? "en" : "zh-Hans")
        configuredLanguage = raw["configuredLanguage"] as? String ?? locale
        mode = raw["mode"] as? String ?? "starting"
        translationEnabled = raw["translationEnabled"] as? Bool
        hudEnabled = raw["hudEnabled"] as? Bool
        appVersion = raw["appVersion"] as? String ?? ""
        entries = raw["entries"] as? Int ?? 0
        windows = raw["windows"] as? Int ?? 0
        message = raw["message"] as? String ?? L10n.t("assistant.starting_service", fallback: "正在连接本机服务…")
        dictionaryVersion = raw["dictionaryVersion"] as? String ?? ""
        dictionaryError = raw["dictionaryError"] as? String ?? ""
        baseVersion = raw["dictionaryBaseVersion"] as? String ?? ""
        rss = (raw["rssMB"] as? NSNumber)?.doubleValue ?? 0
        updatedAt = raw["updatedAt"] as? String ?? ""
        pending = raw["newStringsCount"] as? Int ?? 0
        activeAccountEmail = raw["activeAccountEmail"] as? String ?? ""
        activeFiveHourQuota = raw["activeFiveHourQuota"] as? Int
        activeSubscriptionTier = raw["activeSubscriptionTier"] as? String ?? "FREE"
        accountsRevision = (raw["accountsRevision"] as? String) ?? "\(raw["accountsRevision"] ?? "")"
        pricingRevision = raw["pricingRevision"] as? String ?? ""
        liveAccountEmail = raw["liveAccountEmail"] as? String ?? ""
        oauthClientConfigured = raw["oauthClientConfigured"] as? Bool ?? false
        sshWindowsCount = (raw["sshWindowsCount"] as? Int) ?? (raw["sshWindows"] as? Int) ?? 0
        activeSshHosts = raw["activeSshHosts"] as? [String] ?? []
        focusedContextKey = raw["focusedContextKey"] as? String ?? "local"
        remoteObservedVersion = raw["remoteObservedVersion"] as? Int ?? 0
        remoteSyncRevision = (raw["remoteSyncRevision"] as? NSNumber)?.intValue ?? (raw["remoteSyncRevision"] as? Int) ?? 0
        remoteSessions = raw["remoteSessions"] as? [[String: Any]] ?? []
        if let errors = raw["errors"] as? [String], !errors.isEmpty {
            connectionError = errors.joined(separator: L10n.shared.isEnglish ? "; " : "；")
        }
    }

    var enabled: Bool {
        // error / debug-port-missing 表示汉化实际未生效：开关显示为“关”。
        if mode == "paused" || mode == "unsupported" || mode == "legacy-blocked" || mode == "stopped" || mode == "error" || mode == "debug-port-missing" {
            return false
        }
        if let translationEnabled {
            return translationEnabled
        }
        return mode == "connected" || mode == "adaptive" || mode == "waiting" || mode == "waiting-window" || mode == "starting"
    }

    var title: String {
        if !dictionaryError.isEmpty { return L10n.t("status.check_dictionary", fallback: "需要检查词典") }
        if !connectionError.isEmpty { return L10n.t("status.check_partial", fallback: "部分界面需要检查") }
        if working && enabled { return L10n.t("status.running_tasks", fallback: "正在处理任务") }
        switch mode {
        case "connected", "adaptive": return L10n.t("status.connected", fallback: "已连接")
        case "paused":
            if L10n.shared.currentLocale == "en" || locale == "en" {
                return windows > 0 ? L10n.t("status.connected_english", fallback: "已连接 · 英文") : L10n.t("status.english_mode", fallback: "英文模式")
            }
            return L10n.t("status.paused", fallback: "汉化已暂停")
        case "unsupported": return L10n.t("status.unsupported", fallback: "等待版本适配")
        case "legacy-blocked": return L10n.t("status.legacy_blocked", fallback: "检测到旧版汉化")
        case "debug-port-missing": return L10n.t("status.debug_port_missing", fallback: "未开启调试端口")
        case "error": return L10n.t("status.error", fallback: "连接需要处理")
        case "stopped": return L10n.t("status.stopped", fallback: "服务已停止")
        case "waiting-window": return L10n.t("status.waiting_window", fallback: "等待可连接窗口")
        case "waiting": return L10n.t("status.waiting", fallback: "等待目标界面")
        default: return L10n.t("status.waiting_app", fallback: "等待 Antigravity")
        }
    }

    var color: NSColor {
        if !connectionError.isEmpty { return .systemOrange }
        if working && enabled { return .systemBlue }
        if !dictionaryError.isEmpty { return .systemOrange }
        switch mode {
        case "connected": return languageMode == "zh" ? .systemGreen : .systemBlue
        case "paused":
            if (L10n.shared.currentLocale == "en" || locale == "en") && windows > 0 {
                return .systemBlue
            }
            return .secondaryLabelColor
        case "adaptive", "unsupported", "legacy-blocked", "debug-port-missing": return .systemOrange
        case "error": return .systemRed
        default: return .secondaryLabelColor
        }
    }
}
