import Foundation

struct AppLocaleMeta {
    let code: String
    let nativeName: String
    let fallback: String
    let hasTargetDictionary: Bool
}

struct AppLocalePack {
    let meta: AppLocaleMeta
    let strings: [String: String]
}

final class L10n {
    static let shared = L10n()
    static let didChangeNotification = Notification.Name("local.gravitybox.languageDidChange")

    private static let defaultFallbackCode = "en"
    private static let defaultLegacyCode = "zh-Hans"
    private static let preferredOrder = ["zh-Hans", "zh-Hant", "en", "ja", "fr"]

    private let lock = NSRecursiveLock()
    private var packs: [String: AppLocalePack] = [:]
    private(set) var configuredLanguage: String = "system"
    private(set) var currentLocale: String = "zh-Hans"

    private init() {
        reloadPacks()
        lock.lock()
        currentLocale = resolveLocaleLocked(configuredLanguage)
        lock.unlock()
    }

    func reloadPacks(directory: URL? = nil) {
        var loaded: [String: AppLocalePack] = [:]
        let searchDirs = directory.map { [$0] } ?? Self.candidateI18nDirectories()
        let fm = FileManager.default
        for dir in searchDirs {
            guard let items = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: nil) else { continue }
            let jsonFiles = items.filter { $0.pathExtension.lowercased() == "json" }.sorted { $0.lastPathComponent < $1.lastPathComponent }
            if jsonFiles.isEmpty { continue }
            for file in jsonFiles {
                guard let data = try? Data(contentsOf: file),
                      let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                      let metaObj = root["meta"] as? [String: Any],
                      let code = (metaObj["code"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines),
                      !code.isEmpty else { continue }
                let nativeName = (metaObj["nativeName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? code
                let fallback = (metaObj["fallback"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? Self.defaultFallbackCode
                let hasDict = (metaObj["hasTargetDictionary"] as? Bool) ?? false
                let backendStrings = (root["backend"] as? [String: String]) ?? [:]
                let appStrings = (root["app"] as? [String: String]) ?? [:]
                // 命名空间合并优先级：以 `backend` 为基底，`app` 中的同名 key 覆盖 `backend`，确保原生前端文案优先。
                let mergedStrings = backendStrings.merging(appStrings) { _, appVal in appVal }
                loaded[code] = AppLocalePack(
                    meta: AppLocaleMeta(code: code, nativeName: nativeName, fallback: fallback, hasTargetDictionary: hasDict),
                    strings: mergedStrings
                )
            }
            if !loaded.isEmpty { break }
        }
        lock.lock()
        packs = loaded
        if !loaded.isEmpty, packs[currentLocale] == nil {
            currentLocale = resolveLocaleLocked(configuredLanguage)
        }
        lock.unlock()
    }

    private static func candidateI18nDirectories() -> [URL] {
        var dirs: [URL] = []
        if let envI18n = ProcessInfo.processInfo.environment["GRAVITYBOX_I18N_DIR"]?.trimmingCharacters(in: .whitespacesAndNewlines),
           !envI18n.isEmpty {
            dirs.append(URL(fileURLWithPath: envI18n, isDirectory: true))
        }
        if let res = Bundle.main.resourceURL {
            dirs.append(res.appendingPathComponent("i18n", isDirectory: true))
        }
        if let exeDir = Bundle.main.executableURL?.deletingLastPathComponent() {
            dirs.append(exeDir.appendingPathComponent("i18n", isDirectory: true))
        }
        #if NATIVE_UI_TEST
        if let envRes = ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] {
            dirs.append(URL(fileURLWithPath: envRes, isDirectory: true).appendingPathComponent("i18n", isDirectory: true))
        }
        #endif
        let cwdAssets = URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)
            .appendingPathComponent("assets/i18n", isDirectory: true)
        dirs.append(cwdAssets)
        return dirs
    }

    var supportedLocales: [AppLocaleMeta] {
        lock.lock()
        defer { lock.unlock() }
        let sortedCodes = packs.keys.sorted { lhs, rhs in
            let li = Self.preferredOrder.firstIndex(of: lhs) ?? Int.max
            let ri = Self.preferredOrder.firstIndex(of: rhs) ?? Int.max
            if li != ri { return li < ri }
            return lhs < rhs
        }
        return sortedCodes.compactMap { packs[$0]?.meta }
    }

    var currentMeta: AppLocaleMeta? {
        lock.lock()
        defer { lock.unlock() }
        return packs[currentLocale]?.meta
    }

    var foundationLocale: Locale {
        lock.lock()
        let code = currentLocale
        lock.unlock()
        return Locale(identifier: code)
    }

    var isEnglish: Bool {
        lock.lock()
        let code = currentLocale
        lock.unlock()
        return code == "en"
    }

    func normalizeLocale(_ input: String?) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return normalizeLocaleLocked(input)
    }

    private func normalizeLocaleLocked(_ input: String?) -> String? {
        guard let raw = input?.trimmingCharacters(in: .whitespacesAndNewlines).replacingOccurrences(of: "_", with: "-"),
              !raw.isEmpty,
              raw.lowercased() != "system" else { return nil }
        if packs[raw] != nil { return raw }
        let lower = raw.lowercased()
        if let match = packs.keys.first(where: { $0.lowercased() == lower }) {
            return match
        }
        if lower.hasPrefix("zh") {
            if lower.contains("hant") || lower.contains("-tw") || lower.contains("-hk") || lower.contains("-mo") {
                if packs["zh-Hant"] != nil { return "zh-Hant" }
            }
            if packs["zh-Hans"] != nil { return "zh-Hans" }
        }
        if let primary = lower.split(separator: "-").first.map(String.init), !primary.isEmpty {
            if let exactPrimary = packs.keys.first(where: { $0.lowercased() == primary }) {
                return exactPrimary
            }
            if let prefixed = packs.keys.first(where: { $0.lowercased().hasPrefix("\(primary)-") }) {
                return prefixed
            }
        }
        return nil
    }

    func resolveLocale(_ configured: String, systemLanguages: [String] = Locale.preferredLanguages) -> String {
        lock.lock()
        defer { lock.unlock() }
        return resolveLocaleLocked(configured, systemLanguages: systemLanguages)
    }

    private func resolveLocaleLocked(_ configured: String, systemLanguages: [String] = Locale.preferredLanguages) -> String {
        if configured.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "system",
           let exact = normalizeLocaleLocked(configured) {
            return exact
        }
        for candidate in systemLanguages {
            if let matched = normalizeLocaleLocked(candidate) {
                return matched
            }
        }
        if packs[Self.defaultFallbackCode] != nil { return Self.defaultFallbackCode }
        if packs[Self.defaultLegacyCode] != nil { return Self.defaultLegacyCode }
        return packs.keys.sorted().first ?? Self.defaultFallbackCode
    }

    @discardableResult
    func setLanguage(_ configured: String, systemLanguages: [String] = Locale.preferredLanguages, notify: Bool = true) -> String {
        let trimmed = configured.trimmingCharacters(in: .whitespacesAndNewlines)
        lock.lock()
        let normalizedConfigured: String
        if trimmed.isEmpty || trimmed.lowercased() == "system" {
            normalizedConfigured = "system"
        } else {
            normalizedConfigured = normalizeLocaleLocked(trimmed) ?? "system"
        }
        let nextResolved = resolveLocaleLocked(normalizedConfigured, systemLanguages: systemLanguages)
        let changed = (configuredLanguage != normalizedConfigured) || (currentLocale != nextResolved)
        configuredLanguage = normalizedConfigured
        currentLocale = nextResolved
        lock.unlock()
        if changed && notify {
            NotificationCenter.default.post(name: Self.didChangeNotification, object: self)
        }
        return nextResolved
    }

    func text(_ key: String, params: [String: CustomStringConvertible] = [:], fallback: String? = nil) -> String {
        lock.lock()
        var visited = Set<String>()
        var cursor: String? = currentLocale
        var resolved: String?

        while let code = cursor, !visited.contains(code) {
            visited.insert(code)
            if let value = packs[code]?.strings[key] {
                resolved = value
                break
            }
            let next = packs[code]?.meta.fallback
            cursor = (next != nil && next != code) ? next : nil
        }

        if resolved == nil {
            resolved = packs[Self.defaultFallbackCode]?.strings[key]
        }
        lock.unlock()
        var output = resolved ?? fallback ?? key
        if !params.isEmpty {
            for (name, val) in params {
                output = output.replacingOccurrences(of: "{\(name)}", with: String(describing: val))
            }
        }
        return output
    }

    static func t(_ key: String, _ params: [String: CustomStringConvertible] = [:], fallback: String? = nil) -> String {
        shared.text(key, params: params, fallback: fallback)
    }
}
