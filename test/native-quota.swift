import Cocoa

@main struct QuotaContractFixture {
    static var assertionCount = 0
    static func check(_ value: Bool, _ message: String) {
        assertionCount += 1
        if !value { FileHandle.standardError.write(Data((message + "\n").utf8)); exit(1) }
    }
    static func main() {
        L10n.shared.setLanguage("zh-Hans", notify: false)
        let unknown: [String: Any] = ["availability":"unknown", "quotaState":"not_reported"]
        let weekly: [String: Any] = ["remaining":0.73, "known":true, "stale":false, "resetCountdown":"6天后重置"]
        let raw: [String: Any] = ["familyWindows":["gemini":["weekly":weekly]], "argonStatus":unknown,
            "geminiFiveHourRemaining":100, "argonWeeklyRemaining":100]
        let contract = QuotaPresentation.contract(raw)
        check(contract.gemini5h == nil, "New contract must override legacy fabricated 5h")
        check(contract.geminiWeekly?.percentage == 73, "Fraction conversion")
        let modelRaw: [String: Any] = ["familyWindows":["gemini":["weekly":weekly]],
            "familyModelQuota":["gemini":["remaining":1,"known":true,"stale":false,"resetCountdown":"4小时59分后重置"],
                                "claude":["remaining":1,"known":true,"stale":false,"resetCountdown":"6天23小时后重置"]]]
        let modelContract = QuotaPresentation.contract(modelRaw)
        check(modelContract.gemini5h == nil && modelContract.claude5h == nil, "Model quota must not fabricate a 5h window")
        check(modelContract.geminiPrimary.window?.percentage == 100 && modelContract.geminiPrimary.label == "模型配额", "Known model quota must remain visible")
        check(modelContract.claudePrimary.window?.resetText == "6天23小时后重置", "Weekly-length model reset must stay intact")
        check(QuotaPresentation.menuQuotaText(modelRaw).contains("模型配额 100%"), "Menu must display model value without fake period")
        check(QuotaPresentation.menuAccountSummary(modelRaw).contains("Claude/GPT 模型配额 100%"), "Account menu shares fallback semantics")
        check(QuotaPresentation.contract(["quota":modelRaw]).geminiPrimary.window?.percentage == 100, "Nested IPC shares model quota")
        var explicitRaw = modelRaw
        explicitRaw["familyWindows"] = ["gemini":["fiveHour":["remaining":0.4,"known":true,"stale":false]]]
        let explicit = QuotaPresentation.contract(explicitRaw)
        check(explicit.geminiPrimary.window?.percentage == 40 && explicit.geminiPrimary.label == "5 小时", "Explicit fresh period wins")
        var zeroRaw = modelRaw; zeroRaw["familyModelQuota"] = ["gemini":["remaining":0,"known":true,"stale":false]]
        check(QuotaPresentation.contract(zeroRaw).geminiPrimary.window?.percentage == 0, "Model zero is exhausted, never unknown")
        check(QuotaPresentation.fingerprint(modelRaw) != QuotaPresentation.fingerprint(zeroRaw), "Model-only updates repaint cards")
        check(contract.argon?.percentage == nil && contract.argon?.title == "Gemini 4 Argon", "No invented Argon week/value")
        check(contract.argon?.resetText == "配额未知", "Missing metadata cannot deny permission")
        check(QuotaPresentation.menuQuotaText(raw).contains("5 小时 未知 · 每周 73%"), "Menu shares contract")
        let nested = QuotaPresentation.contract(["quota":raw])
        check(nested.argon?.placeholder == contract.argon?.placeholder, "Nested IPC shares contract")
        let known = QuotaPresentation.contract(["argonStatus":["availability":"available", "quotaState":"known", "remaining":0.42, "period":"unspecified"]])
        check(known.argon?.percentage == 42 && known.argon?.title == "Gemini 4 Argon" && known.argon?.periodLabel == "模型配额" && known.argon?.resetText == "", "Own quota must not claim weekly or 周期未知")
        let disabled = QuotaPresentation.contract(["argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(disabled.argon?.percentage == nil && disabled.argon?.placeholder == "不可用" && disabled.argon?.resetText == "", "Disabled is not zero and shows 不可用")
        let stale = QuotaPresentation.contract(["familyWindows":["gemini":["weekly":["remaining":0.6,"known":true,"stale":true]]],
            "argonStatus":["availability":"unknown", "quotaState":"stale", "remaining":0.3,"period":"weekly"]])
        check(stale.geminiWeekly?.percentage == 60 && stale.geminiWeekly?.resetText.contains("数据已过期") == true, "Carried values labelled")
        check(stale.argon?.percentage == 30 && stale.argon?.resetText.contains("数据已过期") == true, "Carried Argon labelled")
        check(QuotaPresentation.menuQuotaText(["familyWindows":["gemini":["weekly":["remaining":0.6,"known":true,"stale":true]]]]).contains("数据已过期"), "Menu labels stale")
        let invalid = QuotaPresentation.contract(["argonStatus":["quotaState":"known","remaining":12]])
        check(invalid.argon?.percentage == nil, "Invalid fraction cannot produce 100%")
        let legacy = QuotaPresentation.contract(["geminiFiveHourRemaining":73,"geminiWeeklyRemaining":73,"geminiFiveHourResetCountdown":"以周限额为准"])
        check(legacy.gemini5h?.percentage == nil && legacy.geminiWeekly?.percentage == 73, "Legacy copied value not revived")
        check(QuotaPresentation.fingerprint(raw) != QuotaPresentation.fingerprint(["argonStatus":["availability":"available"]]), "Contract changes repaint cards")
        let warning = QuotaPresentation.contract(["quotaWarnings":["UNVERIFIED_CLOUD_SCOPE: HTTP 403", "OTHER: Other information"]])
        check(QuotaPresentation.warningSummary(warning, excluding:["HTTP 403"]) == "Other information", "Refresh error not repeated; independent warnings retained")
        let same = QuotaPresentation.contract(["quotaWarnings":["UNVERIFIED_CLOUD_SCOPE: HTTP 403"], "refreshState":["complete":false]])
        check(QuotaPresentation.warningSummary(same, excluding:["HTTP 403"]).isEmpty, "Single failure renders only once")
        check(ModelDisplayName.name("gemini-3.8-flash-n") == "gemini-3.8-flash-n", "Response model with -n suffix stays exact")
        check(ModelDisplayName.name("claude-opus-5-5-high") == "claude-opus-5-5-high", "Raw response model with -high suffix is preserved verbatim")
        check(ModelDisplayName.name("gemini-4-argon-trial") == "gemini-4-argon-trial", "Response model with trial variant stays exact raw slug")
        check(ModelDisplayName.name("gemini-4-carbon") == "Gemini 4 Carbon", "Format Gemini 4 Carbon")
        check(ModelDisplayName.name("gemini-4-neon") == "Gemini 4 Neon", "Auto-format future Gemini 4+ codename models")
        check(ModelDisplayName.name("gemini-3.8-flash-exp-a") == "gemini-3.8-flash-exp-a", "Response model with -exp-a suffix stays exact")
        check(ModelDisplayName.name("Gemini 3.8 Flash (High)") == "Gemini 3.8 Flash", "Bracketed reasoning effort is stripped")
        check(ModelDisplayName.name("Gemini 4 Neon (XHigh)") == "Gemini 4 Neon", "Bracketed XHigh effort is stripped cleanly")
        check(ModelDisplayName.name("Gemini 4 Neon (Extra)") == "Gemini 4 Neon", "Bracketed Extra effort is stripped cleanly")
        check(ModelDisplayName.name("Gemini 4 Neon (Extra High)") == "Gemini 4 Neon", "Bracketed Extra High effort is stripped cleanly")
        check(ModelDisplayName.name("Gemini 4 Neon (Extra-High)") == "Gemini 4 Neon", "Bracketed Extra-High effort is stripped cleanly")
        check(ModelDisplayName.name("Gemini 4 Neon (Minimal)") == "Gemini 4 Neon", "Bracketed Minimal effort is stripped cleanly")
        check(ModelDisplayName.name("Gemini 4 Neon (Max)") == "Gemini 4 Neon", "Bracketed Max effort is stripped cleanly")
        check(ModelDisplayName.name("gemini-4-neon-xhigh-thinking") == "Gemini 4 Neon Thinking", "xhigh-thinking suffix formats cleanly")
        check(ModelDisplayName.name("gemini-4-neon-extra-thinking") == "Gemini 4 Neon Thinking", "extra-thinking suffix formats cleanly")
        check(ModelDisplayName.name("gemini-4-neon-extra-high-thinking") == "Gemini 4 Neon Thinking", "extra-high-thinking suffix formats cleanly")
        check(ModelDisplayName.name("gemini-4-neon-extra") == "Gemini 4 Neon", "extra suffix strips cleanly for known model")
        check(ModelDisplayName.name("gemini-5-nova-xhigh-thinking") == "Gemini 5 Nova Thinking", "Future Gemini 4+ xhigh-thinking suffix formats cleanly")
        check(ModelDisplayName.name("Claude Opus 5.5 (XHigh)") == "Claude Opus 5.5", "Non-Gemini bracketed XHigh effort is stripped cleanly")
        check(ModelDisplayName.name("claude-opus-4-6-xhigh-thinking") == "Claude Opus 4.6 Thinking", "Claude xhigh-thinking suffix formats cleanly")
        check(ModelDisplayName.name("Claude Opus 4.6 (Orchestrator)") == "Claude Opus 4.6 Orchestrator", "Non-Gemini orchestrator display name is preserved cleanly")
        check(ModelDisplayName.name("Orchestrator (Claude Opus 4.6)") == "Orchestrator Claude Opus 4.6", "Prefixed non-Gemini orchestrator display name is preserved cleanly")
        check(ModelDisplayName.name("Claude Sonnet 4.6 (Thinking)") == "Claude Sonnet 4.6 Thinking", "Database thinking suffix preserved")
        let proNoCarbon = QuotaPresentation.contract(["subscription_tier":"PRO", "argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(proNoCarbon.carbon == nil && proNoCarbon.standaloneGroups.isEmpty, "Missing Carbon evidence must not synthesize a fake carbon row")
        let ultraWithNewModel = QuotaPresentation.contract([
            "subscription_tier":"ULTRA",
            "carbonStatus":["availability":"available", "quotaState":"known", "remaining":0.85, "period":"weekly", "modelName":"gemini-4-carbon"],
            "standaloneModels":[
                ["key":"argon", "modelName":"gemini-4-argon", "availability":"available", "quotaState":"known", "remaining":0.5, "period":"weekly"],
                ["key":"carbon", "modelName":"gemini-4-carbon", "availability":"available", "quotaState":"known", "remaining":0.85, "period":"weekly"],
                ["key":"gemini-4-neon", "modelName":"gemini-4-neon", "availability":"available", "quotaState":"known", "remaining":0.92, "period":"weekly"]
            ]
        ])
        check(ultraWithNewModel.carbon?.percentage == 85 && ultraWithNewModel.carbon?.title == "Gemini 4 Carbon · 每周", "Ultra Carbon quota parsed")
        check(ultraWithNewModel.extraStandaloneModels.count == 1 && ultraWithNewModel.extraStandaloneModels.first?.title == "Gemini 4 Neon · 每周" && ultraWithNewModel.extraStandaloneModels.first?.percentage == 92, "Auto-detected standalone model parsed")
        check(InterfaceText.quotaMessage("HTTP 403 (#3501)") == "许可校验失败 · 3501", "Concise service state")
        check(InterfaceText.isMultiAccountSummary("已读取 1 个账号；2 个刷新失败。详情见账号卡片。"), "Detects multi-account summary message")
        check(InterfaceText.quotaMessage("已读取 1 个账号；2 个刷新失败。详情见账号卡片。") == "部分账号配额未更新", "Multi-account partial error must not misreport current account failure")
        // Replaces JS copies of retired UI algorithms with production Swift contracts.
        let dual = QuotaPresentation.contract(["familyWindows":["gemini":[
            "fiveHour":["remaining":1.0,"known":true,"stale":false],
            "weekly":["remaining":0.11,"known":true,"stale":false]
        ]]])
        check(dual.geminiPrimary.window?.percentage == 100 && dual.geminiWeekly?.percentage == 11, "5h and weekly quota retain their distinct values")
        let depleted = QuotaPresentation.contract(["familyWindows":["claude":[
            "fiveHour":["remaining":0.8,"known":true,"stale":false],
            "weekly":["remaining":0.0,"known":true,"stale":false]
        ]]])
        check(depleted.claude5h?.percentage == 80 && depleted.claudeWeekly?.percentage == 0, "Weekly exhaustion must remain visible without relabeling the 5h value")
        for (value, expected) in [(0.0,"$0.00"),(0.000001,"<$0.001"),(0.002,"$0.002"),(0.12,"$0.12")] {
            check(InterfaceText.formatUsd(value) == expected, "Production currency formatting for \(value)")
        }
        let partialScope = InterfaceText.usageScope(scanned: 2, discovered: 3, failed: 1, skipped: 4, unknown: 5)
        check(partialScope.contains("2/3") && partialScope.contains("1 个读取失败") && partialScope.contains("4 条未读取") && partialScope.contains("5 条时间未知"), "Incomplete reads disclose each failure category")
        let completeScope = InterfaceText.usageScope(scanned: 3, discovered: 3, failed: 0, skipped: 0, unknown: 0)
        check(!completeScope.contains("读取失败") && !completeScope.contains("未读取") && !completeScope.contains("时间未知"), "Complete reads do not manufacture warnings")

        // English quota contracts, countdowns, integer locale formatting & weekly-only sentinel (P1-24 / P1-25 / P1-29)
        L10n.shared.setLanguage("en", notify: false)
        check(InterfaceText.countdown("4小时13分钟后重置") == "Resets in 4h 13m", "English countdown formatting")
        check(InterfaceText.countdown("即将重置") == "Resetting soon", "English imminent countdown")
        check(InterfaceText.countdown("已过") == "Passed", "English passed countdown")
        check(InterfaceText.formatInteger(12345) == "12,345", "English integer locale formatting must match en_US")
        for (value, expected) in [(0.0,"$0.00"),(0.000001,"<$0.001"),(0.002,"$0.002"),(0.12,"$0.12")] {
            check(InterfaceText.formatUsd(value) == expected, "English currency formatting for \(value)")
        }
        let enDisabled = QuotaPresentation.contract(["argonStatus":["availability":"disabled", "quotaState":"not_reported"]])
        check(enDisabled.argon?.placeholder == "Unavailable", "English disabled placeholder must show Unavailable")
        let enUnknown = QuotaPresentation.contract(["argonStatus":["availability":"unknown", "quotaState":"not_reported"]])
        check(enUnknown.argon?.resetText == "Unknown", "English unknown reset text must show Unknown")
        let enWeeklyOnly = QuotaPresentation.contract([
            "geminiFiveHourRemaining": 73,
            "geminiWeeklyRemaining": 73,
            "geminiFiveHourPeriodMode": "weekly_only",
            "geminiFiveHourResetCountdown": "Resets by weekly limit"
        ])
        check(enWeeklyOnly.gemini5h?.percentage == nil && enWeeklyOnly.geminiWeekly?.percentage == 73, "English weekly-only sentinel suppresses fabricated 5h quota")
        let hanRegex = "[\\u4E00-\\u9FFF]"
        let enPartialScope = InterfaceText.usageScope(scanned: 2, discovered: 3, failed: 1, skipped: 4, unknown: 5)
        check(enPartialScope.contains("2/3") && enPartialScope.range(of: hanRegex, options: .regularExpression) == nil, "English usageScope must contain no CJK leakage: \(enPartialScope)")
        check(InterfaceText.quotaMessage("HTTP 403 (#3501)").range(of: hanRegex, options: .regularExpression) == nil, "English quotaMessage must contain no CJK leakage")
        L10n.shared.setLanguage("zh-Hans", notify: false)
        check(InterfaceText.countdown("Resets in 6d 12h") == "6 天 12 小时后重置", "Chinese localized countdown must use L10n countdown keys")

        // Dynamic quotaGroups across Ultra, Pro, Free tiers
        let ultraGroupsContract = QuotaPresentation.contract([
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                [
                    "key": "gemini",
                    "displayName": "Gemini",
                    "summaryLabel": "Gemini",
                    "brands": ["gemini"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "4小时后重置"],
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "6天后重置"]
                    ]
                ],
                [
                    "key": "claude_gpt",
                    "displayName": "Claude/GPT",
                    "summaryLabel": "Claude/GPT",
                    "brands": ["claude", "gpt"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false, "resetCountdown": "5小时后重置"],
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false, "resetCountdown": "7天后重置"]
                    ]
                ]
            ]
        ])
        check(ultraGroupsContract.displayGroups.count == 2 && ultraGroupsContract.standaloneGroups.isEmpty, "Ultra quotaGroups must render only Gemini and Claude/GPT without Argon/Carbon")
        check(ultraGroupsContract.gemini5h?.percentage == 64 && ultraGroupsContract.claude5h?.percentage == 100, "quotaGroups backfills core windows")
        let ultraSummary = QuotaPresentation.menuAccountSummary([
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]]
            ]
        ])
        check(ultraSummary.contains("Gemini") && ultraSummary.contains("Claude/GPT") && !ultraSummary.contains("Argon") && !ultraSummary.contains("Carbon"), "Ultra summary must omit Argon and Carbon")

        let legacyUnifiedUltra = QuotaPresentation.contract([
            "subscription_tier": "ULTRA",
            "familyWindows": [
                "gemini": ["fiveHour": ["remaining": 0.64, "known": true], "weekly": ["remaining": 0.64, "known": true]],
                "claude": ["fiveHour": ["remaining": 1.0, "known": true], "weekly": ["remaining": 1.0, "known": true]]
            ],
            "argonStatus": ["availability": "available", "quotaState": "known", "mode": "unified", "pooledInFamily": "gemini", "remaining": 0.64],
            "carbonStatus": ["availability": "available", "quotaState": "known", "mode": "unified", "pooledInFamily": "gemini", "remaining": 0.64]
        ])
        check(legacyUnifiedUltra.displayGroups.count == 2 && legacyUnifiedUltra.standaloneGroups.isEmpty, "Unified Argon/Carbon in legacy payload must not create standalone rows")

        let proGroupsContract = QuotaPresentation.contract([
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.53, "stale": false], ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.53, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.76, "stale": false], ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.76, "stale": false]]],
                ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["gemini"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "6天后重置"]]]
            ]
        ])
        check(proGroupsContract.standaloneGroups.count == 1 && proGroupsContract.standaloneGroups[0].barTitle(for: proGroupsContract.standaloneGroups[0].windows[0]) == "Gemini 4 Argon · 每周" && proGroupsContract.standaloneGroups[0].primaryPercentage == 64, "Pro independent Argon shows real weekly period and 64%")

        let freeDisabledContract = QuotaPresentation.contract([
            "subscription_tier": "FREE",
            "familyWindows": [
                "gemini": ["model_quota": ["remaining": 1.0, "known": true]],
                "claude": ["model_quota": ["remaining": 1.0, "known": true]]
            ],
            "argonStatus": ["availability": "disabled", "quotaState": "not_reported"]
        ])
        check(freeDisabledContract.standaloneGroups.isEmpty, "Free tier disabled Argon must not appear as a standalone group")

        check(QuotaPresentation.localizedWindowLabel(period: "unspecified", label: "周期未知") == "模型配额", "Chinese unspecified window never displays 周期未知")
        L10n.shared.setLanguage("en", notify: false)
        check(QuotaPresentation.localizedWindowLabel(period: "unspecified", label: "") == "Model Quota", "English unspecified window displays Model Quota")
        L10n.shared.setLanguage("zh-Hans", notify: false)

        let fpA = QuotaPresentation.fingerprint(["subscription_tier": "PRO", "quotaGroups": [["key": "gemini"], ["key": "argon"]]])
        let fpB = QuotaPresentation.fingerprint(["subscription_tier": "ULTRA", "quotaGroups": [["key": "gemini"]]])
        check(fpA != fpB && fpA.contains("argon"), "Fingerprint reflects quotaGroups and subscription_tier changes")
        check(QuotaPresentation.inferredBrands(for: "Orchestrator (Argon)") == ["gemini"], "Orchestrator group infers gemini brand icon")
        let slugBrandPro = QuotaPresentation.contract([
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["argon"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false]]],
                ["key": "gemini-4-xenon", "displayName": "Gemini 4 Xenon", "summaryLabel": "Gemini 4 Xenon", "brands": ["gemini-4-xenon"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.9, "stale": false]]]
            ]
        ])
        check(slugBrandPro.standaloneGroups.count == 2 && slugBrandPro.standaloneGroups[0].brands == ["gemini"] && slugBrandPro.standaloneGroups[1].brands == ["gemini"], "Non-canonical standalone brand slugs normalize to canonical icon brands")
        check(QuotaPresentation.monitoredModelDisplayName("argon", accounts: []) == "Gemini 4 Argon", "Monitored model display name resolves argon")

        // Per-tier adaptive monitored scope choices, fallback mapping, and disambiguation subtitles
        let ultraAccPayload: [String: Any] = [
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]]
            ]
        ]
        let proAccPayload: [String: Any] = [
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.53, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.76, "stale": false]]],
                ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["gemini"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false]]]
            ]
        ]
        let freeAccPayload: [String: Any] = [
            "subscription_tier": "FREE",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false]]]
            ]
        ]

        let proChoices = QuotaPresentation.monitoredScopeChoices(for: proAccPayload)
        check(proChoices.filter { !$0.isSeparator }.map(\.title) == ["全部主力模型", "Gemini 全系（含 Argon）", "Gemini（基础池）", "Claude/GPT", "Gemini 4 Argon"], "Pro monitored choices show combined + base + argon labels")
        check(proChoices.contains(where: { $0.isSeparator }), "Pro monitored choices include separator")
        check(QuotaPresentation.effectiveMonitoredModelKey("argon", activeAccount: proAccPayload) == "argon", "Pro preserves argon selection")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "all", activeAccount: proAccPayload).contains("不受 Argon 独立周限额影响"), "Pro all subtitle clarifies Argon exclusion")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini_all", activeAccount: proAccPayload).contains("同时盯住基础 Gemini 与独立 Argon"), "Pro gemini_all subtitle clarifies combined tracking")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: proAccPayload).contains("不含独立计费的 Argon"), "Pro base gemini subtitle clarifies Argon exclusion")
        check(QuotaPresentation.monitoredModelDisplayName("gemini", activeAccount: proAccPayload) == "Gemini（基础池）", "Pro display name clarifies base Gemini pool")

        let ultraChoices = QuotaPresentation.monitoredScopeChoices(for: ultraAccPayload)
        check(ultraChoices.filter { !$0.isSeparator }.map(\.title) == ["全部可用模型", "Gemini", "Claude/GPT"], "Ultra monitored choices omit Argon and redundant Gemini All")
        check(QuotaPresentation.effectiveMonitoredModelKey("argon", activeAccount: ultraAccPayload) == "gemini", "Ultra remaps argon to shared gemini pool")
        check(QuotaPresentation.effectiveMonitoredModelKey("gemini_all", activeAccount: ultraAccPayload) == "gemini", "Ultra remaps gemini_all to shared gemini pool")
        check(QuotaPresentation.pooledUltraGeminiModelNames(ultraAccPayload).isEmpty, "Ultra without member evidence must not assume Argon/Carbon")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: ultraAccPayload) == "仅监测当前 Ultra 账号的 Gemini 共享配额池", "Ultra gemini subtitle uses neutral copy without member evidence")
        check(QuotaPresentation.monitoredModelDisplayName("argon", activeAccount: ultraAccPayload) == "Gemini", "Ultra display name resolves argon to Gemini")
        var ultraWithOnlyOrchestrator = ultraAccPayload
        ultraWithOnlyOrchestrator["models"] = [
            ["name": "gemini-pro-orchestrator-neon", "model_id": "gemini-pro-orchestrator-neon", "display_name": "Orchestrator (Neon)", "disabled": false]
        ]
        check(!QuotaPresentation.pooledUltraGeminiModelNames(ultraWithOnlyOrchestrator).contains("Neon"), "Orchestrator meta-models must be excluded from pooledUltraGeminiModelNames")
        var ultraWithDescriptionPayload = ultraAccPayload
        ultraWithDescriptionPayload["quotaGroups"] = [
            [
                "key": "gemini",
                "displayName": "Gemini",
                "description": "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Gemini 3.8 Flash",
                "summaryLabel": "Gemini",
                "brands": ["gemini"],
                "isStandalone": false,
                "availability": "available",
                "quotaState": "known",
                "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]
            ],
            [
                "key": "claude_gpt",
                "displayName": "Claude/GPT",
                "summaryLabel": "Claude/GPT",
                "brands": ["claude", "gpt"],
                "isStandalone": false,
                "availability": "available",
                "quotaState": "known",
                "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]
            ]
        ]
        check(QuotaPresentation.pooledUltraGeminiModelNames(ultraWithDescriptionPayload) == ["Neon", "Carbon", "Argon", "Hydrogen"], "pooledUltraGeminiModelNames dynamically extracts non-generic models from Gemini group description")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: ultraWithDescriptionPayload).contains("Neon、Carbon、Argon 与 Hydrogen 并入此共享池"), "Ultra gemini subtitle dynamically reflects models from group description")
        var ultraWithTrailingSentenceDesc = ultraWithDescriptionPayload
        ultraWithTrailingSentenceDesc["quotaGroups"] = [
            [
                "key": "gemini",
                "displayName": "Gemini",
                "description": "Models within this group: Gemini 4 Neon, Gemini 4 Argon, Gemini 3.8 Flash. Resets every 5 hours.",
                "summaryLabel": "Gemini",
                "brands": ["gemini"],
                "isStandalone": false,
                "availability": "available",
                "quotaState": "known",
                "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]
            ],
            [
                "key": "claude_gpt",
                "displayName": "Claude/GPT",
                "summaryLabel": "Claude/GPT",
                "brands": ["claude", "gpt"],
                "isStandalone": false,
                "availability": "available",
                "quotaState": "known",
                "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]
            ]
        ]
        check(QuotaPresentation.pooledUltraGeminiModelNames(ultraWithTrailingSentenceDesc) == ["Neon", "Argon"], "pooledUltraGeminiModelNames strips trailing sentences after member list without breaking decimal versions")
        var ultraWithNonMemberDesc = ultraAccPayload
        ultraWithNonMemberDesc["quotaGroups"] = [
            [
                "key": "gemini",
                "displayName": "Gemini",
                "description": "Resets at 12:30 UTC",
                "summaryLabel": "Gemini",
                "brands": ["gemini"],
                "isStandalone": false,
                "availability": "available",
                "quotaState": "known",
                "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.64, "stale": false]]
            ]
        ]
        ultraWithNonMemberDesc["models"] = [
            ["name": "gemini-4-neon", "model_id": "gemini-4-neon", "display_name": "Gemini 4 Neon", "family": "gemini", "disabled": false]
        ]
        check(QuotaPresentation.pooledUltraGeminiModelNames(ultraWithNonMemberDesc) == ["Neon"], "Non-member description with colon smoothly falls back to visible Gemini models without guessing Argon/Carbon")
        var ultraWithVisibleModels = ultraAccPayload
        ultraWithVisibleModels["models"] = [
            ["name": "gemini-4-argon", "model_id": "gemini-4-argon", "display_name": "Gemini 4 Argon", "family": "gemini", "disabled": false],
            ["name": "gemini-4-carbon", "model_id": "gemini-4-carbon", "display_name": "Gemini 4 Carbon", "family": "gemini", "disabled": false],
            ["name": "gemini-4-neon-high", "model_id": "gemini-4-neon-high", "display_name": "Gemini 4 Neon (High)", "family": "gemini", "disabled": false],
            ["name": "gemini-pro-orchestrator-nova", "model_id": "gemini-pro-orchestrator-nova", "display_name": "Orchestrator (Nova)", "family": "other", "disabled": false]
        ]
        check(QuotaPresentation.pooledUltraGeminiModelNames(ultraWithVisibleModels) == ["Argon", "Carbon", "Neon"], "pooledUltraGeminiModelNames falls back to visible non-orchestrator Gemini models")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: ultraWithVisibleModels).contains("Argon、Carbon 与 Neon 并入此共享池"), "Ultra gemini subtitle dynamically appends visible pooled Gemini models")
        check(QuotaPresentation.effectiveMonitoredModelKey("gemini-4-neon", activeAccount: ultraWithVisibleModels) == "gemini", "Ultra remaps neon to shared gemini pool")

        let freeChoices = QuotaPresentation.monitoredScopeChoices(for: freeAccPayload)
        check(freeChoices.filter { !$0.isSeparator }.map(\.title) == ["全部可用模型", "Gemini", "Claude/GPT"], "Free monitored choices expose only available core pools")
        check(QuotaPresentation.effectiveMonitoredModelKey("argon", activeAccount: freeAccPayload) == "gemini", "Free remaps disabled argon to base gemini")
        check(QuotaPresentation.monitoredScopeSubtitle(for: "all", activeAccount: freeAccPayload).contains("免费账号"), "Free all subtitle clarifies free account pools")

        // v1.1.3 ModelUsageFold.foldThinkingVariants contract assertions
        let thinkingSuffixCases: [(String, String)] = [
            ("claude-opus-4-6-low", "claude-opus-4-6"),
            ("claude-opus-4-6-medium", "claude-opus-4-6"),
            ("claude-opus-4-6-high", "claude-opus-4-6"),
            ("claude-opus-4-6-xhigh", "claude-opus-4-6"),
            ("claude-opus-4-6-extra-high", "claude-opus-4-6"),
            ("claude-opus-4-6-extra-low", "claude-opus-4-6"),
            ("claude-opus-4-6-thinking", "claude-opus-4-6"),
            ("claude-opus-4-6-max", "claude-opus-4-6"),
            ("claude-opus-4-6-high-thinking", "claude-opus-4-6"),
            ("gemini-3.8-flash-n", "gemini-3.8-flash-n"),
            ("gemini-3.8-flash-exp-a", "gemini-3.8-flash-exp-a"),
            ("未知模型", "未知模型"),
            ("Unknown Model", "Unknown Model")
        ]
        for (inputModel, expectedBase) in thinkingSuffixCases {
            check(ModelUsageFold.baseModelKey(for: inputModel) == expectedBase, "ModelUsageFold.baseModelKey(\(inputModel)) must be \(expectedBase)")
        }

        let foldRows: [[String: Any]] = [
            ["model": "claude-opus-4-6-low", "totalTokens": 100, "promptTokens": 60, "candidatesTokens": 40, "cachedTokens": 10, "cacheWriteTokens": 5, "requestCount": 1, "estimatedUsd": 0.10, "priced": true, "unpricedTokens": 0],
            ["model": "claude-opus-4-6-medium", "total_tokens": 200, "input_tokens": 120, "output_tokens": 80, "cached_tokens": 20, "cache_write_tokens": 10, "request_count": 2, "estimated_usd": 0.20, "priced": true, "unpriced_tokens": 0],
            ["model": "claude-opus-4-6-high", "totalTokens": 300, "promptTokens": 180, "candidatesTokens": 120, "cachedTokens": 30, "cacheWriteTokens": 15, "requestCount": 3, "estimatedUsd": 0.30, "priced": true, "unpricedTokens": 0],
            ["model": "claude-opus-4-6-xhigh", "totalTokens": 400, "promptTokens": 240, "candidatesTokens": 160, "cachedTokens": 40, "cacheWriteTokens": 20, "requestCount": 4, "estimatedUsd": 0.40, "priced": true, "unpricedTokens": 0],
            ["model": "claude-opus-4-6-extra-high", "totalTokens": 500, "promptTokens": 300, "candidatesTokens": 200, "cachedTokens": 50, "cacheWriteTokens": 25, "requestCount": 5, "estimatedUsd": 0.50, "priced": true, "unpricedTokens": 0],
            ["model": "claude-opus-4-6-extra-low", "totalTokens": 600, "promptTokens": 360, "candidatesTokens": 240, "cachedTokens": 60, "cacheWriteTokens": 30, "requestCount": 6, "estimatedUsd": 0.60, "priced": true, "unpricedTokens": 0],
            ["model": "claude-opus-4-6-thinking", "totalTokens": 700, "promptTokens": 420, "candidatesTokens": 280, "cachedTokens": 70, "cacheWriteTokens": 35, "requestCount": 7, "estimatedUsd": 0.70, "priced": true, "unpricedTokens": 0],
            ["model": "claude-opus-4-6-max", "totalTokens": 800, "promptTokens": 480, "candidatesTokens": 320, "cachedTokens": 80, "cacheWriteTokens": 40, "requestCount": 8, "estimatedUsd": 0.80, "priced": true, "unpricedTokens": 0],
            ["model": "gemini-3.8-flash-n", "totalTokens": 250, "promptTokens": 150, "candidatesTokens": 100, "requestCount": 2, "estimatedUsd": 0.05, "priced": true, "unpricedTokens": 0],
            ["model": "gemini-3.8-flash-exp-a", "totalTokens": 150, "promptTokens": 90, "candidatesTokens": 60, "requestCount": 1, "estimatedUsd": 0.03, "priced": true, "unpricedTokens": 0],
            ["model": "gemini-3.8-flash", "totalTokens": 500, "promptTokens": 300, "candidatesTokens": 200, "requestCount": 4, "estimatedUsd": 0.12, "priced": true, "unpricedTokens": 0]
        ]
        let folded = ModelUsageFold.foldThinkingVariants(foldRows)
        check(folded.count == 4, "All 8 thinking variants fold into 1 row while -n, -exp-a, and base flash stay independent")
        check((folded[0]["model"] as? String) == "claude-opus-4-6", "Folded thinking variants expose canonical base model")
        check((folded[0]["totalTokens"] as? Int) == 3600 && (folded[0]["total_tokens"] as? Int) == 3600, "Folded total tokens sum across all 8 variants")
        check((folded[0]["promptTokens"] as? Int) == 2160 && (folded[0]["input_tokens"] as? Int) == 2160, "Folded prompt/input tokens sum across all 8 variants")
        check((folded[0]["candidatesTokens"] as? Int) == 1440 && (folded[0]["output_tokens"] as? Int) == 1440, "Folded candidates/output tokens sum across all 8 variants")
        check((folded[0]["cachedTokens"] as? Int) == 360 && (folded[0]["cached_tokens"] as? Int) == 360, "Folded cached tokens sum across all 8 variants")
        check((folded[0]["cacheWriteTokens"] as? Int) == 180 && (folded[0]["cache_write_tokens"] as? Int) == 180, "Folded cache write tokens sum across all 8 variants")
        check((folded[0]["requestCount"] as? Int) == 36 && (folded[0]["request_count"] as? Int) == 36, "Folded request count sums across all 8 variants")
        let foldedUsd = (folded[0]["estimatedUsd"] as? Double) ?? -1
        let foldedUsdSnake = (folded[0]["estimated_usd"] as? Double) ?? -1
        check(abs(foldedUsd - 3.60) < 1e-9 && abs(foldedUsdSnake - 3.60) < 1e-9, "Folded USD cost sums across all 8 variants")
        check((folded[0]["priced"] as? Bool) == true && (folded[0]["partiallyPriced"] as? Bool) == false, "Fully priced folded row keeps priced=true and partiallyPriced=false")
        check((folded[1]["model"] as? String) == "gemini-3.8-flash-n" && (folded[1]["totalTokens"] as? Int) == 250 && (folded[1]["requestCount"] as? Int) == 2, "-n variant must stay as an independent row")
        check((folded[2]["model"] as? String) == "gemini-3.8-flash-exp-a" && (folded[2]["totalTokens"] as? Int) == 150 && (folded[2]["requestCount"] as? Int) == 1, "-exp-a variant must stay as an independent row")
        check((folded[3]["model"] as? String) == "gemini-3.8-flash" && (folded[3]["totalTokens"] as? Int) == 500, "Base flash row remains unaffected by -n and -exp-a rows")

        let mixedPricingFolded = ModelUsageFold.foldThinkingVariants([
            ["model": "gemini-4-neon-high", "totalTokens": 1000, "requestCount": 2, "estimatedUsd": 0.75, "priced": true, "unpricedTokens": 0],
            ["model": "gemini-4-neon-thinking", "totalTokens": 500, "requestCount": 1, "estimatedUsd": 0.0, "priced": false, "unpricedTokens": 500, "pricingStatus": "expired"],
            ["model": "gemini-4-unpriced-low", "totalTokens": 300, "requestCount": 1, "estimatedUsd": 0.0, "priced": false, "unpricedTokens": 300],
            ["model": "gemini-4-unpriced-high", "totalTokens": 200, "requestCount": 1, "estimatedUsd": 0.0, "priced": false, "unpricedTokens": 200]
        ])
        check(mixedPricingFolded.count == 2, "Mixed priced/unpriced and fully unpriced groups fold separately")
        let mixedRow = mixedPricingFolded[0]
        check((mixedRow["model"] as? String) == "gemini-4-neon" && (mixedRow["totalTokens"] as? Int) == 1500 && (mixedRow["requestCount"] as? Int) == 3, "Mixed pricing folded row aggregates tokens and requests")
        check(abs(((mixedRow["estimatedUsd"] as? Double) ?? -1) - 0.75) < 1e-9 && (mixedRow["unpricedTokens"] as? Int) == 500 && (mixedRow["unpriced_tokens"] as? Int) == 500, "Mixed pricing folded row preserves priced USD and unpriced tokens")
        check((mixedRow["priced"] as? Bool) == false && (mixedRow["partiallyPriced"] as? Bool) == true && (mixedRow["pricingStatus"] as? String) == "expired", "Mixed priced/unpriced fold marks partiallyPriced=true, priced=false, and propagates expired status")
        let unpricedRow = mixedPricingFolded[1]
        check((unpricedRow["model"] as? String) == "gemini-4-unpriced" && (unpricedRow["priced"] as? Bool) == false && (unpricedRow["partiallyPriced"] as? Bool) == false && (unpricedRow["unpricedTokens"] as? Int) == 500, "Fully unpriced fold marks priced=false and partiallyPriced=false")

        let singleFolded = ModelUsageFold.foldThinkingVariants([
            ["model": "claude-sonnet-4-6-extra-low", "totalTokens": 120, "requestCount": 1]
        ])
        check(singleFolded.count == 1 && (singleFolded[0]["model"] as? String) == "claude-sonnet-4-6", "Single-row fold still normalizes thinking suffix")

        // v1.1.3 LiveStatus parsing contract assertions (pricingRevision, oauthClientConfigured, debug-port-missing)
        let defaultStatus = LiveStatus()
        check(defaultStatus.pricingRevision == "" && defaultStatus.oauthClientConfigured == false, "Default LiveStatus initializes empty pricingRevision and oauthClientConfigured=false")

        let connectedStatus = LiveStatus([
            "mode": "connected",
            "languageMode": "zh",
            "translationEnabled": true,
            "pricingRevision": "feed-20261119-sha",
            "oauthClientConfigured": true,
            "accountsRevision": 7,
            "activeAccountEmail": "active@example.test",
            "liveAccountEmail": "live@example.test"
        ])
        check(connectedStatus.pricingRevision == "feed-20261119-sha", "LiveStatus parses pricingRevision")
        check(connectedStatus.oauthClientConfigured == true, "LiveStatus parses oauthClientConfigured=true")
        check(connectedStatus.accountsRevision == "7" && connectedStatus.enabled == true && connectedStatus.color == .systemGreen, "Connected LiveStatus parses accountsRevision, enabled state, and green indicator")

        L10n.shared.setLanguage("zh-Hans", notify: false)
        let debugPortMissingZh = LiveStatus([
            "mode": "debug-port-missing",
            "translationEnabled": true,
            "pricingRevision": "rev-debug",
            "oauthClientConfigured": false
        ])
        check(debugPortMissingZh.enabled == false, "debug-port-missing must force enabled=false even when translationEnabled=true")
        check(debugPortMissingZh.title == "未开启调试端口", "Chinese debug-port-missing title matches L10n asset")
        check(debugPortMissingZh.color == .systemOrange, "debug-port-missing indicator color must be systemOrange")
        check(debugPortMissingZh.pricingRevision == "rev-debug" && debugPortMissingZh.oauthClientConfigured == false, "debug-port-missing retains pricingRevision and oauthClientConfigured=false")

        L10n.shared.setLanguage("en", notify: false)
        let debugPortMissingEn = LiveStatus(["mode": "debug-port-missing", "locale": "en", "translationEnabled": true])
        check(debugPortMissingEn.enabled == false && debugPortMissingEn.title == "Debug Port Not Enabled" && debugPortMissingEn.color == .systemOrange, "English debug-port-missing status maps cleanly")
        L10n.shared.setLanguage("zh-Hans", notify: false)

        // Reset time parsing, live local countdown, and overdue reset detection
        let nowRef = Date(timeIntervalSince1970: 1_800_000_000)
        let overdueIso = ISO8601DateFormatter().string(from: nowRef.addingTimeInterval(-30))
        let future5hIso = ISO8601DateFormatter().string(from: nowRef.addingTimeInterval(4 * 3600 + 42 * 60 + 10))
        let overdueContract = QuotaPresentation.contract([
            "quotaGroups": [
                [
                    "key": "gemini",
                    "displayName": "Gemini",
                    "brands": ["gemini"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        [
                            "id": "5h",
                            "period": "5h",
                            "label": "5 小时",
                            "known": true,
                            "remaining": 0.6,
                            "stale": false,
                            "resetCountdown": "1 分钟后重置",
                            "resetTime": overdueIso
                        ],
                        [
                            "id": "weekly",
                            "period": "weekly",
                            "label": "每周",
                            "known": true,
                            "remaining": 0.51,
                            "stale": false,
                            "resetCountdown": "4天 13小时后重置",
                            "resetTime": future5hIso
                        ]
                    ]
                ]
            ]
        ])
        check(overdueContract.hasOverdueKnownWindow(at: nowRef), "Contract detects overdue resetTime even when cached stale flag was false")
        let overdueWin = overdueContract.quotaGroups[0].windows[0]
        check(overdueWin.effectiveStale(at: nowRef) == true, "Overdue resetDate turns effectiveStale to true")
        check(overdueWin.effectiveResetText(at: nowRef).contains("数据已过期"), "Overdue window surfaces stale label locally")
        let freshWin = overdueContract.quotaGroups[0].windows[1]
        check(freshWin.effectiveStale(at: nowRef) == false, "Future resetDate stays fresh")
        check(freshWin.effectiveResetText(at: nowRef).contains("4小时 42分后重置"), "Future resetDate computes live countdown locally")

        // Antigravity 2.34.0 Orchestrator meta-model guard: legacy polluted payloads must NEVER produce standalone pools
        check(QuotaPresentation.isOrchestratorMetaModel(id: "gemini-pro-coordinator"), "Detects gemini-pro-coordinator")
        check(QuotaPresentation.isOrchestratorMetaModel(id: "gemini-pro-orchestrator"), "Detects gemini-pro-orchestrator")
        check(QuotaPresentation.isOrchestratorMetaModel(id: "gemini-pro-orchestrator-neon"), "Detects gemini-pro-orchestrator-neon")
        check(QuotaPresentation.isOrchestratorMetaModel(displayName: "Orchestrator (Neon)"), "Detects Orchestrator (Neon) display name")
        check(QuotaPresentation.isOrchestratorMetaModel(displayName: "Orchestrator Neon"), "Detects Orchestrator Neon display name")
        check(!QuotaPresentation.isOrchestratorMetaModel(id: "gemini-4-neon", displayName: "Gemini 4 Neon"), "Does not misclassify Gemini 4 Neon as orchestrator")
        check(!QuotaPresentation.isOrchestratorMetaModel(id: "nova-models", displayName: "Nova Models"), "Does not misclassify Nova Models as orchestrator")

        let legacyOrchestratorPolluted = QuotaPresentation.contract([
            "subscription_tier": "ULTRA",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "description": "Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.98, "stale": false]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 1.0, "stale": false]]],
                ["key": "gemini-pro-orchestrator-neon", "displayName": "Orchestrator (Neon)", "brands": ["gemini"], "isStandalone": true, "availability": "unknown", "quotaState": "stale", "windows": [["id": "model", "period": "unspecified", "label": "模型配额", "known": true, "remaining": 1.0, "stale": true, "resetCountdown": "4小时 15分后重置"]]]
            ],
            "standaloneModels": [
                ["key": "gemini-pro-orchestrator-neon", "displayName": "Orchestrator (Neon)", "availability": "unknown", "quotaState": "stale", "remaining": 1.0, "period": "unspecified"]
            ],
            "models": [
                ["name": "gemini-pro-orchestrator-neon", "model_id": "gemini-pro-orchestrator-neon", "display_name": "Orchestrator (Neon)", "family": "other", "own_percentage": 100, "disabled": false],
                ["name": "gemini-4-neon-high", "model_id": "gemini-4-neon-high", "display_name": "Gemini 4 Neon (High)", "family": "other", "own_percentage": 98, "disabled": false]
            ]
        ])
        check(legacyOrchestratorPolluted.displayGroups.count == 2 && legacyOrchestratorPolluted.standaloneGroups.isEmpty && legacyOrchestratorPolluted.standaloneModels.isEmpty, "Polluted Orchestrator (Neon) payload must produce zero standalone pools")

        let legacyNoGroupsOrchestrator = QuotaPresentation.contract([
            "familyWindows": [
                "gemini": ["fiveHour": ["remaining": 0.98, "known": true, "stale": false]],
                "claude": ["fiveHour": ["remaining": 1.0, "known": true, "stale": false]]
            ],
            "models": [
                ["name": "gemini-pro-orchestrator-neon", "model_id": "gemini-pro-orchestrator-neon", "display_name": "Orchestrator (Neon)", "family": "other", "own_percentage": 100, "disabled": false],
                ["name": "gemini-4-xenon-high", "model_id": "gemini-4-xenon-high", "display_name": "Gemini 4 Xenon", "family": "other", "own_percentage": 85, "disabled": false]
            ]
        ])
        check(legacyNoGroupsOrchestrator.standaloneGroups.isEmpty && legacyNoGroupsOrchestrator.standaloneModels.isEmpty, "Swift must not invent standalone pools from rawModels when standaloneModels is absent")

        // Future unknown multi-window standalone groups (5h + weekly + daily) with live resetTime countdowns
        let futureDailyIso = ISO8601DateFormatter().string(from: nowRef.addingTimeInterval(12 * 3600 + 15 * 60 + 5))
        let futureWeeklyIso = ISO8601DateFormatter().string(from: nowRef.addingTimeInterval(3 * 24 * 3600 + 6 * 3600 + 30))
        let futureStandalonePayload: [String: Any] = [
            "subscription_tier": "PRO",
            "quotaGroups": [
                ["key": "gemini", "displayName": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.8, "stale": false, "resetTime": future5hIso]]],
                ["key": "claude_gpt", "displayName": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.9, "stale": false, "resetTime": future5hIso]]],
                [
                    "key": "nova-models",
                    "displayName": "Nova Models",
                    "description": "Models within this group: Nova Pro, Nova Lite",
                    "brands": ["nova"],
                    "isStandalone": true,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.75, "stale": false, "resetCountdown": "旧文本", "resetTime": future5hIso],
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.45, "stale": false, "resetCountdown": "旧周文本", "resetTime": futureWeeklyIso]
                    ]
                ],
                [
                    "key": "pulse-daily",
                    "displayName": "Pulse Daily",
                    "brands": [],
                    "isStandalone": true,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "daily", "period": "daily", "label": "每日", "known": true, "remaining": 0.62, "stale": false, "resetCountdown": "旧日文本", "resetTime": futureDailyIso]
                    ]
                ]
            ]
        ]
        let futureStandaloneContract = QuotaPresentation.contract(futureStandalonePayload)
        check(futureStandaloneContract.standaloneGroups.count == 2, "Preserves multiple future official standalone groups")
        let novaGroup = futureStandaloneContract.standaloneGroups[0]
        check(novaGroup.displayName == "Nova Models" && novaGroup.description == "Models within this group: Nova Pro, Nova Lite" && novaGroup.windows.count == 2, "Nova Models preserves description and both 5h and weekly windows")
        check(novaGroup.barTitle(for: novaGroup.windows[0]) == "Nova Models · 5 小时" && novaGroup.barTitle(for: novaGroup.windows[1]) == "Nova Models · 每周", "Multi-window standalone group renders period-qualified bar titles")
        check(novaGroup.windows[0].effectiveResetText(at: nowRef).contains("4小时 42分后重置"), "Standalone 5h window computes live countdown from resetTime")
        check(novaGroup.windows[1].effectiveResetText(at: nowRef).contains("3天 6小时后重置"), "Standalone weekly window computes live countdown from resetTime")
        let pulseGroup = futureStandaloneContract.standaloneGroups[1]
        check(pulseGroup.windows.count == 1 && pulseGroup.windows[0].localizedLabel == "每日" && pulseGroup.barTitle(for: pulseGroup.windows[0]) == "Pulse Daily · 每日", "Daily standalone window renders localized Chinese daily label")
        check(pulseGroup.windows[0].effectiveResetText(at: nowRef).contains("12小时 15分后重置"), "Standalone daily window computes live countdown from resetTime")
        L10n.shared.setLanguage("en", notify: false)
        check(pulseGroup.windows[0].localizedLabel == "Daily" && pulseGroup.barTitle(for: pulseGroup.windows[0]) == "Pulse Daily · Daily", "Daily standalone window renders localized English Daily label")
        L10n.shared.setLanguage("zh-Hans", notify: false)
        check(QuotaPresentation.inferredBrands(for: "Nova Models").isEmpty && novaGroup.brands.isEmpty, "Unknown future pool does not mislabel brands as Gemini or Claude")
        let futureChoices = QuotaPresentation.monitoredScopeChoices(for: futureStandalonePayload).filter { !$0.isSeparator }
        check(futureChoices.contains(where: { $0.key == "nova-models" && $0.title == "Nova Models" }) && futureChoices.contains(where: { $0.key == "pulse-daily" && $0.title == "Pulse Daily" }), "Dynamic future standalone groups surface in monitoredScopeChoices")

        check(ModelUsageFold.baseModelKey(for: "gemini-4-nova-tiered-high") == "gemini-4-nova", "ModelUsageFold.baseModelKey must strip -tiered-high suffix")
        let sortedFold = ModelUsageFold.sortByUsage([
            ["model": "a", "totalTokens": 100, "estimatedUsd": 1.0, "requestCount": 1],
            ["model": "b", "totalTokens": 500, "estimatedUsd": 0.5, "requestCount": 2],
            ["model": "c", "totalTokens": 500, "estimatedUsd": 2.0, "requestCount": 1]
        ])
        check(sortedFold.map { $0["model"] as? String ?? "" } == ["c", "b", "a"], "ModelUsageFold.sortByUsage must sort by totalTokens desc then estimatedUsd desc")

        // Standby cooling & cooldown-elapsed plain-language reset text
        let standbyOverduePayload: [String: Any] = [
            "standbyRefreshStatus": [
                "mode": "snapshot_cooldown_elapsed",
                "hasLocalOAuthClient": false,
                "canBackgroundRefresh": false,
                "cooldownElapsedFamilies": ["gemini"]
            ],
            "quotaGroups": [
                [
                    "key": "gemini",
                    "displayName": "Gemini",
                    "brands": ["gemini"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        [
                            "id": "5h",
                            "period": "5h",
                            "label": "5 小时",
                            "known": true,
                            "remaining": 0.25,
                            "stale": true,
                            "resetCountdown": "重置时间已过",
                            "resetTime": overdueIso
                        ],
                        [
                            "id": "weekly",
                            "period": "weekly",
                            "label": "每周",
                            "known": true,
                            "remaining": 0.55,
                            "stale": true,
                            "resetCountdown": "旧文本",
                            "resetTime": future5hIso
                        ]
                    ]
                ]
            ]
        ]
        let standbyContract = QuotaPresentation.contract(standbyOverduePayload)
        check(standbyContract.standbyMode == "snapshot_cooldown_elapsed", "Contract parses standbyRefreshStatus.mode")
        let standbyOverdueWin = standbyContract.quotaGroups[0].windows[0]
        let standbyFutureWin = standbyContract.quotaGroups[0].windows[1]
        check(standbyOverdueWin.effectiveResetText(at: nowRef, standbyMode: "snapshot_cooldown_elapsed", compact: true) == "预计已重置", "Compact overdue standby window shows 预计已重置")
        check(standbyOverdueWin.effectiveResetText(at: nowRef, standbyMode: "snapshot_cooldown_elapsed", compact: false) == "预计已重置 · 切换后更新", "Wide overdue standby window shows 预计已重置 · 切换后更新")
        check(standbyOverdueWin.effectiveResetText(at: nowRef) == "预计已重置 · 切换后更新", "Default effectiveResetText uses contract standbyMode")
        let coolingCleanText = standbyFutureWin.effectiveResetText(at: nowRef, standbyMode: "snapshot_cooling", compact: false)
        check(coolingCleanText.contains("4小时 42分后重置") && !coolingCleanText.contains("数据已过期"), "Future standby snapshot window keeps clean countdown without 数据已过期")
        L10n.shared.setLanguage("en", notify: false)
        check(standbyOverdueWin.effectiveResetText(at: nowRef, standbyMode: "snapshot_cooldown_elapsed", compact: true) == "Likely reset", "English compact overdue standby window shows Likely reset")
        check(standbyOverdueWin.effectiveResetText(at: nowRef, standbyMode: "snapshot_cooldown_elapsed", compact: false) == "Likely reset · Syncs on switch", "English wide overdue standby window shows Likely reset · Syncs on switch")
        L10n.shared.setLanguage("zh-Hans", notify: false)

        print("\(assertionCount) native quota assertions passed")
    }
}
