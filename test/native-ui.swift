import Cocoa

@main struct NativeUIFixture {
    static var assertionCount = 0
    static func check(_ condition: Bool, _ message: String) {
        assertionCount += 1
        if !condition { FileHandle.standardError.write(Data((message+"\n").utf8)); exit(1) }
    }
    static func assertNoVisibleWindowsOnScreen(_ context: String = "") {
        guard Assistant.headlessOffscreenUI else { return }
        let pid = Int(getpid())
        let list = (CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]]) ?? []
        let visible = list.filter { info in
            guard (info[kCGWindowOwnerPID as String] as? Int) == pid else { return false }
            let alpha = (info[kCGWindowAlpha as String] as? Double) ?? 1.0
            guard alpha > 0.0 else { return false }
            if let bounds = info[kCGWindowBounds as String] as? [String: Any],
               let w = bounds["Width"] as? Double,
               let h = bounds["Height"] as? Double {
                return w > 0 && h > 0
            }
            return true
        }
        if !visible.isEmpty {
            let prefix = context.isEmpty ? "" : "[\(context)] "
            check(false, "\(prefix)Headless UI test leaked visible window(s) on screen: \(visible)")
        }
    }
    static func makeHeadlessHostWindow(width: CGFloat, height: CGFloat) -> NSWindow {
        let win = NSWindow(
            contentRect: NSRect(x: -24000, y: -24000, width: width, height: height),
            styleMask: [.titled],
            backing: .buffered,
            defer: false
        )
        Assistant.configureHeadlessWindowIfNeeded(win)
        return win
    }
    static func pump(_ duration: TimeInterval = 0.02) {
        let safeDuration = max(0.005, duration)
        let end = Date().addingTimeInterval(safeDuration)
        let tick = min(0.005, safeDuration)
        var tickCount = 0
        repeat {
            let remaining = end.timeIntervalSinceNow
            let step = max(0.001, min(tick, remaining > 0 ? remaining : 0.002))
            RunLoop.main.run(until: Date().addingTimeInterval(step))
            tickCount += 1
            if tickCount == 1 {
                assertNoVisibleWindowsOnScreen("pump-first-tick")
            }
        } while tickCount < 2 || Date() < end
        assertNoVisibleWindowsOnScreen("pump-end")
    }
    static func waitForSheetDetach(on hostWindow: NSWindow, description: String) {
        pump()
        waitUntil(step: 0.01, description: description) {
            hostWindow.activeSheetWindow == nil && hostWindow.attachedSheet == nil
        }
    }
    @discardableResult
    static func waitUntil(
        timeout: TimeInterval = {
            if let custom = ProcessInfo.processInfo.environment["GRAVITYBOX_CI_TIMEOUT"], let val = TimeInterval(custom), val > 0 {
                return val
            }
            let isCI = ProcessInfo.processInfo.environment["CI"].map { !$0.isEmpty && $0 != "0" && $0.lowercased() != "false" } ?? false
            return isCI ? 10.0 : 3.0
        }(),
        step: TimeInterval = 0.05,
        description: String = "condition",
        condition: () -> Bool
    ) -> Bool {
        if condition() { return true }
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            RunLoop.main.run(mode: .default, before: Date().addingTimeInterval(step))
            assertNoVisibleWindowsOnScreen("waitUntil:\(description)")
            if condition() { return true }
        }
        let satisfied = condition()
        check(satisfied, "Timed out waiting for \(description) after \(timeout)s")
        return satisfied
    }
    static func capture(_ view: NSView, _ url: URL) throws {
        view.layoutSubtreeIfNeeded()
        guard let rep = view.bitmapImageRepForCachingDisplay(in:view.bounds) else { fatalError("No bitmap") }
        view.cacheDisplay(in:view.bounds,to:rep)
        try rep.representation(using:.png,properties:[:])!.write(to:url)
    }
    static func allTextValues(_ v: NSView) -> [String] {
        var values: [String] = []
        if let tf = v as? NSTextField { values.append(tf.stringValue) }
        if let btn = v as? NSButton { values.append(btn.title) }
        if let pop = v as? NSPopUpButton { values.append(contentsOf: pop.itemTitles) }
        for sub in v.subviews { values.append(contentsOf: allTextValues(sub)) }
        return values
    }
    static func visibleTextValues(_ v: NSView) -> [String] {
        guard !v.isHidden else { return [] }
        var values: [String] = []
        if let tf = v as? NSTextField { values.append(tf.stringValue) }
        if let btn = v as? NSButton { values.append(btn.title) }
        if let pop = v as? NSPopUpButton { values.append(contentsOf: pop.itemTitles) }
        for sub in v.subviews { values.append(contentsOf: visibleTextValues(sub)) }
        return values
    }
    static func main() throws {
        let application = NSApplication.shared
        let interactive = CommandLine.arguments.contains("--interactive")
        Assistant.headlessOffscreenUI = !interactive
        application.setActivationPolicy(interactive ? .regular : .prohibited)
        let state = URL(fileURLWithPath:CommandLine.arguments[1]), output = URL(fileURLWithPath:CommandLine.arguments[2])
        try FileManager.default.createDirectory(at:output,withIntermediateDirectories:true)
        L10n.shared.setLanguage("zh-Hans", notify: false)
        let assistant = Assistant(state:state)
        assistant.configuration = try ConfigurationStore(state:state)
        assistant.configuration.value.navigationVersion = 5
        assistant.configuration.value.appLanguage = "zh-Hans"
        assistant.bridge = BackendBridge(resources:state,state:state)
        assistant.reachable = true
        var fixtureStatus: [String:Any] = ["mode":"adaptive","windows":1,"entries":4300,"appVersion":"2.25.0","liveAccountEmail":"alex@example.invalid","activeAccountEmail":"alex@example.invalid","accountsRevision":"fixture","pid":-1,"configuredLanguage":"zh-Hans","locale":"zh-Hans","translationEnabled":true]
        let status = fixtureStatus
        assistant.statusValue = LiveStatus(fixtureStatus)
        func bucket(_ percent: Double, reset: String = "2小时后重置") -> [String:Any] {
            ["remaining":percent/100,"known":true,"stale":false,"source":"live","observedAt":Date().timeIntervalSince1970,"resetCountdown":reset]
        }
        func account(_ id:String, _ name:String, _ email:String, _ current:Bool) -> [String:Any] {
            let windows:[String:Any] = ["gemini":["fiveHour":bucket(91),"weekly":bucket(33)],"claude":["fiveHour":bucket(current ? 0 : 100),"weekly":bucket(48)]]
            return ["id":id,"name":name,"email":email,"subscription_tier":"PRO","revision":id,"familyWindows":windows,"argonStatus":["availability":"available","quotaState":"known","period":"weekly","remaining":0.008],"quota":["last_updated":Date().timeIntervalSince1970,"source":"live"],"models":[]]
        }
        var accounts = [account("a","Alex","alex@example.invalid",true),account("b","Bob","bob@example.invalid",false),account("c","Charlie","charlie@example.invalid",false)]
        accounts[2]["subscription_tier"] = "FREE"
        accounts[2]["familyWindows"] = ["gemini":["weekly":bucket(100,reset:"6天23小时后重置")],"claude":["weekly":bucket(100,reset:"6天23小时后重置")]]
        accounts[2]["familyModelQuota"] = ["gemini":bucket(100,reset:"4小时59分后重置"),"claude":bucket(100,reset:"6天23小时后重置")]
        var activeId = "a", switches = 0, preflightState = "safe", lastLanguageCommand: String? = nil, lastHudCommandEnabled: Bool? = nil
        assistant.activeAccountId = activeId; assistant.cachedAccounts = accounts
        let models:[[String:Any]] = [
            ["model":"gemini-3.8-flash-n","totalTokens":78_500_000,"promptTokens":3_100_000,"cachedTokens":75_240_000,"candidatesTokens":160_000,"requestCount":611,"estimatedUsd":10.77,"priced":true,"pricingStatus":"historical"],
            ["model":"gemini-3.8-flash-exp-a","totalTokens":12_400_000,"promptTokens":700_000,"cachedTokens":11_630_000,"candidatesTokens":70_000,"requestCount":84,"estimatedUsd":6.40,"priced":true,"pricingStatus":"historical"],
            ["model":"claude-opus-5-5-medium","totalTokens":4_500_000,"promptTokens":500_000,"cachedTokens":3_930_000,"candidatesTokens":70_000,"requestCount":18,"estimatedUsd":5.25,"priced":true,"pricingStatus":"historical"],
            ["model":"claude-sonnet-4-6","totalTokens":2_800_000,"promptTokens":400_000,"cachedTokens":2_390_000,"candidatesTokens":10_000,"requestCount":43,"estimatedUsd":1.36,"priced":true]
        ]
        let todayHourly:[[String:Any]] = [
            ["hour":"2026-10-23 09:00","total_tokens":6200000],
            ["hour":"2026-10-23 10:00","total_tokens":14800000],
            ["hour":"2026-10-23 11:00","total_tokens":11400000],
            ["hour":"2026-10-23 14:00","total_tokens":19600000],
            ["hour":"2026-10-23 15:00","total_tokens":16200000],
            ["hour":"2026-10-23 16:00","total_tokens":12500000],
            ["hour":"2026-10-23 20:00","total_tokens":9800000],
            ["hour":"2026-10-23 21:00","total_tokens":7700000]
        ]
        let conservedTokens = models.reduce(0) { $0 + ($1["totalTokens"] as? Int ?? 0) }
        let conservedPrompt = models.reduce(0) { $0 + ($1["promptTokens"] as? Int ?? 0) }
        let conservedCached = models.reduce(0) { $0 + ($1["cachedTokens"] as? Int ?? 0) }
        let conservedCandidates = models.reduce(0) { $0 + ($1["candidatesTokens"] as? Int ?? 0) }
        let conservedRequests = models.reduce(0) { $0 + ($1["requestCount"] as? Int ?? 0) }
        let conservedUsd = ((models.reduce(0.0) { $0 + ($1["estimatedUsd"] as? Double ?? 0) }) * 100.0).rounded() / 100.0
        let conservedHourlyTokens = todayHourly.reduce(0) { $0 + ($1["total_tokens"] as? Int ?? 0) }
        for m in models {
            let p = m["promptTokens"] as? Int ?? 0
            let c = m["cachedTokens"] as? Int ?? 0
            let o = m["candidatesTokens"] as? Int ?? 0
            let tot = m["totalTokens"] as? Int ?? 0
            check(p + c + o == tot, "P1-24: model \(m["model"] ?? "") token breakdown must equal totalTokens")
        }
        check(conservedPrompt + conservedCached + conservedCandidates == conservedTokens, "P1-24: conserved totals breakdown must equal conserved totalTokens")
        check(conservedHourlyTokens == conservedTokens, "P1-24: todayHourly sum (\(conservedHourlyTokens)) must equal conserved totalTokens (\(conservedTokens))")
        let totals:[String:Any] = ["totalTokens":conservedTokens,"promptTokens":conservedPrompt,"cachedTokens":conservedCached,"candidatesTokens":conservedCandidates,"requestCount":conservedRequests,"estimatedUsd":conservedUsd,"pricedModels":models.count,"unpricedModels":0,"databasesScanned":343,"databasesDiscovered":343,"availability":"complete","scanScopeDescription":"全部 343 个会话数据库","lastScannedAt":Date().timeIntervalSince1970]
        assistant.bridge.fixtureReply = { payload in
            switch payload["command"] as? String {
            case "status": return ["ok":true,"status":fixtureStatus,"tasks":[],"taskRevision":0]
            case "account_list": return ["ok":true,"activeId":activeId,"accounts":accounts,"pendingSwitch":false]
            case "auto_switch_get": return ["ok":true,"config":["enabled":false,"strategy":"priority","monitored_model":"all"]]
            case "dashboard_summary": return ["ok":true,"accounts":accounts.first(where:{$0["id"] as? String == activeId})!.merging(["activeName":"Alex","activeEmail":"alex@example.invalid","activeTier":"PRO","liveAccountEmail":"alex@example.invalid","isLiveVerified":true]) { _, new in new },"usage":["todayTokens":conservedTokens,"totalTokens":3000000000,"estimatedUsd":conservedUsd,"allTimeEstimatedUsd":410.25,"requestCount":conservedRequests,"totalRequestCount":27175,"todayPricedModels":models.count,"todayUnpricedModels":0,"pricedModels":models.count,"unpricedModels":0,"databasesScanned":343,"databasesDiscovered":343,"availability":"complete"]]
            case "usage_summary":
                let period = payload["period"] as? String ?? "today"
                return ["ok":true,"period":period,"snapshotId":"fixture-snapshot","summary":totals,"byModel":models,"todayHourly":todayHourly,"dailyTrends":[]]
            case "usage_events":
                let eventRows: [[String: Any]] = [
                    ["model": "gemini-3.8-flash-n", "timestamp_seconds": 1761544267, "input_tokens": 8290, "output_tokens": 374, "cached_tokens": 344104, "cache_write_tokens": 0],
                    ["model": "claude-opus-5-5-medium", "timestamp_seconds": 1761544259, "input_tokens": 6420, "output_tokens": 428, "cached_tokens": 343720, "cache_write_tokens": 0],
                    ["model": "gpt-5-turbo", "timestamp_seconds": 1761544255, "input_tokens": 5180, "output_tokens": 306, "cached_tokens": 240500, "cache_write_tokens": 0]
                ]
                return ["ok":true,"snapshot_id":"fixture-snapshot","rows":eventRows,"total":129,"scope":"全部 344 个会话数据库"]
            case "maintenance_scan":
                let reqRetention = intVal(payload, "retentionDays", fallback: 7)
                var scanEntries: [[String: Any]] = [
                    ["name": "Cache", "title": "网络与静态资源缓存", "subtitle": "界面静态资源与临时网络响应数据", "icon": "tray.full", "category": "safe", "defaultSelected": true, "bytes": 524_288_000, "fileCount": 1820, "exists": true, "clearable": true],
                    ["name": "AgentBrowserCache", "title": "浏览器沙箱加速缓存", "subtitle": "Browser 沙箱的网页与编译缓存（保留站点登录与 Cookie）", "icon": "globe", "category": "safe", "defaultSelected": true, "bytes": 324_009_984, "fileCount": 1410, "exists": true, "clearable": true],
                    ["name": "PartitionsCache", "title": "内嵌视图子分区缓存", "subtitle": "内嵌浏览器与隔离分区的静态资源及编译缓存", "icon": "square.split.2x2", "category": "safe", "defaultSelected": true, "bytes": 96_468_992, "fileCount": 420, "exists": true, "clearable": true],
                    ["name": "OrphanAgentData", "title": "已删对话残留与临时文件", "subtitle": "含 6 个已删主对话遗留的孤儿记录、崩溃日志与临时媒体", "icon": "trash.slash", "category": "safe", "defaultSelected": true, "bytes": 48_234_496, "fileCount": 192, "exists": true, "clearable": true]
                ]
                let safeSum = 993_001_472
                var statefulSum = 0
                if reqRetention <= 7 {
                    scanEntries.append(contentsOf: [
                        ["name": "AgentSubagentDatabases", "title": "历史子智能体轨迹库", "subtitle": "7 天前共 142 个后台子智能体库（清理前自动归档 Token 账单）", "icon": "arrow.triangle.branch", "category": "stateful", "defaultSelected": false, "bytes": 856_686_592, "fileCount": 142, "exists": true, "clearable": true],
                        ["name": "AgentTaskStepLogs", "title": "历史任务与步骤输出日志", "subtitle": "7 天前对话的后台终端日志、步骤输出与 scratch 草稿", "icon": "terminal", "category": "stateful", "defaultSelected": false, "bytes": 218_103_808, "fileCount": 980, "exists": true, "clearable": true]
                    ])
                    statefulSum = 1_074_790_400
                }
                let latestSnap: [String: Any] = ["id": "GravityBox-缓存-1729900800000", "timestamp": 1729900800, "totalBytes": 312_475_648, "fileCount": 3180, "snapshotPath": "/tmp/gb-snap-latest"]
                return [
                    "ok": true,
                    "token": "fixture-token",
                    "retentionDays": reqRetention,
                    "entries": scanEntries,
                    "buckets": [
                        "runtimeCache": ["id": "runtime_cache", "bytes": safeSum, "clearableBytes": safeSum, "fileCount": 3842, "available": true],
                        "historyLogs": ["id": "history_logs", "bytes": statefulSum, "clearableBytes": statefulSum, "fileCount": statefulSum > 0 ? 1122 : 0, "subagentCount": statefulSum > 0 ? 142 : 0, "retentionDays": reqRetention, "available": statefulSum > 0]
                    ],
                    "safeBytes": safeSum,
                    "statefulBytes": statefulSum,
                    "totalBytes": safeSum + statefulSum,
                    "totalFiles": 4964,
                    "protectedEntries": [
                        ["id": "workspace", "title": "工作区与核心账号凭据", "subtitle": "User/globalStorage（OAuth 令牌库 state.vscdb）、Cookies、Local Storage 与工作区配置", "icon": "folder.badge.gearshape", "bytes": 87_031_808, "fileCount": 324, "exists": true],
                        ["id": "conversations", "title": "Agent 历史对话与上下文库", "subtitle": "受保护的主对话、已归档对话、正式产物与站点会话", "icon": "bubble.left.and.bubble.right", "bytes": 1_841_640_960, "fileCount": 201, "exists": true]
                    ],
                    "protectedBytes": 1_928_672_768,
                    "snapshots": [
                        ["id": "GravityBox-缓存-1729900800000", "timestamp": 1729900800, "totalBytes": 312_475_648, "fileCount": 3180, "items": ["Cache", "AgentBrowserCache", "OrphanAgentData"], "itemTitles": ["网络与静态资源缓存", "浏览器沙箱加速缓存", "已删对话残留与临时文件"], "movedCount": 3, "restorable": true, "interrupted": false],
                        ["id": "GravityBox-缓存-1729814400000", "timestamp": 1729814400, "totalBytes": 642_252_800, "fileCount": 1120, "items": ["AgentSubagentDatabases", "AgentTaskStepLogs"], "itemTitles": ["历史子智能体轨迹库", "历史任务与步骤输出日志"], "movedCount": 2, "restorable": true, "interrupted": false]
                    ],
                    "latestRestorableSnapshot": latestSnap,
                    "running": true,
                    "browserBusy": false,
                    "scannedAt": Int(Date().timeIntervalSince1970)
                ]
            case "account_switch_preflight": return [
                "ok": preflightState != "error",
                "safe": preflightState == "safe" || preflightState == "running_idle",
                "appRunning": preflightState == "busy" || preflightState == "running_idle",
                "stableRunning": preflightState == "running_idle",
                "hasRunningTask": preflightState == "busy",
                "error": "隔离预检失败"
            ]
            case "account_switch": switches += 1; activeId = payload["id"] as? String ?? activeId; return ["ok":true,"message":"隔离事务完成"]
            case "account_recovery_info": return ["ok":true,"available":false]
            case "language_set":
                let lang = payload["language"] as? String ?? "system"
                lastLanguageCommand = lang
                let resolved = lang == "en" ? "en" : "zh-Hans"
                fixtureStatus["configuredLanguage"] = lang
                fixtureStatus["locale"] = resolved
                fixtureStatus["translationEnabled"] = resolved == "zh-Hans"
                fixtureStatus["mode"] = resolved == "zh-Hans" ? "adaptive" : "paused"
                return ["ok":true,"status":fixtureStatus]
            case "hud_set":
                let enabled = payload["enabled"] as? Bool ?? true
                lastHudCommandEnabled = enabled
                fixtureStatus["hudEnabled"] = enabled
                return ["ok":true,"status":fixtureStatus]
            default: return ["ok":true]
            }
        }
        assistant.installApplicationMenu()
        assistant.showPanel(); pump()
        guard let window = assistant.window else { fatalError("Missing window") }
        if interactive {
            window.title = "GravityBox · 隔离 UI 预览（合成数据）"
            window.setFrame(NSRect(origin:window.frame.origin,size:NSSize(width:880,height:580)),display:true)
            window.makeKeyAndOrderFront(nil); application.activate(ignoringOtherApps:true)
            withExtendedLifetime(assistant) { application.run() }
            return
        }
        // 非交互测试模式将窗口锚定在离屏坐标且不激活前台，避免测试期间在桌面闪现并切换页面
        func findViewById(_ root: NSView, _ id: String) -> NSView? {
            if root.identifier?.rawValue == id { return root }
            for sub in root.subviews {
                if let found = findViewById(sub, id) { return found }
            }
            return nil
        }
        func findFirst<T: NSView>(_ root: NSView, as type: T.Type) -> T? {
            if let match = root as? T { return match }
            for sub in root.subviews {
                if let found = findFirst(sub, as: type) { return found }
            }
            return nil
        }
        func findEnclosingBox(_ view: NSView) -> NSBox? {
            var cur: NSView? = view.superview
            while let v = cur {
                if let box = v as? NSBox { return box }
                cur = v.superview
            }
            return nil
        }
        func verifyOverviewHeaderGeometry(_ ov: DashboardPage, context: String) {
            guard let header = findViewById(ov.view, "account-identity-header"),
                  let actions = findViewById(ov.view, "account-actions") as? NSStackView,
                  let heroCard = findEnclosingBox(header) else {
                check(false, "\(context): missing overview account-identity-header / heroCard")
                return
            }
            let expectedActionsW = actions.arrangedSubviews.filter { !$0.isHidden }.reduce(CGFloat(0)) { $0 + $1.intrinsicContentSize.width }
                + CGFloat(max(0, actions.arrangedSubviews.filter { !$0.isHidden }.count - 1)) * actions.spacing
            check(abs(actions.frame.width - expectedActionsW) <= 1.0, "\(context): overview heroActions must hug button width (got \(actions.frame.width), expected \(expectedActionsW))")
            let btnRect = heroCard.convert(ov.refreshQuotaButton.bounds, from: ov.refreshQuotaButton)
            let expectedRight = heroCard.bounds.width - 14
            check(abs(btnRect.maxX - expectedRight) <= 1.0, "\(context): refreshQuotaButton must align to heroCard trailing edge (maxX=\(btnRect.maxX), expected=\(expectedRight))")
            if !ov.tierBadge.isHidden {
                let nameRect = header.convert(ov.activeAccountLabel.bounds, from: ov.activeAccountLabel)
                let tierRect = header.convert(ov.tierBadge.bounds, from: ov.tierBadge)
                let gap = tierRect.minX - nameRect.maxX
                check(gap >= 4 && gap <= 10, "\(context): tierBadge must sit beside activeAccountLabel instead of stretching right (gap=\(gap))")
            }
            if let nameFont = ov.activeAccountLabel.font, !ov.activeAccountLabel.stringValue.isEmpty {
                let neededNameW = ceil((ov.activeAccountLabel.stringValue as NSString).size(withAttributes: [.font: nameFont]).width)
                check(ov.activeAccountLabel.bounds.width >= neededNameW - 0.5, "\(context): activeAccountLabel truncated (\(ov.activeAccountLabel.bounds.width) < \(neededNameW) for '\(ov.activeAccountLabel.stringValue)')")
            }
            if !ov.activeEmailLabel.isHidden, let emailFont = ov.activeEmailLabel.font, !ov.activeEmailLabel.stringValue.isEmpty {
                let neededEmailW = ceil((ov.activeEmailLabel.stringValue as NSString).size(withAttributes: [.font: emailFont]).width)
                check(ov.activeEmailLabel.bounds.width >= neededEmailW - 0.5, "\(context): activeEmailLabel truncated (\(ov.activeEmailLabel.bounds.width) < \(neededEmailW) for '\(ov.activeEmailLabel.stringValue)')")
            }
        }
        func verifyAccountsCardsGeometry(_ page: AccountsPage, expectedCount: Int = 3, context: String) {
            check(page.cardsStack.arrangedSubviews.count == expectedCount, "\(context): expected \(expectedCount) account cards (got \(page.cardsStack.arrangedSubviews.count))")
            for (idx, boxView) in page.cardsStack.arrangedSubviews.enumerated() {
                guard let cardBox = boxView as? NSBox,
                      let header = findViewById(cardBox, "account-identity-header"),
                      let actions = findViewById(cardBox, "account-actions") as? NSStackView else {
                    continue
                }
                let visibleActions = actions.arrangedSubviews.filter { !$0.isHidden }
                check(!visibleActions.isEmpty, "\(context) card[\(idx)]: actionStack must have visible actions")
                let expectedActionsW = visibleActions.reduce(CGFloat(0)) { $0 + $1.intrinsicContentSize.width }
                    + CGFloat(max(0, visibleActions.count - 1)) * actions.spacing
                check(abs(actions.frame.width - expectedActionsW) <= 1.0, "\(context) card[\(idx)]: actionStack must hug visible buttons without absorbing empty space (got \(actions.frame.width), expected \(expectedActionsW))")
                if let lastBtn = visibleActions.last {
                    let btnRect = cardBox.convert(lastBtn.bounds, from: lastBtn)
                    let expectedRight = cardBox.bounds.width - 16
                    check(abs(btnRect.maxX - expectedRight) <= 1.0, "\(context) card[\(idx)]: trailing action must align to cardBox trailing edge (maxX=\(btnRect.maxX), expected=\(expectedRight))")
                }
                if let badge = findFirst(header, as: TierBadge.self), !badge.isHidden {
                    func allLabels(_ v: NSView) -> [NSTextField] { (v as? NSTextField).map { [$0] } ?? v.subviews.flatMap { allLabels($0) } }
                    if let nameLbl = allLabels(header).first(where: { $0.font?.pointSize ?? 0 >= 14.5 }) {
                        let nameRect = header.convert(nameLbl.bounds, from: nameLbl)
                        let badgeRect = header.convert(badge.bounds, from: badge)
                        let gap = badgeRect.minX - nameRect.maxX
                        check(gap >= 4 && gap <= 10, "\(context) card[\(idx)]: tierPill must stay beside name label (gap=\(gap))")
                        if let font = nameLbl.font, !nameLbl.stringValue.isEmpty {
                            let neededW = ceil((nameLbl.stringValue as NSString).size(withAttributes: [.font: font]).width)
                            check(nameLbl.bounds.width >= neededW - 0.5, "\(context) card[\(idx)]: account name truncated (\(nameLbl.bounds.width) < \(neededW))")
                        }
                    }
                }
            }
        }

        window.setFrameOrigin(NSPoint(x: -24000, y: -24000))
        var captures:[String] = []
        for (theme, appearance) in [("light",NSAppearance.Name.aqua),("dark",NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named:appearance)
            for size in [NSSize(width:880,height:580),NSSize(width:960,height:640),NSSize(width:1100,height:760)] {
                window.setFrame(NSRect(origin:window.frame.origin,size:size),display:true)
                for page in 0..<5 {
                    assistant.selectPage(page); pump()
                    if page == 1 {
                        waitUntil(step: 0.01, description: "\(theme)-\(Int(size.width))x\(Int(size.height)) AccountsPage to settle \(accounts.count) cards") {
                            !assistant.accountListInFlight
                                && !assistant.accountListPendingRefetch
                                && assistant.accountsPage?.activeId == activeId
                                && assistant.accountsPage?.cardsStack.arrangedSubviews.count == accounts.count
                        }
                    } else if page == 2 {
                        waitUntil(step: 0.01, description: "\(theme)-\(Int(size.width))x\(Int(size.height)) UsagePage to finish loading") {
                            assistant.usagePage?.loading == false
                        }
                    }
                    window.contentView?.layoutSubtreeIfNeeded()
                    let name = "\(theme)-\(Int(size.width))x\(Int(size.height))-\(page).png"
                    try capture(window.contentView!,output.appendingPathComponent(name)); captures.append(name)
                    check(assistant.currentPage == page,"Navigation mismatch")
                    check(window.frame.width == size.width && (window.contentView?.fittingSize.width ?? 0) <= 880, "Page \(page) exceeds 880pt minimum window width")
                    if page == 0, size.width == 880, size.height == 580, let scroll = assistant.overview?.view as? NSScrollView, let document = scroll.documentView {
                        for card in [assistant.overview!.tokenMetricCard!, assistant.overview!.costMetricCard!, assistant.overview!.requestsMetricCard!] {
                            let rect = document.convert(card.bounds, from:card)
                            check(rect.minY >= scroll.contentView.bounds.minY-1 && rect.maxY <= scroll.contentView.bounds.maxY+1, "Minimum dashboard clips a metric card")
                        }
                    }
                    if page == 0, let ov = assistant.overview {
                        verifyOverviewHeaderGeometry(ov, context: "\(theme)-\(Int(size.width))x\(Int(size.height))")
                    }
                    if page == 1, let acc = assistant.accountsPage {
                        verifyAccountsCardsGeometry(acc, context: "\(theme)-\(Int(size.width))x\(Int(size.height))-expanded")
                    }
                    if page == 2 {
                        let usage = assistant.usagePage!
                        func labels(_ view:NSView)->[NSTextField] { (view as? NSTextField).map{[$0]} ?? view.subviews.flatMap{labels($0)} }
                        for targetName in ["gemini-3.8-flash-n", "gemini-3.8-flash-exp-a", "Claude Opus 5.5"] {
                            for label in labels(usage.donutLegendStack) where label.stringValue == targetName {
                                let width = (label.stringValue as NSString).size(withAttributes:[.font:label.font!]).width
                                check(label.bounds.width >= ceil(width), "Cost legend constrains model name \(targetName) at \(Int(size.width))pt width (\(label.bounds.width) < \(ceil(width)))")
                                check(label.bounds.height < 24, "Model label \(targetName) wrapped onto multiple lines at \(Int(size.width))pt width")
                            }
                        }
                        check(usage.costTitle.stringValue == "API费用估算" || usage.costTitle.stringValue == "今日费用估算" || usage.costTitle.stringValue == "API 费用估算","Title must remain API费用估算")
                        check(usage.statusSummary.stringValue.isEmpty && usage.footerBox.isHidden,"Partial pricing footer warning must stay hidden when all models are priced")
                        check(usage.donutLegendStack.fittingSize.width <= size.width-190,"Legend exceeds page")
                    }
                }
            }
            let policy = AccountPolicySheet(app:assistant,config:["strategy":"priority","monitored_model":"gemini","reserve_percentage":10,"candidate_min_percentage":30],saved:{})
            policy.show(in:window,onDismiss:{})
            policy.window.appearance = NSAppearance(named:appearance); pump()
            let policyMenuItems = policy.modelPopup.menu?.items ?? []
            check(policyMenuItems.filter { !$0.isSeparatorItem }.map(\.title) == ["全部主力模型","Gemini 全系（含 Argon）","Gemini（基础池）","Claude/GPT","Gemini 4 Argon"], "Model popup must expose adaptive Pro options with base/combined disambiguation")
            check(policyMenuItems.count == 6 && policyMenuItems[2].isSeparatorItem, "Model popup must separate combined and single-pool sections")
            check(policy.monitoredSubLabel.stringValue == "仅监测基础 Gemini 共享池，Pro 套餐下不含独立计费的 Argon", "Initial monitored scope subtitle explains Pro base Gemini boundary")
            if let geminiAllIdx = policyMenuItems.firstIndex(where: { ($0.representedObject as? String) == "gemini_all" }) {
                policy.modelPopup.selectItem(at: geminiAllIdx)
                policy.monitoredScopeChanged()
                check(policy.monitoredSubLabel.stringValue == "同时盯住基础 Gemini 与独立 Argon 周配额，任一偏低即提示切换", "Changing monitored scope updates subtitle live")
            } else {
                check(false, "Expected gemini_all menu item")
            }
            if let geminiIdx = policyMenuItems.firstIndex(where: { ($0.representedObject as? String) == "gemini" }) {
                policy.modelPopup.selectItem(at: geminiIdx)
                policy.monitoredScopeChanged()
            }
            check(policy.strategyPopup.frame.width == policy.modelPopup.frame.width, "Policy popups must share uniform width")
            check(policy.modelPopup.frame.width >= 150 && policy.modelPopup.frame.width <= 195, "Pro policy popups must tightly fit longest option without 220pt bloat (got \(policy.modelPopup.frame.width))")
            check(policy.modelPopup.frame.width >= Design.fittedPopUpWidth(policy.modelPopup) - 0.5 && policy.strategyPopup.frame.width >= Design.fittedPopUpWidth(policy.strategyPopup) - 0.5, "Policy popups must never truncate longest option")
            check((policy.window.contentView?.frame.height ?? 999) < 395, "Policy sheet content height must hug content instead of 436pt excess gap (got \(policy.window.contentView?.frame.height ?? -1))")
            check(policy.fieldsCard.frame.height <= (groupStack(policy.fieldsCard)?.fittingSize.height ?? 0) + 34, "Policy fields card must not leave blank space below 候选准入下限 (cardH=\(policy.fieldsCard.frame.height), stackFitH=\(groupStack(policy.fieldsCard)?.fittingSize.height ?? 0))")
            var dynamicAccount = accounts[0]
            dynamicAccount["standaloneModels"] = [
                ["key":"argon","displayName":"Gemini 4 Argon","availability":"available","quotaState":"known","period":"weekly","remaining":0.008],
                ["key":"carbon","displayName":"Gemini 4 Carbon","availability":"disabled","quotaState":"not_reported","period":"weekly"],
                ["key":"xenon","displayName":"Gemini 4 Xenon","availability":"available","quotaState":"known","period":"weekly","remaining":0.85]
            ]
            assistant.cachedAccounts = [dynamicAccount]
            let dynamicPolicy = AccountPolicySheet(app:assistant,config:["strategy":"priority","monitored_model":"xenon","reserve_percentage":10,"candidate_min_percentage":30],saved:{})
            check((dynamicPolicy.modelPopup.menu?.items ?? []).filter { !$0.isSeparatorItem }.map(\.title) == ["全部主力模型","Gemini 全系模型","Gemini（基础池）","Claude/GPT","Gemini 4 Argon","Gemini 4 Xenon"], "Model popup must auto-detect active standalone models while omitting disabled ones")
            check(dynamicPolicy.modelPopup.selectedItem?.title == "Gemini 4 Xenon", "Model popup must select configured dynamic model")
            check(dynamicPolicy.monitoredSubLabel.stringValue == "仅监测当前账号独立的 Gemini 4 Xenon 配额池", "Dynamic standalone scope shows targeted subtitle")
            assistant.cachedAccounts = accounts
            for popup in [policy.strategyPopup, policy.modelPopup] {
                check(popup.focusRingType == .none && popup.cell?.focusRingType == NSFocusRingType.none, "Installed popup cell must not restore the square focus bezel")
                check(popup.cell is DesignPopUpCell, "PopUp buttons must use DesignPopUpCell so menus drop cleanly below the control")
                let origin = Design.popUpOrigin(below: popup)
                check(origin.x == 0 && origin.y == popup.bounds.maxY + 6, "Flipped popup origin must place menu 6pt below control bottom")
            }
            let unflippedProbe = NSView(frame: NSRect(x: 0, y: 0, width: 80, height: 28))
            check(Design.popUpOrigin(below: unflippedProbe) == NSPoint(x: 0, y: -6), "Unflipped anchor origin must place menu 6pt below control bottom")
            policy.window.makeFirstResponder(policy.strategyPopup); pump()
            try capture(policy.window.contentView!,output.appendingPathComponent("\(theme)-policy-popup-focused.png"))
            policy.window.makeFirstResponder(policy.reserve); pump()
            check(policy.reserve.currentEditor()?.alignment == .center, "Threshold editor changed number alignment")
            try capture(policy.window.contentView!,output.appendingPathComponent("\(theme)-policy-threshold-focused.png"))
            policy.window.makeFirstResponder(policy.candidate); pump()
            check(policy.candidate.currentEditor()?.alignment == .center, "Candidate editor changed number alignment")
            try capture(policy.window.contentView!,output.appendingPathComponent("\(theme)-policy-candidate-focused.png"))
            policy.cancel(); waitForSheetDetach(on: window, description: "AccountPolicySheet to detach")
            check(LiveStatus().oauthClientConfigured == false, "LiveStatus default oauthClientConfigured must be false")
            check(LiveStatus(["mode": "adaptive"]).oauthClientConfigured == false, "LiveStatus missing oauthClientConfigured must default to false")
            check(LiveStatus(["oauthClientConfigured": true]).oauthClientConfigured == true, "LiveStatus explicit oauthClientConfigured=true must parse")

            func findLabels(_ v: NSView) -> [NSTextField] { (v as? NSTextField).map { [$0] } ?? v.subviews.flatMap { findLabels($0) } }
            func verifyLabelNotTruncated(_ label: NSTextField, context: String) {
                check(label.lineBreakMode != .byTruncatingMiddle, "\(context) must not middle-truncate")
                if let cell = label.cell {
                    let needed = cell.cellSize(forBounds: NSRect(x: 0, y: 0, width: label.bounds.width, height: .greatestFiniteMagnitude))
                    check(label.bounds.height >= floor(needed.height) - 1, "\(context) height truncated (\(label.bounds.height) < \(needed.height))")
                }
            }

            // 1) 三卡管理账号模式（第一卡「保存当前账号」主操作 + 第二卡「导入账号」 + 第三卡「导出账号」，彻底移除 Google OAuth 登录按钮）
            let prevStatusForAdd = assistant.statusValue
            assistant.statusValue = LiveStatus(fixtureStatus)
            check(assistant.statusValue.oauthClientConfigured == false, "Fixture default status must treat oauthClientConfigured as false")
            let addSheet = AddAccountSheet(app: assistant, accountCount: 3, saved: {})
            addSheet.show(in: window, onDismiss: {})
            addSheet.window.appearance = NSAppearance(named: appearance)
            addSheet.window.contentView?.layoutSubtreeIfNeeded(); pump()
            let singleContent = addSheet.window.contentView!
            check(!allTextValues(singleContent).contains { $0.contains("Google 授权登录") || $0.contains("Sign in with Google") }, "AddAccountSheet must not render removed Google OAuth button")
            check(addSheet.currentButton.isDescendant(of: singleContent) && addSheet.currentButton.isEnabled, "Three-card AddAccountSheet must present enabled currentButton")
            check(addSheet.importJsonButton.isDescendant(of: singleContent) && addSheet.importJsonButton.isEnabled, "Three-card AddAccountSheet must present enabled importJsonButton")
            check(addSheet.exportButton.isDescendant(of: singleContent) && addSheet.exportButton.isEnabled, "Three-card AddAccountSheet must present enabled exportButton when accounts exist")
            check(addSheet.currentButton.bezelColor == Design.blue && addSheet.currentButton.keyEquivalent == "\r", "Three-card currentButton must be primary blue Return button")
            check(addSheet.currentButton.toolTip == nil && addSheet.importJsonButton.toolTip == nil && addSheet.exportButton.toolTip == nil && addSheet.cancelButton.toolTip == nil, "AddAccountSheet buttons must not set toolTip")
            check(addSheet.window.initialFirstResponder === addSheet.currentButton && addSheet.window.firstResponder === addSheet.currentButton, "Initial focus must land on currentButton")
            let singleZhHeight = singleContent.frame.height
            check(singleZhHeight > 280 && singleZhHeight < 415, "Three-card AddAccountSheet height must be compact (got \(singleZhHeight))")
            let singleLabels = findLabels(singleContent)
            check(singleLabels.contains { $0.stringValue == "当前 Antigravity 账号" }, "AddAccountSheet must show current account card title")
            check(singleLabels.contains { $0.stringValue == "导入账号" }, "AddAccountSheet must show JSON import card title")
            check(singleLabels.contains { $0.stringValue == "导出账号" }, "AddAccountSheet must show JSON export card title")
            if let subLbl = singleLabels.first(where: { $0.stringValue == "导入当前 Antigravity 登录账号" }) {
                verifyLabelNotTruncated(subLbl, context: "Three-card zh save subtitle")
            } else {
                check(false, "AddAccountSheet missing zh save subtitle")
            }
            if let importSubLbl = singleLabels.first(where: { $0.stringValue == "支持导入 GravityBox 备份文件、单账号 JSON 或账号文件夹" }) {
                verifyLabelNotTruncated(importSubLbl, context: "Three-card zh import subtitle")
            } else {
                check(false, "AddAccountSheet missing zh import subtitle")
            }
            if let exportSubLbl = singleLabels.first(where: { $0.stringValue == "将已保存的 3 个账号导出为 JSON 文件（含登录凭据，请妥善保管）" }) {
                verifyLabelNotTruncated(exportSubLbl, context: "Three-card zh export subtitle")
            } else {
                check(false, "AddAccountSheet missing zh export subtitle")
            }
            check(singleLabels.contains { $0.stringValue == "alex@example.invalid" }, "AddAccountSheet must show copyable current email")
            check(!allTextValues(singleContent).contains { $0.localizedCaseInsensitiveContains("Insiders") }, "AddAccountSheet must not mention Insiders")
            try capture(singleContent, output.appendingPathComponent("\(theme)-add-account.png"))

            // 展开 feedback 与 busy 状态：同时禁用三个卡片按钮且高度紧贴内容
            addSheet.status.stringValue = "正在从 JSON 导入账号…"
            addSheet.busy(true); pump()
            check(!addSheet.currentButton.isEnabled && !addSheet.importJsonButton.isEnabled && !addSheet.exportButton.isEnabled, "Busy state must disable currentButton, importJsonButton, and exportButton")
            let singleBusyHeight = singleContent.frame.height
            check(singleBusyHeight > singleZhHeight + 8 && singleBusyHeight < 455, "Expanded feedback height must hug content (got \(singleBusyHeight))")
            addSheet.status.stringValue = ""
            addSheet.busy(false); pump()
            check(addSheet.currentButton.isEnabled && addSheet.importJsonButton.isEnabled && addSheet.exportButton.isEnabled, "Clearing busy state must re-enable all card buttons")
            check(abs(singleContent.frame.height - singleZhHeight) <= 1, "Collapsing feedback must restore compact three-card height")

            // 中英文热切换：三卡文案与按钮全部更新且高度自适应不截断
            L10n.shared.setLanguage("en", notify: true); pump()
            addSheet.window.contentView?.layoutSubtreeIfNeeded()
            let singleEnLabels = findLabels(singleContent)
            check(singleEnLabels.contains { $0.stringValue == "Current Antigravity Account" }, "English hot-switch must update card 1 title")
            check(singleEnLabels.contains { $0.stringValue == "Import Accounts" }, "English hot-switch must update card 2 title")
            check(singleEnLabels.contains { $0.stringValue == "Export Accounts" }, "English hot-switch must update card 3 title")
            check(addSheet.currentButton.title == "Save Current Account" && addSheet.importJsonButton.title == "Choose Files…" && addSheet.exportButton.title == "Export File…" && addSheet.cancelButton.title == "Cancel", "English hot-switch must update card and footer buttons")
            if let enSub = singleEnLabels.first(where: { $0.stringValue == "Import active Antigravity sign-in session" }) {
                verifyLabelNotTruncated(enSub, context: "Three-card en save subtitle")
            } else {
                check(false, "English hot-switch missing card 1 subtitle")
            }
            if let enImportSub = singleEnLabels.first(where: { $0.stringValue == "Import GravityBox backup files, single-account JSON files, or a folder" }) {
                verifyLabelNotTruncated(enImportSub, context: "Three-card en import subtitle")
            } else {
                check(false, "English hot-switch missing card 2 subtitle")
            }
            if let enExportSub = singleEnLabels.first(where: { $0.stringValue == "Export 3 saved account(s) as a JSON file (includes credentials; store securely)" }) {
                verifyLabelNotTruncated(enExportSub, context: "Three-card en export subtitle")
            } else {
                check(false, "English hot-switch missing card 3 subtitle")
            }
            check(singleContent.frame.height < 425, "Three-card English sheet height must remain compact (got \(singleContent.frame.height))")
            L10n.shared.setLanguage("zh-Hans", notify: true); pump()
            addSheet.dismiss(); waitForSheetDetach(on: window, description: "AddAccountSheet to detach")

            // 2) 0 账号时导出按钮自动禁用；同时验证导入与导出控制流
            let emptyManageSheet = AddAccountSheet(app: assistant, accountCount: 0, saved: {})
            check(!emptyManageSheet.exportButton.isEnabled, "Export button must be disabled when 0 accounts are saved")
            emptyManageSheet.busy(false)
            check(!emptyManageSheet.exportButton.isEnabled, "Clearing busy state must keep export button disabled when 0 accounts are saved")

            var oauthStatusRaw = fixtureStatus
            oauthStatusRaw["oauthClientConfigured"] = true
            let withOAuthStatus = LiveStatus(oauthStatusRaw)
            let mergedWithoutOAuthField = assistant.mergeStatusSnapshot(["mode": "connected"], previous: withOAuthStatus)
            check(mergedWithoutOAuthField.oauthClientConfigured == true, "mergeStatusSnapshot must preserve oauthClientConfigured when omitted from partial status payloads")
            assistant.statusValue = withOAuthStatus
            var importSavedCallbackFired = false
            var expiredNoticeCaptured: (String, String)? = nil
            let oauthSheet = AddAccountSheet(app: assistant, accountCount: 3, saved: { importSavedCallbackFired = true })
            oauthSheet.show(in: window, onDismiss: {})
            oauthSheet.window.appearance = NSAppearance(named: appearance)
            oauthSheet.window.contentView?.layoutSubtreeIfNeeded(); pump()
            let oauthContent = oauthSheet.window.contentView!
            check(oauthSheet.currentButton.isDescendant(of: oauthContent) && oauthSheet.importJsonButton.isDescendant(of: oauthContent) && oauthSheet.exportButton.isDescendant(of: oauthContent), "AddAccountSheet must keep three-card layout regardless of oauthClientConfigured")
            check(!allTextValues(oauthContent).contains { $0.contains("Google 授权登录") || $0.contains("Sign in with Google") }, "AddAccountSheet must never show removed Google OAuth button")
            let prevFixtureReplyForImport = assistant.bridge.fixtureReply
            var exportedPayloadFromSheet: [String: Any]? = nil
            assistant.bridge.fixtureReply = { payload in
                if (payload["command"] as? String) == "account_import_json" {
                    return ["ok": true, "imported": 2, "updated": 1, "skipped": [["source": "bad.json", "reason": "缺少有效的 refresh_token"]], "expiredWithoutRefreshConfig": 1]
                }
                if (payload["command"] as? String) == "account_export_backup" {
                    exportedPayloadFromSheet = payload
                    return ["ok": true, "path": payload["path"] as? String ?? "", "count": 3]
                }
                return prevFixtureReplyForImport?(payload) ?? ["ok": true]
            }
            oauthSheet.filePickerHook = { [URL(fileURLWithPath: "/tmp/mock-accounts-backup.json")] }
            oauthSheet.expiredNoticeHook = { title, body in expiredNoticeCaptured = (title, body) }
            oauthSheet.importFromJson(); pump()
            check(importSavedCallbackFired, "Successful JSON import must trigger saved callback")
            check(expiredNoticeCaptured?.0 == "部分导入账号的短期凭据已过期" && (expiredNoticeCaptured?.1.contains("1 个账号") == true), "JSON import with expiredWithoutRefreshConfig > 0 must surface expired credential notice")

            let exportSheet = AddAccountSheet(app: assistant, accountCount: 3, saved: {})
            exportSheet.show(in: window, onDismiss: {})
            exportSheet.exportConfirmHook = { true }
            exportSheet.exportSavePanelHook = { defaultName in
                check(defaultName.hasPrefix("gravitybox-accounts-backup-") && defaultName.hasSuffix(".json"), "Export accounts default filename must match gravitybox-accounts-backup-YYYYMMDD.json")
                return URL(fileURLWithPath: "/tmp/\(defaultName)")
            }
            exportSheet.exportAccounts(); pump()
            assistant.bridge.fixtureReply = prevFixtureReplyForImport
            check((exportedPayloadFromSheet?["confirmed"] as? Bool) == true && (exportedPayloadFromSheet?["path"] as? String)?.hasPrefix("/tmp/gravitybox-accounts-backup-") == true, "Export accounts inside Manage Accounts sheet must send account_export_backup with confirmed: true")
            exportSheet.dismiss(); waitForSheetDetach(on: window, description: "Export AddAccountSheet to detach")
            assistant.statusValue = prevStatusForAdd
            let logSheet = UsageLogController(app:assistant,period:"today")
            logSheet.show(in:window,onDismiss:{})
            logSheet.sheet.appearance = NSAppearance(named:appearance); pump()
            check(logSheet.refreshButton.title == "刷新" && logSheet.exportButton.title == "导出…", "UsageLogController must unify refresh and export buttons")
            logSheet.sheet.makeFirstResponder(logSheet.pageNumber); pump()
            check(logSheet.pageNumber.currentEditor()?.alignment == .center, "Page number editor must stay centered")
            logSheet.sheet.makeFirstResponder(nil); pump()
            try capture(logSheet.sheet.contentView!,output.appendingPathComponent("\(theme)-usage-log.png"))
            logSheet.closeSheet(); waitForSheetDetach(on: window, description: "UsageLogController to detach")
            assistant.selectPage(3); pump()
            let maintSheet = assistant.preferencesController?.maintenanceSheet ?? MaintenanceSheetController(app: assistant)
            maintSheet.sheet.appearance = NSAppearance(named: appearance)
            maintSheet.cachePage.fetch(force: true); pump()
            waitUntil(step: 0.01, description: "maintSheet initial scan to complete") { !maintSheet.cachePage.busy }
            maintSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
            check(maintSheet.sheet.frame.width == MaintenanceSheetController.sheetWidth, "Maintenance sheet must use compact 620pt width")
            check(maintSheet.cachePage.retentionPopup.itemTitles == ["清理 7 天前", "清理 30 天前", "清理全部非活跃"], "Maintenance sheet must expose 3 inline retention window choices")
            check(maintSheet.cachePage.retentionPopup.fittingSize.width <= 126 && maintSheet.cachePage.retentionPopup.fittingSize.width >= Design.fittedPopUpWidth(maintSheet.cachePage.retentionPopup) - 0.5, "Maintenance retentionPopup must tightly fit longest option without excess width (got \(maintSheet.cachePage.retentionPopup.fittingSize.width), expected ~\(Design.fittedPopUpWidth(maintSheet.cachePage.retentionPopup)))")
            check(maintSheet.cachePage.historySubtitleLabel.stringValue.contains("保留近 7 天"), "Maintenance 7d retention must disclose 7-day preservation: \(maintSheet.cachePage.historySubtitleLabel.stringValue)")
            maintSheet.cachePage.retentionPopup.selectItem(at: 1)
            maintSheet.cachePage.retentionWindowChanged(); pump()
            waitUntil(step: 0.01, description: "maintSheet 30d retention scan to complete") { !maintSheet.cachePage.busy }
            maintSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            check(maintSheet.cachePage.historySubtitleLabel.stringValue.contains("保留近 30 天"), "Maintenance 30d retention must dynamically disclose 30-day preservation: \(maintSheet.cachePage.historySubtitleLabel.stringValue)")
            maintSheet.cachePage.retentionPopup.selectItem(at: 2)
            maintSheet.cachePage.retentionWindowChanged(); pump()
            waitUntil(step: 0.01, description: "maintSheet 0d retention scan to complete") { !maintSheet.cachePage.busy }
            maintSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            check(maintSheet.cachePage.historySubtitleLabel.stringValue.contains("清理所有非活跃对话"), "Maintenance 0d retention must dynamically explain all inactive cleanup: \(maintSheet.cachePage.historySubtitleLabel.stringValue)")
            let zeroDayNatW = (maintSheet.cachePage.historySubtitleLabel.stringValue as NSString).size(withAttributes: [.font: maintSheet.cachePage.historySubtitleLabel.font!]).width
            check(maintSheet.cachePage.historySubtitleLabel.bounds.width + 1.5 >= floor(zeroDayNatW), "Maintenance 0d historySubtitleLabel must not truncate (\(maintSheet.cachePage.historySubtitleLabel.stringValue)): \(maintSheet.cachePage.historySubtitleLabel.bounds.width) < \(zeroDayNatW)")
            maintSheet.cachePage.retentionPopup.selectItem(at: 0)
            maintSheet.cachePage.retentionWindowChanged(); pump()
            waitUntil(step: 0.01, description: "maintSheet 7d restore scan to complete") { !maintSheet.cachePage.busy }
            maintSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            check(maintSheet.cachePage.runtimeCacheSwitch.state == .on && maintSheet.cachePage.historyLogsSwitch.state == .off, "Maintenance default switches must enable runtime cache and keep history logs off")
            check(maintSheet.cachePage.selectedScopes == ["runtime_cache"], "Maintenance default selectedScopes must contain runtime_cache only")
            check(maintSheet.cachePage.clearButton.isEnabled && maintSheet.cachePage.clearButton.title == "一键清理", "Maintenance primary CTA must display 一键清理")
            check(!maintSheet.cachePage.restoreLatestButton.isHidden && maintSheet.cachePage.restoreLatestButton.title == "撤回上次清理", "Maintenance footer card must expose single-click 撤回上次清理 when restorable snapshot exists")
            check(!maintSheet.cachePage.sheetDoneButton.isHidden && maintSheet.cachePage.sheetDoneButton.title == "完成", "Maintenance sheet must display 完成 button")
            check(maintSheet.cachePage.sheetDoneButton.frame.minY < maintSheet.cachePage.view.frame.minY, "Maintenance 完成 button must sit in pinned bottom footer below card area")
            check(maintSheet.cachePage.sheetDoneButton.frame.maxX >= maintSheet.cachePage.clearButton.frame.minX, "Maintenance 完成 button must align at bottom-right")
            for maintLbl in [maintSheet.cachePage.reclaimableTitleLabel, maintSheet.cachePage.reclaimableValueLabel, maintSheet.cachePage.heroSubtitleLabel, maintSheet.cachePage.safeLegendLabel, maintSheet.cachePage.statefulLegendLabel, maintSheet.cachePage.protectedLegendLabel, maintSheet.cachePage.runtimeTitleLabel, maintSheet.cachePage.runtimeSubtitleLabel, maintSheet.cachePage.historyTitleLabel, maintSheet.cachePage.historySubtitleLabel, maintSheet.cachePage.recoveryTitleLabel, maintSheet.cachePage.recoverySubtitleLabel] where !maintLbl.isHidden && !maintLbl.stringValue.isEmpty {
                let natW = (maintLbl.stringValue as NSString).size(withAttributes: [.font: maintLbl.font!]).width
                check(maintLbl.bounds.width + 1.5 >= floor(natW), "Maintenance label must not truncate (\(maintLbl.stringValue)): \(maintLbl.bounds.width) < \(natW)")
            }
            try capture(maintSheet.sheet.contentView!, output.appendingPathComponent("\(theme)-maintenance-sheet.png"))
            maintSheet.closeSheet(); pump()
            let allAccounts = accounts
            accounts = [allAccounts[2]]; activeId = "c"; assistant.activeAccountId = "c"; assistant.cachedAccounts = accounts
            window.setFrame(NSRect(origin:window.frame.origin,size:NSSize(width:880,height:580)),display:true)
            assistant.selectPage(1); pump()
            assistant.accountsPage?.fetch()
            waitUntil(step: 0.01, description: "AccountsPage activeId to sync to c") {
                !assistant.accountListInFlight
                    && !assistant.accountListPendingRefetch
                    && assistant.accountsPage?.activeId == "c"
                    && assistant.accountsPage?.cardsStack.arrangedSubviews.count == 1
            }
            func quotaBars(_ view:NSView)->[QuotaBarView] { (view as? QuotaBarView).map{[$0]} ?? view.subviews.flatMap{quotaBars($0)} }
            let modelBars = quotaBars(window.contentView!).filter{$0.titleLabel.stringValue.contains("模型配额")}
            check(modelBars.count == 2 && modelBars.allSatisfy{$0.percentageKnown && $0.percentage == 100}, "FREE model quota must render known on both account rows")
            for bar in modelBars where !bar.resetLabel.stringValue.isEmpty {
                let naturalW = (bar.resetLabel.stringValue as NSString).size(withAttributes: [.font: bar.resetLabel.font!]).width
                check(bar.resetLabel.bounds.width + 1.0 >= floor(naturalW), "Model quota resetLabel (\(bar.resetLabel.stringValue)) must not truncate at 880pt minimum width (\(bar.resetLabel.bounds.width) < \(naturalW))")
            }
            check(assistant.accountsPage?.activeId == "c", "AccountsPage must preserve configured activeId when liveAccountEmail is not in saved accounts")
            try capture(window.contentView!,output.appendingPathComponent("\(theme)-free-model-quota.png"))
            let freeMenuPanel = MenuPanelController(app: assistant)
            let freeHost = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            freeHost.appearance = NSAppearance(named: appearance)
            freeHost.contentViewController = freeMenuPanel
            freeMenuPanel.selectTab(1, persist: false); freeMenuPanel.panelWillOpen(); pump()
            freeHost.setContentSize(freeMenuPanel.preferredContentSize); freeHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(freeMenuPanel.quotaEmailLabel.stringValue == "charlie@example.invalid", "Full email lost on MenuPanelController")
            check(freeMenuPanel.quotaGemini5h.titleLabel.stringValue == "模型配额" && freeMenuPanel.quotaGemini5h.valueLabel.stringValue == "100%", "Menu must show FREE model quota")
            check(freeMenuPanel.quotaClaude5h.resetLabel.stringValue.contains("6天23小时"), "Menu must preserve the real long model reset")
            try capture(freeHost.contentView!,output.appendingPathComponent("\(theme)-free-model-menu.png"))
            freeHost.orderOut(nil)
            waitUntil(step: 0.01, description: "freeMenuPanel account_list requests to settle before restoring 3 accounts") {
                !assistant.accountListInFlight && !assistant.accountListPendingRefetch
            }
            accounts = allAccounts; activeId = "a"; assistant.activeAccountId = "a"; assistant.cachedAccounts = accounts
            assistant.accountsPage?.fetch()
            waitUntil(step: 0.01, description: "AccountsPage to restore all 3 accounts and activeId a") {
                !assistant.accountListInFlight
                    && !assistant.accountListPendingRefetch
                    && assistant.accountsPage?.activeId == "a"
                    && assistant.accountsPage?.cardsStack.arrangedSubviews.count == 3
            }
        }
        assistant.accountsPage!.fetch(); pump()
        waitUntil(step: 0.01, description: "AccountsPage initial 3 cards before countdown tick") {
            !assistant.accountListInFlight
                && !assistant.accountListPendingRefetch
                && assistant.accountsPage?.cardsStack.arrangedSubviews.count == 3
        }
        let initialCards = assistant.accountsPage!.cardsStack.arrangedSubviews
        check(initialCards.count == 3, "Expected 3 account cards before countdown tick")
        accounts[0]["geminiFiveHourResetCountdown"] = "1小时59分后重置"
        assistant.accountsPage!.fetch(); pump()
        waitUntil(step: 0.01, description: "AccountsPage countdown tick fetch to settle") {
            !assistant.accountListInFlight && !assistant.accountListPendingRefetch
        }
        let updatedCards = assistant.accountsPage!.cardsStack.arrangedSubviews
        check(updatedCards.count == initialCards.count && zip(initialCards, updatedCards).allSatisfy { $0 === $1 }, "Countdown tick must update account cards in place without rebuilding card views")
        assistant.preferencesController?.showMaintenanceSheet(); pump()
        let liveCache = assistant.cachePage!
        let initialScopeRows = liveCache.scopeStack.arrangedSubviews
        liveCache.fetch(force: true); pump()
        waitUntil(step: 0.01, description: "liveCache scan to settle") { !liveCache.busy }
        let updatedScopeRows = liveCache.scopeStack.arrangedSubviews
        check(updatedScopeRows.count == 3 && zip(initialScopeRows, updatedScopeRows).allSatisfy { $0 === $1 }, "3-card CachePage must retain fixed 2-switch scope views across scans without rebuilding")
        let baseSelectedBytes = liveCache.selectedReclaimableBytes
        let baseConfirmBody = liveCache.buildRunningClearConfirmationBody()
        check(baseConfirmBody.contains("4") && (baseConfirmBody.contains("3,842") || baseConfirmBody.contains("3842")), "Stage-2 running confirmation must dynamically disclose selected category and file counts: \(baseConfirmBody)")
        liveCache.runtimeInfoButton.performClick(nil); pump()
        check(liveCache.activePopoverKind == .runtime && liveCache.detailPopover?.behavior == .transient && liveCache.runtimeInfoButton.isActivePopover, "Clicking runtimeInfoButton must open transient runtime NSPopover")
        let rtPopTexts = allTextValues(liveCache.detailPopover!.contentViewController!.view)
        check(rtPopTexts.contains("应用运行缓存明细") && rtPopTexts.contains("网络与静态资源缓存") && rtPopTexts.contains("浏览器沙箱加速缓存"), "Runtime popover must render itemized cache titles: \(rtPopTexts)")
        liveCache.legendProtectedTrigger.performClick(nil); pump()
        check(liveCache.activePopoverKind == .protected && !liveCache.runtimeInfoButton.isActivePopover && liveCache.legendProtectedTrigger.isActivePopover, "Clicking protected legend must replace runtime popover with protected popover")
        let protPopTexts = allTextValues(liveCache.detailPopover!.contentViewController!.view)
        check(protPopTexts.contains("受自动保护的核心数据") && protPopTexts.contains("永不触碰") && protPopTexts.contains("工作区与核心账号凭据") && protPopTexts.contains("Agent 历史对话与上下文库"), "Protected popover must render positive core-data inventory: \(protPopTexts)")
        liveCache.historyInfoButton.performClick(nil); pump()
        check(liveCache.activePopoverKind == .history && liveCache.historyInfoButton.isActivePopover, "Clicking historyInfoButton must open history logs popover")
        let histPopTexts = allTextValues(liveCache.detailPopover!.contentViewController!.view)
        check(histPopTexts.contains { $0.contains("后台运行日志明细") } && histPopTexts.contains("历史子智能体轨迹库") && histPopTexts.contains { $0.contains("账单保护") }, "History popover must disclose subagent DBs and billing archive guard: \(histPopTexts)")
        liveCache.recoveryTriggerView.performClick(nil); pump()
        check(liveCache.activePopoverKind == .snapshot && liveCache.recoveryTriggerView.isActivePopover, "Clicking recoveryTriggerView with restorable snapshot must open snapshot audit popover")
        let snapPopTexts = allTextValues(liveCache.detailPopover!.contentViewController!.view)
        check(snapPopTexts.contains("上次清理快照清单") && snapPopTexts.contains("网络与静态资源缓存") && snapPopTexts.contains { $0.contains("3,180") || $0.contains("3180") }, "Snapshot popover must disclose staged file count and item titles: \(snapPopTexts)")
        liveCache.recoveryTriggerView.performClick(nil); pump()
        check(liveCache.activePopoverKind == nil && liveCache.detailPopover == nil, "Clicking same trigger again must toggle popover closed")
        liveCache.historyLogsSwitch.state = .on
        liveCache.historyScopeToggled()
        let combinedConfirmBody = liveCache.buildRunningClearConfirmationBody()
        check(liveCache.selectedScopes == ["runtime_cache", "history_logs"] && liveCache.selectedReclaimableBytes > baseSelectedBytes && combinedConfirmBody.contains("6") && (combinedConfirmBody.contains("4,964") || combinedConfirmBody.contains("4964")), "Toggling historyLogsSwitch on must dynamically add history_logs scope, Hero bytes, and confirmation counts")
        liveCache.historyLogsSwitch.state = .off
        liveCache.historyScopeToggled()
        check(liveCache.selectedScopes == ["runtime_cache"] && liveCache.selectedReclaimableBytes == baseSelectedBytes, "Toggling historyLogsSwitch off must restore runtime_cache-only Hero bytes")
        assistant.preferencesController?.maintenanceSheet?.closeSheet(); waitForSheetDetach(on: window, description: "MaintenanceSheetController to detach")

        // Verify three-tab MenuPanelController (用量｜配额｜账号)
        let menuPanel = assistant.ensureMenuPanelController()
        let panelHost = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
        panelHost.contentViewController = menuPanel
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            panelHost.appearance = NSAppearance(named: appearance)
            menuPanel.selectTab(0, persist: false); menuPanel.panelWillOpen(); pump()
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.brandLabel.superview?.superview?.superview?.frame.maxY == menuPanel.view.bounds.height, "Header bar must stay pinned to the top edge on Usage tab")
            try capture(panelHost.contentView!, output.appendingPathComponent("\(theme)-menu-panel-usage.png"))
            menuPanel.selectTab(1, persist: false); pump()
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.brandLabel.superview?.superview?.superview?.frame.maxY == menuPanel.view.bounds.height, "Header bar must stay pinned to the top edge on Quota tab")
            try capture(panelHost.contentView!, output.appendingPathComponent("\(theme)-menu-panel-quota.png"))
            menuPanel.selectTab(2, persist: false); pump()
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.brandLabel.superview?.superview?.superview?.frame.maxY == menuPanel.view.bounds.height, "Header bar must stay pinned to the top edge on Accounts tab")
            try capture(panelHost.contentView!, output.appendingPathComponent("\(theme)-menu-panel-accounts.png"))
        }
        menuPanel.selectTab(0, persist: false); menuPanel.panelWillOpen(); pump()
        let multiModelHeight = menuPanel.preferredContentSize.height
        check(menuPanel.selectedTab == 0, "Menu panel must default to Usage tab (0)")
        check(menuPanel.usageFooterLabel.stringValue.hasPrefix("更新于 "), "Menu usage footer must use concise 更新于 timestamp")
        check(menuPanel.usageFooterLabel.superview === menuPanel.usageRoot, "Menu usage footer must reside directly in usageRoot, outside modelsCard")
        check(menuPanel.tokensTile.valueLabel.stringValue == "98.2M", "Menu usage tab must match Usage KPI tokens")
        check(menuPanel.requestsTile.valueLabel.stringValue == "756", "Menu usage tab must match Usage KPI requests")
        check(menuPanel.costTile.valueLabel.stringValue == "$23.78", "Menu usage tab must match Usage KPI cost")
        check(menuPanel.tokensTile.toolTip == nil, "Tokens tile must not have tooltip per requirement")
        let metricTiles = [menuPanel.tokensTile, menuPanel.requestsTile, menuPanel.costTile, menuPanel.cacheTile]
        for tile in metricTiles {
            check(tile.iconView.image != nil, "\(tile.metricKey) tile must contain micro colored SF Symbol")
            check(tile.frame.height >= 54 && tile.frame.height <= 56, "\(tile.metricKey) tile must maintain 54~56pt compact height")
            check(tile.accessibilityRole() == .group, "\(tile.metricKey) tile must be a read-only group, not interactive button")
            check(!((tile as AnyObject) is NSControl), "\(tile.metricKey) tile must not inherit from NSControl")
            check(tile.titleLabel.font?.pointSize == 11.5, "\(tile.metricKey) tile title font must be 11.5pt")
            check(tile.valueLabel.font?.pointSize == 20, "\(tile.metricKey) tile value font must be 20pt")
            func subviewsRecursive(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { subviewsRecursive($0) } }
            let allSubviews = subviewsRecursive(tile)
            check(allSubviews.filter { $0 is NSImageView }.count == 1, "\(tile.metricKey) tile must contain only 1 micro icon and no chevron arrow")
            let visibleTextFields = allSubviews.compactMap { $0 as? NSTextField }.filter { !$0.isHidden && !($0.superview?.isHidden ?? false) }
            check(visibleTextFields.count == 2 && tile.statusBadge.isHidden, "\(tile.metricKey) tile must contain only title and value visible labels when status badge is hidden")
        }
        panelHost.appearance = NSAppearance(named: .aqua); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
        check(menuPanel.contentScroll.contentView.frame.width == MenuPanelController.panelWidth && (menuPanel.contentScroll.verticalScroller?.frame.width ?? 0) == 0, "Menu panel content must never reserve a scroller gutter or squeeze content width")
        menuPanel.selectChartDimension(.requests, persist: false)
        check(menuPanel.trendChart.dimension == .requests, "Menu trend chart must support switching to requests dimension")
        menuPanel.selectChartDimension(.tokens, persist: false)
        let baselineUsageFitHeight = menuPanel.usageRoot.fittingSize.height
        let samplePt = menuPanel.trendChart.convert(NSPoint(x: 60, y: 40), to: nil)
        let hoverEvent = NSEvent.mouseEvent(with: .mouseMoved, location: samplePt, modifierFlags: [], timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
        menuPanel.trendChart.mouseMoved(with: hoverEvent)
        check(menuPanel.trendChart.toolTip == nil, "Menu trend chart must not have hover tooltip per requirement")
        check(menuPanel.trendCoverageLabel.alphaValue == 1.0, "Trend coverage label must be visible on hover")
        check(menuPanel.usageRoot.fittingSize.height == baselineUsageFitHeight, "Menu usage view fitting height must remain stable on trend hover without jitter")
        menuPanel.trendChart.resetHoverState()
        check(menuPanel.trendCoverageLabel.alphaValue == 0.0, "Trend coverage label must be hidden when hover resets")
        check(menuPanel.usageRoot.fittingSize.height == baselineUsageFitHeight, "Menu usage view fitting height must remain stable after hover reset")
        check(!menuPanel.toggleModelsButton.isHidden && menuPanel.toggleModelsButton.title.contains("展开其余 1 个模型"), "Menu model list must default to top 3 and offer inline expansion")
        let firstThreeModels = Array(menuPanel.modelsListStack.arrangedSubviews.prefix(3))
        menuPanel.toggleAllModelsPressed()
        check(menuPanel.showAllModels && menuPanel.toggleModelsButton.title.contains("收起"), "Menu model list must expand all models in place")
        check(zip(firstThreeModels, menuPanel.modelsListStack.arrangedSubviews.prefix(3)).allSatisfy { $0 === $1 }, "Expanding model list must reuse existing model row views without rebuilding")
        for sub in menuPanel.modelsListStack.arrangedSubviews {
            guard let modelRow = sub as? MenuModelUsageRow else { continue }
            check(!((modelRow as AnyObject) is NSControl), "MenuModelUsageRow must be a read-only NSView, not NSControl")
            check(modelRow.accessibilityRole() == .group, "MenuModelUsageRow must have group accessibility role")
            func rowSubviews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { rowSubviews($0) } }
            let subs = rowSubviews(modelRow)
            check(subs.filter { $0 is NSButton }.isEmpty, "MenuModelUsageRow must contain 0 NSButtons (no headerButton)")
            check(subs.filter { $0 is NSImageView }.count == 1, "MenuModelUsageRow must contain only 1 icon and no chevronView")
            let visibleRowTextFields = subs.compactMap { $0 as? NSTextField }.filter { !$0.isHidden && !($0.superview?.isHidden ?? false) }
            check(visibleRowTextFields.count == 2 && modelRow.statusBadge.isHidden, "MenuModelUsageRow must contain exactly 2 visible labels without detailLabel when statusBadge is hidden")
            check(subs.filter { $0 is MenuMeterBar }.count == 1, "MenuModelUsageRow must contain shareBar")
        }
        check(menuPanel.contentScroll.contentView.frame.width == MenuPanelController.panelWidth && (menuPanel.contentScroll.verticalScroller?.frame.width ?? 0) == 0, "Expanded menu panel must never reserve a scroller gutter or squeeze content width")
        menuPanel.toggleAllModelsPressed()
        // Verify single-model Usage tab shrinks height to fit content with zero bottom blank gap
        if var singleModelReport = assistant.cachedUsageReportsByPeriod["today"] {
            singleModelReport["byModel"] = [models[0]]
            singleModelReport["snapshotId"] = "single-model-snap"
            assistant.cachedUsageReportsByPeriod["today"] = singleModelReport
            menuPanel.onUsageReportUpdated(period: "today", result: .success(singleModelReport))
            panelHost.appearance = NSAppearance(named: .aqua)
            panelHost.setContentSize(menuPanel.preferredContentSize); panelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(menuPanel.preferredContentSize.height < multiModelHeight - 60, "Single-model usage tab must shrink height to eliminate bottom blank space")
            try capture(panelHost.contentView!, output.appendingPathComponent("light-menu-panel-usage-single-model.png"))
        }
        check(
            menuPanel.selectedTab == 0
                && !menuPanel.headerRefreshButton.iconOnly
                && menuPanel.headerRefreshButton.title == L10n.t("common.refresh", fallback: "刷新")
                && menuPanel.headerRefreshButton.image == nil
                && menuPanel.headerRefreshButton.toolTip == nil
                && menuPanel.headerRefreshButton.frame.size == NSSize(width: 78, height: 28)
                && menuPanel.headerRefreshButton.spinner.superview === menuPanel.headerRefreshButton
                && !(menuPanel.headerRefreshButton.accessibilityLabel() ?? "").isEmpty
                && !menuPanel.moreButton.isHidden
                && menuPanel.moreButton.isEnabled
                && menuPanel.moreButton.alphaValue == 1.0
                && menuPanel.moreButton.frame.size == NSSize(width: 28, height: 28),
            "Usage tab must keep 78x28 text headerRefreshButton with embedded spinner and always-enabled 28x28 moreButton"
        )
        menuPanel.selectTab(1, persist: false); pump()
        check(
            menuPanel.selectedTab == 1
                && !menuPanel.headerRefreshButton.iconOnly
                && menuPanel.headerRefreshButton.title == L10n.t("common.refresh", fallback: "刷新")
                && menuPanel.headerRefreshButton.image == nil
                && menuPanel.headerRefreshButton.toolTip == nil
                && menuPanel.headerRefreshButton.frame.size == NSSize(width: 78, height: 28)
                && menuPanel.headerRefreshButton.spinner.superview === menuPanel.headerRefreshButton
                && !(menuPanel.headerRefreshButton.accessibilityLabel() ?? "").isEmpty
                && !menuPanel.moreButton.isHidden
                && menuPanel.moreButton.isEnabled
                && menuPanel.moreButton.alphaValue == 1.0,
            "Quota tab must keep 78x28 text headerRefreshButton with embedded spinner, accessibilityLabel, zero hover tooltip, and active moreButton (tab=\(menuPanel.selectedTab) iconOnly=\(menuPanel.headerRefreshButton.iconOnly) title='\(menuPanel.headerRefreshButton.title)' img=\(menuPanel.headerRefreshButton.image != nil) tip=\(String(describing: menuPanel.headerRefreshButton.toolTip)) size=\(menuPanel.headerRefreshButton.frame.size) a11y=\(String(describing: menuPanel.headerRefreshButton.accessibilityLabel())))"
        )
        check(menuPanel.quotaAccountNameLabel.stringValue == "Alex" && menuPanel.quotaGemini5h.valueLabel.stringValue == "91%", "Quota tab must display active account identity and contract quota")
        check(menuPanel.quotaStatusBadge.isHidden, "Quota tab must hide redundant current/selected pill badge when live account matches")
        let quotaGroupTexts = allTextValues(menuPanel.quotaGroupsContainer)
        check(quotaGroupTexts.contains("Gemini 4 Argon") && !quotaGroupTexts.contains("Gemini 4 Carbon"), "PRO menu quota tab must render real Argon without synthesizing fake Carbon")
        check(!quotaGroupTexts.contains(where: { $0.contains("周期未知") }), "Menu quota tab must never display 周期未知")
        check(menuPanel.quotaFooterLabel.stringValue.hasPrefix("更新于 ") && !menuPanel.quotaFooterLabel.stringValue.contains("采样于"), "Quota tab footer must use concise 更新于 timestamp")
        check(menuPanel.quotaFooterLabel.superview === menuPanel.quotaRoot, "Quota tab footer must reside directly in quotaRoot")
        menuPanel.selectTab(2, persist: false); pump()
        check(
            menuPanel.selectedTab == 2
                && !menuPanel.headerRefreshButton.iconOnly
                && menuPanel.headerRefreshButton.title == L10n.t("common.refresh", fallback: "刷新")
                && menuPanel.headerRefreshButton.image == nil
                && menuPanel.headerRefreshButton.toolTip == nil
                && menuPanel.headerRefreshButton.frame.size == NSSize(width: 78, height: 28)
                && menuPanel.headerRefreshButton.spinner.superview === menuPanel.headerRefreshButton
                && !(menuPanel.headerRefreshButton.accessibilityLabel() ?? "").isEmpty
                && !menuPanel.moreButton.isHidden
                && menuPanel.moreButton.isEnabled
                && menuPanel.moreButton.alphaValue == 1.0,
            "Accounts tab must keep 78x28 text headerRefreshButton with embedded spinner, accessibilityLabel, zero hover tooltip, and active moreButton (tab=\(menuPanel.selectedTab) iconOnly=\(menuPanel.headerRefreshButton.iconOnly) title='\(menuPanel.headerRefreshButton.title)' img=\(menuPanel.headerRefreshButton.image != nil) tip=\(String(describing: menuPanel.headerRefreshButton.toolTip)) size=\(menuPanel.headerRefreshButton.frame.size) a11y=\(String(describing: menuPanel.headerRefreshButton.accessibilityLabel())))"
        )
        check(menuPanel.accountsCountLabel.stringValue == "3 个账号" && menuPanel.expandedAccountIds.contains("a"), "Accounts tab must list all accounts with active account expanded")
        menuPanel.toggleAccountExpanded("b")
        check(menuPanel.expandedAccountIds.contains("b"), "Clicking backup account row must expand its 5-window quota details without switching")
        for sub in menuPanel.accountsCardsStack.arrangedSubviews {
            if let card = sub as? MenuExpandableAccountCardView {
                check(card.stateButton.frame.width >= 16 && card.stateButton.frame.origin.x >= 0, "Account card stateButton must be clearly visible and uncrushed")
                check(card.nameLabel.frame.width >= 20, "Account card nameLabel must not be compressed down to ellipsis")
                let headerStack = card.headerButton.subviews.compactMap { $0 as? NSStackView }.first
                check(headerStack?.arrangedSubviews.count == 2, "Account card header stack must contain exactly 2 arranged subviews (topTitleRow and emailLabel), summaryLabel must be removed")
                check(headerStack?.arrangedSubviews.contains(card.emailLabel) == true, "Account card header stack must contain emailLabel")
                func cardSubviews(_ v: NSView) -> [NSView] { [v] + v.subviews.flatMap { cardSubviews($0) } }
                let allHeaderLabels = cardSubviews(card.headerButton).compactMap { $0 as? NSTextField }
                check(allHeaderLabels.allSatisfy { !$0.stringValue.contains("小时") && !$0.stringValue.contains("每周") }, "Account card header must not duplicate text quota summary")
            }
        }
        var switchedAccountId: String? = nil
        var toggledAccountId: String? = nil
        if let firstCard = menuPanel.accountsCardsStack.arrangedSubviews.first as? MenuExpandableAccountCardView {
            let firstTexts = allTextValues(firstCard)
            check(!firstTexts.contains("当前账号") && !firstTexts.contains("已选记录"), "Menu accounts first card must not display redundant 当前账号 or 已选记录 pill")
            firstCard.onSwitchAccount = { switchedAccountId = $0 }
            firstCard.onToggleExpand = { toggledAccountId = $0 }
            firstCard.headerButton.performClick(nil)
            check(toggledAccountId == firstCard.accountId && switchedAccountId == nil, "Clicking account header must toggle expand without triggering switch")
        }
        if let secondCard = menuPanel.accountsCardsStack.arrangedSubviews.dropFirst().first as? MenuExpandableAccountCardView {
            secondCard.onSwitchAccount = { switchedAccountId = $0 }
            secondCard.onToggleExpand = { toggledAccountId = $0 }
            secondCard.stateButton.performClick(nil)
            check(switchedAccountId == secondCard.accountId, "Clicking account stateButton must trigger account switch independently")
        }

        // Package C: MenuPanelController edge states & switches
        check(menuPanel.openAntigravityBtn.title == "打开 Antigravity", "MenuPanel openAntigravityBtn title must be 打开 Antigravity")
        check(menuPanel.openMainBtn.title.hasPrefix("打开") && menuPanel.openMainBtn.title.hasSuffix("↗"), "MenuPanel openMainBtn title must be 打开... ↗")

        // Tab 0 (Usage) empty models & toggle
        menuPanel.selectTab(0, persist: false); pump()
        if var emptyModelReport = assistant.cachedUsageReportsByPeriod["today"] {
            emptyModelReport["byModel"] = []
            emptyModelReport["snapshotId"] = "empty-models-snap"
            assistant.cachedUsageReportsByPeriod["today"] = emptyModelReport
            menuPanel.onUsageReportUpdated(period: "today", result: .success(emptyModelReport))
            check(menuPanel.modelsHeaderCountLabel.stringValue == "暂无记录", "Empty models must show 暂无记录")
            check(allTextValues(menuPanel.modelsListStack).contains { $0.contains("当前时间范围暂无模型调用记录") }, "Empty models must show placeholder")
            check(menuPanel.toggleModelsButton.isHidden == true, "Empty models must hide toggleModelsButton")
        }

        // Tab 0 period switching
        menuPanel.selectPeriod(1, persist: false); pump()
        check(menuPanel.trendTitleLabel.stringValue == "近 7 天趋势", "Period 1 must show 近 7 天趋势")
        menuPanel.selectPeriod(3, persist: false); pump()
        check(menuPanel.trendTitleLabel.stringValue == "全部趋势", "Period 3 must show 全部趋势")
        menuPanel.selectPeriod(0, persist: false); pump()

        // Tab 0 offline state
        assistant.reachable = false
        assistant.cachedUsageReportsByPeriod.removeValue(forKey: "today")
        menuPanel.selectTab(0, persist: false); pump()
        check(menuPanel.usageScopeLabel.stringValue == "正在等待本机服务…", "Offline Tab 0 must show 正在等待本机服务…")
        check(menuPanel.usageFooterLabel.stringValue == "本机服务离线", "Offline Tab 0 footer must show 本机服务离线")
        check(menuPanel.tokensTile.valueLabel.stringValue == "—", "Offline metric tiles must show —")

        // Tab 0 unavailable state
        assistant.reachable = true
        let unavailableReport: [String: Any] = ["summary": ["availability": "unavailable"]]
        assistant.cachedUsageReportsByPeriod["today"] = unavailableReport
        menuPanel.onUsageReportUpdated(period: "today", result: .success(unavailableReport)); pump()
        check(menuPanel.usageScopeLabel.stringValue == "所选会话数据库均读取失败", "Unavailable Tab 0 must show 所选会话数据库均读取失败")
        check(menuPanel.usageFooterLabel.stringValue.contains("统计暂不可用"), "Unavailable Tab 0 footer must show 统计暂不可用")

        // Tab 1 (Quota) empty & live unsaved
        let savedFixtureAccounts = accounts
        let savedMenuAccounts = assistant.cachedAccounts
        let savedActiveId = assistant.activeAccountId
        let savedLiveStatus = assistant.statusValue

        accounts = []
        assistant.cachedAccounts = []
        assistant.activeAccountId = ""
        fixtureStatus["liveAccountEmail"] = ""
        assistant.statusValue = LiveStatus(["mode": "adaptive", "liveAccountEmail": ""])
        menuPanel.selectTab(1, persist: false); pump()
        check(menuPanel.quotaAccountNameLabel.stringValue == "尚未保存账号", "Empty quota tab must show 尚未保存账号")
        check(menuPanel.quotaEmptyButton.isHidden == false, "Empty quota tab must show quotaEmptyButton")
        check(menuPanel.quotaGroupsContainer.isHidden == true, "Empty quota tab must hide quotaGroupsContainer")

        fixtureStatus["liveAccountEmail"] = "unsaved@example.invalid"
        assistant.statusValue = LiveStatus(["mode": "adaptive", "liveAccountEmail": "unsaved@example.invalid"])
        menuPanel.selectTab(1, persist: false); pump()
        check(menuPanel.quotaAccountNameLabel.stringValue == "运行中账号尚未保存", "Unsaved live account must show 运行中账号尚未保存")
        check(menuPanel.quotaEmailLabel.stringValue.contains("unsaved@example.invalid"), "Unsaved live account must show email in subtitle")

        // Tab 1 refreshing state & global multi-account summary isolation
        accounts = savedFixtureAccounts
        assistant.cachedAccounts = savedMenuAccounts
        assistant.activeAccountId = savedActiveId
        assistant.quotaRefreshError = "已读取 1 个账号；2 个刷新失败。详情见账号卡片。"
        menuPanel.selectTab(1, persist: false); pump()
        check(menuPanel.quotaWarningLabel.isHidden == true, "Multi-account partial summary must not pollute healthy current account warning label")
        assistant.quotaRefreshError = "刷新超时，请重试；保留上次配额"
        menuPanel.selectTab(1, persist: false); pump()
        check(menuPanel.quotaWarningLabel.isHidden == false && menuPanel.quotaWarningLabel.stringValue == "配额查询超时", "Transport/timeout global error must still display on current quota tab")
        assistant.quotaRefreshError = nil
        assistant.quotaRefreshing = true
        menuPanel.selectTab(1, persist: false); pump()
        check(menuPanel.quotaFooterLabel.stringValue == "正在刷新配额…", "Refreshing quota must show 正在刷新配额…")
        assistant.quotaRefreshing = false

        // Tab 2 (Accounts) empty online & offline
        accounts = []
        assistant.cachedAccounts = []
        assistant.reachable = true
        menuPanel.selectTab(2, persist: false); pump()
        check(menuPanel.accountsCountLabel.stringValue == "0 个账号", "Empty accounts count must be 0 个账号")
        check(allTextValues(menuPanel.accountsCardsStack).contains { $0.contains("暂无账号，请前往主界面添加") }, "Empty accounts tab must show guidance")

        assistant.reachable = false
        menuPanel.selectTab(2, persist: false); pump()
        check(allTextValues(menuPanel.accountsCardsStack).contains { $0.contains("正在等待本机服务读取账号列表…") }, "Offline accounts tab must show waiting message")

        // Restore accounts and reports
        accounts = savedFixtureAccounts
        assistant.reachable = true
        assistant.cachedAccounts = savedMenuAccounts
        assistant.activeAccountId = savedActiveId
        fixtureStatus["liveAccountEmail"] = savedLiveStatus.liveAccountEmail
        assistant.statusValue = savedLiveStatus
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        menuPanel.selectTab(0, persist: false); pump()
        assistant.openMainWindowFromMenuPanel(tab: 0, usagePeriod: 2); pump()
        check(assistant.currentPage == 2 && assistant.usageSelectedPeriod == 2, "Footer deep-link from Usage tab must navigate to UsagePage and carry selected period")
        check(assistant.usagePage!.donutChart.totalUsd == 23.78, "Donut chart must receive total equivalent USD")
        check(!assistant.usagePage!.donutChart.isHidden, "Donut chart must be visible when priced models exist")
        do {
            let sixModels: [[String: Any]] = models + [
                ["model": "gemini-4-hydrogen", "totalTokens": 1200000, "promptTokens": 400000, "candidatesTokens": 50000, "requestCount": 14, "estimatedUsd": 2.40, "priced": true],
                ["model": "gemini-4-carbon", "totalTokens": 800000, "promptTokens": 250000, "candidatesTokens": 40000, "requestCount": 9, "estimatedUsd": 1.15, "priced": true]
            ]
            let usage = assistant.usagePage!
            usage.applyUsagePayload([
                "ok": true, "period": "30d", "snapshotId": "six-model-snapshot",
                "summary": totals.merging(["estimatedUsd": 27.33]) { _, n in n },
                "byModel": sixModels, "todayHourly": [], "dailyTrends": []
            ], period: "30d", segIdx: 2, requestKey: "six-model-test")
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            func findRequestCard(_ v: NSView) -> NSView? {
                if v.identifier?.rawValue == "requests-cache-card" { return v }
                for s in v.subviews { if let found = findRequestCard(s) { return found } }
                return nil
            }
            if let reqCard = findRequestCard(usage.view) {
                let trackFrame = reqCard.convert(usage.cacheTrack.bounds, from: usage.cacheTrack)
                let bottomGap = reqCard.isFlipped ? (reqCard.bounds.height - trackFrame.maxY) : trackFrame.minY
                check(usage.donutLegendStack.arrangedSubviews.count == 5, "6 priced models must render 5 legend rows (got \(usage.donutLegendStack.arrangedSubviews.count))")
                check(bottomGap <= 34, "requests-cache-card must distribute slack symmetrically instead of leaving large bottom gap below cacheTrack (bottomGap=\(bottomGap))")
            } else {
                check(false, "requests-cache-card must exist in UsagePage")
            }
        }
        // Verify rapid page switching does not leave blank view host or drop views
        assistant.selectPage(0); assistant.selectPage(1); assistant.selectPage(0); pump()
        check(assistant.currentPage == 0, "Rapid switching must end on page 0")
        check(assistant.pageHost.subviews.contains(where: { $0 === assistant.overview!.view }), "Overview view must remain in pageHost after rapid switching")
        check(assistant.overview!.view.alphaValue == 1.0, "Overview view alpha must be 1.0 after completing transition")

        let ov = assistant.overview!
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        ov.update(force: true)
        let curHour = Calendar.current.component(.hour, from: Date())
        let expectedCurHourPrefix = String(format: "今日 %02d:00 · ", locale: Locale(identifier: "en_US_POSIX"), curHour)
        check(ov.trendDetailLabel.stringValue.hasPrefix(expectedCurHourPrefix), "Overview trend detail must default to current hour (got \(ov.trendDetailLabel.stringValue))")
        if ov.todayTrendChart.points.count == 24 {
            ov.todayTrendChart.onHoverPoint?(ov.todayTrendChart.points[0])
            check(ov.trendDetailLabel.stringValue == "今日 00:00 · 0 Token", "Overview trend detail must show 今日 00:00 · 0 Token when hovering 00:00 (got \(ov.trendDetailLabel.stringValue))")
            ov.todayTrendChart.onHoverPoint?(ov.todayTrendChart.points[14])
            check(ov.trendDetailLabel.stringValue == "今日 14:00 · 19.6M Token", "Overview trend detail must show 今日 14:00 · 19.6M Token when hovering 14:00 (got \(ov.trendDetailLabel.stringValue))")
            ov.todayTrendChart.onHoverPoint?(nil)
            check(ov.trendDetailLabel.stringValue.hasPrefix(expectedCurHourPrefix), "Overview trend detail must restore current hour when hover exits")
        }
        ov.syncTrendDetailLabel(currentHour: 3)
        check(ov.trendDetailLabel.stringValue == "今日 03:00 · 0 Token" || ov.trendDetailLabel.stringValue == "今日 03:00 · 尚未到达", "Overview trend detail helper must format 03:00 accurately (got \(ov.trendDetailLabel.stringValue))")
        ov.syncTrendDetailLabel()
        check(ov.rightBentoTitleLabel.stringValue == "今日活跃模型", "Overview right Bento card title must be 今日活跃模型")
        check(ov.rightBentoCountBadge.title == "Top 2 / 共 4 个", "Overview right Bento count badge must show Top 2 / 共 4 个")
        check(ov.bentoRightStack.arrangedSubviews.count == 2, "Overview Bento right stack must display 2 subrows")
        func findButtons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? v.subviews.flatMap { findButtons($0) } }
        check(!findButtons(ov.view).contains { $0.title == "管理账号" }, "Overview hero card must not display 管理账号 button")
        if let firstBox = ov.bentoRightStack.arrangedSubviews.first as? NSBox {
            func findBadges(_ v: NSView) -> [PillBadge] { (v as? PillBadge).map { [$0] } ?? v.subviews.flatMap { findBadges($0) } }
            func findShareBars(_ v: NSView) -> [BentoShareBarView] { (v as? BentoShareBarView).map { [$0] } ?? v.subviews.flatMap { findShareBars($0) } }
            check(findBadges(firstBox).allSatisfy { $0.isHidden }, "Active model row must move USD into subtitle without showing a pill badge")
            check(findShareBars(firstBox).count == 1 && findShareBars(firstBox)[0].fraction > 0.7, "Active model subrow must render token share progress bar")
            check(firstBox.accessibilityLabel()?.contains("Gemini 3.8 Flash") == true || firstBox.accessibilityLabel()?.contains("gemini-3.8-flash") == true, "Subrow box must expose VoiceOver accessibility label")
            check(firstBox.toolTip == nil || firstBox.toolTip?.isEmpty == true, "Overview Bento subrows must be read-only without deep-link tooltip")
            check(firstBox.accessibilityRole() == .group, "Subrow box must be an accessible display group, not a button")
        }

        // Test single active model in Overview Bento
        assistant.cachedUsageReportsByPeriod["today"] = [
            "byModel": [models[0]],
            "todayHourly": todayHourly
        ]
        ov.update(force: true)
        check(ov.rightBentoTitleLabel.stringValue == "今日活跃模型", "Single model Bento title must remain 今日活跃模型")
        check(ov.rightBentoCountBadge.title == "1 个模型", "Single model Bento badge must show 1 个模型")
        check(ov.bentoRightStack.arrangedSubviews.count == 2, "Single model Bento must maintain exactly 2 subrows for layout symmetry")
        func allLabels(_ view: NSView) -> [NSTextField] { (view as? NSTextField).map{[$0]} ?? view.subviews.flatMap{allLabels($0)} }
        let singleLabels = allLabels(ov.bentoRightStack).map { $0.stringValue }
        check(singleLabels.contains(where: { $0.contains("占今日全部调用") }), "Single model Bento must state 占今日全部调用")
        check(singleLabels.contains("查看更多模型统计"), "Single model Bento row 2 must provide guide card 查看更多模型统计")

        // Test zero / inactive models in Overview Bento (e.g. 0 tokens & 0 requests)
        assistant.cachedUsageReportsByPeriod["today"] = [
            "byModel": [["model": "inactive-model", "totalTokens": 0, "requestCount": 0]],
            "todayHourly": []
        ]
        ov.update(force: true)
        check(ov.rightBentoTitleLabel.stringValue == "今日活跃模型", "Zero model Bento title must remain 今日活跃模型")
        check(ov.rightBentoCountBadge.title == "暂无调用", "Zero/inactive model Bento badge must show 暂无调用")
        check(ov.bentoRightStack.arrangedSubviews.count == 2, "Empty state Bento must display exactly 2 symmetrical subrows")
        let emptyLabels = allLabels(ov.bentoRightStack).map { $0.stringValue }
        check(emptyLabels.contains("今日暂无模型调用"), "Empty state Bento row 1 must show 今日暂无模型调用")
        check(emptyLabels.contains("模型用量明细"), "Empty state Bento row 2 must show 模型用量明细")
        for box in ov.bentoRightStack.arrangedSubviews.compactMap({ $0 as? NSBox }) {
            check(box.toolTip == nil || box.toolTip?.isEmpty == true, "Both empty state rows must be read-only without deep-link tooltip")
            check(box.accessibilityRole() == .group, "Both empty state rows must be accessible display groups, not buttons")
        }

        // Restore fixture data
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        ov.update(force: true)
        panelHost.orderOut(nil)

        assistant.activeAccountId = "a"
        assistant.confirmSwitchForTesting = { _, reply in reply(true) }
        assistant.switchAccountByIdFromMenu("b")
        check(assistant.activeAccountId == "a","Menu must not optimistically change current identity")
        waitUntil(description: "account switch to complete") {
            switches >= 1 && !assistant.accountSwitchInFlight
        }
        check(switches == 1, "Confirmed fixture switch must run exactly once")
        let opensBeforeIdleSwitch = assistant.openedApplications
        preflightState = "running_idle"
        assistant.switchAccountByIdFromMenu("c")
        waitUntil(description: "running_idle switch to complete and relaunch") {
            switches >= 2 && !assistant.accountSwitchInFlight && assistant.openedApplications > opensBeforeIdleSwitch
        }
        check(switches == 2 && assistant.openedApplications == opensBeforeIdleSwitch + 1, "Switching while Antigravity was running must automatically relaunch Antigravity")
        switches = 1; assistant.activeAccountId = "a"; activeId = "a"
        preflightState = "safe"
        preflightState = "busy"; assistant.switchAccountByIdFromMenu("c"); pump()
        check(switches == 1,"Running official app must block switching")
        preflightState = "error"; assistant.switchAccountByIdFromMenu("c"); pump()
        check(switches == 1,"Failed preflight must not execute")
        preflightState = "safe"; assistant.confirmSwitchForTesting = { _, reply in reply(false) }
        assistant.switchAccountByIdFromMenu("c"); pump(); check(switches == 1,"Cancelled confirmation must not execute")
        let summary = QuotaPresentation.menuAccountSummary(accounts[0]); check(summary.contains("Claude/GPT") && summary.contains("已耗尽"),"Menu must disclose exhausted family")

        // 校验菜单栏图标纯净性：无论配额是否耗尽（当前账号 a 的 Claude 为 0%），图标始终保持纯净 Template 图标，绝不附带警告圆点
        let statusButton = NSButton(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
        let baseIcon = assistant.baseMenuConnectedIcon()
        check(baseIcon != nil, "baseMenuConnectedIcon must load valid icon")
        check(baseIcon?.size == NSSize(width: 20, height: 20), "baseMenuConnectedIcon size must be 20x20")
        check(baseIcon?.isTemplate == true, "baseMenuConnectedIcon must be marked as template for system auto-tinting")
        assistant.updateStatusItemState(buttonOverride: statusButton)
        check(statusButton.image === baseIcon, "Status item image must be baseMenuConnectedIcon")
        check(statusButton.image?.isTemplate == true, "Status item image must remain template without warning dot")
        check(statusButton.alphaValue == 1.0, "Connected status icon must maintain full opacity (1.0)")
        let pausedStatus: [String: Any] = ["mode": "paused", "windows": 1, "entries": 4300, "appVersion": "2.25.0", "liveAccountEmail": "alex@example.invalid", "activeAccountEmail": "alex@example.invalid", "accountsRevision": "fixture", "pid": -1]
        assistant.statusValue = LiveStatus(pausedStatus)
        assistant.updateStatusItemState(buttonOverride: statusButton)
        check(statusButton.alphaValue == 1.0, "Pausing translation must not reduce menu bar icon opacity")
        assistant.statusValue = LiveStatus(status)

        DesktopApplicationTarget.installedChannelsOverride = ["stable", "insiders"]
        Assistant.applicationChannel = "insiders"
        assistant.configuration.value.applicationChannel = "insiders"
        check(assistant.targetApplication.label == "Antigravity" && assistant.targetApplication.name == "Antigravity", "Unified target label and name must always be Antigravity")
        check(assistant.targetApplication.supportsAccountSwitch == true, "Stable Antigravity must support account switching")
        check(assistant.targetApplication.channel == "stable", "Legacy channel cannot redirect native target")
        check(assistant.targetApplication.bundleIdentifier == "com.google.antigravity", "Native target must be stable")
        check(DesktopApplicationTarget.installedChannels() == ["stable"], "Insiders must not be discoverable")
        let stableSettings = PreferencesController(app: assistant)
        check(!allTextValues(stableSettings.view).contains { $0.localizedCaseInsensitiveContains("Insiders") || $0.contains("目标应用") }, "Settings UI must not display target application switcher or Insiders text")
        check(stableSettings.manageCacheBtn.title == "管理存储…", "Storage settings row button must display 管理存储…")
        check(stableSettings.pricingSyncCheckBtn.title == "立即检查" && stableSettings.pricingSyncCheckBtn.intrinsicContentSize.height == 28, "Pricing check button must use fixed-width InlineRefreshButton matching global 28pt height")
        stableSettings.pricingSyncCheckBtn.setBusy(true, available: true)
        check(stableSettings.pricingSyncCheckBtn.isActivitySpinning && stableSettings.pricingSyncCheckBtn.title == "立即检查", "Pricing check button must spin in place without title jump")
        stableSettings.pricingSyncCheckBtn.setBusy(false, available: true)
        stableSettings.refreshStorageRowState(force: true); pump()
        check(!stableSettings.storageBadge.isHidden && stableSettings.storageBadge.title.hasPrefix("可释放 "), "Storage settings row must display reclaimable space pill badge")
        check(!allTextValues(stableSettings.view).contains("检查更新") && !allTextValues(stableSettings.view).contains("关于"), "Settings UI must extract 关于 section out into its own top-level sidebar tab")
        assistant.selectPage(4); pump()
        let aboutPage = assistant.aboutPage!
        check(assistant.names == ["总览", "账号", "用量", "设置", "关于"], "Sidebar must contain 5 top-level tabs ending with 关于")
        check(aboutPage.checkUpdateBtn.title == "检查更新", "About page must display 检查更新 button")
        check(aboutPage.statusLine.isHidden && aboutPage.updateStatusLabel.stringValue.isEmpty, "About page must hide idle status subtitle line")
        check(assistant.installUpdateButton?.isHidden == true, "Sidebar installUpdateButton must stay hidden when no update is available")
        assistant.updateManager.simulateRelease(AppReleaseInfo(
            version: "1.1.0",
            tagName: "v1.1.0",
            title: "GravityBox v1.1.0",
            changelog: "### 更新亮点\n- 新增 GitHub Release 检查更新与后台预下载\n- 毛玻璃更新 Sheet 展示完整 Changelog\n```bash\nsudo xattr -rd com.apple.quarantine /Applications/GravityBox.app\n```\n### 附件 SHA-256 校验\n```text\n7a88a030118d8e58a5f265bf0de61d00f9d26c115d56bad41e52f0969f3b3346  GravityBox-1.0.1-arm64.dmg\n```",
            publishedDate: "2026-11-04",
            htmlURL: URL(string: "https://github.com/Enzoo404/gravitybox/releases/tag/v1.1.0")!,
            dmgURL: nil,
            sha256URL: nil
        ))
        aboutPage.refreshUpdateState()
        check(!aboutPage.installNowBtn.isHidden && aboutPage.updateStatusLabel.stringValue.contains("v1.1.0"), "About page must display inline update prompt and 立即更新 button when update is available")
        check(assistant.installUpdateButton?.isHidden == false && assistant.installUpdateButton?.title == "安装更新" && assistant.installUpdateButton?.badgeText == "v1.1.0" && assistant.installUpdateButton?.isUpdatePrompt == true, "Sidebar must display 安装更新 prompt capsule above 打开 Antigravity when update is available")
        if let installBtn = assistant.installUpdateButton, let openBtn = assistant.launchApplicationButton, let bStack = installBtn.superview as? NSStackView {
            let installIdx = bStack.arrangedSubviews.firstIndex(of: installBtn) ?? -1
            let openIdx = bStack.arrangedSubviews.firstIndex(of: openBtn) ?? -1
            check(installIdx >= 0 && openIdx == installIdx + 1, "安装更新 capsule must sit directly above 打开 Antigravity in sidebar bottomStack")
        }
        // Capture Hero/Overview with sidebar 安装更新 capsule visible
        assistant.selectPage(0); window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 960, height: 640)), display: true); pump()
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            try capture(window.contentView!, output.appendingPathComponent("\(theme)-hero-install-update-capsule.png"))
        }
        assistant.selectPage(4); pump()
        check(aboutPage.releaseNotesBtn.title == "更新日志 ↗" && !aboutPage.releaseNotesBtn.isHidden, "About page must display 更新日志 ↗ button when release is available")
        if let rel = assistant.updateManager.availableRelease {
            let formattedNotes = AppUpdateManager.formatReleaseNotes(rel.changelog)
            check(formattedNotes.contains("• 新增 GitHub Release 检查更新"), "Release notes formatter must format markdown list items into bullets")
            check(!formattedNotes.contains("```") && !formattedNotes.contains("###"), "Release notes formatter must strip raw markdown code fences and heading hashes")
            check(!formattedNotes.contains("sudo xattr") && !formattedNotes.contains("SHA-256"), "Release notes formatter must strip terminal quarantine commands and SHA-256 footer blocks")
        }
        do {
            let updaterScript = AppUpdateManager.buildDetachedUpdaterScript(
                myPid: 12345,
                stagedAppPath: "/tmp/staged/GravityBox.app",
                targetAppPath: "/Applications/GravityBox.app",
                workDirPath: "/tmp/staged",
                dmgFilePath: "/tmp/updates/v1.0.4/GravityBox-1.0.4-arm64.dmg"
            )
            check(updaterScript.contains("HUP TERM INT QUIT PIPE") && updaterScript.contains("kill -9 12345") && updaterScript.contains("--install-update"), "Detached updater must wait for its parent then invoke the transactional helper")
            check(!updaterScript.contains("rm -rf") && !updaterScript.contains("ditto"), "Detached launcher must never delete or copy over the live app")
            check(AppUpdateManager.extractGravityBoxDMGVersion(from: "GravityBox-1.0.4-arm64.dmg") == "1.0.4", "Must extract version from standard arm64 DMG filename")
            check(AppUpdateManager.extractGravityBoxDMGVersion(from: "GravityBox-v1.0.3-universal.dmg.sha256") == "1.0.3", "Must extract version from v-prefixed DMG sha256 sidecar")
            check(AppUpdateManager.extractGravityBoxDMGVersion(from: "OtherApp-1.0.4-arm64.dmg") == nil, "Must ignore unrelated DMG filenames")

            // Test cleanupObsoleteUpdateArtifacts across state/updates and Downloads
            let fm = FileManager.default
            let oldUpdateDir = state.appendingPathComponent("updates/v1.0.3", isDirectory: true)
            let currUpdateDir = state.appendingPathComponent("updates/v1.0.4", isDirectory: true)
            let newerUpdateDir = state.appendingPathComponent("updates/v1.1.0", isDirectory: true)
            let staleInstallDir = state.appendingPathComponent("updates/install-stale", isDirectory: true)
            let staleTxDir = state.appendingPathComponent("updates/transactions/install-aborted", isDirectory: true)
            let confirmedTxDir = state.appendingPathComponent("updates/transactions/install-confirmed", isDirectory: true)
            let fakeDownloadsDir = state.appendingPathComponent("test-downloads", isDirectory: true)
            for dir in [oldUpdateDir, currUpdateDir, newerUpdateDir, staleInstallDir, staleTxDir, confirmedTxDir, fakeDownloadsDir] {
                try fm.createDirectory(at: dir, withIntermediateDirectories: true)
            }
            let confirmedReceipt = UpdateInstallReceipt(phase: "confirmed", token: "tok", targetPath: "/Applications/GravityBox.app", backupPath: "/Applications/.GravityBox-backup-test.app", expectedVersion: "1.0.5", newAppHash: "abc", oldAppHash: "def", dmgPath: "")
            try confirmedReceipt.save(to: confirmedTxDir.appendingPathComponent(UpdateInstaller.receiptName))
            let confirmedStagedApp = confirmedTxDir.appendingPathComponent("GravityBox.app")
            let confirmedHelper = confirmedTxDir.appendingPathComponent("installer")
            try fm.createDirectory(at: confirmedStagedApp, withIntermediateDirectories: true)
            try Data("helper".utf8).write(to: confirmedHelper)
            let oldCachedDMG = oldUpdateDir.appendingPathComponent("GravityBox-1.0.3-arm64.dmg")
            let currCachedDMG = currUpdateDir.appendingPathComponent("GravityBox-1.0.4-arm64.dmg")
            let newerCachedDMG = newerUpdateDir.appendingPathComponent("GravityBox-1.1.0-arm64.dmg")
            let newerPartDMG = newerUpdateDir.appendingPathComponent("download-temp.dmg.part")
            let dlOldDMG = fakeDownloadsDir.appendingPathComponent("GravityBox-1.0.3-arm64.dmg")
            let dlCurrDMG = fakeDownloadsDir.appendingPathComponent("GravityBox-1.0.4-arm64.dmg")
            let dlCurrSha = fakeDownloadsDir.appendingPathComponent("GravityBox-1.0.4-arm64.dmg.sha256")
            let dlNewerDMG = fakeDownloadsDir.appendingPathComponent("GravityBox-1.1.0-arm64.dmg")
            let dlUnrelated = fakeDownloadsDir.appendingPathComponent("Antigravity-2.29.0.dmg")
            for f in [oldCachedDMG, currCachedDMG, newerCachedDMG, newerPartDMG, dlOldDMG, dlCurrDMG, dlCurrSha, dlNewerDMG, dlUnrelated] {
                try Data("dummy".utf8).write(to: f)
            }
            let previousCleanedVersion = assistant.configuration.value.lastCleanedVersion
            let unconfirmedCount = assistant.updateManager.cleanupObsoleteUpdateArtifacts(
                restartedAfterUpdate: true,
                currentVersionOverride: "1.0.4",
                downloadsDirectory: fakeDownloadsDir,
                detachMountedVolumes: false
            )
            check(unconfirmedCount == 0, "Startup, version change and restarted-after-update flags alone must never trigger cleanup")
            for f in [oldCachedDMG, currCachedDMG, newerCachedDMG, newerPartDMG, dlOldDMG, dlCurrDMG, dlCurrSha] {
                check(fm.fileExists(atPath: f.path), "Unconfirmed update must retain packages and checksums")
            }
            check(assistant.configuration.value.lastCleanedVersion == previousCleanedVersion, "Unconfirmed launch must not advance cleanup marker")
            let cleanedCount = assistant.updateManager.cleanupObsoleteUpdateArtifacts(
                successfulLaunchConfirmed: true,
                restartedAfterUpdate: true,
                currentVersionOverride: "1.0.4",
                downloadsDirectory: fakeDownloadsDir,
                detachMountedVolumes: false
            )
            check(cleanedCount >= 6, "cleanupObsoleteUpdateArtifacts must clean obsolete update folders, part files, and <=1.0.4 Downloads DMGs")
            check(!fm.fileExists(atPath: oldUpdateDir.path) && !fm.fileExists(atPath: currUpdateDir.path) && !fm.fileExists(atPath: staleInstallDir.path) && !fm.fileExists(atPath: staleTxDir.path), "Obsolete updates/v<=1.0.4 and install-* directories must be removed")
            check(!fm.fileExists(atPath: confirmedStagedApp.path) && !fm.fileExists(atPath: confirmedHelper.path) && fm.fileExists(atPath: confirmedTxDir.appendingPathComponent(UpdateInstaller.receiptName).path), "Confirmed transaction must clean staged GravityBox.app and installer while retaining install-receipt.json")
            check(fm.fileExists(atPath: newerCachedDMG.path) && !fm.fileExists(atPath: newerPartDMG.path), "Newer pre-downloaded DMG (v1.1.0 > 1.0.4) must be preserved while .dmg.part is cleaned")
            check(!fm.fileExists(atPath: dlOldDMG.path) && !fm.fileExists(atPath: dlCurrDMG.path) && !fm.fileExists(atPath: dlCurrSha.path), "Downloads DMGs and .sha256 for versions <= 1.0.4 must be cleaned")
            check(fm.fileExists(atPath: dlNewerDMG.path) && fm.fileExists(atPath: dlUnrelated.path), "Downloads DMGs for newer versions (>1.0.4) and unrelated apps must be preserved")
            check(assistant.configuration.value.lastCleanedVersion == "1.0.4", "cleanupObsoleteUpdateArtifacts must persist lastCleanedVersion = 1.0.4")
            try? fm.removeItem(at: state.appendingPathComponent("updates"))
            try? fm.removeItem(at: fakeDownloadsDir)

            check(aboutPage.autoUpdateSwitch.state == .off, "Auto update switch on About page must default to off")
            aboutPage.autoUpdateSwitch.state = .on
            aboutPage.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == true, "Toggling About autoUpdateSwitch to on must persist autoUpdateEnabled = true")
            aboutPage.autoUpdateSwitch.state = .off
            aboutPage.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == false, "Toggling About autoUpdateSwitch to off must persist autoUpdateEnabled = false")
            aboutPage.autoUpdateSwitch.state = .on
            aboutPage.toggleAutoUpdate()
            check(assistant.configuration.value.autoUpdateEnabled == true, "Toggling About autoUpdateSwitch back to on must persist autoUpdateEnabled = true")

            assistant.selectPage(0); pump()
            assistant.checkForUpdatesFromMenu(); pump()
            check(assistant.currentPage == 4 && window.activeSheetWindow == nil, "checkForUpdatesFromMenu must navigate inline to About page without opening legacy update sheet")

            if let maintSheet = assistant.preferencesController?.maintenanceSheet {
                maintSheet.show(in: window); pump()
                maintSheet.cachePage.runtimeInfoButton.performClick(nil); pump()
                check(window.activeSheetWindow === maintSheet.sheet && maintSheet.cachePage.detailPopover != nil, "Maintenance sheet and detailPopover must attach before dismissAllSheetsAndPopovers verification")
                assistant.dismissAllSheetsAndPopovers(); waitForSheetDetach(on: window, description: "dismissAllSheetsAndPopovers to detach")
                check(window.activeSheetWindow == nil && maintSheet.cachePage.detailPopover == nil && maintSheet.cachePage.activePopoverKind == nil, "dismissAllSheetsAndPopovers must cleanly end attached modal sheets and detail popovers")
            }
        }

        // Package D: AboutPage states and system specs
        let sampleRelease = AppReleaseInfo(
            version: "1.1.0",
            tagName: "v1.1.0",
            title: "GravityBox v1.1.0",
            changelog: "### 更新亮点\n- 新增功能",
            publishedDate: "2026-11-04",
            htmlURL: URL(string: "https://github.com/Enzoo404/gravitybox/releases/tag/v1.1.0")!,
            dmgURL: nil,
            sha256URL: nil
        )
        assistant.updateManager.simulateDownloading(sampleRelease)
        aboutPage.refreshUpdateState()
        check(aboutPage.cancelDownloadBtn.isHidden == false && aboutPage.updateMetaLabel.stringValue == "下载中", "About page downloading state must show cancel button and 下载中")

        let fakeReadyDMG = state.appendingPathComponent("fake-ready.dmg")
        assistant.updateManager.simulateReadyToInstall(sampleRelease, dmgURL: fakeReadyDMG)
        aboutPage.refreshUpdateState()
        check(aboutPage.installNowBtn.isHidden == false && aboutPage.updateMetaLabel.stringValue == "已校验", "About page readyToInstall state must show installNowBtn and 已校验")

        assistant.updateManager.simulateFailed("本地校验异常")
        aboutPage.refreshUpdateState()
        check(aboutPage.checkUpdateBtn.isHidden == false && aboutPage.updateMetaLabel.stringValue == "可重试" && aboutPage.releaseNotesBtn.isHidden, "About page failed state must show checkUpdateBtn, 可重试 and hide releaseNotesBtn")

        check(!aboutPage.versionSpecLabel.stringValue.isEmpty, "About page versionSpecLabel must not be empty")
        check(aboutPage.versionSpecLabel.stringValue.contains("Antigravity") && !aboutPage.versionSpecLabel.stringValue.contains("Build "), "About page versionSpecLabel must display Antigravity version without Build number")
        let aboutTexts = allTextValues(aboutPage.view)
        check(aboutTexts.contains("自动检查更新") && aboutTexts.contains("运行信息") && aboutTexts.contains("目标应用") && aboutTexts.contains("GravityBox 数据目录"), "Simplified About page must render 自动检查更新, 运行信息, 目标应用 and GravityBox 数据目录")
        check(!aboutTexts.contains("系统环境") && !aboutTexts.contains("构建与环境") && !aboutTexts.contains("本地数据与隐私原则") && !aboutTexts.contains("macOS · arm64") && !aboutTexts.contains { $0.contains("查看历史发行版本") }, "Simplified About page must omit redundant OS, build, privacy, arm64 pill and Releases subtitle rows")
        check(aboutPage.revealDataBtn.title == "在访达中显示", "About page revealDataBtn title must be 在访达中显示")
        check(aboutPage.githubReleasesBtn.title == "GitHub ↗", "About page githubReleasesBtn title must be GitHub ↗")

        assistant.updateManager.simulateRelease(nil)
        aboutPage.refreshUpdateState()
        check(!aboutPage.checkUpdateBtn.isHidden && aboutPage.installNowBtn.isHidden, "Clearing available release must restore 检查更新 button on About page")
        check(!aboutPage.statusLine.isHidden && aboutPage.updateStatusLabel.stringValue == "已是最新版本", "About page must display 已是最新版本 status after checking up-to-date")
        check(assistant.installUpdateButton?.isHidden == true, "Clearing available release must hide sidebar installUpdateButton again")
        check(aboutPage.releaseNotesBtn.isHidden && window.activeSheetWindow == nil, "Clearing available release must hide releaseNotesBtn without opening modal update sheet")
        // Verify unified inactive PillBadge styling across neutral/secondary tints
        let lightApp = NSAppearance(named: .aqua)!
        let darkApp = NSAppearance(named: .darkAqua)!
        for c in [Design.inactivePill, Design.secondary, NSColor.secondaryLabelColor, NSColor.systemGray] {
            check(PillBadge.isNeutralOrInactiveTint(c, in: lightApp), "Neutral/inactive tint must be recognized in Light mode")
            check(PillBadge.isNeutralOrInactiveTint(c, in: darkApp), "Neutral/inactive tint must be recognized in Dark mode")
        }
        check(!PillBadge.isNeutralOrInactiveTint(Design.blue, in: lightApp), "Active blue tint must not be treated as neutral/inactive")
        for scale in [TierBadge.Scale.regular, .compact] {
            check(scale.iconSize(for: .free) == 0, "FREE TierBadge must not reserve icon space for a bullseye")
            check(scale.iconSize(for: .pro) > 0, "PRO TierBadge must retain single-sparkle icon space")
            check(scale.iconSize(for: .ultra) > scale.iconSize(for: .pro), "ULTRA TierBadge must retain twin-sparkle icon space")
            let freeBadge = TierBadge("FREE", scale: scale)
            let proBadge = TierBadge("PRO", scale: scale)
            freeBadge.frame = NSRect(origin: .zero, size: freeBadge.intrinsicContentSize)
            freeBadge.layoutSubtreeIfNeeded()
            if let freeLbl = freeBadge.subviews.compactMap({ $0 as? NSTextField }).first {
                let leftGap = freeLbl.frame.minX
                let rightGap = freeBadge.bounds.width - freeLbl.frame.maxX
                check(abs(leftGap - rightGap) <= 1.0, "FREE TierBadge text must sit symmetrically centered without leading bullseye offset (left=\(leftGap), right=\(rightGap))")
            }
            check(proBadge.intrinsicContentSize.width > 0 && freeBadge.intrinsicContentSize.width > 0, "TierBadge intrinsic width must be positive")
        }

        // Capture Overview in idle (0 active models, 0 hourly tokens) to verify unified inactive capsules
        assistant.selectPage(0); window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 960, height: 640)), display: true); pump()
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": [],
            "todayHourly": []
        ]
        assistant.overview!.updateReadinessMatrix()
        check(assistant.overview!.todayPeakBadge.title == "24 小时分布" && assistant.overview!.rightBentoCountBadge.title == "暂无调用", "Overview idle badges must show 24 小时分布 and 暂无调用")
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.contentView?.layoutSubtreeIfNeeded()
            try capture(window.contentView!, output.appendingPathComponent("\(theme)-overview-idle-pills.png"))
        }
        assistant.cachedUsageReportsByPeriod["today"] = [
            "summary": totals,
            "byModel": models,
            "todayHourly": todayHourly
        ]
        assistant.overview!.updateReadinessMatrix()

        // Verify AccountsPage unified & per-card collapse/expand behavior and removal of Backup button
        assistant.selectPage(1); pump()
        let accPage = assistant.accountsPage!
        accPage.fetch(); pump()
        waitUntil(step: 0.01, description: "AccountsPage fetch to settle before collapse checks") {
            !assistant.accountListInFlight
                && !assistant.accountListPendingRefetch
                && accPage.cardsStack.arrangedSubviews.count == 3
        }
        window.appearance = NSAppearance(named: .aqua)
        window.contentView?.layoutSubtreeIfNeeded(); pump()
        func allAccButtons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? v.subviews.flatMap { allAccButtons($0) } }
        check(!allAccButtons(accPage.view).contains { $0.title == "备份…" || $0.title == "导出备份…" }, "AccountsPage header must remove standalone 备份… and 导出备份… buttons")
        check(accPage.manageAccountsButton.title == "管理账号…" && accPage.manageAccountsButton.toolTip == nil, "AccountsPage header must expose 管理账号… button")
        check((accPage.toggleCollapseAllButton as? DesignButton)?.isQuietAccessory == false, "AccountsPage 收起配额/展开配额 button must match global capsule button style")
        check(accPage.autoSwitchStatusBadge.title == "已停用", "Smart switch disabled state must retain 已停用 pill badge")
        let offSubtitle = accPage.policySubtitleLabel.stringValue
        check(offSubtitle.contains("需手动确认切换"), "Standby advisor subtitle must clarify manual confirmation before switching: \(offSubtitle)")
        accPage.autoSwitchToggle.state = .on
        accPage.updateAutoSwitchState()
        check(accPage.autoSwitchStatusBadge.title.hasPrefix("已启用"), "Smart switch enabled state must display 已启用 pill badge")
        check(accPage.policySubtitleLabel.stringValue == offSubtitle, "Smart switch subtitle must stay consistent between ON and OFF states")
        accPage.autoSwitchToggle.state = .off
        accPage.updateAutoSwitchState()
        check(!accPage.toggleCollapseAllButton.isHidden && accPage.toggleCollapseAllButton.title == "收起配额", "AccountsPage header must show 收起配额 button when cards are expanded")
        let expandedFirstCardHeight = accPage.cardsStack.arrangedSubviews.first?.bounds.height ?? 0
        check(expandedFirstCardHeight > 180, "Expanded account card height must include full quota bars (>180pt)")
        verifyAccountsCardsGeometry(accPage, context: "accounts-all-expanded")

        accPage.toggleCollapseAllAccounts(); pump()
        window.contentView?.layoutSubtreeIfNeeded(); pump()
        check(accPage.isAllCollapsedMode && accPage.collapsedAccountIds.count == 3, "Clicking 收起配额 must collapse all 3 account cards")
        check(accPage.toggleCollapseAllButton.title == "展开配额", "Header button title must switch to 展开配额 when all cards are collapsed")
        check(assistant.configuration.value.accountsCollapsed == true, "Collapsing all accounts must persist accountsCollapsed = true in configuration")
        let collapsedFirstCardHeight = accPage.cardsStack.arrangedSubviews.first?.bounds.height ?? 0
        check(collapsedFirstCardHeight > 40 && collapsedFirstCardHeight < expandedFirstCardHeight - 100, "Collapsed account card height must shrink by >100pt (got \(collapsedFirstCardHeight) vs \(expandedFirstCardHeight))")
        let collapsedTexts = allTextValues(accPage.cardsStack)
        check(collapsedTexts.contains { $0.contains("Gemini 91%") && $0.contains("Claude/GPT 0%") }, "Collapsed account card must display inline quota summary")
        verifyAccountsCardsGeometry(accPage, context: "accounts-all-collapsed")
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            try capture(window.contentView!, output.appendingPathComponent("\(theme)-accounts-collapsed.png"))
        }

        // Toggle single account card expand while others stay collapsed
        let singleBtn = NSButton()
        singleBtn.identifier = NSUserInterfaceItemIdentifier("a")
        accPage.toggleSingleAccountCollapse(singleBtn); pump()
        window.contentView?.layoutSubtreeIfNeeded(); pump()
        check(!accPage.collapsedAccountIds.contains("a") && accPage.collapsedAccountIds.contains("b"), "Per-card collapse button must expand account a while keeping b collapsed")
        check(accPage.toggleCollapseAllButton.title == "收起配额", "When any card is expanded, header button must offer 收起配额")
        verifyAccountsCardsGeometry(accPage, context: "accounts-mixed-collapsed")

        // Collapse all again, then expand all
        accPage.toggleCollapseAllAccounts(); pump()
        check(accPage.collapsedAccountIds.count == 3 && accPage.toggleCollapseAllButton.title == "展开配额", "Clicking 收起配额 when partially expanded must collapse all cards")
        accPage.toggleCollapseAllAccounts(); pump()
        check(accPage.collapsedAccountIds.isEmpty && accPage.toggleCollapseAllButton.title == "收起配额" && assistant.configuration.value.accountsCollapsed == false, "Clicking 展开配额 must expand all cards and persist accountsCollapsed = false")

        let stableAccounts = AccountsPage(app: assistant)
        stableAccounts.updateAutoSwitchState()
        check(stableAccounts.autoSwitchToggle.isEnabled && stableAccounts.configButton.isEnabled, "All account switch controls must remain enabled for stable Antigravity")
        check(!allTextValues(stableAccounts.view).contains { $0.localizedCaseInsensitiveContains("Insiders") }, "Accounts UI must not mention Insiders")
        check(Assistant.desiredActivationPolicy(isWindowVisible: false, isWindowMiniaturized: false, isQuitting: false) == .accessory, "Closed main window must return to .accessory menu-bar-only mode")
        check(Assistant.desiredActivationPolicy(isWindowVisible: true, isWindowMiniaturized: false, isQuitting: false) == .regular, "Visible main window must use .regular mode for Stage Manager and Dock")
        check(Assistant.desiredActivationPolicy(isWindowVisible: false, isWindowMiniaturized: true, isQuitting: false) == .regular, "Miniaturized main window must stay .regular instead of dropping Dock association")
        check(Assistant.desiredActivationPolicy(isWindowVisible: true, isWindowMiniaturized: false, isQuitting: true) == .accessory, "Quitting app must revert to .accessory")
        let stableAdd = AddAccountSheet(app: assistant) {}
        check(stableAdd.currentButton.isEnabled, "Save current account must remain enabled")
        stableAdd.busy(false)
        check(stableAdd.currentButton.isEnabled, "Leaving busy state must keep save current account enabled")
        check(!allTextValues(stableAdd.window.contentView!).contains { $0.localizedCaseInsensitiveContains("Insiders") }, "AddAccountSheet UI must not mention Insiders")
        assistant.pageHost.subviews.forEach { $0.removeFromSuperview() }
        assistant.preferencesController = stableSettings
        assistant.currentPage = -1
        assistant.selectPage(3); window.setContentSize(NSSize(width: 1060, height: 760)); pump()
        try capture(window.contentView!, output.appendingPathComponent("stable-settings.png"))

        // Verify languagePopup, More menu language submenu, reachability, and live zh-Hans <-> en hot-switching
        check(stableSettings.languagePopup.isEnabled == true, "languagePopup must be enabled for supported Antigravity")
        check((stableSettings.hudSwitch as AnyObject) is DesignSwitch && (stableAccounts.autoSwitchToggle as AnyObject) is DesignSwitch, "Switches must use DesignSwitch to stay blue when window is unfocused")
        check(stableSettings.languagePopup.cell is DesignPopUpCell, "languagePopup must use DesignPopUpCell")
        check(stableSettings.languagePopup.fittingSize.width <= 110 && stableSettings.languagePopup.fittingSize.width >= Design.fittedPopUpWidth(stableSettings.languagePopup) - 0.5, "Chinese languagePopup must tightly fit longest option (got \(stableSettings.languagePopup.fittingSize.width))")
        check(stableSettings.refresh.fittingSize.width <= 112 && stableSettings.refresh.fittingSize.width >= Design.fittedPopUpWidth(stableSettings.refresh) - 0.5, "Chinese refresh popup must tightly fit longest option (got \(stableSettings.refresh.fittingSize.width))")
        check(stableSettings.languagePopup.itemArray.compactMap { $0.representedObject as? String } == ["system", "zh-Hans", "en"], "languagePopup must expose system, zh-Hans, and en options")
        check((stableSettings.languagePopup.selectedItem?.representedObject as? String) == "zh-Hans", "languagePopup must select zh-Hans when configuredLanguage=zh-Hans")
        check(stableSettings.languagePopup.toolTip == nil && stableSettings.hudSwitch.toolTip == nil, "Settings language/hud controls must not display hover tooltips")

        let unsupportedPrev = assistant.statusValue
        assistant.statusValue = LiveStatus(["mode": "unsupported", "appVersion": "2.25.0"])
        stableSettings.update()
        check(stableSettings.languagePopup.isEnabled == false && stableSettings.hudSwitch.isEnabled == false, "languagePopup and hudSwitch must disable in unsupported mode")
        assistant.statusValue = unsupportedPrev
        stableSettings.update()

        // Verify More Menu (…) includes 显示语言 submenu directly above 对话状态栏
        let moreMenu = assistant.buildMoreMenu()
        let moreTitles = moreMenu.items.map(\.title)
        if let langIdx = moreTitles.firstIndex(of: "显示语言"), let hudIdx = moreTitles.firstIndex(of: "对话状态栏") {
            check(hudIdx == langIdx + 1, "对话状态栏 must sit directly below 显示语言 in More menu")
            let subCodes = moreMenu.items[langIdx].submenu?.items.compactMap { $0.representedObject as? String } ?? []
            check(subCodes == ["system", "zh-Hans", "en"], "显示语言 submenu must expose system, zh-Hans, and en items")
            let checkedItem = moreMenu.items[langIdx].submenu?.items.first { ($0.representedObject as? String) == "zh-Hans" }
            check(checkedItem?.state == .on, "显示语言 submenu must checkmark active configured language")
        } else {
            check(false, "More menu must contain both 显示语言 and 对话状态栏")
        }

        // Verify global zero-tooltip requirement across all pages and menu panel
        func hasNonEmptyTooltip(_ v: NSView) -> String? {
            if let tip = v.toolTip, !tip.isEmpty { return "\(type(of: v)): \(tip)" }
            for sub in v.subviews {
                if let found = hasNonEmptyTooltip(sub) { return found }
            }
            return nil
        }
        for pageView: NSView in [assistant.overview!.view, assistant.accountsPage!.view, assistant.usagePage!.view, stableSettings.view!, aboutPage.view, menuPanel.view] {
            let found = hasNonEmptyTooltip(pageView)
            check(found == nil, "Global tooltip cleanup violated on view: \(found ?? "")")
        }

        // Verify unreachable backend disables HUD switch & menu toggle while preserving language selection
        assistant.reachable = false
        stableSettings.update()
        check(stableSettings.hudSwitch.isEnabled == false && stableSettings.hudSwitch.toolTip == nil, "hudSwitch must disable without tooltip when backend is unreachable")
        let menuDisabled = assistant.buildMoreMenu()
        check(menuDisabled.items.first { $0.title == "对话状态栏" }?.isEnabled == false, "Menu bar HUD toggle must be disabled when backend is unreachable")
        assistant.reachable = true
        stableSettings.update()
        check(stableSettings.hudSwitch.isEnabled == true, "hudSwitch must re-enable once backend becomes reachable")

        // Verify live global hot-switch to English across main window, more menu, and menu panel
        var enCaptures: [String] = []
        let enFontWindowSize = NSSize(width: 880, height: 580)
        assistant.setGlobalLanguage("en"); pump()
        check(lastLanguageCommand == "en", "setGlobalLanguage(en) must send language_set(en)")
        check(L10n.shared.currentLocale == "en" && assistant.configuration.value.appLanguage == "en", "setGlobalLanguage(en) must update L10n locale and configuration")
        check(assistant.statusValue.translationEnabled == false, "English mode must disable Antigravity translation injection")
        check(assistant.names == ["Overview", "Accounts", "Usage", "Settings", "About"], "Sidebar tabs must hot-switch to English: \(assistant.names)")
        check(assistant.launchApplicationButton?.title == "Open Antigravity", "Sidebar primary CTA must hot-switch to English")
        if let enWinItems = NSApp.windowsMenu?.items {
            let enWinTitles = enWinItems.map(\.title)
            check(["Close Window", "Minimize", "Zoom"].allSatisfy { enWinTitles.contains($0) }, "English Window menu must expose Close Window, Minimize, and Zoom: \(enWinTitles)")
            let zoomItem = enWinItems.first { $0.title == "Zoom" }
            check(zoomItem?.action == #selector(NSWindow.performZoom(_:)) && zoomItem?.target == nil, "English Zoom menu item must dispatch performZoom(_:) via responder chain")
        } else {
            check(false, "NSApp.windowsMenu must be installed in English mode")
        }
        let enMoreMenu = assistant.buildMoreMenu()
        let enMoreTitles = enMoreMenu.items.map(\.title)
        check(enMoreTitles.contains("Display Language") && enMoreTitles.contains("Session HUD") && enMoreTitles.contains("Settings…"), "More menu must hot-switch to English: \(enMoreTitles)")

        window.setContentSize(enFontWindowSize)
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            for page in 0..<5 {
                assistant.selectPage(page); pump(); window.contentView?.layoutSubtreeIfNeeded()
                let capName = "en-\(theme)-880x580-\(page).png"
                try capture(window.contentView!, output.appendingPathComponent(capName))
                enCaptures.append(capName)
                check((window.contentView?.fittingSize.width ?? 0) <= 880, "English page \(page) (\(theme)) exceeds 880pt minimum window width")
            }
        }
        // Assert no CJK Han leakage on static Settings & About UI views when active locale is English
        assistant.selectPage(3); pump()
        let enSettings = assistant.preferencesController!
        check((enSettings.languagePopup.selectedItem?.representedObject as? String) == "en", "English Settings languagePopup must select en")
        check(enSettings.languagePopup.fittingSize.width <= 136 && enSettings.languagePopup.fittingSize.width >= Design.fittedPopUpWidth(enSettings.languagePopup) - 0.5, "English languagePopup must tightly fit longest option (got \(enSettings.languagePopup.fittingSize.width))")
        check(enSettings.refresh.fittingSize.width <= 128 && enSettings.refresh.fittingSize.width >= Design.fittedPopUpWidth(enSettings.refresh) - 0.5, "English refresh popup must tightly fit longest option (got \(enSettings.refresh.fittingSize.width))")
        let hanPattern = "[\\u4E00-\\u9FFF]"
        let allowedNativeNames = Set(L10n.shared.supportedLocales.map(\.nativeName))
        let localizedViews: [(String, NSView)] = [("Settings", enSettings.view!), ("About", assistant.aboutPage!.view)]
        for (label, view) in localizedViews {
            let leaks = allTextValues(view).filter { !allowedNativeNames.contains($0) && $0.range(of: hanPattern, options: .regularExpression) != nil }
            check(leaks.isEmpty, "English \(label) page must not contain untranslated Chinese labels: \(leaks)")
        }

        // Capture Light/Dark English MenuPanel snapshots (Usage / Quota / Accounts)
        let enMenuPanel = assistant.ensureMenuPanelController()
        let enPanelHost = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
        enPanelHost.contentViewController = enMenuPanel
        var enExtraCaptures: [String] = []
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            enPanelHost.appearance = NSAppearance(named: appearance)
            enMenuPanel.selectTab(0, persist: false); enMenuPanel.panelWillOpen(); pump()
            enPanelHost.setContentSize(enMenuPanel.preferredContentSize); enPanelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            let panelName = "en-\(theme)-menu-panel-usage.png"
            try capture(enPanelHost.contentView!, output.appendingPathComponent(panelName))
            enCaptures.append(panelName)
            enMenuPanel.selectTab(1, persist: false); pump()
            enPanelHost.setContentSize(enMenuPanel.preferredContentSize); enPanelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            let quotaName = "en-\(theme)-menu-panel-quota.png"
            try capture(enPanelHost.contentView!, output.appendingPathComponent(quotaName))
            enExtraCaptures.append(quotaName)
            enMenuPanel.selectTab(2, persist: false); pump()
            enPanelHost.setContentSize(enMenuPanel.preferredContentSize); enPanelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            let accName = "en-\(theme)-menu-panel-accounts.png"
            try capture(enPanelHost.contentView!, output.appendingPathComponent(accName))
            enExtraCaptures.append(accName)
        }
        enMenuPanel.selectTab(0, persist: false); pump()
        check(enMenuPanel.tokensTile.titleLabel.stringValue == "Tokens" && enMenuPanel.requestsTile.titleLabel.stringValue == "Requests" && enMenuPanel.costTile.titleLabel.stringValue == "Est. API Cost", "English MenuPanel KPI tiles must use English titles")
        enPanelHost.orderOut(nil)

        // Capture Light/Dark 1100x760 English full-layout main pages & Maintenance sheet for README
        let enFullWindowSize = NSSize(width: 1100, height: 760)
        window.setFrame(NSRect(origin: window.frame.origin, size: enFullWindowSize), display: true)
        for (theme, appearance) in [("light", NSAppearance.Name.aqua), ("dark", NSAppearance.Name.darkAqua)] {
            window.appearance = NSAppearance(named: appearance)
            for page in 0..<5 {
                assistant.selectPage(page); pump()
                if page == 1 {
                    waitUntil(step: 0.01, description: "en-\(theme)-1100x760 AccountsPage to settle") {
                        !assistant.accountListInFlight
                            && !assistant.accountListPendingRefetch
                            && assistant.accountsPage?.activeId == activeId
                    }
                } else if page == 2 {
                    waitUntil(step: 0.01, description: "en-\(theme)-1100x760 UsagePage to settle") {
                        assistant.usagePage?.loading == false
                    }
                }
                window.contentView?.layoutSubtreeIfNeeded()
                let capName = "en-\(theme)-1100x760-\(page).png"
                try capture(window.contentView!, output.appendingPathComponent(capName))
                enExtraCaptures.append(capName)
            }
            assistant.selectPage(3); pump()
            let enMaintSheet = MaintenanceSheetController(app: assistant)
            enMaintSheet.sheet.appearance = NSAppearance(named: appearance)
            enMaintSheet.cachePage.fetch(force: true); pump()
            waitUntil(step: 0.01, description: "en-\(theme) maintSheet scan to complete") { !enMaintSheet.cachePage.busy }
            enMaintSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
            let maintLeaks = allTextValues(enMaintSheet.sheet.contentView!).filter { !allowedNativeNames.contains($0) && $0.range(of: hanPattern, options: .regularExpression) != nil }
            check(maintLeaks.isEmpty, "English Maintenance sheet must not contain untranslated Chinese labels: \(maintLeaks)")
            let maintName = "en-\(theme)-maintenance-sheet.png"
            try capture(enMaintSheet.sheet.contentView!, output.appendingPathComponent(maintName))
            enExtraCaptures.append(maintName)
            enMaintSheet.closeSheet(); pump()
        }

        // Hot-switch back to Simplified Chinese and verify restoration
        assistant.setGlobalLanguage("zh-Hans"); pump()
        check(lastLanguageCommand == "zh-Hans" && L10n.shared.currentLocale == "zh-Hans", "setGlobalLanguage(zh-Hans) must restore Simplified Chinese locale")
        check(assistant.names == ["总览", "账号", "用量", "设置", "关于"], "Sidebar tabs must restore to Chinese")
        if let zhWinItems = NSApp.windowsMenu?.items {
            let zhWinTitles = zhWinItems.map(\.title)
            check(["关闭窗口", "最小化", "缩放"].allSatisfy { zhWinTitles.contains($0) }, "Chinese Window menu must expose 关闭窗口, 最小化, and 缩放: \(zhWinTitles)")
            let zoomItem = zhWinItems.first { $0.title == "缩放" }
            check(zoomItem?.action == #selector(NSWindow.performZoom(_:)) && zoomItem?.target == nil, "Chinese 缩放 menu item must dispatch performZoom(_:) via responder chain")
            check(!window.collectionBehavior.contains(.fullScreenPrimary), "Main window must keep + zoom button behavior without fullScreenPrimary")
        } else {
            check(false, "NSApp.windowsMenu must be installed in Chinese mode")
        }
        window.appearance = nil
        window.setContentSize(NSSize(width: 1060, height: 760))
        assistant.selectPage(3); pump()
        fixtureStatus["translationEnabled"] = true
        fixtureStatus["mode"] = "adaptive"
        assistant.statusValue = LiveStatus(fixtureStatus)
        let restoredSettings = assistant.preferencesController!
        restoredSettings.update()
        check(restoredSettings.hudSwitch.isEnabled == true && restoredSettings.hudSwitch.state == .on, "hudSwitch must default to on and enabled when translation is active")
        restoredSettings.hudSwitch.state = .off
        restoredSettings.toggleHud()
        pump()
        check(lastHudCommandEnabled == false && assistant.configuration.value.hudEnabled == false, "Turning off hudSwitch must send hud_set(false) and persist hudEnabled=false")
        restoredSettings.hudSwitch.state = .on
        restoredSettings.toggleHud()
        pump()
        check(lastHudCommandEnabled == true && assistant.configuration.value.hudEnabled == true, "Turning on hudSwitch must send hud_set(true) and persist hudEnabled=true")

        DesktopApplicationTarget.installedChannelsOverride = ["stable"]
        check(DesktopApplicationTarget.bothInstalled == false, "Single-app mode must report bothInstalled == false")
        check(DesktopApplicationTarget.effectiveChannel(configured: "insiders") == "stable", "Single-app mode must auto-fallback to sole installed app")
        DesktopApplicationTarget.installedChannelsOverride = ["insiders"]
        check(DesktopApplicationTarget.installedChannels().isEmpty, "Insiders alone is not a supported installation")
        check(DesktopApplicationTarget.preferredLaunchPath() == "/Applications/Antigravity.app", "Launch must not fall back to Insiders")
        DesktopApplicationTarget.installedChannelsOverride = nil

        // Exercise the real download/cache path with local fixture bytes; no external requests or installation.
        let updateRoot = state.appendingPathComponent("update-integrity-fixtures")
        try FileManager.default.createDirectory(at: updateRoot, withIntermediateDirectories: true)
        let fakeDMG = updateRoot.appendingPathComponent("source.dmg")
        try Data("synthetic package".utf8).write(to: fakeDMG)
        let malformed = updateRoot.appendingPathComponent("malformed.sha256")
        try Data("invalid".utf8).write(to: malformed)
        let wrongName = updateRoot.appendingPathComponent("wrong-name.sha256")
        try Data((String(repeating: "0", count: 64) + "  Other.dmg\n").utf8).write(to: wrongName)
        let mismatch = updateRoot.appendingPathComponent("mismatch.sha256")
        try Data((String(repeating: "0", count: 64) + "  GravityBox-9.9.9-arm64.dmg\n").utf8).write(to: mismatch)
        let sources: [URL?] = [nil, updateRoot.appendingPathComponent("missing.sha256"), malformed, wrongName, mismatch]
        for source in sources {
            let release = AppReleaseInfo(version: "9.9.9", tagName: "v9.9.9", title: "fixture", changelog: "", publishedDate: "", htmlURL: URL(string: "https://example.invalid")!, dmgURL: fakeDMG, sha256URL: source)
            var finished = false, accepted = false
            assistant.updateManager.preDownloadRelease(release, silent: false) { result in
                if case .success = result { accepted = true }
                finished = true
            }
            waitUntil(description: "preDownloadRelease to finish") {
                finished
            }
            check(finished && !accepted && assistant.updateManager.downloadedDMGURL == nil, "Invalid or missing checksum must never produce an installable package")
        }
        let cachedDMG = state.appendingPathComponent("updates/v9.9.9/GravityBox-9.9.9-arm64.dmg")
        try FileManager.default.createDirectory(at: cachedDMG.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data("previously verified synthetic package".utf8).write(to: cachedDMG)
        let cachedHash = try UpdatePackageIntegrity.fileHash(cachedDMG)
        try Data("\(cachedHash)  \(cachedDMG.lastPathComponent)\n".utf8).write(to: cachedDMG.appendingPathExtension("sha256"))
        try AppUpdateManager.verifyCachedDownload(cachedDMG)
        try Data("tampered cached package".utf8).write(to: cachedDMG)
        var rejectedCache = false
        do { try AppUpdateManager.verifyCachedDownload(cachedDMG) } catch { rejectedCache = true }
        check(rejectedCache, "Cached packages must be rehashed before installation")
        assistant.updateManager.simulateRelease(nil)

        Assistant.applicationChannel = "stable"
        assistant.configuration.value.applicationChannel = "stable"
        // Failed account changes must never export stale contents under the new account name.
        do {
            let isolated = Assistant(state: state.appendingPathComponent("usage-query-contract"))
            isolated.configuration = try ConfigurationStore(state: isolated.state)
            isolated.bridge = BackendBridge(resources: state, state: isolated.state)
            isolated.reachable = true
            var fail = false
            isolated.bridge.fixtureReply = { request in
                if fail { return ["ok": false, "error": "synthetic read failure"] }
                return ["ok": true, "period": request["period"] as? String ?? "today", "selectedAccountId": "all", "snapshotId": "stable-query-snapshot", "summary": ["availability": "complete", "totalTokens": 150, "requestCount": 1, "databasesScanned": 1, "databasesDiscovered": 1], "byModel": [], "dailyTrends": [], "todayHourly": []]
            }
            let page = UsagePage(app: isolated)
            pump()
            fail = true; page.fetch(force: true); pump()
            check(page.statusSummary.stringValue.contains("读取失败"), "Failure feedback must be present")
            fail = false; page.fetch(force: true); pump()
            check(!page.statusSummary.stringValue.contains("读取失败"), "Same snapshot success must clear an earlier failure")
            page.periodSegment.selectedSegment = 1
            fail = true; page.fetch(force: true); pump()
            check(!page.exportButton.isEnabled, "A period mismatch must disable stale export")
            if let overview = assistant.dashboardPage {
                overview.renderSummary([
                    "accounts": ["activeEmail": "test@example.invalid", "activeName": "Test", "activeTier": "PRO", "isLiveVerified": true],
                    "usage": ["todayTokens": 100, "totalTokens": 1000, "estimatedUsd": 0.1, "allTimeEstimatedUsd": 1.0, "requestCount": 1, "totalRequestCount": 10, "databasesScanned": 378, "databasesDiscovered": 378, "failedDatabasesCount": 0, "skippedLargeRecords": 0, "unknownTimeRecords": 0, "hasError": false, "availability": "partial"]
                ], isStaleFallback: false)
                check(overview.usageQualityLabel.isHidden, "Overview usageQualityLabel must remain hidden when 378/378 DBs succeeded with 0 failed/skipped/unknown despite partial historical availability")
            }
            page.updateReadStatus(["databasesScanned": 378, "databasesDiscovered": 378, "failedDatabasesCount": 0, "skippedLargeRecords": 0, "unknownTimeRecords": 0, "unpricedModels": 0, "availability": "partial", "pricing_warnings": ["旧JSON含缺少来源或归属证据的记录，原件已保留；请查看只读账本预览", "历史金额凭据缺少原始用量或时间，已单独保留待核对，不计入Token和请求数"]])
            check(page.footerBox.isHidden, "Usage footerBox must remain hidden in healthy state even with read-only legacy archive notes")
            page.updateReadStatus(["databasesScanned": 377, "databasesDiscovered": 378, "failedDatabasesCount": 1, "skippedLargeRecords": 0, "unknownTimeRecords": 0, "unpricedModels": 0, "availability": "partial"])
            check(!page.footerBox.isHidden && page.statusSummary.stringValue.contains("1"), "Usage footerBox must appear when failedDatabasesCount > 0")
            let pricingSheet = PricingSyncSheetController(app: isolated)

            // Package A: Modal sheet lifecycle, healed count, badge varieties, empty state and recheck
            let testParentWindow = makeHeadlessHostWindow(width: 800, height: 600)
            pricingSheet.show(in: testParentWindow, payload: [
                "synced": true,
                "count": 3,
                "healedCount": 12,
                "version": "2026-11-13",
                "status": ["lastCheckAt": 1794539810722.0, "modelCount": 3],
                "prices": [
                    "gemini-custom": [
                        "input": 0.5, "output": 2.5, "cached": 0.05,
                        "provenance": ["platform": "Custom", "checkedAt": "2026-11-13"]
                    ],
                    "gemini-expired": [
                        "input": 1.0, "output": 5.0, "cached": 0.1,
                        "provenance": ["platform": "Google Cloud", "checkedAt": "2026-01-01"]
                    ],
                    "gemini-legacy": [
                        "input": 0.8, "output": 4.0, "cached": 0.08
                    ]
                ],
                "pricingStatus": ["gemini-custom": "user", "gemini-expired": "expired", "gemini-legacy": "historical"]
            ])
            check(pricingSheet.sheet.sheetParent === testParentWindow, "PricingSyncSheetController must attach to parent window")
            check(pricingSheet.renderedSummaryLines.contains { $0.contains("gemini-custom [自定义]") }, "Must render user pricing status as 自定义")
            check(pricingSheet.renderedSummaryLines.contains { $0.contains("gemini-expired [已过期]") }, "Must render expired pricing status as 已过期")
            check(pricingSheet.renderedSummaryLines.contains { $0.contains("gemini-legacy [参考估算]") }, "Must render default pricing status as 参考估算")
            check(pricingSheet.subtitleLabel.stringValue.contains("已自动补齐 12 条历史未计价记录"), "Must display auto-healed count in subtitle")
            check(allTextValues(pricingSheet.sheet.contentView!).contains("价格基准已同步并补齐历史记录"), "Must display healed title")
            pricingSheet.closeSheet()
            waitForSheetDetach(on: testParentWindow, description: "PricingSyncSheetController to detach")
            check(testParentWindow.attachedSheet == nil, "PricingSyncSheetController must cleanly detach on close")

            // Empty prices dictionary
            pricingSheet.apply(payload: ["synced": true, "prices": [:]])
            check(allTextValues(pricingSheet.sheet.contentView!).contains("暂无可用的模型价格基准记录"), "Empty prices must render empty label")

            // Recheck button
            check(pricingSheet.recheckBtn.title == "重新检查" && pricingSheet.recheckBtn.frame.width >= 88, "Recheck button must be titled 重新检查 with width >= 88")
            pricingSheet.recheck()
            pump()

            // Triggering pricingSheet from PreferencesController
            let testPrefs = PreferencesController(app: isolated)
            isolated.window = testParentWindow
            let prevReply = isolated.bridge.fixtureReply
            isolated.bridge.fixtureReply = { payload in
                if payload["command"] as? String == "pricing_sync_check" {
                    return ["ok": true, "synced": true, "prices": ["model-a": ["input": 1.0, "output": 2.0, "cached": 0.1]]]
                }
                return prevReply?(payload) ?? ["ok": true]
            }
            testPrefs.checkPricingSync()
            pump()
            check(testPrefs.pricingSheet != nil && testPrefs.pricingSheet?.sheet.sheetParent === testParentWindow, "checkPricingSync must show pricingSheet attached to window")
            testPrefs.pricingSheet?.closeSheet()
            waitForSheetDetach(on: testParentWindow, description: "Preferences pricingSheet to detach")
            isolated.bridge.fixtureReply = prevReply

            pricingSheet.apply(payload: [
                "synced": true,
                "count": 2,
                "version": "2026-11-13",
                "status": ["lastCheckAt": 1794539810722.0, "modelCount": 2],
                "prices": [
                    "gemini-3.8-flash": [
                        "input": 0.75, "output": 3.75, "cached": 0.075,
                        "provenance": ["platform": "Google Cloud 标准 Global API", "checkedAt": "2026-11-12", "validUntil": "2026-12-31T23:59:59Z", "sourceUrl": "https://cloud.google.com/vertex-ai/generative-ai/pricing"]
                    ],
                    "gemini-4-hydrogen": [
                        "input": 1.5, "output": 7.5, "cached": 0.075, "cacheWrite": 0,
                        "provenance": ["platform": "Google Cloud 标准 Global API", "checkedAt": "2026-11-13", "sourceUrl": "https://cloud.google.com/model-garden/pricing?hl=en"]
                    ]
                ],
                "pricingStatus": ["gemini-3.8-flash": "confirmed", "gemini-4-hydrogen": "confirmed"],
            ])
            check(pricingSheet.sheet.contentView != nil, "PricingSyncSheetController must populate native sheet view")
            check(hasNonEmptyTooltip(pricingSheet.sheet.contentView!) == nil, "PricingSyncSheetController must have zero hover tooltips even with sourceUrl")
            func allPricingButtons(_ v: NSView) -> [NSButton] { (v as? NSButton).map { [$0] } ?? v.subviews.flatMap { allPricingButtons($0) } }
            check(!allPricingButtons(pricingSheet.sheet.contentView!).contains { $0.title == "复制价格表" }, "PricingSyncSheetController must remove 复制价格表 button")
            check(pricingSheet.closeBtn.title == "完成", "PricingSyncSheetController exit button must be titled 完成")
            check(pricingSheet.subtitleLabel.isHidden && pricingSheet.subtitleLabel.stringValue.isEmpty, "PricingSyncSheetController must hide header subtitle on normal synced state")
            check(pricingSheet.summaryPill.title.hasPrefix("已同步 ") && pricingSheet.summaryPill.title.hasSuffix("· 2 款"), "PricingSyncSheetController pill must display latest sync time and active count: \(pricingSheet.summaryPill.title)")
            check(!pricingSheet.historicalNoteLabel.isHidden && pricingSheet.historicalNoteLabel.stringValue.contains("已下架模型"), "PricingSyncSheetController must explain historical pricing retention")
            check(pricingSheet.renderedSummaryLines.contains { $0.contains("官方定价 2026-11-12 · 优惠至 2026-12-31") } && !pricingSheet.renderedSummaryLines.contains { $0.contains("核对 2026") }, "PricingSyncSheetController must use Plan 1 date wording")
            try capture(pricingSheet.sheet.contentView!, output.appendingPathComponent("light-pricing-sheet.png"))
            pricingSheet.apply(payload: [
                "synced": false,
                "error": "offline",
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 1],
                "prices": [
                    "gemini-4-hydrogen": ["input": 1.5, "output": 7.5, "cached": 0.075]
                ],
                "pricingStatus": ["gemini-4-hydrogen": "confirmed"],
            ])
            check(!pricingSheet.subtitleLabel.isHidden && pricingSheet.subtitleLabel.stringValue == "检查提示：offline", "PricingSyncSheetController must show concise failure reason without unit suffix")
            check(pricingSheet.summaryPill.title.hasSuffix("· 1 款"), "PricingSyncSheetController pill must display failed check time and active count: \(pricingSheet.summaryPill.title)")

            // Real-time active / tier-aware / unpriced live / collapsible retired section assertions (zh-Hans)
            let tierPricingPayload: [String: Any] = [
                "synced": true,
                "version": "2026-11-16",
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 6],
                "unpricedLiveModels": [
                    ["key": "gemini-4.5-live", "displayName": "Gemini 4.5 Live", "disabled": false],
                    ["key": "gemini-4.5-locked", "displayName": "Gemini 4.5 Locked", "disabled": true]
                ],
                "prices": [
                    "gemini-4-other": ["input": 1.2, "output": 6.0, "cached": 0.12],
                    "gemini-4-carbon": ["input": 2.0, "output": 10.0, "cached": 0.2],
                    "gemini-4-argon": ["input": 1.5, "output": 7.5, "cached": 0.15],
                    "gemini-3.8-flash": ["input": 0.75, "output": 3.75, "cached": 0.075]
                ],
                "retiredPrices": [
                    "gemini-2.5-pro": ["input": 1.25, "output": 10.0, "cached": 0.31],
                    "claude-3.5-sonnet": ["input": 3.0, "output": 15.0, "cached": 0.3]
                ],
                "pricingStatus": [
                    "gemini-3.8-flash": "confirmed",
                    "gemini-4-argon": "confirmed",
                    "gemini-4-carbon": "confirmed",
                    "gemini-4-other": "confirmed",
                    "gemini-2.5-pro": "historical",
                    "claude-3.5-sonnet": "confirmed"
                ],
                "modelCatalogState": [
                    "gemini-4.5-live": ["availability": "unpriced_live", "displayName": "Gemini 4.5 Live"],
                    "gemini-4.5-locked": ["availability": "unpriced_live", "displayName": "Gemini 4.5 Locked"],
                    "gemini-3.8-flash": ["availability": "available", "displayName": "Gemini 3.8 Flash", "activeTier": "PRO"],
                    "gemini-4-argon": ["availability": "tier_locked", "displayName": "Gemini 4 Argon", "activeTier": "FREE"],
                    "gemini-4-carbon": ["availability": "other_tier_only", "displayName": "Gemini 4 Carbon", "availableInTiers": ["ULTRA"], "activeTier": "PRO"],
                    "gemini-4-other": ["availability": "other_tier_only", "displayName": "Gemini 4 Other", "availableInTiers": []],
                    "gemini-2.5-pro": ["availability": "retired", "displayName": "Gemini 2.5 Pro"],
                    "claude-3.5-sonnet": ["availability": "retired", "displayName": "Claude 3.5 Sonnet"]
                ]
            ]
            pricingSheet.retiredExpanded = true
            pricingSheet.show(in: testParentWindow, payload: tierPricingPayload)
            pump()
            check(pricingSheet.retiredExpanded == false, "PricingSyncSheetController.show must reset retiredExpanded to false")
            check(pricingSheet.summaryPill.title.hasSuffix("· 6 款"), "summaryPill must count only active + unpriced live (6), excluding retired: \(pricingSheet.summaryPill.title)")
            check(pricingSheet.renderedSummaryLines.count == 6, "renderedSummaryLines must contain 6 active/unpriced entries (got \(pricingSheet.renderedSummaryLines.count))")
            check(pricingSheet.renderedSummaryLines[0].contains("gemini-4.5-live [新上线 · 待定价]"), "First card must be unpriced live model: \(pricingSheet.renderedSummaryLines)")
            check(pricingSheet.renderedSummaryLines[1].contains("gemini-4.5-locked [新上线 · 暂未解锁]"), "Disabled unpriced live model must fold into single combined badge: \(pricingSheet.renderedSummaryLines)")
            check(pricingSheet.renderedSummaryLines[2].hasPrefix("gemini-3.8-flash [已核对]"), "Available rank must precede tier_locked: \(pricingSheet.renderedSummaryLines)")
            check(pricingSheet.renderedSummaryLines[3].hasPrefix("gemini-4-argon [已核对]") && pricingSheet.renderedSummaryLines[3].contains("[暂未解锁]"), "tier_locked rank must follow available")
            check(pricingSheet.renderedSummaryLines[4].hasPrefix("gemini-4-carbon [已核对]") && pricingSheet.renderedSummaryLines[4].contains("[限 ULTRA]"), "other_tier_only must sort Gemini-first by family/series and include named tiers")
            check(pricingSheet.renderedSummaryLines[5].hasPrefix("gemini-4-other [已核对]") && pricingSheet.renderedSummaryLines[5].contains("[其他套餐]"), "other_tier_only with empty availableInTiers must use generic badge")
            check(!pricingSheet.renderedSummaryLines.contains { $0.contains("gemini-2.5-pro") || $0.contains("claude-3.5-sonnet") }, "retiredPrices must be absent from renderedSummaryLines")
            check(pricingSheet.retiredToggleBtn?.isBordered == false && pricingSheet.retiredToggleBtn?.title == "▸ 已下架模型（2 款 · 仅用于历史账单核算）", "Collapsed retiredToggleBtn must show collapsed count title: \(pricingSheet.retiredToggleBtn?.title ?? "nil")")
            check(pricingSheet.retiredListStack?.isHidden == true, "retiredListStack must be hidden by default")
            check(pricingSheet.renderedRetiredSummaryLines.count == 2 && pricingSheet.renderedRetiredSummaryLines[0].contains("gemini-2.5-pro [参考估算]") && pricingSheet.renderedRetiredSummaryLines[1].contains("claude-3.5-sonnet [已核对]"), "renderedRetiredSummaryLines must sort Gemini before third-party models: \(pricingSheet.renderedRetiredSummaryLines)")
            let visibleSheetTexts = allTextValues(pricingSheet.sheet.contentView!)
            check(pricingSheet.subtitleLabel.isHidden && pricingSheet.subtitleLabel.stringValue.isEmpty, "Sheet header subtitle must stay hidden when unpriced banner already explains it: \(pricingSheet.subtitleLabel.stringValue)")
            check(visibleSheetTexts.contains("Gemini 4 Argon") && visibleSheetTexts.contains("Gemini 4.5 Live") && visibleSheetTexts.contains { $0.contains("检测到 2 组新上线模型暂未公布公开单价") }, "Sheet must render displayName and unified unpriced summary banner")
            func findPricingScrollView(_ v: NSView) -> NSScrollView? {
                if let sv = v as? NSScrollView { return sv }
                for sub in v.subviews { if let found = findPricingScrollView(sub) { return found } }
                return nil
            }
            var preExpandScrollY: CGFloat?
            if let sv = findPricingScrollView(pricingSheet.sheet.contentView!) {
                let docH = sv.documentView?.bounds.height ?? 0
                let clipH = sv.contentView.bounds.height
                let targetY = min(30.0, max(0.0, docH - clipH))
                sv.contentView.scroll(to: NSPoint(x: 0, y: targetY))
                sv.reflectScrolledClipView(sv.contentView)
                preExpandScrollY = sv.contentView.bounds.origin.y
            }
            pricingSheet.retiredToggleBtn?.performClick(nil); pump()
            check(pricingSheet.retiredExpanded == true && pricingSheet.retiredListStack?.isHidden == false, "Clicking retiredToggleBtn must expand retiredListStack")
            check(pricingSheet.retiredToggleBtn?.title == "▾ 已下架模型（2 款 · 仅用于历史账单核算）", "Expanded retiredToggleBtn must show expanded count title: \(pricingSheet.retiredToggleBtn?.title ?? "nil")")
            if let beforeY = preExpandScrollY, let sv = findPricingScrollView(pricingSheet.sheet.contentView!) {
                let afterY = sv.contentView.bounds.origin.y
                check(abs(afterY - beforeY) <= 1.0, "Expanding retired section must not jump scroll to bottom (before=\(beforeY), after=\(afterY))")
            }
            pricingSheet.retiredToggleBtn?.performClick(nil); pump()
            check(pricingSheet.retiredExpanded == false && pricingSheet.retiredListStack?.isHidden == true, "Clicking retiredToggleBtn again must collapse retiredListStack")
            pricingSheet.closeSheet(); waitForSheetDetach(on: testParentWindow, description: "Tiered PricingSyncSheetController to detach")

            // Retired-only payload must show toggle button without empty-state message
            pricingSheet.apply(payload: [
                "synced": true,
                "prices": [:],
                "retiredPrices": ["gemini-2.5-pro": ["input": 1.25, "output": 10.0, "cached": 0.31]],
                "pricingStatus": ["gemini-2.5-pro": "historical"],
                "modelCatalogState": ["gemini-2.5-pro": ["availability": "retired", "displayName": "Gemini 2.5 Pro"]],
                "status": ["modelCount": 0]
            ])
            check(pricingSheet.retiredToggleBtn != nil && !allTextValues(pricingSheet.sheet.contentView!).contains("暂无可用的模型价格基准记录"), "Retired-only payload must not show empty-state label")
            var checks = 0
            let manager = isolated.updateManager
            manager.checkTransport = { request, completion in
                checks += 1
                DispatchQueue.global().async {
                    let response = HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)
                    completion(nil, response, nil)
                }
            }
            manager.checkForUpdates(silent: true)
            manager.checkForUpdates(silent: false)
            waitUntil(step: 0.01, description: "first background 403 update check to finish") {
                if case .checking = manager.state { return false }
                return true
            }
            pump()
            check(checks == 1, "Overlapping update checks must share the main-thread busy gate")
            manager.checkForUpdates(silent: false)
            waitUntil(step: 0.01, description: "retry background 403 update check to finish") {
                if case .checking = manager.state { return false }
                return checks == 2
            }
            pump()
            check(checks == 2, "A background 403 must reset busy state so retry can run")
            for (input, expected) in [(999, "999"), (1000, "1K"), (999499, "999K"), (999500, "1M"), (999999, "1M"), (1_000_000, "1M"), (999_500_000, "1B")] {
                check(InterfaceText.formatCompactTokens(input) == expected, "Compact number boundary must match HUD: \(input)")
            }
            let appPaths = ["/Applications/Antigravity.app"]
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/Applications/Antigravity.app/Contents/MacOS/Electron\n",
                    appPaths: appPaths
                ) == true,
                "Executable inside Antigravity.app/Contents must count as running"
            )
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/bin/zsh -c ls /Applications/Antigravity.app/Contents/Resources\n",
                    appPaths: appPaths
                ) == false,
                "Unrelated process mentioning app path in arguments must not block switching"
            )
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --subclient_type hub\n",
                    appPaths: appPaths,
                    includeLanguageServer: true
                ) == true,
                "Standalone language_server must still block full quit when includeLanguageServer=true"
            )
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --subclient_type hub\n",
                    appPaths: appPaths,
                    includeLanguageServer: false
                ) == false,
                "Safe debug relaunch must ignore external/detached language_server when includeLanguageServer=false"
            )
            check(
                Assistant.hasRunningAntigravityProcess(
                    psOutput: "/Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --type=gpu-process\n",
                    appPaths: appPaths,
                    includeLanguageServer: false
                ) == true,
                "Safe debug relaunch must still drain Electron helper processes when includeLanguageServer=false"
            )
            let psTreeWithSidecarOnly = """
            64189 63870 /Applications/Antigravity.app/Contents/Resources/bin/language_server --standalone --enable_sidecars
            69480 64189 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --import=file:///Users/test/.gemini/antigravity/lib/node_modules/sidecar_sdk/register_loader.js main.mjs
            69485 69480 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/Antigravity Helper --custom-worker
            69490 63870 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper.app/Contents/MacOS/chrome_crashpad_handler --monitor-self
            """
            check(
                Assistant.hasRunningAntigravityProcess(
                    psPidPpidArgsOutput: psTreeWithSidecarOnly,
                    appPaths: appPaths,
                    includeLanguageServer: false
                ) == false,
                "Safe debug relaunch must ignore language_server, its sidecar_sdk Antigravity Helper descendants, and chrome_crashpad_handler"
            )
            check(
                Assistant.hasRunningAntigravityProcess(
                    psPidPpidArgsOutput: psTreeWithSidecarOnly,
                    appPaths: appPaths,
                    includeLanguageServer: true
                ) == true,
                "Full quit check with includeLanguageServer=true must still detect language_server and its tree"
            )
            let psTreeWithLiveRenderer = psTreeWithSidecarOnly + "\n63900 63870 /Applications/Antigravity.app/Contents/Frameworks/Antigravity Helper (Renderer).app/Contents/MacOS/Antigravity Helper (Renderer) --type=renderer\n"
            check(
                Assistant.hasRunningAntigravityProcess(
                    psPidPpidArgsOutput: psTreeWithLiveRenderer,
                    appPaths: appPaths,
                    includeLanguageServer: false
                ) == true,
                "Safe debug relaunch must still wait for Chromium renderer/gpu/utility processes"
            )
            check(
                Assistant.describeBlockingAntigravityProcesses(
                    psPidPpidArgsOutput: psTreeWithLiveRenderer,
                    appPaths: appPaths,
                    includeLanguageServer: false
                ) == ["renderer"],
                "Blocking process diagnostics must report sanitized roles excluding language_server tree"
            )
            check(
                Assistant.parseDevToolsActivePort("55777\n/devtools/browser/mock-id\n") == 55777 &&
                Assistant.parseDevToolsActivePort("0\n/devtools/browser/mock-id\n") == nil &&
                Assistant.parseDevToolsActivePort("not-a-port\n") == nil,
                "parseDevToolsActivePort must accept valid TCP ports and reject invalid values"
            )
            check(
                Assistant.hasDebugPortArgument(
                    inPsOutput: "/Applications/Antigravity.app/Contents/MacOS/Antigravity --remote-debugging-port=0\n",
                    appPaths: appPaths
                ) == true &&
                Assistant.hasDebugPortArgument(
                    inPsOutput: "/Applications/Antigravity.app/Contents/MacOS/Antigravity\n",
                    appPaths: appPaths
                ) == false &&
                Assistant.hasDebugPortArgument(
                    inPsOutput: "/Applications/Other.app/Contents/MacOS/Other --remote-debugging-port=0\n",
                    appPaths: appPaths
                ) == false,
                "hasDebugPortArgument must strictly match Antigravity main executable with --remote-debugging-port"
            )
            isolated.suppressLifecycleAutoQuit(seconds: 60.0)
            let longDeadline = isolated.suppressLifecycleAutoQuitUntil
            isolated.suppressLifecycleAutoQuit(seconds: 5.0)
            check(
                isolated.suppressLifecycleAutoQuitUntil >= longDeadline,
                "Shorter lifecycle auto-quit suppression must not shorten an existing longer deadline"
            )

            // Package E: AssistantAccountUsage switch menu and cache invalidation
            isolated.cachedAccounts = []
            let emptyAccountMenu = isolated.buildAccountSwitchMenu()
            check(emptyAccountMenu.items.contains { $0.title == "暂无可用账号快照" }, "Empty account switch menu must show 暂无可用账号快照")
            isolated.cachedAccounts = accounts
            isolated.activeAccountId = "a"
            let fullAccountMenu = isolated.buildAccountSwitchMenu()
            check(fullAccountMenu.items.contains { $0.title == "管理账号…" }, "Account switch menu must contain 管理账号…")
            check(fullAccountMenu.items.contains { $0.title.contains("Alex") && $0.title.contains("PRO") }, "Account switch menu must show account name and tier")

            isolated.cachedUsageReportsByPeriod["today"] = ["summary": totals]
            check(!isolated.cachedUsageReportsByPeriod.isEmpty, "Usage report cache must be populated")
            isolated.invalidateUsageReportCache()
            check(isolated.cachedUsageReportsByPeriod.isEmpty, "invalidateUsageReportCache must clear cachedUsageReportsByPeriod")
            testParentWindow.orderOut(nil)
        }

        // Exercise the real countdown view, rather than a JS reimplementation of its old colors.
        let countdown = QuotaBarView(percentage: 80, resetText: "6天12小时后重置")
        check(countdown.resetLabel.textColor == Design.secondary, "Normal countdown stays neutral")
        countdown.update(percentage: 5, resetText: "3小时后重置")
        check(countdown.resetLabel.textColor == Design.secondary, "Low percentage does not turn a normal reset time into an urgent notice")
        countdown.update(percentage: 50, resetText: "即将重置")
        check(countdown.resetLabel.textColor != Design.secondary, "Imminent reset uses warning color")
        countdown.update(percentage: 50, resetText: "重置时间已过")
        check(countdown.resetLabel.textColor != Design.secondary, "Expired reset uses warning color")

        // Production account quota updates reuse card views, including unchanged snapshots.
        do {
            if assistant.accountsPage == nil { assistant.selectPage(1); pump() }
            let page = assistant.accountsPage!
            let windows = ["gemini":["fiveHour":bucket(80),"weekly":bucket(90)],"claude":["fiveHour":bucket(100),"weekly":bucket(70)]]
            let base: [String: Any] = ["id":"gate-account", "email":"gate@example.invalid", "revision":"gate-revision", "familyWindows":windows]
            page.fetch(["accounts":[base], "activeId":"gate-account"])
            let cards = page.cardsStack.arrangedSubviews
            page.fetch(["accounts":[base], "activeId":"gate-account"])
            check(zip(cards,page.cardsStack.arrangedSubviews).allSatisfy { $0 === $1 }, "Identical snapshots retain card views")
            func quotaViews(_ view: NSView) -> [QuotaBarView] { (view as? QuotaBarView).map{[$0]} ?? view.subviews.flatMap{quotaViews($0)} }
            for (family, key, percent, title) in [("gemini","fiveHour",40.0,"Gemini · 5 小时"),("gemini","weekly",85.0,"Gemini · 每周"),("claude","fiveHour",50.0,"Claude/GPT · 5 小时")] {
                var changed = base
                var nextWindows = windows; nextWindows[family]?[key] = bucket(percent)
                changed["familyWindows"] = nextWindows
                page.fetch(["accounts":[changed], "activeId":"gate-account"])
                check(quotaViews(page.view).contains { $0.titleLabel.stringValue == title && $0.percentageKnown && $0.percentage == Int(percent) }, "Production card refresh observes \(family)/\(key)")
                check(page.cardsStack.arrangedSubviews.count == cards.count && zip(cards,page.cardsStack.arrangedSubviews).allSatisfy { $0 === $1 }, "Account quota changes reuse existing card views")
                let cardTexts = allTextValues(page.cardsStack)
                check(!cardTexts.contains("当前账号") && !cardTexts.contains("已选记录"), "Accounts page active card must not display redundant 当前账号 or 已选记录 pill")
            }
        }

        // Production dashboard identity handling includes mismatch, missing identity and offline states.
        do {
            if assistant.dashboardPage == nil { assistant.selectPage(0); pump() }
            let page = assistant.dashboardPage!
            for (verified, liveEmail, expectedStatus) in [(true,"other@example.invalid","账号不一致"),(true,"gate@example.invalid",""),(true,"",""),(false,"","")] {
                page.renderSummary(["accounts":["activeEmail":"gate@example.invalid", "isLiveVerified":verified, "liveAccountEmail":liveEmail]], isStaleFallback:false)
                check(page.accountStatusLabel.stringValue == expectedStatus, "Production dashboard identity status for \(liveEmail)")
                check(page.activeEmailLabel.stringValue == "gate@example.invalid", "Identity warning preserves saved email")
                check(page.contextPill.isHidden && page.contextMetaLabel.isHidden && page.heroRemoteHostBadge.isHidden, "Dashboard must hide contextPill, contextMetaLabel, and heroRemoteHostBadge when no SSH hosts are active")
                let dashTexts = allTextValues(page.view)
                check(!dashTexts.contains("当前账号") && !dashTexts.contains("已选记录"), "Dashboard must never render 当前账号 or 已选记录 pill")
            }
        }

        // Phase A 1.1.1 regressions: P0-04/P0-06/P0-07, P1-01/P1-09/P1-21/P1-24/P1-25/P1-27/P1-28/P1-29
        do {
            let p1Host = Assistant(state: state.appendingPathComponent("p1-regressions"))
            p1Host.configuration = try ConfigurationStore(state: p1Host.state)
            p1Host.bridge = BackendBridge(resources: state, state: p1Host.state)
            p1Host.reachable = true
            var usageEventsFetches = 0
            p1Host.bridge.fixtureReply = { request in
                let cmd = request["command"] as? String ?? ""
                if cmd == "usage_events" {
                    usageEventsFetches += 1
                    let offset = request["offset"] as? Int ?? 0
                    return [
                        "ok": true, "snapshotId": "log-snap", "generated_at": 1700000000,
                        "scope": "2 DBs", "total": 450,
                        "rows": [["model": "gemini-test", "timestamp_seconds": 1700000000, "input_tokens": 100 + offset, "output_tokens": 50, "cached_tokens": 25, "cache_write_tokens": 25]]
                    ]
                }
                if cmd == "maintenance_scan" {
                    return [
                        "ok": true, "token": "scan-tok-1", "running": false,
                        "retentionDays": request["retentionDays"] as? Int ?? 7,
                        "scannedAt": 1700000000, "totalBytes": 4096, "totalFiles": 4,
                        "entries": [
                            ["name": "Cache", "bytes": 2048, "fileCount": 2, "clearable": true, "category": "safe"],
                            ["name": "GPUCache", "bytes": 1024, "fileCount": 1, "clearable": true, "category": "safe"],
                            ["name": "Code Cache", "bytes": 1024, "fileCount": 1, "clearable": true, "category": "safe"]
                        ],
                        "snapshots": [
                            ["id": "snap-1", "timestamp": 1700000000, "totalBytes": 1024, "restorable": true, "items": ["Cache"]],
                            ["id": "snap-2", "timestamp": 1699990000, "totalBytes": 1024, "restorable": true, "items": ["GPUCache"]]
                        ]
                    ]
                }
                return [
                    "ok": true, "period": request["period"] as? String ?? "today",
                    "selectedAccountId": "all", "snapshotId": "p109-snap",
                    "summary": [
                        "availability": "complete",
                        "totalTokens": 300,
                        "promptTokens": 50,
                        "cachedTokens": 50,
                        "cacheWriteTokens": 100,
                        "requestCount": 3,
                        "estimatedUsd": 0.15,
                        "databasesScanned": 2,
                        "databasesDiscovered": 2
                    ],
                    "byModel": [["model": "claude-sonnet-4.5", "totalTokens": 300, "inputTokens": 50, "outputTokens": 100, "requestCount": 3, "priced": false]],
                    "dailyTrends": [],
                    "todayHourly": [["hour": "2026-11-15 10:00", "totalTokens": 300, "requestCount": 3]]
                ]
            }

            // P0-04 + P1-09: usage page cacheWriteTokens denominator + structured pricing_warning_codes
            let uPage = UsagePage(app: p1Host)
            uPage.fetch(force: true); pump()
            check(uPage.cacheRateMetric.stringValue == "25.0%", "P1-09: UsagePage cacheHitRate denominator must include cacheWriteTokens (expected 25.0%, got \(uPage.cacheRateMetric.stringValue))")
            uPage.updateReadStatus([
                "databasesScanned": 2, "databasesDiscovered": 2,
                "pricing_warning_codes": ["legacy_json_migrated", "legacy_ledger_migrated", "historical_receipts_locked"],
                "pricing_warnings": ["Custom localized migration", "Another internal migration", "Locked receipts notice"]
            ])
            check(uPage.footerBox.isHidden, "P0-04: pricing_warning_codes must filter internal migration warnings regardless of text")
            uPage.updateReadStatus([
                "databasesScanned": 2, "databasesDiscovered": 2,
                "pricing_warnings": ["Legacy JSON archive", "Legacy ledger preserved", "Historical cost receipts"]
            ])
            check(uPage.footerBox.isHidden, "P0-04: English legacy warning prefixes must remain filtered")
            uPage.updateReadStatus([
                "databasesScanned": 2, "databasesDiscovered": 2,
                "pricing_warning_codes": ["pricing_rate_anomaly"],
                "pricing_warnings": ["Pricing interval check needed"]
            ])
            check(!uPage.footerBox.isHidden && uPage.statusSummary.stringValue.contains("Pricing interval check needed"), "P0-04: Unknown warning codes must stay visible")
            check(InterfaceText.isInternalDualWindowError("Dual window unavailable") && InterfaceText.isInternalDualWindowError("双周期缺失") && !InterfaceText.isInternalDualWindowError("HTTP 500"), "P0-04: Dual window error helper must handle English and Chinese")

            // P1-09 + P1-28 + P0-07: MenuPanel cacheWriteTokens, unavailable clearing, cachedRecommendedAccountId + language reopen
            L10n.shared.setLanguage("zh-Hans", notify: false)
            p1Host.cachedUsageReportsByPeriod["today"] = [
                "snapshotId": "menu-p109",
                "summary": [
                    "availability": "complete",
                    "totalTokens": 300,
                    "promptTokens": 50,
                    "cachedTokens": 50,
                    "cacheWriteTokens": 100,
                    "requestCount": 3,
                    "estimatedUsd": 0.15,
                    "databasesScanned": 2,
                    "databasesDiscovered": 2
                ],
                "byModel": [["model": "gemini-test", "totalTokens": 300]],
                "todayHourly": [["hour": "2026-11-15 10:00", "totalTokens": 300, "requestCount": 3]]
            ]
            p1Host.cachedAccounts = [
                ["id": "a", "email": "a@example.invalid", "name": "Alpha", "subscription_tier": "PRO"],
                ["id": "b", "email": "b@example.invalid", "name": "Beta", "subscription_tier": "PRO"]
            ]
            p1Host.activeAccountId = "a"
            p1Host.cachedRecommendedAccountId = "b"
            let mPanel = p1Host.ensureMenuPanelController()
            mPanel.selectTab(0, persist: false); mPanel.panelWillOpen(); pump()
            check(mPanel.cacheTile.valueLabel.stringValue == "25.0%", "P1-09: MenuPanel cacheTile must include cacheWriteTokens in denominator")
            check(!mPanel.trendChart.buckets.isEmpty && !mPanel.modelsListStack.arrangedSubviews.isEmpty, "MenuPanel chart and models must populate on complete data")

            p1Host.cachedUsageReportsByPeriod["today"] = ["summary": ["availability": "unavailable"]]
            mPanel.panelWillOpen(); pump()
            check(mPanel.trendChart.buckets.isEmpty && mPanel.modelsListStack.arrangedSubviews.isEmpty && mPanel.modelsHeaderCountLabel.stringValue.isEmpty && mPanel.toggleModelsButton.isHidden, "P1-28: Unavailable state must clear old MenuPanel trend chart and model rows")

            mPanel.selectTab(2, persist: false); mPanel.panelWillOpen(); pump()
            check(allTextValues(mPanel.accountsCardsStack).contains("推荐备用"), "P0-07: MenuPanel must read cachedRecommendedAccountId even before AccountsPage opens")
            p1Host.setGlobalLanguage("en"); pump()
            check(p1Host.menuPanelController == nil && p1Host.menuPanel?.contentView == nil && p1Host.menuPanel?.contentViewController == nil, "P0-07: Closed panel controller and contentView must clear on language switch")
            let panelCtrlForTest = p1Host.ensureMenuPanelController()
            let floatingPanel = p1Host.ensureMenuPanel(hosting: panelCtrlForTest)
            check(floatingPanel.styleMask.contains(.nonactivatingPanel) && floatingPanel.canBecomeKey && !floatingPanel.canBecomeMain && !floatingPanel.hidesOnDeactivate && floatingPanel.worksWhenModal, "MenuFloatingPanel must use non-activating keyable panel with worksWhenModal so background/Stage Manager clicks open reliably without pulling main window")
            check(floatingPanel.contentViewController == nil && floatingPanel.contentView === panelCtrlForTest.view, "MenuFloatingPanel must attach controller.view directly without contentViewController to prevent preferredContentSize layout conflicts")
            check(panelCtrlForTest.preferredContentSize == .zero, "MenuPanelController hosted in MenuFloatingPanel must clear preferredContentSize so AppKit does not install priority-501 height constraints")
            check(floatingPanel.collectionBehavior.contains(.canJoinAllSpaces) && floatingPanel.collectionBehavior.contains(.fullScreenAuxiliary) && floatingPanel.collectionBehavior.contains(.canJoinAllApplications) && floatingPanel.collectionBehavior.contains(.ignoresCycle), "MenuFloatingPanel must stay reachable across Spaces, full-screen apps, and Stage Manager")
            check(floatingPanel.level == .statusBar && floatingPanel.level.rawValue < NSWindow.Level.popUpMenu.rawValue, "MenuFloatingPanel must sit at .statusBar level (25) so screenshot tools can snap to it and NSMenu layers above it")
            let rootView = panelCtrlForTest.view as? MenuPanelRootView
            check(rootView != nil && rootView?.maskImage != nil && (rootView?.layer?.cornerRadius ?? -1) == 0 && (rootView?.layer?.borderWidth ?? -1) == 0 && rootView?.subviews.last is MenuPanelRimOverlayView, "MenuPanelRootView must use maskImage rounded clipping and top MenuPanelRimOverlayView without layer cornerRadius/border artifacts")
            floatingPanel.setFrame(NSRect(x: 400, y: 300, width: MenuPanelController.panelWidth, height: 420), display: false)
            let anchoredMaxY = floatingPanel.frame.maxY
            p1Host.resizeMenuPanel(to: NSSize(width: MenuPanelController.panelWidth, height: 500), animate: false)
            check(abs(floatingPanel.frame.maxY - anchoredMaxY) <= 1 && abs(floatingPanel.frame.height - 500) <= 1, "Resizing MenuFloatingPanel upward must keep top edge anchored below menu bar (beforeMaxY=\(anchoredMaxY), after=\(floatingPanel.frame))")
            p1Host.resizeMenuPanel(to: NSSize(width: MenuPanelController.panelWidth, height: 360), animate: false)
            check(abs(floatingPanel.frame.maxY - anchoredMaxY) <= 1 && abs(floatingPanel.frame.height - 360) <= 1, "Resizing MenuFloatingPanel downward must keep top edge anchored below menu bar (beforeMaxY=\(anchoredMaxY), after=\(floatingPanel.frame))")
            p1Host.menuPanelController = nil
            p1Host.menuPanel?.contentView = nil
            let reopenedPanel = p1Host.ensureMenuPanelController()
            reopenedPanel.selectTab(2, persist: false); reopenedPanel.panelWillOpen(); pump()
            check(allTextValues(reopenedPanel.accountsCardsStack).contains("Recommended") && !allTextValues(reopenedPanel.accountsCardsStack).contains("推荐备用"), "P0-07: Recreated MenuPanel must preserve recommendation badge in English")

            // P1-28: UsageLog jumpToPage single fetch on blurred Enter
            let sheetHostWin = makeHeadlessHostWindow(width: 820, height: 620)
            let logCtrl = UsageLogController(app: p1Host, period: "today")
            logCtrl.show(in: sheetHostWin) {}
            pump()
            check(usageEventsFetches == 1, "UsageLog initial show must trigger one fetch")
            logCtrl.sheet.makeFirstResponder(logCtrl.pageNumber)
            logCtrl.pageNumber.stringValue = "2"
            logCtrl.jumpToPage(); pump()
            check(usageEventsFetches == 2, "P1-28: UsageLog jumpToPage + focus loss must not double-fetch usage_events (got \(usageEventsFetches))")
            logCtrl.closeSheet(); waitForSheetDetach(on: sheetHostWin, description: "P1-28 UsageLogController to detach")

            // P1-28: Maintenance busy-state locks scanButton, clearButton, switches, retentionPopup & restoreLatestButton
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let cacheCtrl = CachePage(app: p1Host)
            cacheCtrl.fetch(force: true); pump()
            cacheCtrl.fetch(force: true)
            check(cacheCtrl.busy && !cacheCtrl.scanButton.isEnabled && !cacheCtrl.retentionPopup.isEnabled && !cacheCtrl.clearButton.isEnabled && !cacheCtrl.runtimeCacheSwitch.isEnabled && !cacheCtrl.historyLogsSwitch.isEnabled && !cacheCtrl.restoreLatestButton.isEnabled, "P1-28: Maintenance busy state must disable all interactive controls during scan")
            pump()
            check(!cacheCtrl.busy && cacheCtrl.scanButton.isEnabled && cacheCtrl.runtimeCacheSwitch.isEnabled && cacheCtrl.restoreLatestButton.isEnabled, "Maintenance scan completion must restore interactive controls")

            // Verify blocked sub-items (e.g. symlinked GPUCache) are silently skipped in 2-bucket projection & smart_clear dispatches scopes cleanly
            var smartClearedScopes: [String] = []
            let prevP1Reply = p1Host.bridge.fixtureReply
            p1Host.bridge.fixtureReply = { request in
                let cmd = request["command"] as? String ?? ""
                if cmd == "maintenance_scan" {
                    return [
                        "ok": true, "token": "scan-tok-partial-block", "running": false,
                        "retentionDays": 7, "scannedAt": 1700000010, "totalBytes": 3072, "totalFiles": 3,
                        "trashDir": "/tmp/gb-fallback-trash", "usingFallbackTrash": true,
                        "entries": [
                            ["name": "Cache", "bytes": 2048, "fileCount": 2, "clearable": true, "category": "safe", "defaultSelected": true],
                            ["name": "Code Cache", "bytes": 1024, "fileCount": 1, "clearable": true, "category": "safe", "defaultSelected": true],
                            ["name": "GPUCache", "bytes": 0, "fileCount": 0, "clearable": false, "reason": "缓存含符号链接，已跳过", "category": "safe", "defaultSelected": true]
                        ],
                        "snapshots": []
                    ]
                }
                if cmd == "maintenance_smart_clear" {
                    smartClearedScopes = (request["scopes"] as? [String]) ?? []
                    return ["ok": true, "moved": 2, "clearedBytes": 3072, "trashDir": "/tmp/gb-fallback-trash", "usingFallbackTrash": true, "supersededSnapshotPaths": []]
                }
                return prevP1Reply?(request) ?? ["ok": true]
            }
            cacheCtrl.fetch(force: true); pump()
            check(cacheCtrl.clearButton.isEnabled && cacheCtrl.runtimeBucketBytes == 3072 && cacheCtrl.restoreLatestButton.isHidden && cacheCtrl.usingFallbackTrash && cacheCtrl.activeTrashPath == "/tmp/gb-fallback-trash", "Blocked sub-item must be silently skipped while keeping healthy runtime bucket enabled")
            cacheCtrl.clearSelectedCaches(); pump()
            check(smartClearedScopes == ["runtime_cache"], "clearSelectedCaches must dispatch maintenance_smart_clear with active scopes")
            p1Host.bridge.fixtureReply = prevP1Reply
            sheetHostWin.orderOut(nil)

            // P0-06: Open modal sheets remain alive & interactive while background window re-localizes on language change
            assistant.setGlobalLanguage("zh-Hans"); pump()
            assistant.selectPage(3); pump()
            let sheetObj = PricingSyncSheetController(app: assistant)
            assistant.preferencesController?.pricingSheet = sheetObj
            sheetObj.show(in: window, payload: ["synced": true, "prices": [:], "status": ["modelCount": 0]]) { [weak prefs = assistant.preferencesController] in
                prefs?.pricingSheet = nil
            }
            pump()
            check(window.activeSheetWindow === sheetObj.sheet, "P0-06: PricingSyncSheetController must attach before language switch")
            assistant.setGlobalLanguage("en"); pump()
            check(window.activeSheetWindow === sheetObj.sheet && sheetObj.closeBtn.target != nil, "P0-06: PricingSyncSheetController must stay retained and responsive across live language change")
            check(assistant.names == ["Overview", "Accounts", "Usage", "Settings", "About"], "P0-06: Background main window must re-localize while modal sheet stays open")
            sheetObj.closeBtn.performClick(nil); waitForSheetDetach(on: window, description: "P0-06 PricingSyncSheetController to detach")
            check(window.activeSheetWindow == nil, "P0-06: PricingSyncSheetController close button must dismiss cleanly after language switch")

            assistant.selectPage(1); pump()
            let policySheet = AccountPolicySheet(app: assistant, config: ["strategy": "priority", "monitored_model": "gemini", "reserve_percentage": 10, "candidate_min_percentage": 30]) {}
            assistant.accountsPage?.policySheet = policySheet
            policySheet.show(in: window) { [weak page = assistant.accountsPage] in
                page?.policySheet = nil
            }
            pump()
            check(window.activeSheetWindow === policySheet.window, "P0-06: AccountPolicySheet must attach before language switch")
            assistant.setGlobalLanguage("zh-Hans"); pump()
            check(window.activeSheetWindow === policySheet.window && assistant.names == ["总览", "账号", "用量", "设置", "关于"], "P0-06: AccountPolicySheet must stay open while background window switches back to Chinese")
            policySheet.cancel(); waitForSheetDetach(on: window, description: "P0-06 AccountPolicySheet to detach")
            check(window.activeSheetWindow == nil, "P0-06: AccountPolicySheet cancel must work after language switch")

            // P1-01, P1-21, P1-25, P1-27, P1-29 English assertions
            assistant.setGlobalLanguage("en"); pump()
            let updateBuild = assistant.updateManager.currentBuildDisplay
            check((Int(updateBuild) ?? 0) >= 10101, "P1-01: UpdateManager currentBuildDisplay fallback/build must be >= 10101 (got \(updateBuild))")
            let updaterScript = AppUpdateManager.buildDetachedUpdaterScript(myPid: 99999, workDirPath: "/tmp/gb-upd", i18nDirPath: "/tmp/gb-upd/i18n", appLanguage: "en")
            let expectedUpdaterExport = String(AppUpdateManager.shellQuote("export GRAVITYBOX_I18N_DIR=" + AppUpdateManager.shellQuote("/tmp/gb-upd/i18n") + " GRAVITYBOX_LANGUAGE=" + AppUpdateManager.shellQuote("en")).dropFirst().dropLast())
            check(updaterScript.contains(expectedUpdaterExport), "P1-21: Updater script must propagate GRAVITYBOX_I18N_DIR and GRAVITYBOX_LANGUAGE")
            let cleanedNotes = AppUpdateManager.formatReleaseNotes("## Checksum\nsha256: abc\n## Release Notes\n- English layout polish\n")
            check(!cleanedNotes.contains("Checksum") && cleanedNotes.contains("English layout polish"), "P1-25: Boilerplate heading filter must drop English Checksum sections")
            let wideRefreshBtn = InlineRefreshButton("Check for Updates", width: 124, target: nil, action: #selector(PricingSyncSheetController.closeSheet))
            check(wideRefreshBtn.intrinsicContentSize.width > 124, "P1-27: InlineRefreshButton must expand beyond 124pt for longer English label (got \(wideRefreshBtn.intrinsicContentSize.width))")

            assistant.selectPage(0); pump()
            check(assistant.dashboardPage?.usageMetric.allowsDefaultTighteningForTruncation == true, "P1-27: Overview cost metric must enable allowsDefaultTighteningForTruncation")
            let enModelRow = ModelUsageRow(name: "unpriced-test", tokens: "100", input: "50", output: "50", requests: 1, cost: L10n.t("menu_panel.usage.unpriced"), share: 100, isUnpriced: true)
            check(enModelRow.costLabel.textColor == Design.secondary && enModelRow.costLabel.stringValue != "未计价", "P1-25: English unpriced model row must style cleanly without Chinese sentinel")

            let enUsagePage = UsagePage(app: p1Host)
            enUsagePage.fetch(force: true); pump()
            let usageTexts = allTextValues(enUsagePage.view)
            check(usageTexts.allSatisfy { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) == nil }, "P1-29: English UsagePage must not leak Chinese characters: \(usageTexts.filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil })")
            let enMaintSheet = MaintenanceSheetController(app: p1Host)
            enMaintSheet.cachePage.fetch(force: true); pump()
            enMaintSheet.sheet.contentView?.layoutSubtreeIfNeeded(); pump()
            let maintTexts = allTextValues(enMaintSheet.sheet.contentView!)
            check(maintTexts.allSatisfy { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) == nil }, "English MaintenanceSheetController must not leak Chinese characters: \(maintTexts.filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil })")
            check(hasNonEmptyTooltip(enMaintSheet.sheet.contentView!) == nil, "MaintenanceSheetController must have zero hover tooltips")
            for enLbl in [enMaintSheet.cachePage.reclaimableTitleLabel, enMaintSheet.cachePage.reclaimableValueLabel, enMaintSheet.cachePage.heroSubtitleLabel, enMaintSheet.cachePage.safeLegendLabel, enMaintSheet.cachePage.statefulLegendLabel, enMaintSheet.cachePage.protectedLegendLabel, enMaintSheet.cachePage.runtimeTitleLabel, enMaintSheet.cachePage.runtimeSubtitleLabel, enMaintSheet.cachePage.historyTitleLabel, enMaintSheet.cachePage.historySubtitleLabel, enMaintSheet.cachePage.recoveryTitleLabel, enMaintSheet.cachePage.recoverySubtitleLabel] where !enLbl.isHidden && !enLbl.stringValue.isEmpty {
                let natW = (enLbl.stringValue as NSString).size(withAttributes: [.font: enLbl.font!]).width
                check(enLbl.bounds.width + 1.5 >= floor(natW), "English Maintenance label must not truncate (\(enLbl.stringValue)): \(enLbl.bounds.width) < \(natW)")
            }
            // Verify all 4 Maintenance NSPopover kinds & running confirmation in English mode (both minimal fixture & Chinese-titled main fixture) emit zero CJK & zero tooltips
            let enMainCache = assistant.cachePage ?? CachePage(app: assistant)
            enMainCache.fetch(force: true); pump()
            for (hostLabel, targetCache) in [("minimal", enMaintSheet.cachePage), ("mainFixture", enMainCache)] {
                let confirmEn = targetCache.buildRunningClearConfirmationBody()
                check(confirmEn.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) == nil && (confirmEn.contains("selected categories") || confirmEn.contains("selected category")), "English \(hostLabel) confirmation body must not leak CJK: \(confirmEn)")
                for kind in [CachePage.DetailKind.runtime, .history, .protected, .snapshot] {
                    targetCache.openDetailPopover(kind, relativeTo: targetCache.runtimeInfoButton)
                    guard let popView = targetCache.detailPopover?.contentViewController?.view else {
                        check(false, "English \(hostLabel) popover \(kind.rawValue) must build contentViewController")
                        continue
                    }
                    let popTexts = allTextValues(popView)
                    let popLeaks = popTexts.filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil }
                    check(popLeaks.isEmpty, "English \(hostLabel) \(kind.rawValue) popover must not leak Chinese characters: \(popLeaks)")
                    check(hasNonEmptyTooltip(popView) == nil, "English \(hostLabel) \(kind.rawValue) popover must have zero hover tooltips")
                    if kind == .runtime {
                        check(popTexts.contains("App Runtime Caches") && popTexts.contains("Network & Static Asset Cache"), "English \(hostLabel) runtime popover must localize catalog titles: \(popTexts)")
                    } else if kind == .protected {
                        check(popTexts.contains("Protected Core Data") && popTexts.contains("Never Touched"), "English \(hostLabel) protected popover must render Never Touched badge: \(popTexts)")
                    } else if kind == .snapshot {
                        check(popTexts.contains("Last Cleanup Snapshot") && popTexts.contains("Network & Static Asset Cache"), "English \(hostLabel) snapshot popover must localize snapshot itemTitles: \(popTexts)")
                    }
                }
                targetCache.dismissDetailPopover()
            }

            // English pricing sheet localization & live language switch coverage
            let enPricingHost = Assistant(state: state.appendingPathComponent("en-pricing-sheet"))
            enPricingHost.configuration = try ConfigurationStore(state: enPricingHost.state)
            enPricingHost.bridge = BackendBridge(resources: state, state: enPricingHost.state)
            let enPricingPayload: [String: Any] = [
                "synced": true,
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 4],
                "unpricedLiveModels": [
                    ["key": "gemini-4.5-live", "displayName": "Gemini 4.5 Live", "disabled": false]
                ],
                "prices": [
                    "gemini-3.8-flash": ["input": 0.75, "output": 3.75, "cached": 0.075],
                    "gemini-4-argon": ["input": 1.5, "output": 7.5, "cached": 0.15],
                    "gemini-4-carbon": ["input": 2.0, "output": 10.0, "cached": 0.2]
                ],
                "retiredPrices": [
                    "claude-3.5-sonnet": ["input": 3.0, "output": 15.0, "cached": 0.3],
                    "gemini-2.5-pro": ["input": 1.25, "output": 10.0, "cached": 0.31]
                ],
                "pricingStatus": [
                    "gemini-3.8-flash": "confirmed",
                    "gemini-4-argon": "confirmed",
                    "gemini-4-carbon": "confirmed",
                    "claude-3.5-sonnet": "confirmed",
                    "gemini-2.5-pro": "historical"
                ],
                "modelCatalogState": [
                    "gemini-4.5-live": ["availability": "unpriced_live", "displayName": "Gemini 4.5 Live"],
                    "gemini-3.8-flash": ["availability": "available", "displayName": "Gemini 3.8 Flash"],
                    "gemini-4-argon": ["availability": "tier_locked", "displayName": "Gemini 4 Argon"],
                    "gemini-4-carbon": ["availability": "other_tier_only", "displayName": "Gemini 4 Carbon", "availableInTiers": ["ULTRA"]],
                    "claude-3.5-sonnet": ["availability": "retired", "displayName": "Claude 3.5 Sonnet"],
                    "gemini-2.5-pro": ["availability": "retired", "displayName": "Gemini 2.5 Pro"]
                ]
            ]
            assistant.setGlobalLanguage("zh-Hans"); pump()
            let enPricingSheet = PricingSyncSheetController(app: enPricingHost)
            enPricingSheet.show(in: window, payload: enPricingPayload)
            pump()
            check(enPricingSheet.retiredToggleBtn?.title == "▸ 已下架模型（2 款 · 仅用于历史账单核算）", "Live switch test starts in zh-Hans before switching to en")
            assistant.setGlobalLanguage("en"); pump()
            check(enPricingSheet.retiredToggleBtn?.title == "▸ Deprecated Models (2 · Historical Ledger Only)", "Live setGlobalLanguage(\"en\") must localize collapsed toggle title: \(enPricingSheet.retiredToggleBtn?.title ?? "nil")")
            enPricingSheet.retiredToggleBtn?.performClick(nil); pump()
            check(enPricingSheet.retiredToggleBtn?.title == "▾ Deprecated Models (2 · Historical Ledger Only)", "Expanded English toggle title must match spec: \(enPricingSheet.retiredToggleBtn?.title ?? "nil")")
            let enPricingTexts = allTextValues(enPricingSheet.sheet.contentView!)
            check(enPricingSheet.subtitleLabel.isHidden && enPricingSheet.subtitleLabel.stringValue.isEmpty, "English pricing sheet header subtitle must stay hidden when unpriced banner is shown: \(enPricingSheet.subtitleLabel.stringValue)")
            check(enPricingTexts.contains("New · Unpriced") && enPricingTexts.contains("Locked") && enPricingTexts.contains("ULTRA Only") && enPricingTexts.contains("Deprecated") && enPricingTexts.contains { $0.contains("Detected 1 newly launched model(s) without public rates yet") }, "English pricing sheet must localize all badges and unified banner: \(enPricingTexts)")
            let enPricingCjkLeaks = enPricingTexts.filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil }
            check(enPricingCjkLeaks.isEmpty, "English pricing sheet must not leak Chinese characters: \(enPricingCjkLeaks)")
            enPricingSheet.closeSheet(); waitForSheetDetach(on: window, description: "English PricingSyncSheetController to detach")

            assistant.setGlobalLanguage("zh-Hans"); pump()

            // Antigravity hostOrder native ordering + 0-to-1 pill decluttering + non-truncated model IDs
            let orderedHostSheet = PricingSyncSheetController(app: enPricingHost)
            let hostOrderPayload: [String: Any] = [
                "synced": true,
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 11],
                "prices": [
                    "claude-sonnet-4-6": ["input": 3.0, "output": 15.0, "cached": 0.3],
                    "gemini-3-flash": ["input": 0.5, "output": 3.0, "cached": 0.05],
                    "claude-opus-4-6": ["input": 5.0, "output": 25.0, "cached": 0.5, "cacheWrite": 6.25],
                    "gemini-4-carbon": ["input": 2.0, "output": 10.0, "cached": 0.1, "provenance": ["checkedAt": "2026-11-13", "validUntil": "2026-11-30T23:59:59Z", "sourceUrl": "https://cloud.google.com/model-garden/pricing?hl=en"]],
                    "gpt-oss-120b": ["input": 0.15, "output": 0.6, "cached": 0.075],
                    "claude-sonnet-5-5": ["input": 2.0, "output": 10.0, "cached": 0.1, "cacheWrite": 2.5],
                    "claude-opus-5-5": ["input": 4.0, "output": 20.0, "cached": 0.2, "cacheWrite": 5.0],
                    "gemini-3.8-flash": ["input": 0.75, "output": 3.75, "cached": 0.075],
                    "gemini-4-hydrogen": ["input": 1.5, "output": 7.5, "cached": 0.075],
                    "gemini-4-argon": ["input": 1.5, "output": 7.5, "cached": 0.075],
                    "gemini-4-neon": ["input": 2.5, "output": 12.5, "cached": 0.25]
                ],
                "pricingStatus": [
                    "gemini-4-neon": "confirmed",
                    "gemini-4-argon": "confirmed",
                    "gemini-4-hydrogen": "confirmed",
                    "gemini-3.8-flash": "confirmed",
                    "claude-opus-5-5": "confirmed",
                    "claude-sonnet-5-5": "confirmed",
                    "gpt-oss-120b": "historical",
                    "gemini-4-carbon": "confirmed",
                    "gemini-3-flash": "historical",
                    "claude-opus-4-6": "confirmed",
                    "claude-sonnet-4-6": "confirmed"
                ],
                "modelCatalogState": [
                    "gemini-4-neon": ["availability": "available", "displayName": "Gemini 4 Neon", "hostOrder": 0],
                    "gemini-4-argon": ["availability": "available", "displayName": "Gemini 4 Argon", "hostOrder": 1],
                    "gemini-4-hydrogen": ["availability": "available", "displayName": "Gemini 4 Hydrogen", "hostOrder": 2],
                    "gemini-3.8-flash": ["availability": "available", "displayName": "Gemini 3.8 Flash", "hostOrder": 3],
                    "claude-opus-5-5": ["availability": "available", "displayName": "Claude Opus 5.5", "hostOrder": 4],
                    "claude-sonnet-5-5": ["availability": "available", "displayName": "Claude Sonnet 5.5", "hostOrder": 5],
                    "gpt-oss-120b": ["availability": "available", "displayName": "GPT-OSS 120B", "hostOrder": 6],
                    "gemini-4-carbon": ["availability": "tier_locked", "displayName": "Gemini 4 Carbon", "hostOrder": 7],
                    "gemini-3-flash": ["availability": "other_tier_only", "displayName": "Gemini 3 Flash", "availableInTiers": ["FREE"]],
                    "claude-opus-4-6": ["availability": "other_tier_only", "displayName": "Claude Opus 4.6", "availableInTiers": ["FREE"]],
                    "claude-sonnet-4-6": ["availability": "other_tier_only", "displayName": "Claude Sonnet 4.6", "availableInTiers": ["FREE"]]
                ]
            ]
            orderedHostSheet.show(in: window, payload: hostOrderPayload)
            pump()
            let orderedKeys = orderedHostSheet.renderedSummaryLines.compactMap { $0.split(separator: " ").first.map(String.init) }
            check(orderedKeys == [
                "gemini-4-neon", "gemini-4-argon", "gemini-4-hydrogen", "gemini-3.8-flash",
                "claude-opus-5-5", "claude-sonnet-5-5", "gpt-oss-120b", "gemini-4-carbon",
                "gemini-3-flash", "claude-opus-4-6", "claude-sonnet-4-6"
            ], "Option 1 must follow Antigravity hostOrder for current plan then Gemini-first other plans (got \(orderedKeys))")
            func countPills(in view: NSView) -> Int {
                (view is PillBadge ? 1 : 0) + view.subviews.reduce(0) { $0 + countPills(in: $1) }
            }
            func collectTextFields(_ v: NSView) -> [NSTextField] {
                ((v as? NSTextField).map { [$0] } ?? []) + v.subviews.flatMap { collectTextFields($0) }
            }
            let cards = orderedHostSheet.listStack.arrangedSubviews.compactMap { $0 as? DesignCardBox }
            check(cards.count == 11, "Expected 11 model cards (got \(cards.count))")
            check(cards.allSatisfy { countPills(in: $0) <= 1 }, "Every pricing card must show at most 1 pill badge")
            check(countPills(in: cards[0]) == 0, "Confirmed available model card (gemini-4-neon) must show 0 pills for visual clarity")
            check(countPills(in: cards[6]) == 0 && allTextValues(cards[6]).contains { $0.contains("参考估算") }, "Historical available card (gpt-oss-120b) must show 0 pills and move 参考估算 to line 2 metadata")
            check(countPills(in: cards[7]) == 1 && allTextValues(cards[7]).contains("暂未解锁"), "Locked current-plan card must show single 暂未解锁 pill")
            let orderedTexts = allTextValues(orderedHostSheet.sheet.contentView!)
            check(orderedTexts.contains("当前账号模型") && orderedTexts.contains("其他套餐模型"), "Section headers must separate current and other plan models")
            check(!orderedTexts.contains("已核对"), "Verified available cards must omit redundant 已核对 pills")
            orderedHostSheet.sheet.contentView?.layoutSubtreeIfNeeded()
            check(abs(orderedHostSheet.listScroll.bounds.height - (orderedHostSheet.listCard.bounds.height - 20)) <= 1.0, "Pricing listScroll must fill listCard vertically without bottom blank gap (scrollH=\(orderedHostSheet.listScroll.bounds.height), cardH=\(orderedHostSheet.listCard.bounds.height))")
            if let carbonKeyLabel = collectTextFields(cards[7]).first(where: { $0.stringValue == "gemini-4-carbon" }) {
                let natW = (carbonKeyLabel.stringValue as NSString).size(withAttributes: [.font: carbonKeyLabel.font!]).width
                check(carbonKeyLabel.bounds.width + 1.0 >= ceil(natW), "Model key label must not truncate when single pill + moved date free row width (\(carbonKeyLabel.bounds.width) < \(natW))")
            } else {
                check(false, "Expected full gemini-4-carbon key label on locked card")
            }
            orderedHostSheet.closeSheet(); waitForSheetDetach(on: window, description: "Ordered PricingSyncSheetController to detach")

            assistant.setGlobalLanguage("zh-Hans"); pump()

            // Dynamic per-tier quotaGroups across Overview, Accounts, MenuPanel, and ModelIcons
            check(ModelIcons.brands(for: "Orchestrator (Argon)") == ["gemini"], "Orchestrator group resolves Gemini brand icon")

            let ultraAcc: [String: Any] = [
                "id": "ultra-1",
                "name": "Ultra User",
                "email": "ultra@example.invalid",
                "subscription_tier": "ULTRA",
                "status": "normal",
                "is_current": true,
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
            ]
            let proAcc: [String: Any] = [
                "id": "pro-1",
                "name": "Pro User",
                "email": "pro@example.invalid",
                "subscription_tier": "PRO",
                "status": "normal",
                "is_current": true,
                "quotaGroups": [
                    ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.53, "stale": false], ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.53, "stale": false]]],
                    ["key": "claude_gpt", "displayName": "Claude/GPT", "summaryLabel": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "five_hour", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.76, "stale": false], ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.76, "stale": false]]],
                    ["key": "argon", "displayName": "Gemini 4 Argon", "summaryLabel": "Argon", "brands": ["gemini"], "isStandalone": true, "availability": "available", "quotaState": "known", "windows": [["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.64, "stale": false, "resetCountdown": "6天后重置"]]]
                ]
            ]
            let freeAcc: [String: Any] = [
                "id": "free-1",
                "name": "Free User",
                "email": "free@example.invalid",
                "subscription_tier": "FREE",
                "status": "normal",
                "is_current": true,
                "familyWindows": [
                    "gemini": ["model_quota": ["remaining": 1.0, "known": true, "stale": false]],
                    "claude": ["model_quota": ["remaining": 0.8, "known": true, "stale": false]]
                ],
                "argonStatus": ["availability": "disabled", "quotaState": "not_reported"]
            ]

            let ultraDashAcc: [String: Any] = [
                "activeEmail": "ultra@example.invalid",
                "activeName": "Ultra User",
                "activeTier": "ULTRA",
                "isLiveVerified": true,
                "quotaGroups": ultraAcc["quotaGroups"] ?? []
            ]
            let proDashAcc: [String: Any] = [
                "activeEmail": "pro@example.invalid",
                "activeName": "Pro User",
                "activeTier": "PRO",
                "isLiveVerified": true,
                "quotaGroups": proAcc["quotaGroups"] ?? []
            ]
            let freeDashAcc: [String: Any] = [
                "activeEmail": "free@example.invalid",
                "activeName": "Free User",
                "activeTier": "FREE",
                "isLiveVerified": true,
                "familyWindows": freeAcc["familyWindows"] ?? [:],
                "argonStatus": freeAcc["argonStatus"] ?? [:]
            ]

            let dashHost = Assistant(state: state.appendingPathComponent("dyn-dash"))
            dashHost.configuration = try ConfigurationStore(state: dashHost.state)
            dashHost.bridge = BackendBridge(resources: state, state: dashHost.state)
            dashHost.reachable = false

            let ultraDash = DashboardPage(app: dashHost)
            ultraDash.view.frame = NSRect(x: 0, y: 0, width: 920, height: 760)
            ultraDash.renderSummary(["accounts": ultraDashAcc], isStaleFallback: false)
            ultraDash.view.layoutSubtreeIfNeeded(); pump()
            let ultraDashTexts = allTextValues(ultraDash.view)
            check(ultraDash.standaloneDivider.isHidden && ultraDash.standaloneQuotaStack.isHidden, "Ultra overview must hide standalone divider and rows")
            check(!ultraDashTexts.contains(where: { $0.contains("Argon") || $0.contains("Carbon") || $0.contains("周期未知") }), "Ultra overview must not show Argon, Carbon, or 周期未知")
            check(ultraDash.trendTitleLabel.stringValue == "今日时段消耗" && ultraDash.trendTitleLabel.bounds.width >= 60, "Overview trend title must remain visible without collapsing to 0pt")
            check(ultraDash.trendDetailLabel.stringValue.hasPrefix("今日 ") && ultraDash.trendDetailLabel.bounds.width >= 110, "Overview trend detail subtitle must have enough horizontal room without truncating at 920px (got width=\(ultraDash.trendDetailLabel.bounds.width))")
            check(ultraDash.todayPeakBadge.frame.minX > ultraDash.trendTitleLabel.frame.maxX + 8, "Overview peak pill badge must align to trailing edge after trend title")
            check(ultraDash.todayTrendChart.bounds.height > 100 && ultraDash.todayTrendChart.bounds.height <= 114.5, "Overview trend chart must cap vertical bar height at <= 114pt while keeping compact clarity (got \(ultraDash.todayTrendChart.bounds.height))")

            let proDash = DashboardPage(app: dashHost)
            proDash.view.frame = NSRect(x: 0, y: 0, width: 920, height: 760)
            proDash.renderSummary(["accounts": proDashAcc], isStaleFallback: false)
            proDash.view.layoutSubtreeIfNeeded(); pump()
            let proDashTexts = allTextValues(proDash.view)
            check(!proDash.standaloneDivider.isHidden && !proDash.standaloneQuotaStack.isHidden, "Pro overview must show standalone Argon row")
            check(proDashTexts.contains("Gemini 4 Argon · 每周") && !proDashTexts.contains(where: { $0.contains("Carbon") || $0.contains("周期未知") }), "Pro overview must show Gemini 4 Argon · 每周 without Carbon or 周期未知")

            let freeDash = DashboardPage(app: dashHost)
            freeDash.view.frame = NSRect(x: 0, y: 0, width: 920, height: 760)
            freeDash.renderSummary(["accounts": freeDashAcc], isStaleFallback: false)
            freeDash.view.layoutSubtreeIfNeeded(); pump()
            check(freeDash.standaloneDivider.isHidden && freeDash.standaloneQuotaStack.isHidden, "Free overview with disabled Argon must show zero standalone rows")

            // Future unknown multi-window standalone pool (5h + weekly + daily) & ModelIcons graceful fallback
            check(ModelIcons.brands(for: "Nova Models").isEmpty && ModelIcons.image("nova") == nil && ModelIcons.fallbackIcon() != nil, "Unknown future pool degrades cleanly to fallback icon without mislabeling or crashing")
            let fallbackHeader = MenuQuotaHelpers.groupHeader("Nova Models", brands: ["nova"], fontSize: 11.5, iconSize: 13)
            check((fallbackHeader as? NSStackView)?.arrangedSubviews.contains(where: { $0 is NSImageView }) == true, "MenuQuotaHelpers.groupHeader renders fallback model icon for unknown future pool")
            let futureIso5h = ISO8601DateFormatter().string(from: Date().addingTimeInterval(3 * 3600 + 25 * 60))
            let futureIsoDaily = ISO8601DateFormatter().string(from: Date().addingTimeInterval(11 * 3600 + 10 * 60))
            let futureIsoWeekly = ISO8601DateFormatter().string(from: Date().addingTimeInterval(4 * 24 * 3600 + 2 * 3600))
            let multiWinStandaloneAcc: [String: Any] = [
                "activeEmail": "future@example.invalid",
                "activeName": "Future User",
                "activeTier": "PRO",
                "isLiveVerified": true,
                "quotaLastUpdated": Date().timeIntervalSince1970,
                "quotaGroups": [
                    ["key": "gemini", "displayName": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.85, "stale": false, "resetTime": futureIso5h]]],
                    ["key": "claude_gpt", "displayName": "Claude/GPT", "brands": ["claude", "gpt"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.90, "stale": false, "resetTime": futureIso5h]]],
                    ["key": "gemini-pro-orchestrator-neon", "displayName": "Orchestrator (Neon)", "brands": ["gemini"], "isStandalone": true, "availability": "unknown", "quotaState": "stale", "windows": [["id": "model", "period": "unspecified", "label": "模型配额", "known": true, "remaining": 1.0, "stale": true]]],
                    [
                        "key": "nova-models",
                        "displayName": "Nova Models",
                        "brands": ["nova"],
                        "isStandalone": true,
                        "availability": "available",
                        "quotaState": "known",
                        "windows": [
                            ["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.72, "stale": false, "resetTime": futureIso5h],
                            ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.44, "stale": false, "resetTime": futureIsoWeekly]
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
                            ["id": "daily", "period": "daily", "label": "每日", "known": true, "remaining": 0.61, "stale": false, "resetTime": futureIsoDaily]
                        ]
                    ]
                ]
            ]
            let multiWinDash = DashboardPage(app: dashHost)
            multiWinDash.view.frame = NSRect(x: 0, y: 0, width: 920, height: 760)
            multiWinDash.renderSummary(["accounts": multiWinStandaloneAcc], isStaleFallback: false)
            multiWinDash.view.layoutSubtreeIfNeeded(); pump()
            let multiWinTexts = allTextValues(multiWinDash.view)
            check(!multiWinDash.standaloneDivider.isHidden && !multiWinDash.standaloneQuotaStack.isHidden, "Future multi-window standalone pools render standalone section")
            check(multiWinTexts.contains("Nova Models · 5 小时") && multiWinTexts.contains("Nova Models · 每周") && multiWinTexts.contains("Pulse Daily · 每日"), "Dashboard renders all 5h, weekly, and daily windows for future standalone pools")
            check(!multiWinTexts.contains(where: { $0.contains("Orchestrator") }), "Dashboard must never render Orchestrator meta-models as standalone pools")

            let singleWindowFreeGroups: [[String: Any]] = [
                [
                    "key": "gemini",
                    "displayName": "Gemini",
                    "summaryLabel": "Gemini",
                    "brands": ["gemini"],
                    "isStandalone": false,
                    "availability": "available",
                    "quotaState": "known",
                    "windows": [
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false, "resetCountdown": "6天23小时后重置"]
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
                        ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 1.0, "stale": false, "resetCountdown": "6天23小时后重置"]
                    ]
                ]
            ]
            let singleWinFreeDashAcc: [String: Any] = [
                "activeEmail": "free1w@example.invalid",
                "activeName": "Alex",
                "activeTier": "FREE",
                "isLiveVerified": true,
                "quotaLastUpdated": Date().timeIntervalSince1970,
                "quotaGroups": singleWindowFreeGroups
            ]
            let singleWinFreeDash = DashboardPage(app: dashHost)
            singleWinFreeDash.view.frame = NSRect(x: 0, y: 0, width: 920, height: 760)
            singleWinFreeDash.renderSummary(["accounts": singleWinFreeDashAcc], isStaleFallback: false)
            singleWinFreeDash.view.layoutSubtreeIfNeeded(); pump()
            check(singleWinFreeDash.coreQuotaStack.arrangedSubviews.count == 1, "Single-window FREE core groups must pair side-by-side into 1 two-column row")
            if let pairedRow = singleWinFreeDash.coreQuotaStack.arrangedSubviews.first as? NSStackView {
                check(pairedRow.arrangedSubviews.count == 2 && pairedRow.arrangedSubviews.allSatisfy { $0 is QuotaBarView }, "Paired FREE core row must render two QuotaBarViews side-by-side")
            }

            for (tierName, dashPage) in [("ULTRA", ultraDash), ("PRO", proDash), ("FREE", freeDash), ("FREE-1W", singleWinFreeDash)] {
                if let scroll = dashPage.view as? NSScrollView, let doc = scroll.documentView {
                    let bentoBottom = doc.convert(dashPage.bentoRow.bounds, from: dashPage.bentoRow).maxY
                    let viewportH = scroll.contentView.bounds.height
                    check(abs(viewportH - 708) <= 1.0 && abs(bentoBottom - (viewportH - 16)) <= 2.0, "\(tierName) overview must adaptively expand vertically to fill viewport down to 16pt bottom margin (bentoBottom=\(bentoBottom), viewportH=\(viewportH))")
                } else {
                    check(false, "Overview view must be an NSScrollView")
                }
            }
            check(ultraDash.refreshQuotaButton.intrinsicContentSize.width <= 96 && ultraDash.refreshQuotaButton.intrinsicContentSize.width >= 84, "Chinese QuotaRefreshButton must use compact width (got \(ultraDash.refreshQuotaButton.intrinsicContentSize.width))")
            let idleRefreshW = ultraDash.refreshQuotaButton.intrinsicContentSize.width
            ultraDash.refreshQuotaButton.setRefreshState(busy: true, available: true, error: nil)
            ultraDash.refreshQuotaButton.frame = NSRect(x: 0, y: 0, width: idleRefreshW, height: 28)
            ultraDash.refreshQuotaButton.layoutSubtreeIfNeeded()
            check(ultraDash.refreshQuotaButton.intrinsicContentSize.width == idleRefreshW && ultraDash.refreshQuotaButton.spinner.frame.minX >= 10, "Busy QuotaRefreshButton must preserve constant width while centering spinner+label group")
            ultraDash.refreshQuotaButton.setRefreshState(busy: false, available: true, error: nil)

            // Capture 1024x710 Dark verification screenshots for Ultra / Pro / Free Overview and 3-tier Accounts
            let prevWinSize = window.frame.size
            window.appearance = NSAppearance(named: .darkAqua)
            window.setFrame(NSRect(origin: window.frame.origin, size: NSSize(width: 1024, height: 710)), display: true)
            assistant.selectPage(0); pump()
            var tierMetricHeights: [String: CGFloat] = [:]
            var tierModelCounts: [String: Int] = [:]
            var tierBadges: [String: String] = [:]
            for (slug, accPayload) in [("ultra", ultraDashAcc), ("pro", proDashAcc), ("free", singleWinFreeDashAcc)] {
                var enriched = accPayload
                enriched["quotaLastUpdated"] = Date().timeIntervalSince1970
                assistant.overview!.renderSummary([
                    "accounts": enriched,
                    "usage": ["todayTokens": 303_000_000, "totalTokens": 3_770_000_000, "estimatedUsd": 75.37, "allTimeEstimatedUsd": 679.89, "requestCount": 2381, "totalRequestCount": 33949, "todayPricedModels": 4, "todayUnpricedModels": 0, "pricedModels": 4, "unpricedModels": 0, "databasesScanned": 343, "databasesDiscovered": 343, "availability": "complete", "todayByModel": models, "todayHourly": todayHourly]
                ], isStaleFallback: false)
                window.contentView?.layoutSubtreeIfNeeded(); pump()
                window.contentView?.layoutSubtreeIfNeeded()
                verifyOverviewHeaderGeometry(assistant.overview!, context: "1024x710-\(slug)")
                tierMetricHeights[slug] = assistant.overview!.tokenMetricCard?.bounds.height ?? 0
                tierModelCounts[slug] = assistant.overview!.bentoRightStack.arrangedSubviews.count
                tierBadges[slug] = assistant.overview!.rightBentoCountBadge.title
                try capture(window.contentView!, output.appendingPathComponent("verify-dark-overview-\(slug).png"))
            }
            let proMetricH = tierMetricHeights["pro"] ?? 0
            let ultraMetricH = tierMetricHeights["ultra"] ?? 0
            let freeMetricH = tierMetricHeights["free"] ?? 0
            check(proMetricH >= 132 && abs(proMetricH - ultraMetricH) <= 2.0 && abs(proMetricH - freeMetricH) <= 2.0, "1024x710 KPI cards must stay tall and uniform across PRO/ULTRA/FREE (got pro=\(proMetricH), ultra=\(ultraMetricH), free=\(freeMetricH))")
            check(tierModelCounts["pro"] == 2 && tierBadges["pro"] == "Top 2 / 共 4 个", "1024x710 PRO overview must render Top 2 active models (got \(tierModelCounts["pro"] ?? -1), \(tierBadges["pro"] ?? ""))")
            check(tierModelCounts["ultra"] == 2 && tierBadges["ultra"] == "Top 2 / 共 4 个", "1024x710 ULTRA overview must render Top 2 active models (got \(tierModelCounts["ultra"] ?? -1), \(tierBadges["ultra"] ?? ""))")
            check(tierModelCounts["free"] == 3 && tierBadges["free"] == "Top 3 / 共 4 个", "1024x710 1-row FREE overview must auto-expand to Top 3 active models (got \(tierModelCounts["free"] ?? -1), \(tierBadges["free"] ?? ""))")
            let singleWinFreeCardAcc: [String: Any] = [
                "id": "free-1w",
                "name": "Alex",
                "email": "free1w@example.invalid",
                "subscription_tier": "FREE",
                "status": "normal",
                "quota": ["last_updated": Date().timeIntervalSince1970],
                "quotaGroups": singleWindowFreeGroups
            ]
            var ultraCardWithStamp = ultraAcc; ultraCardWithStamp["quota"] = ["last_updated": Date().timeIntervalSince1970]
            var proCardWithStamp = proAcc; proCardWithStamp["quota"] = ["last_updated": Date().timeIntervalSince1970]; proCardWithStamp["is_current"] = false
            assistant.selectPage(1); pump()
            assistant.accountsPage!.fetch(["accounts": [ultraCardWithStamp, proCardWithStamp, singleWinFreeCardAcc], "activeId": "ultra-1"]); pump()
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            try capture(window.contentView!, output.appendingPathComponent("verify-dark-accounts-3tiers.png"))
            assistant.quotaRefreshing = true
            assistant.updateQuotaRefreshControls()
            window.contentView?.layoutSubtreeIfNeeded(); pump()
            try capture(window.contentView!, output.appendingPathComponent("verify-dark-accounts-refreshing.png"))
            assistant.quotaRefreshing = false
            assistant.updateQuotaRefreshControls()
            window.setFrame(NSRect(origin: window.frame.origin, size: prevWinSize), display: true)

            let dynAccountsHost = Assistant(state: state.appendingPathComponent("dyn-quota-groups"))
            dynAccountsHost.configuration = try ConfigurationStore(state: dynAccountsHost.state)
            dynAccountsHost.bridge = BackendBridge(resources: state, state: dynAccountsHost.state)
            dynAccountsHost.reachable = true
            dynAccountsHost.cachedAccounts = [ultraAcc, proAcc]
            dynAccountsHost.activeAccountId = "ultra-1"
            dynAccountsHost.statusValue = LiveStatus(["running": true, "runningChannel": "stable", "liveAccountEmail": "ultra@example.invalid"])
            dynAccountsHost.bridge.fixtureReply = { request in
                let cmd = request["command"] as? String ?? ""
                if cmd == "account_list" {
                    return ["ok": true, "accounts": [ultraAcc, proAcc], "activeId": "ultra-1"]
                }
                if cmd == "smart_switch_status" || cmd == "auto_switch_get" {
                    return ["ok": true, "config": ["enabled": true, "strategy": "priority", "monitored_model": "argon", "reserve_percentage": 10, "candidate_min_percentage": 30]]
                }
                return ["ok": true]
            }
            let dynAccountsPage = AccountsPage(app: dynAccountsHost)
            dynAccountsPage.view.frame = NSRect(x: 0, y: 0, width: 920, height: 760)
            dynAccountsPage.fetch(["accounts": [ultraAcc, proAcc], "activeId": "ultra-1"]); pump()
            dynAccountsPage.fetchPolicy(); pump()
            check(dynAccountsPage.policySubtitleLabel.stringValue == "监测 Gemini · 剩余 ≤ 10% 时推荐备用（≥ 30%，需手动确认切换）", "Ultra active account must display pooled Gemini summary even if saved policy says argon")
            check(dynAccountsPage.policySubtitleLabel.toolTip == nil && (dynAccountsPage.policySubtitleLabel.accessibilityHelp() ?? "").contains("自适应为 Gemini"), "Ultra active account policy subtitle must expose cross-tier adaptation via accessibilityHelp without hover tooltip")
            var capturedSavedMonitored: String?
            let prevDynFixture = dynAccountsHost.bridge.fixtureReply
            dynAccountsHost.bridge.fixtureReply = { request in
                if (request["command"] as? String) == "auto_switch_set",
                   let cfg = request["config"] as? [String: Any] {
                    capturedSavedMonitored = cfg["monitored_model"] as? String
                }
                return prevDynFixture?(request) ?? ["ok": true]
            }
            let ultraScopedPolicy = AccountPolicySheet(app: dynAccountsHost, config: ["strategy": "priority", "monitored_model": "argon", "reserve_percentage": 10, "candidate_min_percentage": 30], saved: {})
            ultraScopedPolicy.window.contentView?.layoutSubtreeIfNeeded()
            check((ultraScopedPolicy.modelPopup.menu?.items ?? []).filter { !$0.isSeparatorItem }.map(\.title) == ["全部可用模型", "Gemini", "Claude/GPT"], "Ultra active account policy popup must not leak standby Pro account's Gemini 4 Argon")
            check(ultraScopedPolicy.modelPopup.selectedItem?.title == "Gemini", "Ultra active account policy popup must remap argon selection to Gemini")
            ultraScopedPolicy.save(); pump()
            check(capturedSavedMonitored == "argon", "Saving Ultra policy sheet without modifying monitored scope must preserve underlying argon config")
            dynAccountsHost.bridge.fixtureReply = prevDynFixture
            var ultraWithNeon = ultraAcc
            ultraWithNeon["models"] = [
                ["name": "gemini-4-argon", "model_id": "gemini-4-argon", "display_name": "Gemini 4 Argon", "disabled": false],
                ["name": "gemini-4-carbon", "model_id": "gemini-4-carbon", "display_name": "Gemini 4 Carbon", "disabled": false],
                ["name": "gemini-4-neon", "model_id": "gemini-4-neon", "display_name": "Gemini 4 Neon", "disabled": false]
            ]
            check(QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: ultraWithNeon) == "Ultra 套餐已将 Argon、Carbon 与 Neon 并入此共享池，一并监测", "Ultra gemini subtitle dynamically lists pooled Argon, Carbon, and Neon models when present")
            check(ultraScopedPolicy.strategyPopup.frame.width == ultraScopedPolicy.modelPopup.frame.width, "Ultra policy popups must share uniform width")
            check(ultraScopedPolicy.modelPopup.frame.width <= 130 && ultraScopedPolicy.modelPopup.frame.width >= Design.fittedPopUpWidth(ultraScopedPolicy.modelPopup) - 0.5, "Ultra policy popups must shrink tightly to longest option without 220pt bloat (got \(ultraScopedPolicy.modelPopup.frame.width))")
            check((ultraScopedPolicy.window.contentView?.frame.height ?? 999) < 395 && ultraScopedPolicy.fieldsCard.frame.height <= (groupStack(ultraScopedPolicy.fieldsCard)?.fittingSize.height ?? 0) + 34, "Ultra policy sheet must hug content without bottom blank space (contentH=\(ultraScopedPolicy.window.contentView?.frame.height ?? -1), cardH=\(ultraScopedPolicy.fieldsCard.frame.height))")
            check(ultraScopedPolicy.monitoredSubLabel.stringValue == "仅监测当前 Ultra 账号的 Gemini 共享配额池", "Ultra policy popup without member evidence omits unverified Argon/Carbon")
            if let ultraCardBox = dynAccountsPage.cardsStack.arrangedSubviews.first {
                let ultraExpandedTexts = allTextValues(ultraCardBox)
                check(!ultraExpandedTexts.contains(where: { $0.contains("Argon") || $0.contains("Carbon") || $0.contains("周期未知") }), "Ultra expanded account card omits Argon, Carbon, and 周期未知")
            } else {
                check(false, "Expected Ultra expanded account card")
            }
            if let proCardBox = dynAccountsPage.cardsStack.arrangedSubviews.dropFirst().first {
                let proExpandedTexts = allTextValues(proCardBox)
                check(proExpandedTexts.contains("Gemini 4 Argon · 每周") && !proExpandedTexts.contains(where: { $0.contains("Carbon") || $0.contains("周期未知") }), "Pro expanded account card shows Gemini 4 Argon · 每周 without Carbon")
            } else {
                check(false, "Expected Pro expanded account card")
            }
            dynAccountsPage.toggleCollapseAllAccounts(); pump()
            let dynAccountsTexts = allTextValues(dynAccountsPage.cardsStack)
            check(dynAccountsTexts.contains { $0.contains("Gemini 64%") && $0.contains("Claude/GPT 100%") && !$0.contains("Argon") }, "Ultra account summary omits Argon/Carbon")
            check(dynAccountsTexts.contains { $0.contains("Gemini 53%") && $0.contains("Claude/GPT 76%") && $0.contains("Argon 64%") }, "Pro account summary includes Argon 64%")

            let dynMenu = MenuPanelController(app: dynAccountsHost)
            dynMenu.loadViewIfNeeded()
            dynMenu.selectTab(1, persist: false); pump()
            let dynMenuQuotaTexts = allTextValues(dynMenu.quotaGroupsContainer)
            check(dynMenuQuotaTexts.contains("Gemini") && dynMenuQuotaTexts.contains("Claude/GPT") && !dynMenuQuotaTexts.contains(where: { $0.contains("Argon") || $0.contains("Carbon") || $0.contains("周期未知") }), "Ultra menu quota tab omits Argon, Carbon, and 周期未知")
            dynMenu.selectTab(2, persist: false); pump()
            if let ultraCard = dynMenu.accountsCardsStack.arrangedSubviews.compactMap({ $0 as? MenuExpandableAccountCardView }).first {
                let ultraCardTexts = allTextValues(ultraCard.detailContainer)
                check(!ultraCardTexts.contains(where: { $0.contains("Argon") || $0.contains("Carbon") || $0.contains("周期未知") }), "Ultra menu account card omits Argon, Carbon, and 周期未知")
            } else {
                check(false, "Expected Ultra MenuExpandableAccountCardView")
            }
        }

        // Verify debug-port-missing status, menu panel & overview safe relaunch guidance UI, and safeRelaunchAntigravityForDebug flow
        do {
            let debugStatus = LiveStatus(["mode": "debug-port-missing"])
            check(debugStatus.title == "未开启调试端口", "LiveStatus debug-port-missing title must be 未开启调试端口 (got \(debugStatus.title))")
            check(debugStatus.color == .systemOrange, "LiveStatus debug-port-missing color must be .systemOrange")
            check(debugStatus.enabled == false, "LiveStatus debug-port-missing enabled must be false")

            let prevStatus = assistant.statusValue
            let prevReachable = assistant.reachable
            assistant.reachable = true
            assistant.statusValue = LiveStatus(["mode": "connected", "windows": 1, "entries": 4300])

            let dbgStatusBtn = NSButton(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
            assistant.updateStatusItemState(buttonOverride: dbgStatusBtn)
            check(dbgStatusBtn.subviews.first(where: { $0.identifier?.rawValue == "status-item-attention-dot" })?.isHidden == true, "Menu bar attention dot must stay hidden when connected")

            let dbgMenu = MenuPanelController(app: assistant)
            let dbgPanelHost = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            dbgPanelHost.contentViewController = dbgMenu
            dbgMenu.loadViewIfNeeded()
            dbgMenu.syncFromAssistant(); pump()
            check(dbgMenu.debugPortBannerBox.isHidden == true && dbgMenu.safeRelaunchBtn.isHidden == true, "MenuPanel must hide debugPortBannerBox and safeRelaunchBtn when connected")
            check(dbgMenu.openAntigravityBtn.isHidden == false && dbgMenu.openAntigravityBtn.title == "打开 Antigravity", "MenuPanel openAntigravityBtn must remain visible and intact when connected")

            let dbgOverview = DashboardPage(app: assistant)
            dbgOverview.view.frame = NSRect(x: 0, y: 0, width: 920, height: 700)
            dbgOverview.update(); pump()
            check(dbgOverview.debugPortBannerBox.isHidden == true && dbgOverview.safeRelaunchButton.isHidden == true, "DashboardPage must hide debugPortBannerBox and safeRelaunchButton when connected")

            assistant.statusValue = LiveStatus(["mode": "debug-port-missing", "running": true])
            assistant.updateStatusItemState(buttonOverride: dbgStatusBtn)
            check(dbgStatusBtn.subviews.first(where: { $0.identifier?.rawValue == "status-item-attention-dot" })?.isHidden == false, "Menu bar attention dot must appear in amber orange when mode is debug-port-missing")
            check(dbgStatusBtn.image?.isTemplate == true, "Base menu bar icon must remain a template image while showing attention dot")
            dbgMenu.syncFromAssistant(); pump()
            dbgPanelHost.setContentSize(dbgMenu.preferredContentSize)
            dbgPanelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(dbgMenu.debugPortBannerBox.isHidden == false && dbgMenu.safeRelaunchBtn.isHidden == false, "MenuPanel must display debugPortBannerBox and safeRelaunchBtn in debug-port-missing mode")
            check(dbgMenu.safeRelaunchBtn.title == "安全重启以连接", "MenuPanel safeRelaunchBtn title must match requirement")
            check(dbgMenu.safeRelaunchBtn.bezelColor == nil && dbgMenu.safeRelaunchBtn.intrinsicContentSize.height == 24, "MenuPanel safeRelaunchBtn must use compact 24pt translucent glass style without heavy blue fill")
            check(dbgMenu.safeRelaunchBtn.toolTip == nil, "MenuPanel safeRelaunchBtn must not set tooltip")
            check(dbgMenu.openAntigravityBtn.isHidden == false && dbgMenu.openAntigravityBtn.title == "打开 Antigravity", "MenuPanel openAntigravityBtn must remain unaffected in debug-port-missing mode")
            let dbgMenuTexts = allTextValues(dbgMenu.debugPortBannerBox)
            check(dbgMenuTexts.contains("未开启调试端口") && dbgMenuTexts.contains(where: { $0.contains("调试端口") }), "MenuPanel debug banner must present clear cause copy")

            dbgOverview.update(); pump()
            dbgOverview.view.layoutSubtreeIfNeeded(); pump()
            check(dbgOverview.debugPortBannerBox.isHidden == false && dbgOverview.safeRelaunchButton.isHidden == false, "DashboardPage must display debugPortBannerBox and safeRelaunchButton in debug-port-missing mode")
            check(dbgOverview.safeRelaunchButton.bezelColor == nil && dbgOverview.safeRelaunchButton.intrinsicContentSize.height == 24, "DashboardPage safeRelaunchButton must use compact 24pt glass style without heavy blue fill")
            check(dbgOverview.safeRelaunchButton.title == "安全重启以连接", "DashboardPage safeRelaunchButton title must match requirement")
            check(dbgOverview.safeRelaunchButton.toolTip == nil, "DashboardPage safeRelaunchButton must not set tooltip")
            let dbgOverviewTexts = allTextValues(dbgOverview.debugPortBannerBox)
            check(dbgOverviewTexts.contains("未开启调试端口") && dbgOverviewTexts.contains(where: { $0.contains("调试端口") }), "DashboardPage debug banner must present clear cause copy")

            check(Assistant.remoteDebuggingArguments == ["--remote-debugging-port=0"], "Cold launch and relaunch must inject --remote-debugging-port=0")

            // Test safeRelaunchAntigravityForDebug direct execution (no secondary confirmation modal or forced main window pop), graceful exit + relaunch path, and timeout path
            var simulatedRunning = true
            var terminateCalls = 0
            let opensBeforeMenuClick = assistant.openedApplications
            let mainWinVisibleBeforeMenuClick = assistant.window?.isVisible == true
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { simulatedRunning },
                terminate: {
                    terminateCalls += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(30)) {
                        simulatedRunning = false
                    }
                },
                timeoutSeconds: 2.0,
                pollIntervalMilliseconds: 20
            ))
            dbgMenu.safeRelaunchBtn.performClick(nil)
            check(assistant.isSafeRelaunchInFlight == true, "Safe relaunch must mark in-flight immediately after click")
            dbgMenu.syncDebugPortBanner()
            dbgOverview.syncDebugPortBanner()
            check(dbgMenu.safeRelaunchBtn.title == "正在安全重启…" && dbgMenu.safeRelaunchBtn.isEnabled == false, "Menu banner safe relaunch button must show busy state while relaunch is in flight")
            check(dbgOverview.safeRelaunchButton.title == "正在安全重启…" && dbgOverview.safeRelaunchButton.isEnabled == false, "Overview banner safe relaunch button must show busy state while relaunch is in flight")
            waitUntil(description: "safeRelaunchAntigravityForDebug direct menu banner execution") {
                assistant.openedApplications == opensBeforeMenuClick + 1 && !assistant.isSafeRelaunchInFlight
            }
            dbgMenu.syncDebugPortBanner()
            dbgOverview.syncDebugPortBanner()
            check(dbgMenu.safeRelaunchBtn.title == "安全重启以连接" && dbgMenu.safeRelaunchBtn.isEnabled == true, "Menu banner safe relaunch button must restore enabled state after completion")
            check(terminateCalls == 1 && assistant.openedApplications == opensBeforeMenuClick + 1, "Menu banner safe relaunch must directly terminate gracefully and reopen Antigravity without a redundant modal alert")
            check((assistant.window?.isVisible == true) == mainWinVisibleBeforeMenuClick, "Menu banner safe relaunch must not force-open the main window")

            simulatedRunning = true
            let opensBeforeSafeConfirm = assistant.openedApplications
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { simulatedRunning },
                terminate: {
                    terminateCalls += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(40)) {
                        simulatedRunning = false
                    }
                },
                timeoutSeconds: 2.0,
                pollIntervalMilliseconds: 20
            ))
            dbgOverview.safeRelaunchButton.performClick(nil)
            waitUntil(description: "safeRelaunchAntigravityForDebug graceful exit and relaunch") {
                assistant.openedApplications == opensBeforeSafeConfirm + 1
            }
            check(terminateCalls == 2 && assistant.openedApplications == opensBeforeSafeConfirm + 1, "Overview safe relaunch must terminate gracefully and reopen Antigravity with --remote-debugging-port=0")

            // Clicking openAntigravity while in debug-port-missing must route through safeRelaunchAntigravityForDebug instead of focusing the non-debug instance
            assistant.statusValue = LiveStatus(["mode": "debug-port-missing", "running": true])
            simulatedRunning = true
            let opensBeforeOpenBtnInDebugMissing = assistant.openedApplications
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { simulatedRunning },
                terminate: {
                    terminateCalls += 1
                    DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(30)) {
                        simulatedRunning = false
                    }
                },
                timeoutSeconds: 2.0,
                pollIntervalMilliseconds: 20
            ))
            assistant.openAntigravity()
            waitUntil(description: "openAntigravity in debug-port-missing triggers safe relaunch") {
                assistant.openedApplications == opensBeforeOpenBtnInDebugMissing + 1
            }
            check(terminateCalls == 3 && assistant.openedApplications == opensBeforeOpenBtnInDebugMissing + 1, "openAntigravity during debug-port-missing must execute safe relaunch instead of silently activating the non-debug app")

            // Stale debug-port-missing status after Antigravity already quit must launch directly without terminating/timing out
            assistant.statusValue = LiveStatus(["mode": "debug-port-missing", "running": true])
            let opensBeforeStaleOpen = assistant.openedApplications
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { false },
                terminate: { terminateCalls += 1 }
            ))
            assistant.openAntigravity()
            check(terminateCalls == 3 && assistant.openedApplications == opensBeforeStaleOpen + 1, "openAntigravity with stale debug-port-missing when Antigravity is not running must launch directly without relaunch loop")

            // Timeout path: Antigravity stays running past timeout, must report manual quit guidance and never reopen or force-kill
            var stuckRunning = true
            let opensBeforeTimeout = assistant.openedApplications
            assistant.showMessage("", error: false)
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { stuckRunning },
                terminate: { terminateCalls += 1 },
                timeoutSeconds: 0.2,
                pollIntervalMilliseconds: 20
            ))
            assistant.safeRelaunchAntigravityForDebug()
            waitUntil(description: "safeRelaunchAntigravityForDebug timeout guidance") {
                assistant.lastOperationError?.contains("手动退出") == true
            }
            stuckRunning = false
            check(assistant.openedApplications == opensBeforeTimeout, "Safe relaunch timeout must not reopen Antigravity while still running")
            assistant.showMessage("", error: false)

            // P1-02: Wait for lingering Antigravity helper/language_server subprocesses before relaunching, and retry transient LaunchServices open failures
            var mainAppAlive = true
            var helperSubprocessAlive = true
            var subprocPollsWhileMainExited = 0
            var launchAttemptsSeen: [Int] = []
            let opensBeforeSubprocDrain = assistant.openedApplications
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { mainAppAlive },
                hasSubprocesses: {
                    if !mainAppAlive && helperSubprocessAlive {
                        subprocPollsWhileMainExited += 1
                        if subprocPollsWhileMainExited >= 2 {
                            helperSubprocessAlive = false
                        }
                    }
                    return helperSubprocessAlive
                },
                terminate: {
                    mainAppAlive = false
                },
                relaunchAttempt: { attempt, done in
                    launchAttemptsSeen.append(attempt)
                    // Simulate transient LaunchServices rejection on attempt 1 while old job finishes tearing down
                    done(attempt >= 2)
                },
                timeoutSeconds: 2.0,
                pollIntervalMilliseconds: 15,
                relaunchRetryDelayMilliseconds: 15
            ))
            assistant.safeRelaunchAntigravityForDebug()
            check(assistant.openedApplications == opensBeforeSubprocDrain, "Safe relaunch must wait for lingering subprocesses before reopening")
            waitUntil(description: "safeRelaunchAntigravityForDebug subprocess drain and retry relaunch") {
                assistant.openedApplications == opensBeforeSubprocDrain + 1
            }
            check(subprocPollsWhileMainExited >= 2, "Safe relaunch must poll subprocess liveness after main app exits (polls=\(subprocPollsWhileMainExited))")
            check(launchAttemptsSeen == [1, 2], "Safe relaunch must retry transient launch failure before succeeding (attempts=\(launchAttemptsSeen))")

            // F-03: Exhausted safe relaunch failure must use safe-relaunch error copy (never misleading "Account switched")
            assistant.showMessage("", error: false)
            var failedAttempts = 0
            assistant.setSafeRelaunchTestingHooks(SafeRelaunchTestingHooks(
                isRunning: { false },
                hasSubprocesses: { false },
                terminate: {},
                relaunchAttempt: { _, done in
                    failedAttempts += 1
                    done(false)
                },
                timeoutSeconds: 1.0,
                pollIntervalMilliseconds: 10,
                relaunchRetryDelayMilliseconds: 10
            ))
            assistant.safeRelaunchAntigravityForDebug()
            waitUntil(description: "safeRelaunchAntigravityForDebug exhausted failure message") {
                assistant.lastOperationError?.contains("未能自动重新打开 Antigravity") == true
            }
            check(failedAttempts == 3, "Safe relaunch must try 3 times before reporting failure (got \(failedAttempts))")
            check(!(assistant.lastOperationError?.contains("账号已切换") ?? false), "Safe relaunch failure must not claim account was switched: \(assistant.lastOperationError ?? "")")
            assistant.showMessage("", error: false)
            assistant.setSafeRelaunchTestingHooks(nil)

            // P2-03: Switching global language while in debug-port-missing keeps debug-port-missing synchronously when HUD is enabled (no banner flash), and transitions to paused only when both translation and HUD are disabled
            let dbgLangHost = Assistant(state: state.appendingPathComponent("dbg-lang-host"))
            dbgLangHost.configuration = try ConfigurationStore(state: dbgLangHost.state)
            dbgLangHost.bridge = BackendBridge(resources: state, state: dbgLangHost.state)
            dbgLangHost.reachable = true
            var dbgHudOn = true
            var dbgCurrentLang = "zh-Hans"
            dbgLangHost.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "language_set" {
                    dbgCurrentLang = payload["language"] as? String ?? "zh-Hans"
                }
                if cmd == "language_set" || cmd == "status" {
                    let resolved = dbgCurrentLang == "en" ? "en" : "zh-Hans"
                    let nextMode = (resolved == "en" && !dbgHudOn) ? "paused" : "debug-port-missing"
                    return ["ok": true, "status": ["mode": nextMode, "running": true, "hudEnabled": dbgHudOn, "configuredLanguage": dbgCurrentLang, "locale": resolved, "translationEnabled": resolved != "en"], "tasks": [], "taskRevision": 0]
                }
                return ["ok": true]
            }
            dbgLangHost.configuration.value.hudEnabled = true
            dbgLangHost.statusValue = LiveStatus(["mode": "debug-port-missing", "running": true, "hudEnabled": true, "configuredLanguage": "zh-Hans", "locale": "zh-Hans", "translationEnabled": true])
            dbgLangHost.setGlobalLanguage("en")
            check(dbgLangHost.statusValue.mode == "debug-port-missing", "P2-03: setGlobalLanguage(en) with HUD enabled must preserve debug-port-missing synchronously without flashing paused")
            pump()
            check(dbgLangHost.statusValue.mode == "debug-port-missing", "P2-03: debug-port-missing must remain steady after language_set reply when HUD is enabled")

            dbgHudOn = false
            dbgLangHost.configuration.value.hudEnabled = false
            dbgLangHost.statusValue = LiveStatus(["mode": "debug-port-missing", "running": true, "hudEnabled": false, "configuredLanguage": "zh-Hans", "locale": "zh-Hans", "translationEnabled": true])
            dbgLangHost.setGlobalLanguage("en")
            check(dbgLangHost.statusValue.mode == "paused", "P2-03: setGlobalLanguage(en) with HUD disabled must transition to paused")
            pump()
            _ = L10n.shared.setLanguage("zh-Hans", notify: true); pump()

            // Connection restored -> banners hide
            assistant.statusValue = LiveStatus(["mode": "connected", "windows": 1, "entries": 4300])
            dbgMenu.syncFromAssistant(); pump()
            dbgOverview.update(); pump()
            check(dbgMenu.debugPortBannerBox.isHidden == true && dbgMenu.safeRelaunchBtn.isHidden == true, "MenuPanel safe relaunch banner must hide once connected")
            check(dbgOverview.debugPortBannerBox.isHidden == true && dbgOverview.safeRelaunchButton.isHidden == true, "DashboardPage safe relaunch banner must hide once connected")

            // English locale check for debug-port-missing
            _ = L10n.shared.setLanguage("en", notify: false)
            let enDebugStatus = LiveStatus(["mode": "debug-port-missing"])
            check(enDebugStatus.title == "Debug Port Not Enabled", "English LiveStatus debug-port-missing title mismatch (got \(enDebugStatus.title))")
            _ = L10n.shared.setLanguage("zh-Hans", notify: false)

            assistant.statusValue = prevStatus
            assistant.reachable = prevReachable
            dbgPanelHost.orderOut(nil)

            // Startup launch action & reopen launch action
            check(
                Assistant.startupLaunchAction(launchAntigravityOnStart: true, loginLaunch: false, restartedAfterUpdate: false, launchedByAntigravity: false) == .launchAntigravityInBackground &&
                Assistant.startupLaunchAction(launchAntigravityOnStart: false, loginLaunch: false, restartedAfterUpdate: false, launchedByAntigravity: false) == .showMainPanel &&
                Assistant.startupLaunchAction(launchAntigravityOnStart: true, loginLaunch: true, restartedAfterUpdate: false, launchedByAntigravity: false) == .stayInMenuBar &&
                Assistant.startupLaunchAction(launchAntigravityOnStart: true, loginLaunch: false, restartedAfterUpdate: true, launchedByAntigravity: false) == .showMainPanel &&
                Assistant.startupLaunchAction(launchAntigravityOnStart: true, loginLaunch: false, restartedAfterUpdate: false, launchedByAntigravity: true) == .stayInMenuBar,
                "startupLaunchAction must respect manual launch vs login/update/legacy flags"
            )
            check(
                Assistant.reopenLaunchAction(launchAntigravityOnStart: true, hasVisibleMainWindow: false, isAntigravityRunning: false) == .launchAntigravityInBackground &&
                Assistant.reopenLaunchAction(launchAntigravityOnStart: false, hasVisibleMainWindow: false, isAntigravityRunning: false) == .showMainPanel &&
                Assistant.reopenLaunchAction(launchAntigravityOnStart: true, hasVisibleMainWindow: true, isAntigravityRunning: false) == .showMainPanel &&
                Assistant.reopenLaunchAction(launchAntigravityOnStart: true, hasVisibleMainWindow: false, isAntigravityRunning: true) == .showMainPanel,
                "reopenLaunchAction must launch Antigravity directly only when enabled, GravityBox main window is hidden, and Antigravity is not running"
            )
        }

        // Unpriced / partial pricing UI decoupling, model badges, and PricingSyncSheet variant folding (zh-Hans & en)
        do {
            let partialHost = Assistant(state: state.appendingPathComponent("partial-pricing-ui"))
            partialHost.configuration = try ConfigurationStore(state: partialHost.state)
            partialHost.bridge = BackendBridge(resources: state, state: partialHost.state)
            partialHost.reachable = true
            let sampleModels: [[String: Any]] = [
                ["model": "gemini-5-nova", "totalTokens": 12_100_000, "promptTokens": 11_000_000, "candidatesTokens": 100_000, "cachedTokens": 1_000_000, "requestCount": 58, "estimatedUsd": 0.0, "priced": false, "partiallyPriced": false, "unpricedTokens": 12_100_000],
                ["model": "gemini-4-hydrogen", "totalTokens": 11_000_000, "promptTokens": 1_000_000, "candidatesTokens": 100_000, "cachedTokens": 9_900_000, "requestCount": 69, "estimatedUsd": 3.16, "priced": true, "partiallyPriced": false, "unpricedTokens": 0, "pricingStatus": "confirmed"]
            ]
            partialHost.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "dashboard_summary" {
                    return [
                        "ok": true,
                        "accounts": [
                            "activeName": "Alex", "activeEmail": "alex@example.invalid", "activeTier": "ULTRA",
                            "liveAccountEmail": "alex@example.invalid", "isLiveVerified": true,
                            "quotaGroups": [
                                ["id": "gemini", "displayName": "Gemini", "fiveHourRemaining": 94, "weeklyRemaining": 88]
                            ]
                        ],
                        "usage": [
                            "todayTokens": 23_100_000, "totalTokens": 4_730_000_000, "estimatedUsd": 3.16, "allTimeEstimatedUsd": 930.70,
                            "requestCount": 127, "totalRequestCount": 38964,
                            "todayPricedModels": 1, "todayUnpricedModels": 1, "pricedModels": 2, "unpricedModels": 1,
                            "databasesScanned": 10, "databasesDiscovered": 10, "availability": "complete",
                            "todayByModel": sampleModels, "todayHourly": []
                        ]
                    ]
                }
                if cmd == "usage_summary" {
                    return [
                        "ok": true, "period": payload["period"] as? String ?? "all", "snapshotId": "partial-snap-1",
                        "summary": [
                            "totalTokens": 4_730_000_000, "promptTokens": 100_000_000, "cachedTokens": 4_600_000_000, "candidatesTokens": 30_000_000,
                            "requestCount": 38964, "estimatedUsd": 930.70, "pricedModels": 2, "unpricedModels": 1,
                            "databasesScanned": 10, "databasesDiscovered": 10, "availability": "complete", "lastScannedAt": Date().timeIntervalSince1970
                        ],
                        "byModel": sampleModels, "models": sampleModels, "dailyTrends": [], "todayHourly": []
                    ]
                }
                return ["ok": true]
            }

            _ = L10n.shared.setLanguage("zh-Hans", notify: true); pump()
            let partialWindow = makeHeadlessHostWindow(width: 960, height: 640)
            partialHost.window = partialWindow
            let partialOverview = DashboardPage(app: partialHost)
            let partialUsage = UsagePage(app: partialHost)
            let ovBox = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 580))
            ovBox.addSubview(partialOverview.view); pin(partialOverview.view, to: ovBox)
            partialWindow.contentView = ovBox
            partialOverview.fetch(); pump()
            ovBox.layoutSubtreeIfNeeded(); pump()

            check(partialOverview.usageMetric.stringValue == "$3.16", "Partial overview KPI must show pure USD without prefix: \(partialOverview.usageMetric.stringValue)")
            check(partialOverview.costMetricCard?.statusBadge?.isHidden == false && partialOverview.costMetricCard?.statusBadge?.title == "部分计价", "Overview cost card must display 部分计价 status badge")
            check(partialOverview.usageDetail.stringValue == "含 1 款待定价 · 累计部分 $930.70", "Overview cost detail must surface pending count and partial total: \(partialOverview.usageDetail.stringValue)")
            let zhCostNatW = (partialOverview.usageMetric.stringValue as NSString).size(withAttributes: [.font: partialOverview.usageMetric.font!]).width
            check(partialOverview.usageMetric.bounds.width + 1.0 >= ceil(zhCostNatW), "Overview pure USD value must not truncate (\(partialOverview.usageMetric.bounds.width) < \(zhCostNatW))")
            let bentoTexts = allTextValues(partialOverview.bentoRightStack)
            check(bentoTexts.contains("待定价"), "Overview bento active models must show 待定价 pill for unpriced model: \(bentoTexts)")

            let usgBox = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 580))
            usgBox.addSubview(partialUsage.view); pin(partialUsage.view, to: usgBox)
            partialWindow.contentView = usgBox
            partialUsage.fetch(force: true); pump()
            usgBox.layoutSubtreeIfNeeded(); pump()
            check(partialUsage.usdMetric.stringValue == "$930.70", "UsagePage KPI must show pure USD without prefix: \(partialUsage.usdMetric.stringValue)")
            check(!partialUsage.costStatusBadge.isHidden && partialUsage.costStatusBadge.title == "部分计价", "UsagePage cost card must show 部分计价 pill")
            check(!partialUsage.usdDetail.isHidden && partialUsage.usdDetail.stringValue.contains("含 1 款待定价模型"), "UsagePage usdDetail must explain pending model: \(partialUsage.usdDetail.stringValue)")

            let partialMenu = partialHost.ensureMenuPanelController()
            let partialPanelHost = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            partialPanelHost.contentViewController = partialMenu
            partialMenu.selectTab(0, persist: false); partialMenu.panelWillOpen(); pump()
            partialPanelHost.setContentSize(partialMenu.preferredContentSize); partialPanelHost.contentView?.layoutSubtreeIfNeeded(); pump()
            check(partialMenu.costTile.valueLabel.stringValue == "$930.70", "MenuPanel costTile must display pure $930.70 without prefix: \(partialMenu.costTile.valueLabel.stringValue)")
            check(!partialMenu.costTile.statusBadge.isHidden && partialMenu.costTile.statusBadge.title == "部分", "MenuPanel costTile must show 部分 status badge")
            check(partialMenu.usageFooterLabel.stringValue.contains("1 款模型待定价"), "MenuPanel footer must note pending models: \(partialMenu.usageFooterLabel.stringValue)")
            let menuCostNatW = (partialMenu.costTile.valueLabel.stringValue as NSString).size(withAttributes: [.font: partialMenu.costTile.valueLabel.font!]).width
            check(partialMenu.costTile.valueLabel.bounds.width + 1.0 >= ceil(menuCostNatW), "MenuPanel pure USD value must not truncate (\(partialMenu.costTile.valueLabel.bounds.width) < \(menuCostNatW))")
            let menuModelsTexts = allTextValues(partialMenu.modelsListStack)
            check(menuModelsTexts.contains("待定价"), "MenuPanel models list must show 待定价 badge on unpriced row: \(menuModelsTexts)")

            // PricingSyncSheetController variant folding check (5 Neon/Nova variants -> 1 card + unified banner + subtitle)
            let foldedSheet = PricingSyncSheetController(app: partialHost)
            foldedSheet.show(in: partialWindow, payload: [
                "synced": true,
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 2],
                "unpricedLiveModels": [
                    ["key": "gemini-5-nova-high", "displayName": "Gemini 5 Nova (High)", "disabled": false],
                    ["key": "gemini-5-nova-xhigh", "displayName": "Gemini 5 Nova (XHigh)", "disabled": false],
                    ["key": "gemini-5-nova-medium", "displayName": "Gemini 5 Nova (Medium)", "disabled": false],
                    ["key": "gemini-5-nova-low", "displayName": "Gemini 5 Nova (Low)", "disabled": false],
                    ["key": "gemini-pro-orchestrator-nova", "displayName": "Orchestrator (Nova)", "disabled": false],
                ],
                "prices": [
                    "gemini-4-hydrogen": ["input": 1.5, "output": 7.5, "cached": 0.075]
                ],
                "pricingStatus": ["gemini-4-hydrogen": "confirmed"],
                "modelCatalogState": ["gemini-4-hydrogen": ["availability": "available", "displayName": "Gemini 4 Hydrogen"]],
            ])
            pump()
            check(foldedSheet.summaryPill.title.hasSuffix("· 2 款"), "Folded PricingSyncSheet must count grouped unpriced + priced as 2: \(foldedSheet.summaryPill.title)")
            check(foldedSheet.renderedSummaryLines.count == 2, "5 Nova variants must fold into 1 unpriced group + 1 priced card (got \(foldedSheet.renderedSummaryLines.count))")
            let foldedZhTexts = allTextValues(foldedSheet.sheet.contentView!)
            check(foldedZhTexts.contains("涵盖变体：Low · Medium · High · XHigh · Orchestrator"), "Folded group card must list combined variants: \(foldedZhTexts)")

            // Non-Gemini / standalone orchestrator rows must never fabricate gemini-4-<codename>; sibling matching + hostOrder must work cleanly
            let standaloneNonGeminiOrch = PricingSyncSheetController.groupUnpricedLiveModels([
                ["key": "gemini-pro-orchestrator-opus", "displayName": "Orchestrator (Opus)", "disabled": false],
                ["key": "gemini-flash-worker-agy", "displayName": "Orchestrator (Claude Opus 6)", "disabled": false],
            ])
            check(standaloneNonGeminiOrch.count == 2, "Standalone non-Gemini orchestrators remain distinct without fabricating gemini-4-*")
            check(standaloneNonGeminiOrch[0].key == "gemini-pro-orchestrator-opus" && standaloneNonGeminiOrch[0].displayName == "Orchestrator (Opus)", "Must not fabricate gemini-4-opus for unmatched Opus orchestrator (got \(standaloneNonGeminiOrch[0]))")
            check(standaloneNonGeminiOrch[1].key == "gemini-flash-worker-agy" && standaloneNonGeminiOrch[1].displayName == "Orchestrator (Claude Opus 6)", "Must preserve canonical key/displayName for unmatched Claude Opus orchestrator (got \(standaloneNonGeminiOrch[1]))")

            let pairedNonGeminiOrch = PricingSyncSheetController.groupUnpricedLiveModels([
                ["key": "claude-opus-6-high", "displayName": "Claude Opus 6 (High)", "disabled": false, "hostOrder": 2],
                ["key": "gemini-flash-worker-agy", "displayName": "Claude Opus 6 (Orchestrator)", "disabled": false, "hostOrder": 2],
                ["key": "gemini-5-zephyr-extra", "displayName": "Gemini 5 Zephyr (Extra)", "disabled": false, "hostOrder": 0],
            ])
            check(pairedNonGeminiOrch.count == 2, "Paired non-Gemini orchestrator folds into its sibling while respecting hostOrder")
            check(pairedNonGeminiOrch[0].key == "gemini-5-zephyr" && pairedNonGeminiOrch[0].displayName == "Gemini 5 Zephyr" && pairedNonGeminiOrch[0].variants == ["Extra"], "Unpriced grouping honors backend hostOrder and -extra variant (got \(pairedNonGeminiOrch[0]))")
            check(pairedNonGeminiOrch[1].key == "claude-opus-6" && pairedNonGeminiOrch[1].displayName == "Claude Opus 6" && pairedNonGeminiOrch[1].variants == ["High", "Orchestrator"], "Non-Gemini orchestrator folds into matching Claude sibling cleanly (got \(pairedNonGeminiOrch[1]))")

            let customHostOrder = PricingSyncSheetController.sortCurrentPlanKeys(
                ["gemini-4-neon", "gemini-4-zephyr", "claude-opus-5-5"],
                catalogState: [
                    "gemini-4-zephyr": ["availability": "available", "hostOrder": 0],
                    "claude-opus-5-5": ["availability": "available", "hostOrder": 1],
                    "gemini-4-neon": ["availability": "available", "hostOrder": 2],
                ]
            )
            check(customHostOrder == ["gemini-4-zephyr", "claude-opus-5-5", "gemini-4-neon"], "sortCurrentPlanKeys must follow backend hostOrder without hardcoded codename precedence (got \(customHostOrder))")

            _ = L10n.shared.setLanguage("en", notify: true); pump()
            let enPartialOverview = DashboardPage(app: partialHost)
            let enPartialUsage = UsagePage(app: partialHost)
            let enPartialMenu = MenuPanelController(app: partialHost)
            let enOvBox = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 580))
            enOvBox.addSubview(enPartialOverview.view); pin(enPartialOverview.view, to: enOvBox)
            partialWindow.contentView = enOvBox
            enPartialOverview.fetch(); pump()
            enOvBox.layoutSubtreeIfNeeded(); pump()

            let enUsgBox = NSView(frame: NSRect(x: 0, y: 0, width: 880, height: 580))
            enUsgBox.addSubview(enPartialUsage.view); pin(enPartialUsage.view, to: enUsgBox)
            partialWindow.contentView = enUsgBox
            enPartialUsage.fetch(force: true); pump()
            enUsgBox.layoutSubtreeIfNeeded(); pump()

            partialPanelHost.contentViewController = enPartialMenu
            enPartialMenu.selectTab(0, persist: false); enPartialMenu.panelWillOpen(); pump()
            partialPanelHost.setContentSize(enPartialMenu.preferredContentSize); partialPanelHost.contentView?.layoutSubtreeIfNeeded(); pump()

            check(enPartialOverview.costMetricCard?.statusBadge?.title == "Partial" && enPartialOverview.usageMetric.stringValue == "$3.16", "English Overview partial card must keep pure USD and Partial pill")
            check(!enPartialMenu.costTile.statusBadge.isHidden && enPartialMenu.costTile.statusBadge.title == "Partial" && enPartialMenu.costTile.valueLabel.stringValue == "$930.70", "English MenuPanel costTile must keep pure USD and Partial pill")
            check(!enPartialUsage.costStatusBadge.isHidden && enPartialUsage.costStatusBadge.title == "Partial" && enPartialUsage.usdMetric.stringValue == "$930.70", "English UsagePage cost must keep pure USD and Partial pill")
            let foldedEnTexts = allTextValues(foldedSheet.sheet.contentView!)
            check(foldedEnTexts.contains("Includes variants: Low · Medium · High · XHigh · Orchestrator"), "English folded group card must localize variants list: \(foldedEnTexts)")
            let partialEnLeaks = (allTextValues(enOvBox) + allTextValues(enUsgBox) + allTextValues(enPartialMenu.view) + foldedEnTexts)
                .filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil }
            check(partialEnLeaks.isEmpty, "English partial-pricing views must not leak Chinese characters: \(partialEnLeaks)")

            foldedSheet.closeSheet(); waitForSheetDetach(on: partialWindow, description: "Folded PricingSyncSheetController to detach")
            partialPanelHost.orderOut(nil)
            partialWindow.orderOut(nil)
            _ = L10n.shared.setLanguage("zh-Hans", notify: true); pump()
        }

        // Backup account stale quota refresh sync between Main App (AccountsPage) and Menu Bar (MenuPanelController)
        do {
            let syncHost = Assistant(state: state.appendingPathComponent("quota-menu-sync-host"))
            syncHost.configuration = try ConfigurationStore(state: syncHost.state)
            syncHost.bridge = BackendBridge(resources: state, state: syncHost.state)
            syncHost.reachable = true
            let nowTs = Date().timeIntervalSince1970
            let staleTs = nowTs - 1800
            let activeAcc: [String: Any] = [
                "id": "acc-main",
                "email": "main@example.invalid",
                "name": "MainUser",
                "subscription_tier": "PRO",
                "quota_last_updated": Int(nowTs),
                "quota": ["last_updated": nowTs, "subscription_tier": "PRO"],
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
                            ["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.90, "stale": false, "resetCountdown": "4 小时 10 分后重置"],
                            ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.85, "stale": false, "resetCountdown": "5 天 2 小时后重置"]
                        ]
                    ]
                ]
            ]
            let makeBackupAccount: (_ stale5h: Bool, _ staleWeekly: Bool, _ known5h: Bool, _ ts: Double, _ rev: String) -> [String: Any] = { stale5h, staleWeekly, known5h, ts, rev in
                [
                    "id": "acc-backup",
                    "email": "backup@example.invalid",
                    "name": "BackupUser",
                    "subscription_tier": "PRO",
                    "revision": rev,
                    "quota_last_updated": Int(ts),
                    "quota": ["last_updated": ts, "subscription_tier": "PRO"],
                    "quotaGroups": [
                        [
                            "key": "gemini",
                            "displayName": "Gemini",
                            "summaryLabel": "Gemini",
                            "brands": ["gemini"],
                            "isStandalone": false,
                            "availability": "available",
                            "quotaState": (stale5h && staleWeekly) ? "stale" : "known",
                            "windows": [
                                [
                                    "id": "5h",
                                    "period": "5h",
                                    "label": "5 小时",
                                    "known": known5h,
                                    "remaining": known5h ? 0.88 : NSNull(),
                                    "stale": stale5h,
                                    "resetCountdown": known5h ? "4 小时 30 分后重置" : ""
                                ],
                                [
                                    "id": "weekly",
                                    "period": "weekly",
                                    "label": "每周",
                                    "known": true,
                                    "remaining": 0.92,
                                    "stale": staleWeekly,
                                    "resetCountdown": "6 天 1 小时后重置"
                                ]
                            ]
                        ]
                    ]
                ]
            }

            var currentBackup = makeBackupAccount(true, true, false, staleTs, "rev-stale:ready")
            var currentPoolRev = "pool-rev-1"
            syncHost.statusValue = LiveStatus(["running": true, "runningChannel": "stable", "liveAccountEmail": "main@example.invalid", "accountsRevision": currentPoolRev])
            syncHost.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "account_list" {
                    return [
                        "ok": true,
                        "activeId": "acc-main",
                        "currentAccountId": "acc-main",
                        "accounts": [activeAcc, currentBackup],
                        "pendingSwitch": false
                    ]
                }
                if cmd == "quota_refresh" {
                    currentBackup = makeBackupAccount(false, false, true, nowTs, "rev-fresh:ready")
                    currentPoolRev = "pool-rev-2"
                    return [
                        "ok": true,
                        "partial": false,
                        "message": "配额已刷新",
                        "account": currentBackup,
                        "quota": currentBackup["quota"] as Any,
                        "subscription_tier": "PRO"
                    ]
                }
                if cmd == "status" {
                    return [
                        "ok": true,
                        "status": [
                            "mode": "connected",
                            "running": true,
                            "runningChannel": "stable",
                            "liveAccountEmail": "main@example.invalid",
                            "accountsRevision": currentPoolRev
                        ],
                        "tasks": [],
                        "taskRevision": 1
                    ]
                }
                return ["ok": true]
            }

            // 1. Initial stale load into both Main App (AccountsPage) and MenuPanelController (Tab 2 expanded backup card)
            let syncAccountsPage = AccountsPage(app: syncHost)
            syncHost.accountsPage = syncAccountsPage
            let syncMenu = syncHost.ensureMenuPanelController()
            let syncMenuWin = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            syncMenuWin.contentViewController = syncMenu
            syncHost.fetchAccountList(notifyPage: true); pump()
            syncMenu.panelWillOpen(); syncMenu.selectTab(2, persist: true); pump()
            syncMenu.toggleAccountExpanded("acc-backup"); pump()

            let backupCardInMenu = syncMenu.accountsCardsStack.arrangedSubviews.compactMap { $0 as? MenuExpandableAccountCardView }.first { $0.accountId == "acc-backup" }
            check(backupCardInMenu != nil, "Menu accounts tab must mount backup account card")
            check(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue == "已过期", "Stale unknown 5h window in menu backup card must initially render 已过期 (got \(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue ?? ""))")

            // Verify partial window staleness in Main App collapsed summary (5h fresh, weekly stale -> still marks 已过期)
            currentBackup = makeBackupAccount(false, true, true, staleTs, "rev-partial-stale:ready")
            syncAccountsPage.fetch(["accounts": [activeAcc, currentBackup], "activeId": "acc-main", "pendingSwitch": false]); pump()
            if !syncAccountsPage.isAllCollapsedMode {
                syncAccountsPage.toggleCollapseAllAccounts(); pump()
            }
            let partialCollapsedTexts = allTextValues(syncAccountsPage.cardsStack)
            check(partialCollapsedTexts.contains { $0.contains("Gemini 88% (已过期)") }, "Collapsed summary in Main App must disclose (已过期) when any window in the group is stale: \(partialCollapsedTexts)")

            // 2. Simulate in-flight account_list race: old account_list starts while backup is still stale, then backup updates before old account_list returns
            currentBackup = makeBackupAccount(true, true, false, staleTs, "rev-stale:ready")
            syncHost.menuTracking = false
            syncHost.fetchAccountList(notifyPage: true) // in-flight request #1 captures stale snapshot
            check(syncHost.accountListInFlight == true, "First fetchAccountList must mark accountListInFlight")
            currentBackup = makeBackupAccount(false, false, true, nowTs, "rev-fresh:ready")
            syncHost.fetchAccountList(notifyPage: true) // request #2 arrives while #1 is still in flight
            check(syncHost.accountListPendingRefetch == true, "fetchAccountList during in-flight account_list must queue accountListPendingRefetch instead of dropping")
            waitUntil(step: 0.01, description: "queued accountListPendingRefetch to complete") {
                !syncHost.accountListInFlight && !syncHost.accountListPendingRefetch
            }
            pump()
            check(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue == "88%", "Queued accountListPendingRefetch must replace stale in-flight payload with fresh 88% in MenuPanelController (got \(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue ?? ""))")

            // 2b. Reset backup to stale, then run single-account refresh in Main App while menu popover is closed
            currentBackup = makeBackupAccount(true, true, false, staleTs, "rev-stale-2:ready")
            syncHost.fetchAccountList(notifyPage: true)
            waitUntil(step: 0.01, description: "stale backup reset fetchAccountList to complete") {
                !syncHost.accountListInFlight && !syncHost.accountListPendingRefetch
            }
            pump()
            check(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue == "已过期", "Menu backup card must reset to 已过期 before single-account refresh")
            syncHost.refreshSingleAccountQuota(id: "acc-backup")
            waitUntil(step: 0.01, description: "single-account quota refresh and account_list sync to complete") {
                !syncHost.refreshingAccountIds.contains("acc-backup")
                    && !syncHost.accountListInFlight
                    && !syncHost.accountListPendingRefetch
            }
            pump()

            // Verify MenuPanelController and cachedAccounts both reflect the fresh quota without reopening or manual refresh in menu bar
            check(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue == "88%", "Menu backup account 5h quota must update from 已过期 to 88% after Main App refresh (got \(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue ?? ""))")
            check(!(backupCardInMenu?.quotaRowViews.first?.resetLabel.stringValue.contains("过期") ?? true), "Menu backup account 5h resetLabel must clear 数据已过期 after Main App refresh")
            check(!(backupCardInMenu?.quotaRowViews.last?.resetLabel.stringValue.contains("过期") ?? true), "Menu backup account weekly resetLabel must clear 数据已过期 after Main App refresh")
            let refreshedCollapsedTexts = allTextValues(syncAccountsPage.cardsStack)
            check(refreshedCollapsedTexts.contains { $0.contains("Gemini 88%") && !$0.contains("已过期") }, "Main App collapsed summary must also clear (已过期) after refresh: \(refreshedCollapsedTexts)")

            // 3. Verify opening MenuPanelController on Tab 2 when lastAccountListFetchAt is >= 15s old proactively refetches account_list
            currentBackup = makeBackupAccount(false, false, true, nowTs + 10, "rev-fresh-2:ready")
            if var g = (currentBackup["quotaGroups"] as? [[String: Any]])?.first,
               var ws = g["windows"] as? [[String: Any]], !ws.isEmpty {
                ws[0]["remaining"] = 0.96
                g["windows"] = ws
                currentBackup["quotaGroups"] = [g]
            }
            syncHost.lastAccountListFetchAt = Date(timeIntervalSinceNow: -20)
            syncMenu.panelWillOpen(); pump()
            waitUntil(step: 0.01, description: "MenuPanel reopen account_list refetch to complete") {
                !syncHost.accountListInFlight && !syncHost.accountListPendingRefetch
            }
            check(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue == "96%", "Reopening MenuPanelController after 15s staleness window must proactively refetch account_list and render 96% (got \(backupCardInMenu?.quotaRowViews.first?.valueLabel.stringValue ?? ""))")
            syncMenuWin.orderOut(nil)
        }

        // Verify ModelUsageFold merges thinking variants (-low / -high / -xhigh) while preserving -n / -exp-a
        do {
            let folded = ModelUsageFold.foldThinkingVariants([
                ["model": "gemini-4-neon-high", "totalTokens": 1000, "promptTokens": 600, "candidatesTokens": 400, "requestCount": 2, "estimatedUsd": 0.12, "priced": true],
                ["model": "gemini-4-neon-xhigh", "totalTokens": 2500, "promptTokens": 1500, "candidatesTokens": 1000, "requestCount": 3, "estimatedUsd": 0.30, "priced": true],
                ["model": "gemini-4-neon-low", "totalTokens": 500, "promptTokens": 300, "candidatesTokens": 200, "requestCount": 1, "estimatedUsd": 0.06, "priced": true],
                ["model": "gemini-3.8-flash-n", "totalTokens": 800, "promptTokens": 500, "candidatesTokens": 300, "requestCount": 4, "estimatedUsd": 0.04, "priced": true],
            ])
            check(folded.count == 2, "Thinking effort variants of gemini-4-neon must fold into 1 row while keeping -n separate (got \(folded.count))")
            check((folded.first?["model"] as? String) == "gemini-4-neon", "Folded model key must be gemini-4-neon (got \(folded.first?["model"] ?? ""))")
            check(intVal(folded[0], "totalTokens") == 4000, "Folded totalTokens must sum to 4000")
            check(intVal(folded[0], "requestCount") == 6, "Folded requestCount must sum to 6")
            check(abs(doubleVal(folded[0], "estimatedUsd") - 0.48) < 1e-6, "Folded estimatedUsd must sum to 0.48")
            check((folded[1]["model"] as? String) == "gemini-3.8-flash-n", "Non-thinking -n suffix must remain distinct")
        }

        // OPT-08 / OPT-11 / OPT-12 / OPT-16: Claude Fable/Mythos & GPT-6+ safe sorting, MenuPanel warningSummary/outdated footer/15s refresh & keyboard navigation
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let futureHost = Assistant(state: state.appendingPathComponent("opt-future-pricing"))
            futureHost.configuration = try ConfigurationStore(state: futureHost.state)
            futureHost.bridge = BackendBridge(resources: state, state: futureHost.state)
            futureHost.reachable = true
            let futureSheet = PricingSyncSheetController(app: futureHost)
            let futurePayload: [String: Any] = [
                "synced": true,
                "status": ["lastCheckAt": 1794539910722.0, "modelCount": 5],
                "prices": [
                    "claude-opus-5-5": ["input": 4.0, "output": 20.0, "cached": 0.2],
                    "claude-fable-5-2": ["input": 8.0, "output": 40.0, "cached": 0.2],
                    "claude-mythos-5-2": ["input": 8.0, "output": 40.0, "cached": 0.2],
                    "gpt-6.2-astra": ["input": 8.0, "output": 40.0, "cached": 0.4],
                    "gpt-6-luna": ["input": 0.1, "output": 0.5, "cached": 0.01],
                ],
                "pricingStatus": [
                    "claude-opus-5-5": "confirmed",
                    "claude-fable-5-2": "confirmed",
                    "claude-mythos-5-2": "confirmed",
                    "gpt-6.2-astra": "confirmed",
                    "gpt-6-luna": "confirmed",
                ],
                "modelCatalogState": [
                    "claude-opus-5-5": ["availability": "available", "displayName": "Claude Opus 5.5"],
                    "claude-fable-5-2": ["availability": "available", "displayName": "Claude Fable 5.2"],
                    "claude-mythos-5-2": ["availability": "available", "displayName": "Claude Mythos 5.2"],
                    "gpt-6.2-astra": ["availability": "available", "displayName": "GPT-6.2 Astra"],
                    "gpt-6-luna": ["availability": "available", "displayName": "GPT-6 Luna"],
                ]
            ]
            futureSheet.show(in: window, payload: futurePayload)
            pump()
            let sortedFutureKeys = futureSheet.renderedSummaryLines.compactMap { $0.split(separator: " ").first.map(String.init) }
            check(sortedFutureKeys.count == 5, "Future models must render without NSRangeException crash (got \(sortedFutureKeys.count))")
            if let opusIdx = sortedFutureKeys.firstIndex(of: "claude-opus-5-5"),
               let fableIdx = sortedFutureKeys.firstIndex(of: "claude-fable-5-2"),
               let astraIdx = sortedFutureKeys.firstIndex(of: "gpt-6.2-astra"),
               let lunaIdx = sortedFutureKeys.firstIndex(of: "gpt-6-luna") {
                check(opusIdx < fableIdx, "Claude 5.5 must sort before Claude Fable 5.2")
                check(astraIdx < lunaIdx, "GPT-6.2 Astra must sort before GPT-6 Luna")
            } else {
                check(false, "Expected all future model keys in renderedSummaryLines: \(sortedFutureKeys)")
            }
            futureSheet.closeSheet(); waitForSheetDetach(on: window, description: "Future PricingSyncSheetController to detach")

            let optHost = Assistant(state: state.appendingPathComponent("opt-menu-panel"))
            optHost.configuration = try ConfigurationStore(state: optHost.state)
            optHost.bridge = BackendBridge(resources: state, state: optHost.state)
            optHost.reachable = true
            optHost.menuTracking = true
            var usageCalls = 0
            var recommendCalls = 0
            optHost.bridge.fixtureReply = { req in
                let cmd = req["command"] as? String ?? ""
                if cmd == "usage_summary" {
                    usageCalls += 1
                    return [
                        "ok": true, "period": "today", "snapshotId": "opt11-snap-\(usageCalls)",
                        "summary": ["availability": "complete", "totalTokens": 1200, "requestCount": 2, "estimatedUsd": 0.25, "pricedModels": 1, "unpricedModels": 0],
                        "byModel": [["model": "gemini-3.6-flash", "totalTokens": 1200, "requestCount": 2, "estimatedUsd": 0.25, "priced": true, "pricingStatus": "expired"]],
                        "dailyTrends": [], "todayHourly": []
                    ]
                }
                if cmd == "auto_switch_best" {
                    recommendCalls += 1
                    return ["ok": true, "shouldSwitch": true, "account": ["id": "opt-b"]]
                }
                return ["ok": true]
            }
            optHost.cachedAccounts = [
                [
                    "id": "opt-a", "email": "opta@example.invalid", "subscription_tier": "PRO",
                    "quotaWarnings": ["NO_MODEL_RECORDS: 未返回模型配额记录"],
                    "quotaWarningCodes": ["NO_MODEL_RECORDS"]
                ],
                ["id": "opt-b", "email": "optb@example.invalid", "subscription_tier": "PRO"]
            ]
            optHost.activeAccountId = "opt-a"
            optHost.lastFetchedAccountsRevision = "rev-opt-1"
            let optMenu = optHost.ensureMenuPanelController()
            optMenu.selectTab(0, persist: false); pump()
            let callsAfterOpen = usageCalls
            check(callsAfterOpen >= 1, "OPT-11: Initial MenuPanel Tab 0 should fetch usage_summary")
            optHost.usageLastFetchTimeByPeriod["today"] = Date(timeIntervalSinceNow: -20)
            optMenu.syncFromAssistant(updateSize: false)
            pump()
            check(usageCalls > callsAfterOpen, "OPT-11: Stale 15s usage cache while MenuPanel Tab 0 is shown must auto-refresh usage_summary")
            check(optMenu.usageFooterLabel.stringValue.contains("价格待核对") || optMenu.usageFooterLabel.stringValue.contains("定价已过期"), "OPT-11: MenuPanel usage footer must indicate expired model pricing")

            optMenu.selectTab(1, persist: false); pump()
            check(!optMenu.quotaWarningLabel.isHidden && !optMenu.quotaWarningLabel.stringValue.isEmpty, "OPT-11: MenuPanel quota tab must display QuotaPresentation.warningSummary")

            optMenu.selectTab(2, persist: false); pump()
            check(recommendCalls == 1 && optHost.cachedRecommendedAccountId == "opt-b", "OPT-12: MenuPanel standalone mode must query auto_switch_best(preview) and populate cachedRecommendedAccountId")
            check(allTextValues(optMenu.accountsCardsStack).contains("推荐备用"), "OPT-12: MenuPanel accounts card must show 推荐备用 badge without opening AccountsPage")
            let optACard = optMenu.accountsCardsStack.arrangedSubviews.compactMap { $0 as? MenuExpandableAccountCardView }.first { $0.accountId == "opt-a" }
            check((optACard?.warningLabel.isHidden == false) && !(optACard?.warningLabel.stringValue.isEmpty ?? true), "OPT-11: MenuExpandableAccountCardView must display QuotaPresentation.warningSummary")

            // OPT-16: Segmented tabs left/right keyboard navigation
            let segTabs = MenuSegmentedTabsView(items: ["A", "B", "C"], style: .primaryTabs, accessibilityLabel: "TestTabs")
            segTabs.moveSelection(by: 1)
            check(segTabs.selectedIndex == 1, "OPT-16: MenuSegmentedTabsView right arrow moves selection to index 1")
            segTabs.moveSelection(by: -1)
            check(segTabs.selectedIndex == 0, "OPT-16: MenuSegmentedTabsView left arrow moves selection back to index 0")
            let designSeg = DesignSegmentedControl(labels: ["One", "Two", "Three"])
            designSeg.moveSelection(by: 2)
            check(designSeg.selectedSegment == 2, "OPT-16: DesignSegmentedControl right arrow moves selection to index 2")
        }

        // Standby cooling UX: auto-refresh eligibility, plain-language reset labels, and deferred single-account notices
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let standbyHost = Assistant(state: state.appendingPathComponent("standby-cooling-ux"))
            standbyHost.configuration = try ConfigurationStore(state: standbyHost.state)
            standbyHost.bridge = BackendBridge(resources: state, state: standbyHost.state)
            standbyHost.reachable = true
            standbyHost.menuTracking = true

            check(!standbyHost.isEligibleForAutoQuotaRefresh(["id": "a", "standbyRefreshStatus": ["mode": "snapshot_cooling"]]), "isEligibleForAutoQuotaRefresh must return false for snapshot_cooling")
            check(!standbyHost.isEligibleForAutoQuotaRefresh(["id": "b", "standbyRefreshStatus": ["mode": "snapshot_cooldown_elapsed"]]), "isEligibleForAutoQuotaRefresh must return false for snapshot_cooldown_elapsed")
            check(standbyHost.isEligibleForAutoQuotaRefresh(["id": "c", "standbyRefreshStatus": ["mode": "live_active"]]), "isEligibleForAutoQuotaRefresh must return true for live_active")
            check(standbyHost.isEligibleForAutoQuotaRefresh(["id": "d", "standbyRefreshStatus": ["mode": "cloud_auto"]]), "isEligibleForAutoQuotaRefresh must return true for cloud_auto")

            let overdueIso = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: -3600))
            let futureIso = ISO8601DateFormatter().string(from: Date(timeIntervalSinceNow: 4 * 3600))
            let sampleTs = Date().timeIntervalSince1970 - 1800
            let standbyAccountsList: [[String: Any]] = [
                [
                    "id": "sb-active", "email": "active@example.invalid", "subscription_tier": "PRO",
                    "standbyRefreshStatus": ["mode": "live_active", "hasLocalOAuthClient": false, "canBackgroundRefresh": true],
                    "quota": ["last_updated": Date().timeIntervalSince1970],
                    "quotaGroups": [[
                        "key": "gemini", "displayName": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known",
                        "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.85, "stale": false, "resetTime": futureIso]]
                    ]]
                ],
                [
                    "id": "sb-cooling", "email": "cooling@example.invalid", "subscription_tier": "PRO",
                    "standbyRefreshStatus": ["mode": "snapshot_cooling", "hasLocalOAuthClient": false, "canBackgroundRefresh": false],
                    "quota": ["last_updated": sampleTs],
                    "quotaGroups": [[
                        "key": "gemini", "displayName": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known",
                        "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.72, "stale": true, "resetTime": futureIso]]
                    ]]
                ],
                [
                    "id": "sb-elapsed", "email": "elapsed@example.invalid", "subscription_tier": "PRO",
                    "standbyRefreshStatus": ["mode": "snapshot_cooldown_elapsed", "hasLocalOAuthClient": false, "canBackgroundRefresh": false, "cooldownElapsedFamilies": ["gemini"]],
                    "quota": ["last_updated": sampleTs],
                    "quotaGroups": [[
                        "key": "gemini", "displayName": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known",
                        "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.20, "stale": true, "resetTime": overdueIso]]
                    ]]
                ]
            ]
            let deferredNotice = L10n.t("account_cloud.err.missing_oauth_client")
            standbyHost.bridge.fixtureReply = { req in
                let cmd = req["command"] as? String ?? ""
                if cmd == "account_list" {
                    return ["ok": true, "accounts": standbyAccountsList, "activeId": "sb-active", "currentAccountId": "sb-active"]
                }
                if cmd == "quota_refresh" {
                    return ["ok": true, "standbyDeferred": true, "notice": deferredNotice]
                }
                if cmd == "auto_switch_best" {
                    return ["ok": true, "shouldSwitch": false]
                }
                return ["ok": true]
            }
            standbyHost.cachedAccounts = standbyAccountsList
            standbyHost.activeAccountId = "sb-active"
            let standbyMenu = standbyHost.ensureMenuPanelController()
            standbyMenu.selectTab(2, persist: false); pump()
            standbyHost.refreshSingleAccountQuota(id: "sb-elapsed")
            waitUntil(step: 0.01, description: "standby deferred single-account refresh notice") {
                !standbyHost.refreshingAccountIds.contains("sb-elapsed")
                    && !standbyHost.accountListInFlight
            }
            pump()
            check(standbyHost.singleAccountRefreshErrors["sb-elapsed"] == nil, "standbyDeferred must not populate singleAccountRefreshErrors")
            check(standbyHost.singleAccountRefreshNotices["sb-elapsed"] == deferredNotice, "standbyDeferred must store notice in singleAccountRefreshNotices")
            let coolingMenuCard = standbyMenu.accountsCardsStack.arrangedSubviews.compactMap { $0 as? MenuExpandableAccountCardView }.first { $0.accountId == "sb-cooling" }
            let elapsedMenuCard = standbyMenu.accountsCardsStack.arrangedSubviews.compactMap { $0 as? MenuExpandableAccountCardView }.first { $0.accountId == "sb-elapsed" }
            check(coolingMenuCard?.timestampLabel.stringValue.contains("切换后更新") == true && coolingMenuCard?.timestampLabel.textColor == .secondaryLabelColor, "Menu cooling card footer shows plain recorded timestamp in secondaryLabelColor")
            check(elapsedMenuCard?.timestampLabel.stringValue == L10n.t("accounts.standby.reset_passed") && elapsedMenuCard?.timestampLabel.textColor == Design.blue, "Menu elapsed card footer shows reset_passed in Design.blue")
            check(elapsedMenuCard?.quotaRowViews.first?.resetLabel.stringValue == L10n.t("accounts.standby.likely_reset"), "Menu elapsed card window shows compact 预计已重置 instead of 已过期")
            check(elapsedMenuCard?.warningLabel.isHidden == false && elapsedMenuCard?.warningLabel.stringValue == deferredNotice && elapsedMenuCard?.warningLabel.textColor == .secondaryLabelColor, "Menu elapsed card displays deferred notice in neutral secondaryLabelColor")

            let standbyAccountsPage = AccountsPage(app: standbyHost)
            standbyAccountsPage.fetch(["accounts": standbyAccountsList, "activeId": "sb-active", "pendingSwitch": false]); pump()
            let standbyPageTexts = allTextValues(standbyAccountsPage.cardsStack)
            check(standbyPageTexts.contains { $0.contains(L10n.t("accounts.standby.likely_reset_sync")) }, "AccountsPage wide card shows 预计已重置 · 切换后更新 for overdue standby window: \(standbyPageTexts)")
            check(standbyPageTexts.contains { $0 == L10n.t("accounts.standby.reset_passed") }, "AccountsPage wide card shows reset_passed footer")
            check(standbyPageTexts.contains { $0 == deferredNotice }, "AccountsPage wide card displays deferred notice")

            standbyHost.confirmSwitchForTesting = { _, cb in cb(true) }
            standbyHost.requestInteractiveAccountSwitch(id: "sb-elapsed", email: "elapsed@example.invalid", name: "")
            waitUntil(step: 0.01, description: "standby switch clears singleAccountRefreshNotices") {
                !standbyHost.accountSwitchInFlight && standbyHost.singleAccountRefreshNotices["sb-elapsed"] == nil
            }
            check(standbyHost.singleAccountRefreshNotices["sb-elapsed"] == nil, "Successful switch must clear singleAccountRefreshNotices for target account")
        }

        // Milestone 1 SSH: 隔离验证 Overview / MenuPanel 远程只读上下文切换、降级态与清空自动回退
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let sshHost = Assistant(state: state.appendingPathComponent("ssh-context-ui"))
            sshHost.configuration = try ConfigurationStore(state: sshHost.state)
            sshHost.bridge = BackendBridge(resources: state, state: sshHost.state)
            sshHost.reachable = true
            let nowTs = Date().timeIntervalSince1970
            let localAccount: [String: Any] = [
                "id": "acc-local",
                "name": "LocalUser",
                "email": "local@example.invalid",
                "subscription_tier": "PRO",
                "revision": "rev-local-ssh",
                "quota_last_updated": Int(nowTs),
                "quota": ["last_updated": nowTs, "subscription_tier": "PRO"],
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
                            ["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.84, "stale": false, "resetCountdown": "4 小时 15 分后重置"],
                            ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.90, "stale": false, "resetCountdown": "6 天 2 小时后重置"]
                        ]
                    ]
                ]
            ]
            sshHost.cachedAccounts = [localAccount]
            sshHost.activeAccountId = "acc-local"
            sshHost.statusValue = LiveStatus([
                "mode": "connected",
                "running": true,
                "runningChannel": "stable",
                "liveAccountEmail": "local@example.invalid",
                "accountsRevision": "rev-local-ssh"
            ])
            var requestedDashboardEnvs: [String] = []
            let allUsage: [String: Any] = [
                "selectedEnvironmentId": "all",
                "todayTokens": 18000,
                "totalTokens": 300000,
                "estimatedUsd": 0.20,
                "allTimeEstimatedUsd": 3.00,
                "requestCount": 7,
                "totalRequestCount": 60,
                "todayPricedModels": 1,
                "todayUnpricedModels": 0,
                "pricedModels": 1,
                "unpricedModels": 0,
                "databasesScanned": 10,
                "databasesDiscovered": 10,
                "availability": "complete",
                "environmentBreakdown": [
                    "local_tokens": 12000, "ssh_tokens": 6000,
                    "local_share_pct": 67, "ssh_share_pct": 33,
                    "has_ssh_data": true
                ],
                "todayByModel": [
                    ["model": "gemini-3.8-flash-n", "totalTokens": 18000, "requestCount": 7, "estimatedUsd": 0.20, "priced": true]
                ]
            ]
            let localOnlyUsage: [String: Any] = [
                "selectedEnvironmentId": "local",
                "todayTokens": 12000,
                "totalTokens": 240000,
                "estimatedUsd": 0.12,
                "allTimeEstimatedUsd": 2.40,
                "requestCount": 4,
                "totalRequestCount": 48,
                "todayPricedModels": 1,
                "todayUnpricedModels": 0,
                "pricedModels": 1,
                "unpricedModels": 0,
                "databasesScanned": 10,
                "databasesDiscovered": 10,
                "availability": "complete",
                "todayByModel": [
                    ["model": "gemini-3.8-flash-n", "totalTokens": 12000, "requestCount": 4, "estimatedUsd": 0.12, "priced": true]
                ]
            ]
            let sshOnlyUsage: [String: Any] = [
                "selectedEnvironmentId": "ssh:demo-env-1",
                "todayTokens": 6000,
                "totalTokens": 60000,
                "estimatedUsd": 0.08,
                "allTimeEstimatedUsd": 0.60,
                "requestCount": 3,
                "totalRequestCount": 12,
                "todayPricedModels": 1,
                "todayUnpricedModels": 0,
                "pricedModels": 1,
                "unpricedModels": 0,
                "databasesScanned": 10,
                "databasesDiscovered": 10,
                "availability": "complete",
                "todayByModel": [
                    ["model": "gemini-3.8-flash-n", "totalTokens": 6000, "requestCount": 3, "estimatedUsd": 0.08, "priced": true]
                ]
            ]
            let baseAccountsPayload = localAccount.merging([
                "activeName": "LocalUser",
                "activeEmail": "local@example.invalid",
                "activeTier": "PRO",
                "liveAccountEmail": "local@example.invalid",
                "isLiveVerified": true
            ]) { _, new in new }
            let localSummary: [String: Any] = [
                "ok": true,
                "accounts": baseAccountsPayload,
                "usage": allUsage,
                "remoteSessions": [],
                "focusedContextKey": "local"
            ]
            sshHost.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "account_list" {
                    return ["ok": true, "activeId": "acc-local", "currentAccountId": "acc-local", "accounts": [localAccount], "pendingSwitch": false]
                }
                if cmd == "dashboard_summary" {
                    let reqEnv = (payload["environmentId"] as? String) ?? "all"
                    requestedDashboardEnvs.append(reqEnv)
                    let selectedUsage: [String: Any] = reqEnv == "local" ? localOnlyUsage : (reqEnv == "ssh:demo-env-1" ? sshOnlyUsage : allUsage)
                    return [
                        "ok": true,
                        "accounts": baseAccountsPayload,
                        "usage": selectedUsage,
                        "remoteSessions": sshHost.remoteSessions,
                        "focusedContextKey": "local"
                    ]
                }
                return ["ok": true]
            }

            let sshOverview = DashboardPage(app: sshHost)
            sshHost.overview = sshOverview
            sshOverview.view.frame = NSRect(x: 0, y: 0, width: 960, height: 680)
            let sshOverviewWin = makeHeadlessHostWindow(width: 960, height: 680)
            sshOverviewWin.contentView = sshOverview.view
            sshOverview.renderSummary(localSummary, isStaleFallback: false)

            let sshMenu = sshHost.ensureMenuPanelController()
            let sshMenuWin = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            sshMenuWin.contentViewController = sshMenu
            sshMenu.panelWillOpen()
            sshMenu.selectTab(1, persist: false)
            pump()

            check(sshOverview.contextPill.isHidden && sshOverview.contextMetaLabel.isHidden && sshOverview.heroRemoteHostBadge.isHidden && sshOverview.companionMoreButton.isHidden, "SSH: Overview must hide contextPill, contextMetaLabel, heroRemoteHostBadge, and companionMoreButton when remoteSessions is empty")
            check(sshMenu.contextPill.isHidden && sshMenu.headerContextDivider.isHidden, "SSH: Menu contextPill and headerContextDivider must remain hidden when remoteSessions is empty")
            check(sshMenu.accountsLocalOnlyNoteLabel.isHidden, "SSH: Menu accountsLocalOnlyNoteLabel must remain hidden when remoteSessions is empty")

            func makeRemoteSession(
                remoteKey: String = "rk-test",
                environmentId: String = "ssh:demo-env-1",
                hostLabel: String = "demo-ssh-host",
                state: String,
                includeQuota: Bool,
                includeStandalone: Bool = false
            ) -> [String: Any] {
                var row: [String: Any] = [
                    "remoteKey": remoteKey,
                    "environmentId": environmentId,
                    "hostLabel": hostLabel,
                    "state": state,
                    "email": "remote-only@example.invalid",
                    "name": "Remote User",
                    "subscription_tier": "ULTRA",
                    "matchedLocalAccountId": NSNull(),
                    "observedAt": nowTs * 1000.0,
                    "quotaLastUpdated": nowTs,
                    "availability": includeQuota ? "available" : "unavailable"
                ]
                var groups: [[String: Any]] = includeQuota ? [
                    [
                        "key": "gemini",
                        "displayName": "Gemini",
                        "summaryLabel": "Gemini",
                        "brands": ["gemini"],
                        "isStandalone": false,
                        "availability": "available",
                        "quotaState": "known",
                        "windows": [
                            ["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.91, "stale": false, "resetCountdown": "4 小时 40 分后重置"],
                            ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.77, "stale": false, "resetCountdown": "5 天 20 小时后重置"]
                        ]
                    ]
                ] : []
                if includeStandalone {
                    groups.append([
                        "key": "standalone-argon",
                        "displayName": "Argon",
                        "summaryLabel": "Argon",
                        "brands": ["argon"],
                        "isStandalone": true,
                        "availability": "available",
                        "quotaState": "known",
                        "windows": [
                            ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.85, "stale": false, "resetCountdown": "6 天后重置"]
                        ]
                    ])
                }
                row["quotaGroups"] = groups
                return row
            }

            func findButtons(in root: NSView) -> [NSButton] {
                var out: [NSButton] = []
                if let btn = root as? NSButton { out.append(btn) }
                for sub in root.subviews { out.append(contentsOf: findButtons(in: sub)) }
                return out
            }

            // 1. 注入 1 个不同账号远端会话：总览顶栏启用 EnvironmentContextPill、Hero 显示本机微标与伴生区「查看」；菜单栏顶栏启用 EnvironmentContextPill（Tab 1 无「全部」）且固定 [刷新]/[···]
            sshHost.syncRemoteSessionsFromPayload([makeRemoteSession(state: "connected", includeQuota: true, includeStandalone: true)], focusedKey: "local")
            pump()
            sshOverviewWin.contentView?.layoutSubtreeIfNeeded()
            sshMenuWin.contentView?.layoutSubtreeIfNeeded()
            check(!sshOverview.contextPill.isHidden && sshOverview.contextPill.selectedScope == .all && !sshOverview.contextPill.isActive, "SSH: Overview default state must show unscoped EnvironmentContextPill")
            check(sshOverview.heroRemoteHostBadge.isHidden, "SSH: Overview default state must keep heroRemoteHostBadge hidden")
            check(sshHost.overviewEnvironmentKey == "all", "SSH: Overview must default to 'all' (总计) when SSH connects")
            if let heroBox = findEnclosingBox(sshOverview.refreshQuotaButton) {
                let heroTexts = allTextValues(heroBox)
                check(heroTexts.contains("demo-ssh-host"), "SSH: Overview default state must show clean hostname demo-ssh-host in companion section (got \(heroTexts))")
                check(!heroTexts.contains(where: { $0.hasPrefix("SSH:") || $0.hasPrefix("SSH ·") }), "SSH: Overview companion section must not contain SSH: or SSH · prefix (got \(heroTexts))")
                check(findButtons(in: heroBox).contains { $0.title == "查看" && $0.image != nil }, "SSH: Overview companion section must show 查看 button with chevron icon")
            } else {
                check(false, "SSH: Overview must locate Hero box")
            }
            check(!sshMenu.contextPill.isHidden && !sshMenu.headerContextDivider.isHidden, "SSH: Menu contextPill and headerContextDivider must be visible for 1 SSH host")
            check(sshMenu.contextPill.frame.width <= 154.5, "SSH: Menu contextPill width must stay <= 154pt (got \(sshMenu.contextPill.frame.width))")
            check(!sshMenu.headerRefreshButton.isHidden && sshMenu.headerRefreshButton.alphaValue == 1.0 && sshMenu.headerRefreshButton.frame.width == 78, "SSH: Menu headerRefreshButton must remain 78pt and opaque")
            check(!sshMenu.moreButton.isHidden && sshMenu.moreButton.alphaValue == 1.0 && sshMenu.moreButton.isEnabled && sshMenu.moreButton.frame.width == 28, "SSH: Menu moreButton must remain 28pt, enabled, and opaque")
            let tab1MenuTitles = sshMenu.contextPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(!tab1MenuTitles.contains(L10n.t("ssh.scope.all", fallback: "全部")), "SSH: Menu Tab 1 contextPill must omit 全部 item (got \(tab1MenuTitles))")
            check(tab1MenuTitles.contains { $0.contains("demo-ssh-host") } && tab1MenuTitles.allSatisfy { !$0.contains("SSH:") && !$0.contains("SSH ·") }, "SSH: Menu contextPill items must show clean hostname without SSH prefix: \(tab1MenuTitles)")
            check(sshOverview.todayTokensMetric.stringValue == "18K" && sshOverview.todayRequestsMetric.stringValue == "7", "SSH: Overview 'all' must show combined usage (18K / 7)")

            let baselineHeaderPillY = sshOverview.contextPill.frame.minY
            let baselineMetricsY = sshOverview.metricsContainer?.frame.minY ?? -1
            let baselineBentoY = sshOverview.bentoRow.frame.minY

            sshMenu.selectTab(2, persist: false); pump()
            check(!sshMenu.accountsLocalOnlyNoteLabel.isHidden, "SSH: Menu accountsLocalOnlyNoteLabel must disclose local-only scope when remoteSessions is non-empty")
            check(sshMenu.contextPill.isHidden && sshMenu.headerContextDivider.isHidden, "SSH: Menu Tab 2 must hide top bar contextPill and headerContextDivider")
            sshMenu.selectTab(1, persist: false); pump()

            // 菜单栏切换不影响总览当前视角；总览点击伴生区「查看」进入远端视角并通过顶栏 Pill 切回「全部」
            sshHost.selectQuotaContext("remote:rk-test", userInitiated: true)
            pump()
            check(sshHost.selectedContextKey == "remote:rk-test" && sshHost.activeNodeScope == .remote(environmentId: "ssh:demo-env-1"), "SSH: selectQuotaContext must activate remote:rk-test in MenuPanel")
            check(sshHost.overviewEnvironmentKey == "all", "SSH: Menu context switch must not override Overview environment selection")
            check(sshMenu.quotaEmailLabel.stringValue == "remote-only@example.invalid", "SSH: Menu quota tab must display remote email")
            check(sshMenu.quotaStatusBadge.isHidden, "SSH: Menu quotaStatusBadge must remain hidden when top EnvironmentContextPill indicates remote host")
            check(!sshMenu.quotaGroupsContainer.isHidden, "SSH: Menu quotaGroupsContainer must remain visible with remote quota groups")
            check(sshMenu.quotaFooterLabel.stringValue.contains("与本机不同账号"), "SSH: Menu footer must disclose different account from local (got \(sshMenu.quotaFooterLabel.stringValue))")

            let settleOverviewEnv: (String, String, () -> Void) -> Void = { expectedEnv, expectedTokens, trigger in
                let prevCount = requestedDashboardEnvs.count
                trigger()
                waitUntil(step: 0.01, description: "SSH Overview settle \(expectedEnv)") {
                    requestedDashboardEnvs.count > prevCount
                        && requestedDashboardEnvs.last == expectedEnv
                        && sshOverview.todayTokensMetric.stringValue == expectedTokens
                }
                pump()
                sshOverviewWin.contentView?.layoutSubtreeIfNeeded()
            }

            settleOverviewEnv("local", "12K") {
                sshHost.selectOverviewEnvironment("local")
            }
            check(requestedDashboardEnvs.contains("local"), "SSH: Switching Overview to local must query dashboard_summary with environmentId=local")
            check(sshOverview.todayTokensMetric.stringValue == "12K" && sshOverview.todayRequestsMetric.stringValue == "4", "SSH: Overview local view must isolate local usage (12K / 4), got \(sshOverview.todayTokensMetric.stringValue)/\(sshOverview.todayRequestsMetric.stringValue)")
            check(abs(sshOverview.contextPill.frame.minY - baselineHeaderPillY) < 0.5, "SSH: Overview header contextPill must not shift vertically when switching to local")
            check((sshOverview.metricsContainer?.frame.height ?? 0) > 60 && sshOverview.bentoRow.frame.height > 80, "SSH: Overview metricsContainer and bentoRow must maintain valid geometry in local view")

            settleOverviewEnv("all", "18K") {
                sshHost.selectOverviewEnvironment("all")
            }
            check(abs((sshOverview.metricsContainer?.frame.minY ?? -99) - baselineMetricsY) < 0.5 && abs(sshOverview.bentoRow.frame.minY - baselineBentoY) < 0.5, "SSH: Overview returning from local to all must restore baseline metricsContainer and bentoRow vertical alignment")
            settleOverviewEnv("ssh:demo-env-1", "6K") {
                if let heroBox = findEnclosingBox(sshOverview.refreshQuotaButton),
                   let viewBtn = findButtons(in: heroBox).first(where: { $0.title == "查看" }) {
                    viewBtn.performClick(nil)
                } else {
                    sshHost.selectOverviewEnvironment("env:ssh:demo-env-1")
                }
            }
            check(sshHost.overviewEnvironmentKey == "env:ssh:demo-env-1", "SSH: Clicking companion 查看 must enter drilldown for env:ssh:demo-env-1 (got \(sshHost.overviewEnvironmentKey))")
            check(requestedDashboardEnvs.contains("ssh:demo-env-1"), "SSH: Switching Overview to SSH must query dashboard_summary with environmentId=ssh:demo-env-1")
            check(sshOverview.todayTokensMetric.stringValue == "6K" && sshOverview.todayRequestsMetric.stringValue == "3", "SSH: Overview SSH view must isolate SSH usage (6K / 3), got \(sshOverview.todayTokensMetric.stringValue)/\(sshOverview.todayRequestsMetric.stringValue)")
            check(sshOverview.activeEmailLabel.stringValue == "remote-only@example.invalid", "SSH: Overview must display remote email in read-only hero (got \(sshOverview.activeEmailLabel.stringValue))")
            check(!sshOverview.heroRemoteHostBadge.isHidden && sshOverview.heroRemoteHostBadge.label.stringValue == "demo-ssh-host", "SSH: Overview remote focus must show heroRemoteHostBadge demo-ssh-host (got \(sshOverview.heroRemoteHostBadge.label.stringValue))")
            check(!sshOverview.contextMetaLabel.isHidden && sshOverview.contextMetaLabel.stringValue.contains(L10n.t("overview.ssh.remote_pill_meta", fallback: "远程只读")), "SSH: Overview remote focus must show 远程只读 in contextMetaLabel (got \(sshOverview.contextMetaLabel.stringValue))")
            check(sshOverview.contextPill.selectedScope == .remote(environmentId: "ssh:demo-env-1") && sshOverview.contextPill.isActive && sshOverview.contextPill.style == .headerPill && sshOverview.contextPill.pillHeight == 26 && sshOverview.contextPill.displayTitle == "demo-ssh-host" && !sshOverview.contextPill.displayTitle.contains("●") && sshOverview.contextPill.triggerButton.itemKind == .ssh, "SSH: Overview remote focus must sync contextPill selection, .headerPill 26pt style, clean host title, and active state")
            if let heroBox = findEnclosingBox(sshOverview.refreshQuotaButton) {
                check(!findButtons(in: heroBox).contains { $0.title == "查看" }, "SSH: Overview remote focus must hide companion 查看 rows")
            }
            check(abs(sshOverview.contextPill.frame.minY - baselineHeaderPillY) < 0.5, "SSH: Overview header contextPill must not shift vertically when switching to SSH")
            check((sshOverview.metricsContainer?.frame.height ?? 0) > 60 && sshOverview.bentoRow.frame.height > 80, "SSH: Overview metricsContainer and bentoRow must maintain valid geometry in SSH view")
            check(sshHost.cachedAccounts.count == 1 && sshHost.activeAccountId == "acc-local", "SSH: Remote session inspection must never mutate local cachedAccounts or activeAccountId")

            settleOverviewEnv("all", "18K") {
                if let allItem = sshOverview.contextPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "all" }),
                   let action = allItem.action {
                    NSApp.sendAction(action, to: allItem.target, from: allItem)
                } else {
                    check(false, "SSH: Overview contextPill menu must include all item")
                    sshHost.selectOverviewEnvironment("all")
                }
            }
            check(sshHost.overviewEnvironmentKey == "all" && sshOverview.heroRemoteHostBadge.isHidden, "SSH: Selecting 全部 in Overview contextPill must restore Overview to 'all'")
            check(abs((sshOverview.metricsContainer?.frame.minY ?? -99) - baselineMetricsY) < 0.5 && abs(sshOverview.bentoRow.frame.minY - baselineBentoY) < 0.5, "SSH: Overview returning from SSH to all must restore baseline metricsContainer and bentoRow vertical alignment")
            check(sshOverview.todayTokensMetric.stringValue == "18K" && sshOverview.todayRequestsMetric.stringValue == "7", "SSH: Returning to Overview 'all' must restore combined usage (18K / 7)")

            // 1.5 多 SSH 主机 + 同主机多窗口去重：2 个不同主机 + 1 个同主机额外窗口 -> 顶栏 EnvironmentContextPill 分组菜单去重展示窗口数
            sshHost.syncRemoteSessionsFromPayload([
                makeRemoteSession(remoteKey: "rk-test", environmentId: "ssh:demo-env-1", hostLabel: "demo-ssh-host", state: "connected", includeQuota: true, includeStandalone: true),
                makeRemoteSession(remoteKey: "rk-test-1b", environmentId: "ssh:demo-env-1", hostLabel: "demo-ssh-host", state: "connected", includeQuota: true, includeStandalone: true),
                makeRemoteSession(remoteKey: "rk-test-2", environmentId: "ssh:demo-env-2", hostLabel: "gpu-ssh-host", state: "connected", includeQuota: true)
            ], focusedKey: "local")
            pump()
            check(!sshOverview.contextPill.isHidden, "SSH: Overview contextPill must remain visible with >=2 SSH hosts")
            check(!sshMenu.contextPill.isHidden && sshMenu.contextPill.frame.width <= 154.5, "SSH: Menu contextPill must remain visible and <= 154pt for >=2 distinct SSH hosts")
            let overflowTitles = sshMenu.contextPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(overflowTitles.contains(L10n.t("ssh.picker.group.online", fallback: "在线 SSH")), "SSH: Menu contextPill grouped menu must include online section header: \(overflowTitles)")
            check(overflowTitles.contains { $0.contains("demo-ssh-host") && $0.contains("2 个窗口") } && overflowTitles.contains { $0.contains("gpu-ssh-host") }, "SSH: Menu contextPill menu must deduplicate same-host windows and omit SSH prefix: \(overflowTitles)")
            check(overflowTitles.allSatisfy { !$0.contains("SSH:") && !$0.contains("SSH ·") }, "SSH: Menu contextPill menu must not contain SSH: prefix: \(overflowTitles)")

            // 2. disconnected 与 auth_expired 态：伴生区与钻取态展示专属提示，绝不回退为“尚未保存账号”，且卡片不位移
            sshHost.syncRemoteSessionsFromPayload([makeRemoteSession(state: "disconnected", includeQuota: true)], focusedKey: nil)
            pump()
            sshOverviewWin.contentView?.layoutSubtreeIfNeeded()
            if let heroBox = findEnclosingBox(sshOverview.refreshQuotaButton) {
                check(allTextValues(heroBox).contains { $0.contains("已断开") }, "SSH: Disconnected remote must show 已断开 in Overview companion row (got \(allTextValues(heroBox)))")
            }
            settleOverviewEnv("ssh:demo-env-1", "6K") {
                sshHost.selectOverviewEnvironment("env:ssh:demo-env-1")
            }
            check(sshOverview.accountStatusLabel.stringValue.contains("SSH 连接已断开"), "SSH: Disconnected remote must show SSH 连接已断开 in Overview drilldown (got \(sshOverview.accountStatusLabel.stringValue))")
            check(!sshMenu.quotaWarningLabel.isHidden && sshMenu.quotaWarningLabel.stringValue.contains("SSH 连接已断开"), "SSH: Disconnected remote must show SSH 连接已断开 in Menu (got \(sshMenu.quotaWarningLabel.stringValue))")
            check(sshMenu.quotaEmptyButton.isHidden, "SSH: Disconnected remote must not fall back to saved-account empty CTA")

            sshHost.syncRemoteSessionsFromPayload([makeRemoteSession(state: "auth_expired", includeQuota: false)], focusedKey: nil)
            settleOverviewEnv("all", "18K") {
                sshHost.selectOverviewEnvironment("all")
            }
            if let heroBox = findEnclosingBox(sshOverview.refreshQuotaButton) {
                check(allTextValues(heroBox).contains { $0.contains("登录已过期") }, "SSH: auth_expired remote must show 登录已过期 in Overview companion row (got \(allTextValues(heroBox)))")
            }
            settleOverviewEnv("ssh:demo-env-1", "6K") {
                sshHost.selectOverviewEnvironment("env:ssh:demo-env-1")
            }
            check(sshOverview.accountStatusLabel.stringValue.contains("远端登录态已过期"), "SSH: auth_expired remote must show 远端登录态已过期 in Overview drilldown (got \(sshOverview.accountStatusLabel.stringValue))")
            check(!sshMenu.quotaWarningLabel.isHidden && sshMenu.quotaWarningLabel.stringValue.contains("远端登录态已过期"), "SSH: auth_expired remote must show 远端登录态已过期 in Menu (got \(sshMenu.quotaWarningLabel.stringValue))")
            check(sshMenu.quotaEmptyButton.isHidden, "SSH: auth_expired remote must not fall back to 尚未保存账号 empty CTA")
            check(sshMenu.quotaAccountNameLabel.stringValue != L10n.t("menu_panel.quota.no_saved", fallback: "尚未保存账号"), "SSH: auth_expired remote must keep remote identity title")

            // 3. 清空 remoteSessions：自动回退至 all / local 并隐藏切换器与提示
            sshHost.syncRemoteSessionsFromPayload([], focusedKey: "local")
            pump()
            check(sshHost.selectedContextKey == "local", "SSH: Clearing remoteSessions must fall back selectedContextKey to local")
            check(sshHost.overviewEnvironmentKey == "all", "SSH: Clearing remoteSessions must fall back overviewEnvironmentKey to all")
            check(sshOverview.contextPill.isHidden && sshOverview.contextMetaLabel.isHidden && sshOverview.heroRemoteHostBadge.isHidden && sshOverview.companionMoreButton.isHidden, "SSH: Clearing remoteSessions must hide Overview contextPill, contextMetaLabel, and badges")
            check(sshMenu.contextPill.isHidden && sshMenu.headerContextDivider.isHidden, "SSH: Clearing remoteSessions must hide Menu contextPill and headerContextDivider")
            sshMenu.selectTab(2, persist: false); pump()
            check(sshMenu.accountsLocalOnlyNoteLabel.isHidden, "SSH: Clearing remoteSessions must hide Menu accountsLocalOnlyNoteLabel")

            sshOverviewWin.orderOut(nil)
            sshMenuWin.orderOut(nil)
        }

        // Milestone 2 Phase 1: 多环境 / 多账号用量筛选、离线 SSH 徽标、UsageQueryIdentity、UsageLogController 与 UsageEventCard 验证
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let m2Host = Assistant(state: state.appendingPathComponent("m2-usage-env-filter"))
            m2Host.configuration = try ConfigurationStore(state: m2Host.state)
            m2Host.bridge = BackendBridge(resources: state, state: m2Host.state)
            m2Host.reachable = true
            m2Host.cachedAccounts = [
                ["id": "acc-local", "email": "local@example.invalid", "subscription_tier": "PRO"],
                ["id": "acc-remote", "email": "remote@example.invalid", "subscription_tier": "ULTRA"]
            ]
            m2Host.activeAccountId = "acc-local"

            check(LiveStatus().remoteSyncRevision == 0, "M2: LiveStatus default remoteSyncRevision must be 0")
            let revStatus = LiveStatus(["mode": "connected", "remoteSyncRevision": 5])
            check(revStatus.remoteSyncRevision == 5, "M2: LiveStatus must parse remoteSyncRevision")
            let mergedKeepRev = m2Host.mergeStatusSnapshot(["mode": "connected"], previous: revStatus)
            check(mergedKeepRev.remoteSyncRevision == 5, "M2: mergeStatusSnapshot must preserve previous remoteSyncRevision when omitted")
            let mergedNextRev = m2Host.mergeStatusSnapshot(["mode": "connected", "remoteSyncRevision": 6], previous: mergedKeepRev)
            check(mergedNextRev.remoteSyncRevision == 6, "M2: mergeStatusSnapshot must update remoteSyncRevision when present")
            m2Host.statusValue = mergedNextRev

            enum M2FixtureMode {
                case pureLocal
                case mixedSsh
                case mismatchEnv
            }
            var m2Mode: M2FixtureMode = .pureLocal
            var summaryRequests: [[String: Any]] = []
            var eventRequests: [[String: Any]] = []
            var eventMismatchEnv: String? = nil

            let m2Models: [[String: Any]] = [
                ["model": "gemini-3.8-flash-n", "totalTokens": 10000, "promptTokens": 4000, "candidatesTokens": 1000, "cachedTokens": 5000, "requestCount": 10, "estimatedUsd": 0.42, "priced": true]
            ]
            let m2SshModels: [[String: Any]] = [
                ["model": "gemini-3.8-flash-n", "totalTokens": 3600, "promptTokens": 1200, "candidatesTokens": 400, "cachedTokens": 2000, "requestCount": 4, "estimatedUsd": 0.16, "priced": true]
            ]

            m2Host.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "usage_summary" {
                    summaryRequests.append(payload)
                    let reqPeriod = payload["period"] as? String ?? "today"
                    let reqEnv = (payload["environmentId"] as? String) ?? "all"
                    let reqAcc = (payload["accountId"] as? String) ?? "all"
                    switch m2Mode {
                    case .pureLocal:
                        return [
                            "ok": true,
                            "period": reqPeriod,
                            "snapshotId": "m2-local-snap",
                            "selectedEnvironmentId": reqEnv,
                            "selectedAccountId": reqAcc,
                            "availableEnvironments": [
                                ["id": "all", "kind": "all", "label": "全部环境"],
                                ["id": "local", "kind": "local", "label": "本机", "total_tokens": 6400, "request_count": 6, "online": true]
                            ],
                            "availableAccounts": [
                                ["id": "all", "type": "all", "label": "全部账号"],
                                ["id": "acc-local", "type": "account", "label": "local@example.invalid", "email": "local@example.invalid"]
                            ],
                            "environmentBreakdown": [
                                "local_tokens": 6400, "ssh_tokens": 0,
                                "local_requests": 6, "ssh_requests": 0,
                                "local_share_pct": 100, "ssh_share_pct": 0,
                                "has_ssh_data": false, "offline_ssh_hosts": []
                            ],
                            "summary": [
                                "availability": "complete",
                                "totalTokens": 6400, "promptTokens": 2400, "cachedTokens": 3400, "candidatesTokens": 600,
                                "requestCount": 6, "estimatedUsd": 0.26, "pricedModels": 1, "unpricedModels": 0,
                                "databasesScanned": 5, "databasesDiscovered": 5
                            ],
                            "byModel": m2Models,
                            "dailyTrends": [],
                            "todayHourly": []
                        ]
                    case .mixedSsh:
                        let isSshOnly = reqEnv == "ssh:demo"
                        let totalTok = isSshOnly ? 3600 : 10000
                        let promptTok = isSshOnly ? 1200 : 4000
                        let cachedTok = isSshOnly ? 2000 : 5000
                        let outTok = isSshOnly ? 400 : 1000
                        let reqCount = isSshOnly ? 4 : 10
                        let usdVal = isSshOnly ? 0.16 : 0.42
                        return [
                            "ok": true,
                            "period": reqPeriod,
                            "snapshotId": "m2-mixed-\(reqEnv)-\(reqAcc)-\(m2Host.statusValue.remoteSyncRevision)",
                            "selectedEnvironmentId": reqEnv,
                            "selectedAccountId": reqAcc,
                            "availableEnvironments": [
                                ["id": "all", "kind": "all", "label": "全部环境", "total_tokens": 10000, "request_count": 10],
                                ["id": "local", "kind": "local", "label": "本机", "total_tokens": 6400, "request_count": 6, "online": true],
                                ["id": "ssh:demo", "kind": "ssh", "label": "SSH: demo-ssh-host", "host_label": "demo-ssh-host", "total_tokens": 3600, "request_count": 4, "online": false]
                            ],
                            "availableAccounts": [
                                ["id": "all", "type": "all", "label": "全部账号"],
                                ["id": "acc-local", "type": "account", "label": "local@example.invalid", "email": "local@example.invalid"],
                                ["id": "acc-remote", "type": "account", "label": "remote@example.invalid", "email": "remote@example.invalid"]
                            ],
                            "environmentBreakdown": [
                                "local_tokens": 6400, "ssh_tokens": 3600,
                                "local_requests": 6, "ssh_requests": 4,
                                "local_share_pct": 64, "ssh_share_pct": 36,
                                "has_ssh_data": true, "offline_ssh_hosts": ["demo-ssh-host"]
                            ],
                            "summary": [
                                "availability": "complete",
                                "totalTokens": totalTok, "promptTokens": promptTok, "cachedTokens": cachedTok, "candidatesTokens": outTok,
                                "requestCount": reqCount, "estimatedUsd": usdVal, "pricedModels": 1, "unpricedModels": 0,
                                "databasesScanned": 5, "databasesDiscovered": 5
                            ],
                            "byModel": isSshOnly ? m2SshModels : m2Models,
                            "dailyTrends": [],
                            "todayHourly": []
                        ]
                    case .mismatchEnv:
                        return [
                            "ok": true,
                            "period": reqPeriod,
                            "snapshotId": "m2-mismatch",
                            "selectedEnvironmentId": "local",
                            "selectedAccountId": reqAcc,
                            "summary": ["availability": "complete", "totalTokens": 100, "requestCount": 1, "databasesScanned": 1, "databasesDiscovered": 1],
                            "byModel": [],
                            "dailyTrends": [],
                            "todayHourly": []
                        ]
                    }
                }
                if cmd == "usage_events" {
                    eventRequests.append(payload)
                    let reqPeriod = payload["period"] as? String ?? "today"
                    let reqEnv = (payload["environmentId"] as? String) ?? "all"
                    let reqAcc = (payload["accountId"] as? String) ?? "all"
                    let offset = payload["offset"] as? Int ?? 0
                    let limit = payload["limit"] as? Int ?? 200
                    if let mismatch = eventMismatchEnv {
                        return [
                            "ok": true, "period": reqPeriod,
                            "selectedEnvironmentId": mismatch, "selectedAccountId": reqAcc,
                            "snapshot_id": "m2-events-mismatch", "generated_at": 1761544300,
                            "total": 1, "rows": []
                        ]
                    }
                    if m2Mode == .pureLocal {
                        return [
                            "ok": true, "period": reqPeriod,
                            "selectedEnvironmentId": reqEnv, "selectedAccountId": reqAcc,
                            "snapshot_id": "m2-events-local", "generated_at": 1761544300,
                            "scope": "本机历史记录",
                            "total": 1,
                            "rows": [
                                ["model": "gemini-3.8-flash-n", "timestamp_seconds": 1761544267, "input_tokens": 120, "output_tokens": 30, "cached_tokens": 50, "cache_write_tokens": 0, "environment_kind": "local", "environment_id": "local", "account_email": "local@example.invalid", "account_confidence": "observed"]
                            ]
                        ]
                    }
                    let totalRows = limit >= 500 ? 650 : 250
                    let batchCount = max(0, min(limit, totalRows - offset))
                    var rows: [[String: Any]] = []
                    for i in 0..<min(3, batchCount) {
                        if reqEnv == "ssh:demo" || i != 1 {
                            rows.append([
                                "model": "gemini-3.8-flash-n",
                                "timestamp_seconds": 1761544267 - i,
                                "input_tokens": 300 + offset + i,
                                "output_tokens": 45,
                                "cached_tokens": 900,
                                "cache_write_tokens": 15,
                                "environment_kind": "ssh",
                                "environment_id": "ssh:demo",
                                "environment_label": "SSH: demo-ssh-host",
                                "account_email": (i == 2 ? "" : "remote@example.invalid"),
                                "account_confidence": (i == 2 ? "unknown" : "observed")
                            ])
                        } else {
                            rows.append([
                                "model": "claude-sonnet-4-6",
                                "timestamp_seconds": 1761544250,
                                "input_tokens": 200,
                                "output_tokens": 20,
                                "cached_tokens": 400,
                                "cache_write_tokens": 0,
                                "environment_kind": "local",
                                "environment_id": "local",
                                "environment_label": "",
                                "account_email": "local@example.invalid",
                                "account_confidence": "observed"
                            ])
                        }
                    }
                    if limit >= 500 && rows.count < batchCount {
                        for idx in rows.count..<batchCount {
                            rows.append([
                                "model": "gemini-3.8-flash-n",
                                "timestamp_seconds": 1761544000 - idx,
                                "input_tokens": 100, "output_tokens": 10, "cached_tokens": 50, "cache_write_tokens": 0,
                                "environment_kind": "ssh", "environment_id": "ssh:demo", "environment_label": "SSH: demo-ssh-host",
                                "account_email": "remote@example.invalid", "account_confidence": "observed"
                            ])
                        }
                    }
                    return [
                        "ok": true,
                        "period": reqPeriod,
                        "selectedEnvironmentId": reqEnv,
                        "selectedAccountId": reqAcc,
                        "snapshot_id": "m2-events-\(reqEnv)-\(reqAcc)",
                        "generated_at": 1761544300,
                        "scope": "本机与 SSH 记录",
                        "total": totalRows,
                        "rows": rows,
                        "availableEnvironments": [
                            ["id": "all", "kind": "all", "label": "全部环境"],
                            ["id": "local", "kind": "local", "label": "本机"],
                            ["id": "ssh:demo", "kind": "ssh", "label": "SSH: demo-ssh-host", "host_label": "demo-ssh-host", "online": false]
                        ],
                        "availableAccounts": [
                            ["id": "all", "type": "all", "label": "全部账号"],
                            ["id": "acc-local", "type": "account", "label": "local@example.invalid", "email": "local@example.invalid"],
                            ["id": "acc-remote", "type": "account", "label": "remote@example.invalid", "email": "remote@example.invalid"]
                        ]
                    ]
                }
                return ["ok": true]
            }

            let m2Window = makeHeadlessHostWindow(width: 960, height: 640)
            m2Host.window = m2Window
            let m2Usage = UsagePage(app: m2Host)
            m2Host.usagePage = m2Usage
            m2Window.contentView = m2Usage.view
            pump()
            m2Window.contentView?.layoutSubtreeIfNeeded()

            defer {
                saveUsageJSONTestHook = nil
                m2Window.contentView = nil
                m2Host.usagePage = nil
                m2Host.window = nil
                m2Window.orderOut(nil)
            }

            // 1. 纯本机单账号（无 SSH 环境）：首张卡正上方 28pt 无框上下文栏自动隐藏，顶部恢复 [刷新] 与 [导出...] 纯文字按钮且零 tooltip
            check(m2Usage.contextBarRow.isHidden == true && m2Usage.environmentPill.isHidden == true && m2Usage.shareNoteLabel.isHidden == true && m2Usage.accountPopup.isHidden == true, "M2: Pure-local single-account UsagePage must hide contextBarRow, environmentPill, shareNoteLabel, and accountPopup")
            check(
                !m2Usage.refreshButton.iconOnly
                    && m2Usage.refreshButton.title == L10n.t("common.refresh")
                    && m2Usage.refreshButton.image == nil
                    && m2Usage.refreshButton.toolTip == nil
                    && m2Usage.refreshButton.frame.size == NSSize(width: 78, height: 28)
                    && m2Usage.refreshButton.spinner.superview === m2Usage.refreshButton
                    && !(m2Usage.refreshButton.accessibilityLabel() ?? "").isEmpty,
                "M2: UsagePage refreshButton must be 78x28 text button with embedded spinner, accessibilityLabel, and nil toolTip"
            )
            check(
                m2Usage.exportButton.title == L10n.t("usage.export_btn")
                    && m2Usage.exportButton.image == nil
                    && m2Usage.exportButton.toolTip == nil
                    && m2Usage.exportButton.frame.height == 28
                    && m2Usage.exportButton.frame.width > 40
                    && !(m2Usage.exportButton.accessibilityLabel() ?? "").isEmpty,
                "M2: UsagePage exportButton must be text button with accessibilityLabel and nil toolTip"
            )
            check(!m2Usage.tokensDetail.stringValue.contains("SSH"), "M2: Pure-local UsagePage tokensDetail must not include SSH share")
            check(m2Host.cachedUsageReportsByPeriod["today"]?["snapshotId"] as? String == "m2-local-snap", "M2: Default all+all query must populate cachedUsageReportsByPeriod[today]")
            check(summaryRequests.last?["environmentId"] == nil && summaryRequests.last?["accountId"] == nil, "M2: Default all+all usage_summary IPC payload must preserve legacy keys without environmentId/accountId")

            // 纯本机下打开 UsageLogController 时环境筛选隐藏
            let pureLocalLog = UsageLogController(app: m2Host, period: "today")
            pureLocalLog.show(in: m2Window, onDismiss: {})
            pump()
            check(pureLocalLog.environmentPill.isHidden == true, "M2: Pure-local UsageLogController must hide environmentPill")
            pureLocalLog.closeSheet()
            waitForSheetDetach(on: m2Window, description: "M2 pure-local UsageLogController to detach")

            // 2. 注入混合本机 + ssh:demo（离线 demo-ssh-host）报表：首张卡正上方 28pt 无框上下文行显露、EnvironmentContextPill + 占比轻文本与 accountPopup 分列左右、tokensDetail 去重、去 SSH 前缀
            m2Mode = .mixedSsh
            m2Usage.fetch(force: true)
            pump()
            m2Window.contentView?.layoutSubtreeIfNeeded()

            check(!m2Usage.contextBarRow.isHidden && !m2Usage.environmentPill.isHidden && !m2Usage.shareNoteLabel.isHidden && !m2Usage.accountPopup.isHidden, "M2: Mixed SSH UsagePage must reveal contextBarRow, environmentPill, shareNoteLabel, and accountPopup")
            check(abs(m2Usage.contextBarRow.frame.height - 28.0) <= 0.5, "M2: UsagePage contextBarRow height must be 28pt (got \(m2Usage.contextBarRow.frame.height))")
            if let rootStack = m2Usage.contextBarRow.superview as? NSStackView,
               let barIdx = rootStack.arrangedSubviews.firstIndex(where: { $0 === m2Usage.contextBarRow }),
               let cardIdx = rootStack.arrangedSubviews.firstIndex(where: { $0 is DesignCardBox }) {
                check(barIdx < cardIdx, "M2: UsagePage contextBarRow must sit directly above the first card (barIdx=\(barIdx), cardIdx=\(cardIdx))")
            } else {
                check(false, "M2: UsagePage contextBarRow must be placed above DesignCardBox in root stack")
            }
            check(m2Usage.accountPopup.superview?.identifier?.rawValue == "usage-context-bar", "M2: Mixed SSH UsagePage must host accountPopup inside usage-context-bar")
            check(m2Usage.environmentPill.style == .headerPill && m2Usage.environmentPill.pillHeight == 26 && m2Usage.environmentPill.triggerButton.toolTip == nil && m2Usage.environmentPill.triggerButton.acceptsFirstMouse(for: nil), "M2: UsagePage environmentPill must use .headerPill 26pt self-drawn triggerButton with nil toolTip and acceptsFirstMouse")
            check(m2Usage.environmentPill.displayTitle == L10n.t("ssh.scope.all", fallback: "全部") && !m2Usage.environmentPill.displayTitle.contains("100%") && !m2Usage.environmentPill.displayTitle.contains("●") && m2Usage.environmentPill.triggerButton.itemKind == .all, "M2: UsagePage environmentPill collapsed displayTitle must be pure 全部 without 100% or dot")
            let m2PillMenuTitles = m2Usage.environmentPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(m2PillMenuTitles.contains { $0.contains("本机") && $0.contains("64%") }, "M2: environmentPill menu must show 本机 64%: \(m2PillMenuTitles)")
            check(m2PillMenuTitles.contains { $0.contains("demo-ssh-host") && $0.contains("36%") } && m2PillMenuTitles.allSatisfy { !$0.contains("SSH:") && !$0.contains("SSH ·") }, "M2: environmentPill menu must show clean demo-ssh-host and 36% share without SSH prefix: \(m2PillMenuTitles)")
            check(m2Usage.shareNoteLabel.stringValue.contains("本机 64%") && m2Usage.shareNoteLabel.stringValue.contains("SSH 36%"), "M2: Mixed all-env UsagePage shareNoteLabel must show 本机 64% · SSH 36% (got \(m2Usage.shareNoteLabel.stringValue))")
            check(!m2Usage.tokensDetail.stringValue.contains("本机 64%") && !m2Usage.tokensDetail.stringValue.contains("SSH 36%"), "M2: Mixed all-env UsagePage tokensDetail must deduplicate share note (got \(m2Usage.tokensDetail.stringValue))")
            let m2AccCell = m2Usage.accountPopup.cell as? DesignPopUpCell
            check(m2AccCell?.visualStyle == .headerPill && m2AccCell?.customHeight == 26 && m2AccCell?.fitsSelectedTitleOnly == true && m2AccCell?.isActiveState == false && m2Usage.accountPopup.toolTip == nil, "M2: accountPopup must use .headerPill 26pt DesignPopUpCell with fitsSelectedTitleOnly, inactive default state, and nil toolTip")
            check(m2Usage.accountPopup.constraints.first(where: { $0.identifier == "usage-popup-max-width" })?.constant == 210, "M2: accountPopup maxWidth constraint must be 210")
            check(m2Usage.accountPopup.itemTitles.contains("remote@example.invalid"), "M2: accountPopup must list available accounts")

            let findViewById: (NSView, String) -> NSView? = { root, id in
                var queue: [NSView] = [root]
                while !queue.isEmpty {
                    let cur = queue.removeFirst()
                    if cur.identifier?.rawValue == id { return cur }
                    queue.append(contentsOf: cur.subviews)
                }
                return nil
            }
            let assertCompactSingleLineHeaderLayout: (UsagePage, String) -> Void = { page, label in
                guard let headerRow = findViewById(page.view, "usage-page-header") as? NSStackView,
                      let titleView = headerRow.arrangedSubviews.first(where: { $0.identifier?.rawValue == "page-title" }) else {
                    check(false, "\(label): UsagePage must expose usage-page-header with page-title")
                    return
                }
                headerRow.superview?.layoutSubtreeIfNeeded()
                headerRow.layoutSubtreeIfNeeded()
                let titleFrame = titleView.convert(titleView.bounds, to: headerRow)
                let periodFrame = page.periodSegment.convert(page.periodSegment.bounds, to: headerRow)
                let refreshFrame = page.refreshButton.convert(page.refreshButton.bounds, to: headerRow)
                let exportFrame = page.exportButton.convert(page.exportButton.bounds, to: headerRow)
                let headerMidY = headerRow.bounds.midY
                for (name, rect) in [("title", titleFrame), ("period", periodFrame), ("refresh", refreshFrame), ("export", exportFrame)] {
                    check(rect.width > 10 && rect.height >= 20, "\(label): \(name) must have non-zero geometry (got \(rect))")
                    check(abs(rect.midY - headerMidY) <= 4.0, "\(label): \(name) must align on single horizontal header row (midY=\(rect.midY), headerMidY=\(headerMidY))")
                }
                check(titleFrame.maxX <= periodFrame.minX + 0.5, "\(label): page-title must not collide with periodSegment (\(titleFrame.maxX) vs \(periodFrame.minX))")
                check(periodFrame.maxX <= refreshFrame.minX + 0.5, "\(label): periodSegment must not collide with refreshButton (\(periodFrame.maxX) vs \(refreshFrame.minX))")
                check(refreshFrame.maxX <= exportFrame.minX + 0.5, "\(label): refreshButton must not collide with exportButton (\(refreshFrame.maxX) vs \(exportFrame.minX))")
                check(exportFrame.maxX <= headerRow.bounds.width + 0.5, "\(label): exportButton must not overflow headerRow width (\(exportFrame.maxX) vs \(headerRow.bounds.width))")
                if let contextBar = findViewById(page.view, "usage-context-bar") as? NSStackView, !page.contextBarRow.isHidden {
                    let pillFrame = page.environmentPill.convert(page.environmentPill.bounds, to: contextBar)
                    let accFrame = page.accountPopup.convert(page.accountPopup.bounds, to: contextBar)
                    check(pillFrame.maxX <= accFrame.minX + 0.5, "\(label): environmentPill must not collide with accountPopup (\(pillFrame.maxX) vs \(accFrame.minX))")
                    if !page.shareNoteLabel.isHidden {
                        let shareFrame = page.shareNoteLabel.convert(page.shareNoteLabel.bounds, to: contextBar)
                        check(pillFrame.maxX <= shareFrame.minX + 0.5 && shareFrame.maxX <= accFrame.minX + 0.5, "\(label): shareNoteLabel must sit cleanly between environmentPill and accountPopup")
                    }
                    check(accFrame.maxX <= contextBar.bounds.width + 0.5, "\(label): accountPopup must not overflow usage-context-bar (\(accFrame.maxX) vs \(contextBar.bounds.width))")
                    check(accFrame.width <= 210.5, "\(label): accountPopup width must stay within 210pt (got \(accFrame.width))")
                }
            }

            // 880pt 最小窗口宽度（扣除最大 210pt 侧边栏 -> 内容区 670pt）下验证中文单行顶栏与上下文栏零挤压/零重叠/零溢出
            m2Window.setContentSize(NSSize(width: 670, height: 580))
            m2Window.contentView?.layoutSubtreeIfNeeded()
            pump()
            assertCompactSingleLineHeaderLayout(m2Usage, "M2 zh-Hans 880pt-min header")

            // 验证英文模式下 UsagePage 筛选栏与环境占比零中文泄漏，且在 880pt 最小窗口下保持单行顶栏零溢出
            L10n.shared.setLanguage("en", notify: false)
            let m2UsageEn = UsagePage(app: m2Host)
            m2Window.contentView = m2UsageEn.view
            m2UsageEn.fetch(force: true)
            waitUntil(step: 0.01, description: "M2 English UsagePage fetch") { !m2UsageEn.loading }
            m2Window.contentView?.layoutSubtreeIfNeeded()
            assertCompactSingleLineHeaderLayout(m2UsageEn, "M2 English 880pt-min header (all)")
            check(m2UsageEn.shareNoteLabel.stringValue.contains("Local 64%") && m2UsageEn.shareNoteLabel.stringValue.contains("SSH 36%"), "M2: English UsagePage shareNoteLabel must show Local 64% · SSH 36% (got \(m2UsageEn.shareNoteLabel.stringValue))")
            check(!m2UsageEn.tokensDetail.stringValue.contains("Local 64%") && !m2UsageEn.tokensDetail.stringValue.contains("SSH 36%"), "M2: English mixed UsagePage tokensDetail must deduplicate share note (got \(m2UsageEn.tokensDetail.stringValue))")
            let m2EnLeaks = allTextValues(m2UsageEn.view).filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil }
            check(m2EnLeaks.isEmpty, "M2: English mixed UsagePage must contain zero Chinese characters: \(m2EnLeaks)")
            m2Window.contentView = m2Usage.view
            m2Window.setContentSize(NSSize(width: 960, height: 640))
            m2Window.contentView?.layoutSubtreeIfNeeded()
            L10n.shared.setLanguage("zh-Hans", notify: false)

            // 3. 通过 EnvironmentContextPill 切换到 ssh:demo（高亮态 + 隐藏全部占比）、切回 all、以及 accountPopup 切换与 MenuPanel all+all 缓存零污染
            let allCacheBeforeFilter = m2Host.cachedUsageReportsByPeriod["today"]?["snapshotId"] as? String
            if let sshItem = m2Usage.environmentPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "ssh:demo" }),
               let action = sshItem.action {
                NSApp.sendAction(action, to: sshItem.target, from: sshItem)
                waitUntil(step: 0.01, description: "M2 switch pill to ssh:demo") { !m2Usage.loading && m2Usage.totalTokensMetric.stringValue == "3.6K" }
            } else {
                check(false, "M2: environmentPill menu must contain ssh:demo")
            }
            check(m2Usage.selectedEnvironmentId == "ssh:demo" && m2Host.usageSelectedEnvironment == "ssh:demo" && m2Host.usageFilterScope == .remote(environmentId: "ssh:demo"), "M2: Selecting ssh:demo in environmentPill must update selectedEnvironmentId and SSOT usageFilterScope")
            check(m2Usage.environmentPill.isActive && m2Usage.environmentPill.displayTitle == "demo-ssh-host" && !m2Usage.environmentPill.displayTitle.contains("●") && !m2Usage.environmentPill.displayTitle.contains("%") && m2Usage.environmentPill.triggerButton.itemKind == .ssh && m2Usage.shareNoteLabel.isHidden, "M2: Selecting ssh:demo must activate environmentPill with clean host title, .ssh icon kind, and hide all-env shareNoteLabel")
            check(summaryRequests.last?["environmentId"] as? String == "ssh:demo", "M2: Selecting ssh:demo must dispatch usage_summary with environmentId=ssh:demo")
            check(m2Usage.totalTokensMetric.stringValue == "3.6K", "M2: Selecting ssh:demo must refresh KPI to SSH-only 3.6K (got \(m2Usage.totalTokensMetric.stringValue))")
            check(!m2Usage.tokensDetail.stringValue.contains("本机 64%"), "M2: Filtered ssh:demo view must not show all-environments share split")
            check(m2Host.cachedUsageReportsByPeriod["today"]?["snapshotId"] as? String == allCacheBeforeFilter, "M2: Filtered ssh:demo query must never overwrite MenuPanel's all+all cachedUsageReportsByPeriod[today]")

            // 切回 all 后再次切回 ssh:demo 继续后续验证
            if m2Usage.environmentPill.selectItem(id: "all", notify: true) {
                waitUntil(step: 0.01, description: "M2 reset pill to all") { !m2Usage.loading && m2Usage.selectedEnvironmentId == "all" }
                check(m2Usage.selectedEnvironmentId == "all" && !m2Usage.environmentPill.isActive && m2Usage.environmentPill.displayTitle == L10n.t("ssh.scope.all", fallback: "全部"), "M2: Selecting all in environmentPill must reset to all with pure title")
            } else {
                check(false, "M2: environmentPill selectItem(id: all) must succeed")
            }
            if let sshItemAgain = m2Usage.environmentPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "ssh:demo" }),
               let action = sshItemAgain.action {
                NSApp.sendAction(action, to: sshItemAgain.target, from: sshItemAgain)
                waitUntil(step: 0.01, description: "M2 select ssh:demo again") { !m2Usage.loading && m2Usage.selectedEnvironmentId == "ssh:demo" }
            }

            if let accIdx = m2Usage.accountPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == "acc-remote" }) {
                m2Usage.accountPopup.selectItem(at: accIdx)
                m2Usage.accountChanged(m2Usage.accountPopup)
                waitUntil(step: 0.01, description: "M2 switch accountPopup to acc-remote") { !m2Usage.loading && summaryRequests.last?["accountId"] as? String == "acc-remote" }
                check((m2Usage.accountPopup.cell as? DesignPopUpCell)?.isActiveState == true, "M2: accountPopup selecting acc-remote must activate headerPill isActiveState")
            } else {
                check(false, "M2: accountPopup must contain acc-remote option")
            }
            check(summaryRequests.last?["environmentId"] as? String == "ssh:demo" && summaryRequests.last?["accountId"] as? String == "acc-remote", "M2: Orthogonal account switch must send both environmentId and accountId")
            check(m2Usage.exportButton.isEnabled, "M2: Matching filtered report must keep exportButton enabled")

            // 880pt 最小窗口宽度（英文选中超长环境与超长账号）单行顶栏与底栏零挤压/零溢出验证
            L10n.shared.setLanguage("en", notify: false)
            let m2UsageEnLong = UsagePage(app: m2Host)
            m2Window.contentView = m2UsageEnLong.view
            m2Window.setContentSize(NSSize(width: 670, height: 580))
            m2UsageEnLong.fetch(force: true)
            waitUntil(step: 0.01, description: "M2 English long-selected UsagePage fetch") { !m2UsageEnLong.loading }
            m2Window.contentView?.layoutSubtreeIfNeeded()
            assertCompactSingleLineHeaderLayout(m2UsageEnLong, "M2 English 880pt-min header (selected long items)")
            m2Window.contentView = m2Usage.view
            m2Window.setContentSize(NSSize(width: 960, height: 640))
            m2Window.contentView?.layoutSubtreeIfNeeded()
            L10n.shared.setLanguage("zh-Hans", notify: false)

            // 校验 UsageQueryIdentity 错配拦截与 remoteSyncRevision 推进自动重拉
            m2Mode = .mismatchEnv
            m2Usage.fetch(force: true)
            pump()
            check(!m2Usage.exportButton.isEnabled && !m2Usage.footerBox.isHidden, "M2: Mismatched selectedEnvironmentId must disable exportButton and show warning banner")

            m2Mode = .mixedSsh
            let reqCountBeforeSyncRev = summaryRequests.count
            m2Host.statusValue.remoteSyncRevision = 7
            m2Usage.update(force: false)
            pump()
            check(summaryRequests.count > reqCountBeforeSyncRev, "M2: Advancing remoteSyncRevision must trigger UsagePage.update(force: false) refetch")

            var exportedUsagePayload: [String: Any]? = nil
            saveUsageJSONTestHook = { report, _ in
                exportedUsagePayload = report
                return true
            }
            m2Usage.exportUsage()
            pump()
            check(exportedUsagePayload?["environmentId"] as? String == "ssh:demo" && exportedUsagePayload?["accountId"] as? String == "acc-remote", "M2: UsagePage exportUsage must carry active environmentId and accountId")

            // 4. 打开 UsageLogController：继承用量筛选、验证 UsageEventCard (showStatusDot == false / 混排本机标)、翻页与多页导出参数透传、快照一致性校验
            m2Usage.showLog()
            pump()
            guard let m2Log = m2Usage.logController else {
                check(false, "M2: UsagePage.showLog must open UsageLogController")
                fatalError("Unreachable")
            }
            check(m2Log.selectedEnvironmentId == "ssh:demo" && m2Log.selectedAccountId == "acc-remote", "M2: UsageLogController must inherit selected environmentId and accountId from UsagePage")
            check(!m2Log.environmentPill.isHidden && !m2Log.accountPopup.isHidden, "M2: Mixed SSH UsageLogController must show both environmentPill and accountPopup")
            check(m2Log.environmentPill.style == .headerPill && m2Log.environmentPill.pillHeight == 26 && m2Log.environmentPill.triggerButton.toolTip == nil, "M2: UsageLogController environmentPill must use .headerPill 26pt style and nil toolTip")
            let m2LogAccCell = m2Log.accountPopup.cell as? DesignPopUpCell
            check(m2LogAccCell?.visualStyle == .headerPill && m2LogAccCell?.customHeight == 26 && m2LogAccCell?.fitsSelectedTitleOnly == true && m2LogAccCell?.isActiveState == true, "M2: UsageLogController accountPopup must use .headerPill 26pt with fitsSelectedTitleOnly and active state for acc-remote")
            check(eventRequests.last?["environmentId"] as? String == "ssh:demo" && eventRequests.last?["accountId"] as? String == "acc-remote", "M2: UsageLogController initial usage_events must pass environmentId and accountId")

            // 验证多页导出参数透传 (650 条 -> limit 500 翻 2 页: offset 0 与 offset 500)
            var exportedLogPayload: [String: Any]? = nil
            saveUsageJSONTestHook = { report, _ in
                exportedLogPayload = report
                return true
            }
            let eventReqsBeforeExport = eventRequests.count
            m2Log.exportRows()
            waitUntil(step: 0.01, description: "M2 UsageLog exportRows") { exportedLogPayload != nil }
            let exportReqs = Array(eventRequests.dropFirst(eventReqsBeforeExport))
            check(exportReqs.count == 2, "M2: UsageLog exportRows for 650 rows must paginate twice (got \(exportReqs.count))")
            check(exportReqs.allSatisfy { ($0["environmentId"] as? String) == "ssh:demo" && ($0["accountId"] as? String) == "acc-remote" }, "M2: All paginated exportRows usage_events requests must carry environmentId and accountId")
            check((exportedLogPayload?["environmentId"] as? String) == "ssh:demo" && (exportedLogPayload?["accountId"] as? String) == "acc-remote", "M2: Exported UsageLog JSON must persist environmentId and accountId")
            check((exportedLogPayload?["rows"] as? [[String: Any]])?.count == 650, "M2: Exported UsageLog JSON must collect all 650 rows")

            // 切到全部环境查看混合事件卡片，并测试下一页参数透传
            if let allEnvItem = m2Log.environmentPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "all" }),
               let action = allEnvItem.action {
                NSApp.sendAction(action, to: allEnvItem.target, from: allEnvItem)
                waitUntil(step: 0.01, description: "M2 UsageLog switch env to all") { !m2Log.loading }
            }
            if let allAccIdx = m2Log.accountPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == "all" }) {
                m2Log.accountPopup.selectItem(at: allAccIdx)
                m2Log.accountChanged(m2Log.accountPopup)
                waitUntil(step: 0.01, description: "M2 UsageLog switch acc to all") { !m2Log.loading }
            }
            m2Log.nextPage()
            waitUntil(step: 0.01, description: "M2 UsageLog nextPage") { !m2Log.loading }
            check(eventRequests.last?["offset"] as? Int == 200 && eventRequests.last?["environmentId"] as? String == "all" && eventRequests.last?["accountId"] as? String == "all", "M2: UsageLog nextPage must preserve current environmentId and accountId")

            m2Log.sheet.contentView?.layoutSubtreeIfNeeded()
            if let sshCard = m2Log.tableView(m2Log.table, viewFor: nil, row: 0) as? UsageEventCard,
               let localCardInMixed = m2Log.tableView(m2Log.table, viewFor: nil, row: 1) as? UsageEventCard,
               let unattributedSshCard = m2Log.tableView(m2Log.table, viewFor: nil, row: 2) as? UsageEventCard {
                func findSshTag(in view: NSView) -> SshHostTagBadge? {
                    if let tag = view as? SshHostTagBadge { return tag }
                    for sub in view.subviews {
                        if let found = findSshTag(in: sub) { return found }
                    }
                    return nil
                }
                let sshTag = findSshTag(in: sshCard)
                let localSshTag = findSshTag(in: localCardInMixed)
                let sshLocalTag = findViewById(sshCard, "usage-event-local-tag")
                let mixedLocalTag = findViewById(localCardInMixed, "usage-event-local-tag")
                check(sshTag != nil && sshTag?.isHidden == false && sshTag?.showStatusDot == false && sshTag?.label.stringValue == "demo-ssh-host" && (sshLocalTag == nil || sshLocalTag?.isHidden == true), "M2: SSH UsageEventCard must display SshHostTagBadge(showStatusDot: false) demo-ssh-host without SSH prefix and hide local tag (got \(sshTag?.label.stringValue ?? "nil"))")
                check(!sshCard.accountLabel.isHidden && sshCard.accountLabel.stringValue == "remote@example.invalid", "M2: SSH UsageEventCard must display account_email (got \(sshCard.accountLabel.stringValue))")
                check(mixedLocalTag != nil && mixedLocalTag?.isHidden == false && (localSshTag == nil || localSshTag?.isHidden == true), "M2: Mixed-list local UsageEventCard must display UsageLocalTagBadge and hide SshHostTagBadge")
                check(!unattributedSshCard.accountLabel.isHidden && unattributedSshCard.accountLabel.stringValue == "未关联账号", "M2: Unattributed SSH UsageEventCard must display 未关联账号")
                sshCard.frame = NSRect(x: 0, y: 0, width: 640, height: 64)
                sshCard.layoutSubtreeIfNeeded()
                check(sshCard.fittingSize.height <= 64, "M2: UsageEventCard with badges must fit within 64pt row height (got \(sshCard.fittingSize.height))")
                check(sshCard.fittingSize.width <= 640, "M2: UsageEventCard with badges must fit within 640pt table width without overflow (got \(sshCard.fittingSize.width))")
            } else {
                check(false, "M2: UsageLog tableView must render UsageEventCard rows")
            }

            let pureLocalCard = UsageEventCard(frame: NSRect(x: 0, y: 0, width: 640, height: 64))
            pureLocalCard.configure(["model": "gemini-3.8-flash-n", "timestamp_seconds": 1761544267, "input_tokens": 100, "output_tokens": 20, "cached_tokens": 50, "cache_write_tokens": 0, "environment_kind": "local"], showLocalEnvironmentBadge: false)
            check(pureLocalCard.sshTag.isHidden && (findViewById(pureLocalCard, "usage-event-local-tag")?.isHidden ?? true) && pureLocalCard.accountLabel.isHidden, "M2: Pure-local UsageEventCard without email must hide sshTag, localBadge, and accountLabel")

            // 验证 UsageLogController 快照筛选一致性校验（返回环境与当前选中不一致时拦截）
            if let sshItem = m2Log.environmentPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "ssh:demo" }),
               let action = sshItem.action {
                eventMismatchEnv = "local"
                NSApp.sendAction(action, to: sshItem.target, from: sshItem)
                pump()
                check(!m2Log.exportButton.isEnabled && m2Log.rows.isEmpty && m2Log.status.stringValue == L10n.t("usage.error.period_mismatch"), "M2: UsageLogController must reject mismatched returned environmentId")
                eventMismatchEnv = nil
            }

            m2Log.closeSheet()
            waitForSheetDetach(on: m2Window, description: "M2 mixed UsageLogController to detach")

            // 5. 切回 all 与无 SSH 报表后，首张卡正上方上下文栏自动重新隐藏
            m2Mode = .pureLocal
            if let allAccIdx = m2Usage.accountPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == "all" }) {
                m2Usage.accountPopup.selectItem(at: allAccIdx)
                m2Usage.accountChanged(m2Usage.accountPopup)
            }
            m2Usage.applyExternalFilter(environmentId: "all")
            waitUntil(step: 0.01, description: "M2 return to pure-local report") { !m2Usage.loading && m2Usage.contextBarRow.isHidden }
            check(m2Usage.contextBarRow.isHidden == true && m2Usage.environmentPill.isHidden == true && m2Usage.shareNoteLabel.isHidden == true && m2Usage.accountPopup.isHidden == true, "M2: Returning to pure-local single-account report must hide contextBarRow, environmentPill, shareNoteLabel, and accountPopup again")
        }

        // UsagePage & UsageLogController: Token card bottom context chips (<=2 SSH inline, >=3 SSH [+N 台] overflow), fitsSelectedTitleOnly accountPopup, unattributed option & zero-record notice
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let u3Host = Assistant(state: state.appendingPathComponent("usage-v12-filter-polish"))
            u3Host.configuration = try ConfigurationStore(state: u3Host.state)
            u3Host.bridge = BackendBridge(resources: state, state: u3Host.state)
            u3Host.reachable = true
            u3Host.cachedAccounts = [
                ["id": "acc-local", "name": "Local", "email": "local@example.invalid", "subscription_tier": "PRO"],
                ["id": "acc-remote", "name": "Remote", "email": "remote@example.invalid", "subscription_tier": "FREE"]
            ]
            u3Host.statusValue = LiveStatus([
                "mode": "connected",
                "running": true,
                "runningChannel": "stable",
                "remoteSyncRevision": 1
            ])
            let u3Window = makeHeadlessHostWindow(width: 920, height: 640)
            u3Host.window = u3Window
            defer {
                u3PageCleanup: do {
                    u3Host.bridge.fixtureReply = nil
                    u3Host.window = nil
                    u3Window.orderOut(nil)
                }
            }

            var envCountMode = 2
            var unavailableNoticeCheck = false
            var summaryCalls: [[String: Any]] = []
            var eventCalls: [[String: Any]] = []

            let buildEnvs: () -> [[String: Any]] = {
                var list: [[String: Any]] = [
                    ["id": "all", "kind": "all", "label": "全部环境", "online": true, "total_tokens": 25_000, "request_count": 5],
                    ["id": "local", "kind": "local", "label": "本机", "online": true, "total_tokens": 10_000, "request_count": 2]
                ]
                if envCountMode == 2 {
                    list.append(["id": "ssh:demo", "kind": "ssh", "label": "demo-ssh-host", "online": true, "total_tokens": 15_000, "request_count": 3])
                } else {
                    for i in 1...5 {
                        list.append(["id": "ssh:demo\(i)", "kind": "ssh", "label": "demo-ssh-\(i)", "online": true, "total_tokens": 3_000, "request_count": 1])
                    }
                }
                return list
            }
            let buildAccs: () -> [[String: Any]] = {
                [
                    ["id": "all", "email": "全部账号", "label": "全部账号", "total_tokens": 25_000, "request_count": 5],
                    ["id": "acc-local", "email": "local@example.invalid", "label": "local@example.invalid", "total_tokens": 10_000, "request_count": 2],
                    ["id": "acc-remote", "email": "remote@example.invalid", "label": "remote@example.invalid", "total_tokens": 0, "request_count": 0]
                ]
            }

            u3Host.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "usage_summary" {
                    summaryCalls.append(payload)
                    let reqPeriod = payload["period"] as? String ?? "today"
                    let reqEnv = payload["environmentId"] as? String ?? "all"
                    let reqAcc = payload["accountId"] as? String ?? "all"
                    let envs = buildEnvs()
                    let accs = buildAccs()
                    let isUnattr = reqAcc == "unattributed"
                    let isAccInSshZero = reqEnv == "ssh:demo" && reqAcc == "acc-local"
                    let tokens = isUnattr ? 15_000 : (isAccInSshZero ? 0 : 25_000)
                    let reqs = isUnattr ? 3 : (isAccInSshZero ? 0 : 5)
                    let availability = unavailableNoticeCheck ? "unavailable" : "available"
                    return [
                        "ok": true,
                        "period": reqPeriod,
                        "snapshotId": "u3-snap-\(reqEnv)-\(reqAcc)-\(envCountMode)-\(availability)",
                        "selectedEnvironmentId": reqEnv,
                        "selectedAccountId": reqAcc,
                        "unattributedRequests": 3,
                        "unattributedTokens": 15_000,
                        "availableEnvironments": envs,
                        "availableAccounts": accs,
                        "environmentBreakdown": [
                            "local_tokens": 10_000,
                            "ssh_tokens": 15_000,
                            "local_requests": 2,
                            "ssh_requests": 3,
                            "local_share_pct": 40,
                            "ssh_share_pct": 60,
                            "has_ssh_data": true,
                            "offline_ssh_hosts": []
                        ],
                        "summary": [
                            "availability": availability,
                            "totalTokens": tokens,
                            "promptTokens": tokens,
                            "candidatesTokens": 0,
                            "cachedTokens": 0,
                            "cacheWriteTokens": 0,
                            "requestCount": reqs,
                            "estimatedUsd": isAccInSshZero ? 0.0 : 0.12,
                            "unattributedRequests": 3,
                            "unattributedTokens": 15_000
                        ],
                        "byModel": [],
                        "hourly": [],
                        "daily": [],
                        "generatedAt": Int(Date().timeIntervalSince1970)
                    ]
                }
                if cmd == "usage_events" {
                    eventCalls.append(payload)
                    let reqPeriod = payload["period"] as? String ?? "today"
                    let reqEnv = payload["environmentId"] as? String ?? "all"
                    let reqAcc = payload["accountId"] as? String ?? "all"
                    let rows: [[String: Any]] = reqAcc == "unattributed" ? [
                        [
                            "model": "gemini-3.8-flash-n",
                            "timestamp_seconds": Int(Date().timeIntervalSince1970) - 60,
                            "input_tokens": 5_000,
                            "output_tokens": 0,
                            "cached_tokens": 0,
                            "cache_write_tokens": 0,
                            "total_tokens": 5_000,
                            "environment_kind": "ssh",
                            "environment_id": "ssh:demo",
                            "environment_label": "demo-ssh-host",
                            "account_confidence": "unknown"
                        ]
                    ] : []
                    return [
                        "ok": true,
                        "snapshot_id": "u3-ev-snap",
                        "generated_at": Int(Date().timeIntervalSince1970),
                        "period": reqPeriod,
                        "selectedEnvironmentId": reqEnv,
                        "selectedAccountId": reqAcc,
                        "scope": "",
                        "total": rows.count,
                        "rows": rows,
                        "availableEnvironments": buildEnvs(),
                        "availableAccounts": buildAccs()
                    ]
                }
                return ["ok": true]
            }

            let u3Page = UsagePage(app: u3Host)
            _ = u3Page.view
            u3Host.usagePage = u3Page
            u3Window.contentView = u3Page.view
            u3Page.view.layoutSubtreeIfNeeded()
            u3Page.update(force: true)
            waitUntil(step: 0.01, description: "UsagePage v5 context bar initial fetch") { !u3Page.loading && !u3Page.contextBarRow.isHidden && !u3Page.environmentPill.isHidden && !u3Page.accountPopup.isHidden }

            // 1. 1 台 SSH 时，首张卡正上方 28pt 上下文栏展示 EnvironmentContextPill 与 [本机 40% · SSH 60%]，accountPopup 为 .headerPill 26pt 轻胶囊（fitsSelectedTitleOnly=true, maxWidth=210, toolTip=nil），彻底移除「未关联账号」选项与提示横幅
            let u3MenuTitles = u3Page.environmentPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(u3MenuTitles.contains { $0.contains("本机") && $0.contains("40%") }, "UsagePage environmentPill menu must include 本机 40%: \(u3MenuTitles)")
            check(u3MenuTitles.contains { $0.contains("demo-ssh-host") && $0.contains("60%") } && u3MenuTitles.allSatisfy { !$0.contains("SSH:") }, "UsagePage environmentPill menu must list clean hostname demo-ssh-host with 60% without SSH prefix: \(u3MenuTitles)")
            check(u3Page.environmentPill.style == .headerPill && u3Page.environmentPill.pillHeight == 26 && u3Page.environmentPill.displayTitle == L10n.t("ssh.scope.all", fallback: "全部") && !u3Page.environmentPill.displayTitle.contains("100%"), "UsagePage environmentPill must use .headerPill 26pt and pure 全部 collapsed title")
            check(u3Page.shareNoteLabel.stringValue.contains("本机 40%") && u3Page.shareNoteLabel.stringValue.contains("SSH 60%"), "UsagePage shareNoteLabel must show 本机 40% · SSH 60% (got \(u3Page.shareNoteLabel.stringValue))")
            let u3AccCell = u3Page.accountPopup.cell as? DesignPopUpCell
            check(u3Page.accountPopup.controlSize == .regular && u3AccCell != nil, "UsagePage accountPopup must use .regular size and DesignPopUpCell")
            check(u3AccCell?.visualStyle == .headerPill && u3AccCell?.customHeight == 26 && u3AccCell?.fitsSelectedTitleOnly == true && u3AccCell?.isActiveState == false && u3Page.accountPopup.toolTip == nil, "UsagePage accountPopup must use .headerPill 26pt DesignPopUpCell with fitsSelectedTitleOnly, inactive default state, and nil toolTip")
            check(u3Page.accountPopup.constraints.first(where: { $0.identifier == "design-control-height" })?.constant == 26, "UsagePage accountPopup design-control-height constraint must be 26")
            check(u3Page.accountPopup.constraints.first(where: { $0.identifier == "usage-popup-max-width" })?.constant == 210, "UsagePage accountPopup maxWidth constraint must be 210")
            check(u3Page.accountPopup.subviews.contains { $0 is DesignPopUpHoverOverlay }, "UsagePage accountPopup must attach DesignPopUpHoverOverlay")
            let u3AccountIds = (u3Page.accountPopup.menu?.items ?? []).compactMap { $0.representedObject as? String }
            check(u3AccountIds == ["all", "acc-local", "acc-remote"] && !u3Page.accountPopup.itemTitles.contains(L10n.t("usage.account.unattributed")), "UsagePage accountPopup must only include all and real accounts, never unattributed even when unattributedRequests > 0 (got \(u3AccountIds))")

            // 2. 选中 ssh:demo 并切换 accountPopup 到 acc-local -> 激活态切换正常，且无任何未关联引导提示条
            if let sshItem = u3Page.environmentPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "ssh:demo" }),
               let action = sshItem.action {
                NSApp.sendAction(action, to: sshItem.target, from: sshItem)
            } else {
                check(false, "UsagePage environmentPill menu must contain ssh:demo")
            }
            if let localAccIdx = u3Page.accountPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == "acc-local" }) {
                u3Page.accountPopup.selectItem(at: localAccIdx)
                u3Page.accountChanged(u3Page.accountPopup)
            } else {
                check(false, "UsagePage accountPopup must contain acc-local")
            }
            waitUntil(step: 0.01, description: "UsagePage ssh:demo + acc-local filter") { !u3Page.loading && u3Page.selectedAccountId == "acc-local" && u3Page.selectedEnvironmentId == "ssh:demo" }
            check((u3Page.accountPopup.cell as? DesignPopUpCell)?.isActiveState == true, "UsagePage accountPopup selecting acc-local must set isActiveState = true")
            check(!allTextValues(u3Page.view).contains { $0.contains("未关联") }, "UsagePage must not render any unattributed notice banner")

            // 3. 验证历史遗留 "unattributed" 传入 syncAccountPopup / UsagePage / UsageLogController 时自动归一化回 "all"，且单真实账号 + unattributedRequests > 0 时隐藏 accountPopup
            let legacyPopup = NSPopUpButton(frame: .zero, pullsDown: false)
            let normalizedLegacyId = UsageFilterSupport.syncAccountPopup(
                legacyPopup,
                accounts: buildAccs(),
                selectedId: "unattributed",
                allTitle: L10n.t("usage.account.all")
            )
            let legacyCell = legacyPopup.cell as? DesignPopUpCell
            let legacyPopupIds = (legacyPopup.menu?.items ?? []).compactMap { $0.representedObject as? String }
            check(normalizedLegacyId == "all" && legacyCell?.visualStyle == .headerPill && legacyCell?.customHeight == 26 && legacyCell?.fitsSelectedTitleOnly == true && legacyCell?.isActiveState == false, "UsageFilterSupport.syncAccountPopup must normalize legacy unattributed to all and configure .headerPill 26pt cell")
            check(legacyPopupIds == ["all", "acc-local", "acc-remote"] && !legacyPopup.itemTitles.contains(L10n.t("usage.account.unattributed")), "UsageFilterSupport.syncAccountPopup must exclude unattributed item")

            u3Host.usageSelectedAccount = "unattributed"
            let legacyUsagePage = UsagePage(app: u3Host)
            check(legacyUsagePage.selectedAccountId == "all" && u3Host.usageSelectedAccount == "all", "UsagePage init must normalize legacy usageSelectedAccount=unattributed back to all")
            let singleRealPopup = NSPopUpButton(frame: .zero, pullsDown: false)
            _ = UsageFilterSupport.syncAccountPopup(
                singleRealPopup,
                accounts: [
                    ["id": "all", "email": "全部账号", "label": "全部账号"],
                    ["id": "acc-local", "email": "local@example.invalid", "label": "local@example.invalid"],
                    ["id": "unattributed", "email": "未关联账号", "label": "未关联账号"]
                ],
                selectedId: "unattributed",
                allTitle: L10n.t("usage.account.all")
            )
            let singleRealIds = (singleRealPopup.menu?.items ?? []).compactMap { $0.representedObject as? String }
            check(singleRealIds == ["all", "acc-local"], "syncAccountPopup must strip unattributed entries even if supplied in accounts payload (got \(singleRealIds))")

            // 4. availability == unavailable 时仍保持正常不可用态，无任何未关联提示
            if let allAccIdx = u3Page.accountPopup.menu?.items.firstIndex(where: { ($0.representedObject as? String) == "all" }) {
                unavailableNoticeCheck = true
                u3Page.accountPopup.selectItem(at: allAccIdx)
                u3Page.accountChanged(u3Page.accountPopup)
                u3Page.update(force: true)
                waitUntil(step: 0.01, description: "UsagePage unavailable state") { !u3Page.loading && u3Page.totalTokensMetric.stringValue == "—" }
                unavailableNoticeCheck = false
            }

            // 5. >= 3 台 SSH 时：EnvironmentContextPill 分组菜单列出全部 5 台 SSH 主机并支持选中第 4 台激活高亮
            envCountMode = 6
            u3Page.applyExternalFilter(environmentId: "all")
            u3Page.fetch(force: true, interruptInFlight: true)
            waitUntil(step: 0.01, description: "UsagePage >=3 SSH grouped pill") {
                !u3Page.loading
                    && u3Page.selectedAccountId == "all"
                    && u3Page.environmentPill.items.filter { $0.kind == .ssh }.count == 5
            }
            let multiPillMenu = u3Page.environmentPill.buildMenu()
            let multiPillTitles = multiPillMenu.items.map { $0.attributedTitle?.string ?? $0.title }
            check(multiPillTitles.contains(L10n.t("ssh.picker.group.online", fallback: "在线 SSH")), "UsagePage >=3 SSH menu must include online section header: \(multiPillTitles)")
            check((1...5).allSatisfy { idx in multiPillTitles.contains { $0.contains("demo-ssh-\(idx)") } }, "UsagePage >=3 SSH menu must list all 5 SSH hosts cleanly: \(multiPillTitles)")
            u3Page.applyExternalFilter(environmentId: "ssh:demo4")
            waitUntil(step: 0.01, description: "UsagePage 4th SSH host selected") {
                !u3Page.loading && u3Page.selectedEnvironmentId == "ssh:demo4"
            }
            check(u3Page.environmentPill.selectedScope == .remote(environmentId: "ssh:demo4") && u3Page.environmentPill.isActive, "UsagePage selecting ssh:demo4 must activate environmentPill with selectedScope == .remote(ssh:demo4)")

            // 6. 打开 UsageLogController 验证 EnvironmentContextPill (.headerPill 26pt) 与 accountPopup (.headerPill 26pt / fitsSelectedTitleOnly)、以及传入历史 "unattributed" 归一化回 "all"
            let legacyLog = UsageLogController(app: u3Host, period: "today", environmentId: "ssh:demo4", accountId: "unattributed")
            check(legacyLog.selectedAccountId == "all", "UsageLogController init must normalize legacy accountId=unattributed back to all")
            let legacyLogAccIds = (legacyLog.accountPopup.menu?.items ?? []).compactMap { $0.representedObject as? String }
            check(legacyLogAccIds == ["all", "acc-local", "acc-remote"] && !legacyLog.accountPopup.itemTitles.contains(L10n.t("usage.account.unattributed")), "UsageLogController accountPopup must exclude unattributed (got \(legacyLogAccIds))")
            legacyLog.show(in: u3Window) {}
            waitUntil(step: 0.01, description: "UsageLogController normalized fetch") { !legacyLog.loading }
            check(legacyLog.environmentPill.style == .headerPill && legacyLog.environmentPill.pillHeight == 26, "UsageLogController environmentPill must use .headerPill 26pt")
            let u3LogAccCell = legacyLog.accountPopup.cell as? DesignPopUpCell
            check(legacyLog.accountPopup.controlSize == .regular && u3LogAccCell?.visualStyle == .headerPill && u3LogAccCell?.customHeight == 26 && u3LogAccCell?.fitsSelectedTitleOnly == true && u3LogAccCell?.isActiveState == false, "UsageLogController accountPopup must use .headerPill 26pt DesignPopUpCell with fitsSelectedTitleOnly and inactive state for all")
            check(legacyLog.accountPopup.constraints.first(where: { $0.identifier == "design-control-height" })?.constant == 26, "UsageLogController accountPopup design-control-height must be 26")
            check(eventCalls.last?["accountId"] as? String == "all", "UsageLogController normalized from unattributed must query usage_events with accountId=all")
            legacyLog.closeSheet()
            waitForSheetDetach(on: u3Window, description: "UsageLogController normalized sheet detach")
        }

        // MenuPanelController Tab 0 (Usage): 条件显隐环境切换栏（无账号选择器、<=3 紧凑分段 / >3 玻璃下拉、396pt 宽度与英文零泄漏、主窗口环境同步）
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let m4Host = Assistant(state: state.appendingPathComponent("menu-usage-env-filter"))
            m4Host.configuration = try ConfigurationStore(state: m4Host.state)
            m4Host.bridge = BackendBridge(resources: state, state: m4Host.state)
            m4Host.reachable = true
            m4Host.statusValue = LiveStatus([
                "mode": "connected",
                "running": true,
                "runningChannel": "stable",
                "remoteSyncRevision": 1
            ])
            defer {
                m4Host.bridge.fixtureReply = nil
                m4Host.window?.orderOut(nil)
            }

            enum M4EnvMode { case pureLocal, oneSsh, multiSsh }
            var m4Mode: M4EnvMode = .pureLocal
            var m4SummaryCalls: [[String: Any]] = []

            m4Host.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "usage_summary" {
                    m4SummaryCalls.append(payload)
                    let reqPeriod = payload["period"] as? String ?? "today"
                    let reqEnv = payload["environmentId"] as? String ?? "all"
                    switch m4Mode {
                    case .pureLocal:
                        return [
                            "ok": true,
                            "period": reqPeriod,
                            "snapshotId": "m4-local-\(reqPeriod)-\(reqEnv)",
                            "selectedEnvironmentId": reqEnv,
                            "selectedAccountId": "all",
                            "availableEnvironments": [
                                ["id": "all", "kind": "all", "label": "全部环境", "online": true, "total_tokens": 100_000, "request_count": 4],
                                ["id": "local", "kind": "local", "label": "本机", "online": true, "total_tokens": 100_000, "request_count": 4]
                            ],
                            "environmentBreakdown": [
                                "local_tokens": 100_000,
                                "ssh_tokens": 0,
                                "has_ssh_data": false
                            ],
                            "summary": [
                                "availability": "available",
                                "totalTokens": 100_000,
                                "promptTokens": 80_000,
                                "candidatesTokens": 20_000,
                                "cachedTokens": 0,
                                "cacheWriteTokens": 0,
                                "requestCount": 4,
                                "estimatedUsd": 0.45
                            ],
                            "byModel": [["model": "gemini-3.8-flash-n", "totalTokens": 100_000, "requestCount": 4, "estimatedUsd": 0.45, "priced": true]],
                            "todayHourly": [],
                            "dailyTrends": []
                        ]
                    case .oneSsh:
                        let isSsh = (reqEnv == "ssh:very-long-remote-dev-hostname-oracle-phx.internal")
                        let isLocal = (reqEnv == "local")
                        let tokens = isSsh ? 91_200 : (isLocal ? 100_000 : 191_200)
                        let reqs = isSsh ? 7 : (isLocal ? 4 : 11)
                        return [
                            "ok": true,
                            "period": reqPeriod,
                            "snapshotId": "m4-onessh-\(reqPeriod)-\(reqEnv)",
                            "selectedEnvironmentId": reqEnv,
                            "selectedAccountId": "all",
                            "availableEnvironments": [
                                ["id": "all", "kind": "all", "label": "全部环境", "online": true, "total_tokens": 191_200, "request_count": 11],
                                ["id": "local", "kind": "local", "label": "本机", "online": true, "total_tokens": 100_000, "request_count": 4],
                                ["id": "ssh:very-long-remote-dev-hostname-oracle-phx.internal", "kind": "ssh", "label": "very-long-remote-dev-hostname-oracle-phx.internal", "online": true, "total_tokens": 91_200, "request_count": 7]
                            ],
                            "environmentBreakdown": [
                                "local_tokens": 100_000,
                                "ssh_tokens": 91_200,
                                "local_share_pct": 52,
                                "ssh_share_pct": 48,
                                "has_ssh_data": true
                            ],
                            "summary": [
                                "availability": "available",
                                "totalTokens": tokens,
                                "promptTokens": tokens,
                                "candidatesTokens": 0,
                                "cachedTokens": 0,
                                "cacheWriteTokens": 0,
                                "requestCount": reqs,
                                "estimatedUsd": isSsh ? 0.04 : 0.49
                            ],
                            "byModel": [["model": "gemini-3.8-flash-n", "totalTokens": tokens, "requestCount": reqs, "estimatedUsd": isSsh ? 0.04 : 0.49, "priced": true]],
                            "todayHourly": [],
                            "dailyTrends": []
                        ]
                    case .multiSsh:
                        let isOffline = (reqEnv == "ssh:offline-demo")
                        let tokens = isOffline ? 30_000 : 221_200
                        return [
                            "ok": true,
                            "period": reqPeriod,
                            "snapshotId": "m4-multi-\(reqPeriod)-\(reqEnv)",
                            "selectedEnvironmentId": reqEnv,
                            "selectedAccountId": "all",
                            "availableEnvironments": [
                                ["id": "all", "kind": "all", "label": "全部环境", "online": true, "total_tokens": 221_200, "request_count": 13],
                                ["id": "local", "kind": "local", "label": "本机", "online": true, "total_tokens": 100_000, "request_count": 4],
                                ["id": "ssh:online-demo", "kind": "ssh", "label": "online-demo", "online": true, "total_tokens": 91_200, "request_count": 7],
                                ["id": "ssh:offline-demo", "kind": "ssh", "label": "offline-demo", "online": false, "total_tokens": 30_000, "request_count": 2]
                            ],
                            "environmentBreakdown": [
                                "local_tokens": 100_000,
                                "ssh_tokens": 121_200,
                                "local_share_pct": 45,
                                "ssh_share_pct": 55,
                                "has_ssh_data": true,
                                "offline_ssh_hosts": ["offline-demo"]
                            ],
                            "summary": [
                                "availability": "available",
                                "totalTokens": tokens,
                                "promptTokens": tokens,
                                "candidatesTokens": 0,
                                "cachedTokens": 0,
                                "cacheWriteTokens": 0,
                                "requestCount": isOffline ? 2 : 13,
                                "estimatedUsd": 0.55
                            ],
                            "byModel": [],
                            "todayHourly": [],
                            "dailyTrends": []
                        ]
                    }
                }
                return ["ok": true]
            }

            let m4Panel = MenuPanelController(app: m4Host)
            m4Host.menuPanelController = m4Panel
            _ = m4Panel.view
            m4Panel.selectTab(0, persist: false)
            m4Panel.panelWillOpen()
            waitUntil(step: 0.01, description: "MenuPanel Tab 0 pure-local fetch") { m4Host.cachedUsageReportsByPeriod["today"] != nil }
            pump()

            // 1. 纯本机模式下隐藏 contextPill 与 headerContextDivider，且零静态 tooltip；顶栏固定 424pt 与 [刷新]/[···]
            let m4PanelWin = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            m4PanelWin.contentViewController = m4Panel
            defer { m4PanelWin.orderOut(nil) }
            m4PanelWin.contentView?.layoutSubtreeIfNeeded()
            check(MenuPanelController.panelWidth == 424, "MenuPanelController.panelWidth must be 424pt (got \(MenuPanelController.panelWidth))")
            check(m4Panel.contextPill.isHidden == true && m4Panel.headerContextDivider.isHidden == true, "MenuPanel Tab 0 in pure-local mode must hide contextPill and headerContextDivider")
            let baselineRefreshX = m4Panel.headerRefreshButton.frame.minX
            let baselineMoreX = m4Panel.moreButton.frame.minX

            // 2. 存在 1 台长主机名 SSH 时：顶栏 contextPill 宽度 <= 154pt 防裁切、[刷新]/[···] 恒定原位不偏移/不遮挡、占比轻融合到 usageFooterLabel，且零静态 tooltip
            m4Mode = .oneSsh
            m4Host.fetchUsageSummary(period: "today", environmentId: "all", force: true)
            waitUntil(step: 0.01, description: "MenuPanel Tab 0 one-SSH fetch") { !m4Panel.contextPill.isHidden }
            m4Panel.view.layoutSubtreeIfNeeded()
            check(!m4Panel.contextPill.isHidden && !m4Panel.headerContextDivider.isHidden && !m4Panel.contextPill.isActive, "MenuPanel Tab 0 in default 'all' must show unscoped contextPill and headerContextDivider")
            check(m4Panel.contextPill.style == .menuHeaderPill && m4Panel.contextPill.pillHeight == 24 && m4Panel.contextPill.displayTitle == L10n.t("ssh.scope.all", fallback: "全部") && !m4Panel.contextPill.displayTitle.contains("100%") && m4Panel.contextPill.triggerButton.itemKind == .all, "MenuPanel contextPill must use .menuHeaderPill 24pt and pure 全部 collapsed title")
            check(m4Panel.contextPill.frame.width <= 154.5, "MenuPanel contextPill width must stay <= 154pt even with long hostname (got \(m4Panel.contextPill.frame.width))")
            check(!m4Panel.headerRefreshButton.isHidden && m4Panel.headerRefreshButton.alphaValue == 1.0 && m4Panel.headerRefreshButton.isEnabled && m4Panel.headerRefreshButton.frame.width == 78 && abs(m4Panel.headerRefreshButton.frame.minX - baselineRefreshX) <= 0.5, "MenuPanel headerRefreshButton must stay fixed at 78pt, opaque, and enabled")
            check(!m4Panel.moreButton.isHidden && m4Panel.moreButton.alphaValue == 1.0 && m4Panel.moreButton.isEnabled && m4Panel.moreButton.frame.width == 28 && abs(m4Panel.moreButton.frame.minX - baselineMoreX) <= 0.5, "MenuPanel moreButton must stay fixed at 28pt, opaque, and enabled")
            check(m4Panel.contextPill.frame.maxX <= m4Panel.headerRefreshButton.frame.minX + 0.5, "MenuPanel contextPill must not overlap headerRefreshButton")
            check(m4Panel.usageFooterLabel.stringValue.contains("本机 52% · SSH 48%"), "MenuPanel usageFooterLabel must include 本机 52% · SSH 48% (got \(m4Panel.usageFooterLabel.stringValue))")
            check(m4Panel.usageScopeLabel.isHidden && m4Panel.usageScopeLabel.stringValue.isEmpty, "MenuPanel normal Tab 0 state must hide duplicate usageScopeLabel line")
            let longMenuTitles = m4Panel.contextPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(longMenuTitles.contains { $0.contains("very-long-remote-dev-hostname-oracle-phx.internal") } && longMenuTitles.allSatisfy { !$0.contains("SSH:") && !$0.contains("SSH ·") }, "MenuPanel contextPill menu must show full clean hostname without SSH prefix: \(longMenuTitles)")
            func viewTreeHasNoTooltip(_ root: NSView) -> Bool {
                if let tip = root.toolTip, !tip.isEmpty { return false }
                return root.subviews.allSatisfy(viewTreeHasNoTooltip)
            }
            check(viewTreeHasNoTooltip(m4Panel.contextPill), "MenuPanel contextPill must have zero static tooltips")

            // 3. 切换至 SSH 环境（通过 contextPill.buildMenu() 菜单项动作）：请求不带 accountId、刷新为 91.2K、持久化 configuration、顶栏变为 active 状态、不偏移刷新按钮且不覆盖默认 all 缓存
            let allCacheSnap = m4Host.cachedUsageReportsByPeriod["today"]?["snapshotId"] as? String
            if let sshItem = m4Panel.contextPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "ssh:very-long-remote-dev-hostname-oracle-phx.internal" }),
               let action = sshItem.action {
                NSApp.sendAction(action, to: sshItem.target, from: sshItem)
            } else {
                check(false, "MenuPanel contextPill menu must include ssh:very-long-remote-dev-hostname-oracle-phx.internal")
                m4Panel.selectUsageEnvironment("ssh:very-long-remote-dev-hostname-oracle-phx.internal", persist: true)
            }
            waitUntil(step: 0.01, description: "MenuPanel switch to SSH environment") { m4Host.cachedUsageReportsByPeriod["today|env=ssh:very-long-remote-dev-hostname-oracle-phx.internal|acc=all"] != nil && m4Panel.tokensTile.valueLabel.stringValue == "91.2K" }
            m4Panel.view.layoutSubtreeIfNeeded()
            check(m4SummaryCalls.last?["environmentId"] as? String == "ssh:very-long-remote-dev-hostname-oracle-phx.internal" && m4SummaryCalls.last?["accountId"] == nil, "MenuPanel environment switch must send environmentId without accountId")
            check(m4Host.configuration?.value.menuUsageEnvironmentId == "ssh:very-long-remote-dev-hostname-oracle-phx.internal", "MenuPanel environment switch must persist menuUsageEnvironmentId")
            check(m4Host.cachedUsageReportsByPeriod["today"]?["snapshotId"] as? String == allCacheSnap, "MenuPanel filtered environment fetch must preserve default all cachedUsageReportsByPeriod[today]")
            check(m4Panel.contextPill.isActive && m4Panel.contextPill.triggerButton.itemKind == .ssh && !m4Panel.contextPill.displayTitle.contains("●") && m4Panel.contextPill.frame.width <= 154.5, "MenuPanel scoped contextPill must activate with .ssh kind, clean hostname, and cap width <= 154pt (got \(m4Panel.contextPill.frame.width))")
            check(abs(m4Panel.headerRefreshButton.frame.minX - baselineRefreshX) <= 0.5 && abs(m4Panel.moreButton.frame.minX - baselineMoreX) <= 0.5, "MenuPanel [刷新] and [···] must remain fixed after selecting long SSH host")
            check(!m4Panel.usageFooterLabel.stringValue.contains("本机 52%"), "MenuPanel viewing specific online SSH env must hide share note from footer")
            check(m4Panel.usageScopeLabel.isHidden && m4Panel.usageScopeLabel.stringValue.isEmpty, "MenuPanel scoped Tab 0 state must hide duplicate usageScopeLabel line")

            // 4. 从菜单栏深链跳转到主窗口用量页时，透传当前选中的环境筛选
            m4Host.openMainWindowFromMenuPanel(tab: 0, usagePeriod: 0, usageEnvironmentId: m4Panel.selectedEnvironmentId)
            pump()
            check(m4Host.currentPage == 2 && m4Host.usagePage?.selectedEnvironmentId == "ssh:very-long-remote-dev-hostname-oracle-phx.internal" && m4Host.usagePage?.selectedAccountId == "all", "openMainWindowFromMenuPanel must carry selectedEnvironmentId to UsagePage")

            // 5. > 3 环境（多台 SSH）：contextPill 弹出分组 NSMenu，选中离线主机在页脚显示「离线快照」
            m4Panel.selectUsageEnvironment("all", persist: true)
            m4Mode = .multiSsh
            m4Host.fetchUsageSummary(period: "today", environmentId: "all", force: true)
            waitUntil(step: 0.01, description: "MenuPanel >3 environments grouped pill menu") { m4Panel.contextPill.buildMenu().items.contains { ($0.representedObject as? String) == "ssh:offline-demo" } }
            check(!m4Panel.contextPill.isHidden, "MenuPanel Tab 0 with >3 environments must show contextPill")
            if let offlineItem = m4Panel.contextPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "ssh:offline-demo" }),
               let action = offlineItem.action {
                NSApp.sendAction(action, to: offlineItem.target, from: offlineItem)
                waitUntil(step: 0.01, description: "MenuPanel select offline SSH host") { m4Panel.usageFooterLabel.stringValue.contains(L10n.t("menu_panel.env.offline_hint")) }
                check(m4Panel.usageFooterLabel.stringValue.contains("离线快照"), "MenuPanel selecting offline SSH host must display 离线快照 in usageFooterLabel (got \(m4Panel.usageFooterLabel.stringValue))")
                check(m4Panel.usageScopeLabel.isHidden, "MenuPanel offline SSH state must hide duplicate usageScopeLabel line")
            } else {
                check(false, "MenuPanel contextPill menu must include ssh:offline-demo")
            }

            // 6. 英文语言验证：无中文泄漏且面板内容不溢出
            L10n.shared.setLanguage("en", notify: false)
            m4Panel.selectUsageEnvironment("all", persist: true)
            m4Mode = .oneSsh
            let m4PanelEn = MenuPanelController(app: m4Host)
            m4Host.menuPanelController = m4PanelEn
            _ = m4PanelEn.view
            m4PanelEn.panelWillOpen()
            m4Host.fetchUsageSummary(period: "today", environmentId: "all", force: true)
            waitUntil(step: 0.01, description: "MenuPanel English one-SSH layout") { m4PanelEn.usageFooterLabel.stringValue.contains("Local 52%") }
            m4PanelEn.view.layoutSubtreeIfNeeded()
            let m4EnMenuTitles = m4PanelEn.contextPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            let m4EnTexts = allTextValues(m4PanelEn.view) + m4EnMenuTitles
            let m4EnLeaks = m4EnTexts.filter { $0.range(of: "[\\u4E00-\\u9FFF]", options: .regularExpression) != nil }
            check(m4EnLeaks.isEmpty, "English MenuPanel must contain zero Chinese characters: \(m4EnLeaks)")

            // 7. 恢复中文并验证无 SSH 纯本机回退时自动清回 all 并隐藏 contextPill 与竖线
            L10n.shared.setLanguage("zh-Hans", notify: false)
            m4Host.menuPanelController = m4Panel
            m4Panel.selectUsageEnvironment("ssh:offline-demo", persist: true)
            waitUntil(step: 0.01, description: "MenuPanel select stale ssh before fallback") { m4Panel.selectedEnvironmentId == "ssh:offline-demo" }
            m4Mode = .pureLocal
            m4Host.fetchUsageSummary(period: "today", environmentId: "ssh:offline-demo", force: true)
            waitUntil(step: 0.01, description: "MenuPanel stale SSH auto-fallback to all") { m4Panel.selectedEnvironmentId == "all" && m4Panel.contextPill.isHidden }
            check(m4Panel.selectedEnvironmentId == "all" && m4Panel.contextPill.isHidden && m4Panel.headerContextDivider.isHidden, "MenuPanel must auto-fallback stale SSH selection to all and hide contextPill and divider on pure-local report")
            check(viewTreeHasNoTooltip(m4Panel.view), "MenuPanel in pure-local mode must leave zero static tooltips")
        }

        // Antigravity System Proxy: SystemProxyResolver + ConfigurationStore + PreferencesController UI
        do {
            defer {
                SystemProxyResolver.testSystemProxySettingsOverride = nil
                SystemProxyResolver.testRunningProxyStateOverride = nil
                L10n.shared.setLanguage("zh-Hans", notify: false)
            }

            // 1. SystemProxyResolver parsing & environment generation
            let httpHttpsRaw: [String: Any] = [
                kCFNetworkProxiesHTTPEnable as String: 1,
                kCFNetworkProxiesHTTPProxy as String: "127.0.0.1",
                kCFNetworkProxiesHTTPPort as String: 7890,
                kCFNetworkProxiesHTTPSEnable as String: 1,
                kCFNetworkProxiesHTTPSProxy as String: "127.0.0.1",
                kCFNetworkProxiesHTTPSPort as String: 7891,
                kCFNetworkProxiesExceptionsList as String: ["*.local", "169.254/16", "127.0.0.1", "localhost"]
            ]
            let snapHttpHttps = SystemProxyResolver.readSystemProxySnapshot(rawSettings: httpHttpsRaw)
            check(snapHttpHttps.httpUrl == "http://127.0.0.1:7890", "SystemProxyResolver must parse HTTP proxy URL (got \(String(describing: snapHttpHttps.httpUrl)))")
            check(snapHttpHttps.httpsUrl == "http://127.0.0.1:7891", "SystemProxyResolver must parse HTTPS proxy URL (got \(String(describing: snapHttpHttps.httpsUrl)))")
            let resSystemActive = SystemProxyResolver.resolve(mode: .system, manualUrl: "", snapshot: snapHttpHttps)
            if case .active(let httpUrl, let httpsUrl, let noProxy, let displayUrl) = resSystemActive {
                check(httpUrl == "http://127.0.0.1:7890", "System resolution httpUrl mismatch: \(httpUrl)")
                check(httpsUrl == "http://127.0.0.1:7891", "System resolution httpsUrl mismatch: \(httpsUrl)")
                check(!displayUrl.isEmpty, "System resolution displayUrl must not be empty")
                let noProxyParts = noProxy.split(separator: ",").map { String($0) }
                check(noProxyParts.prefix(3) == ["127.0.0.1", "localhost", "::1"], "NO_PROXY must always start with mandatory loopback exclusions (got \(noProxy))")
                check(noProxyParts.contains("*.local") && noProxyParts.contains("169.254/16"), "NO_PROXY must merge macOS ExceptionsList (got \(noProxy))")
                check(Set(noProxyParts).count == noProxyParts.count, "NO_PROXY must deduplicate entries (got \(noProxy))")
            } else {
                check(false, "Expected .active for HTTP+HTTPS system proxy, got \(resSystemActive)")
            }
            let launchEnv = SystemProxyResolver.launchEnvironment(for: resSystemActive)
            check(launchEnv["HTTP_PROXY"] == "http://127.0.0.1:7890" && launchEnv["http_proxy"] == "http://127.0.0.1:7890", "launchEnvironment must set HTTP_PROXY and http_proxy")
            check(launchEnv["HTTPS_PROXY"] == "http://127.0.0.1:7891" && launchEnv["https_proxy"] == "http://127.0.0.1:7891", "launchEnvironment must set HTTPS_PROXY and https_proxy")
            check(launchEnv["NO_PROXY"]?.hasPrefix("127.0.0.1,localhost,::1") == true && launchEnv["no_proxy"] == launchEnv["NO_PROXY"], "launchEnvironment must set NO_PROXY and no_proxy with loopback bypass")
            check(launchEnv["NODE_USE_ENV_PROXY"] == "1", "launchEnvironment must set NODE_USE_ENV_PROXY=1")
            check(SystemProxyResolver.launchEnvironment(for: .disabled).isEmpty, "Disabled proxy resolution must yield empty launchEnvironment")

            let pacRaw: [String: Any] = [
                kCFNetworkProxiesProxyAutoConfigEnable as String: 1,
                kCFNetworkProxiesProxyAutoConfigURLString as String: "http://127.0.0.1:8080/proxy.pac"
            ]
            let resPac = SystemProxyResolver.resolve(mode: .system, manualUrl: "", snapshot: SystemProxyResolver.readSystemProxySnapshot(rawSettings: pacRaw))
            if case .systemUnsupported(.pac(let url)) = resPac {
                check(url == "http://127.0.0.1:8080/proxy.pac", "PAC unsupported kind must preserve PAC URL")
            } else {
                check(false, "Expected .systemUnsupported(.pac), got \(resPac)")
            }
            check(SystemProxyResolver.launchEnvironment(for: resPac).isEmpty, "Unsupported PAC resolution must yield empty launchEnvironment")

            let socksRaw: [String: Any] = [
                kCFNetworkProxiesSOCKSEnable as String: 1,
                kCFNetworkProxiesSOCKSProxy as String: "127.0.0.1",
                kCFNetworkProxiesSOCKSPort as String: 1080
            ]
            let resSocks = SystemProxyResolver.resolve(mode: .system, manualUrl: "", snapshot: SystemProxyResolver.readSystemProxySnapshot(rawSettings: socksRaw))
            if case .systemUnsupported(.socksOnly(let url)) = resSocks {
                check(url.contains("127.0.0.1") && url.contains("1080"), "SOCKS-only unsupported kind must include host/port (got \(url))")
            } else {
                check(false, "Expected .systemUnsupported(.socksOnly), got \(resSocks)")
            }

            let resEmpty = SystemProxyResolver.resolve(mode: .system, manualUrl: "", snapshot: SystemProxyResolver.readSystemProxySnapshot(rawSettings: [:]))
            check(resEmpty == .systemNotConfigured, "Empty system proxy settings must resolve to .systemNotConfigured (got \(resEmpty))")

            // 2. normalizeManualProxyUrl validation
            if case .success(let norm1) = SystemProxyResolver.normalizeManualProxyUrl("http://127.0.0.1:7222") {
                check(norm1 == "http://127.0.0.1:7222", "Valid http URL must normalize cleanly")
            } else {
                check(false, "Expected http://127.0.0.1:7222 to succeed")
            }
            if case .success(let norm2) = SystemProxyResolver.normalizeManualProxyUrl("  127.0.0.1:7890  ") {
                check(norm2 == "http://127.0.0.1:7890", "Bare host:port must normalize to http://host:port (got \(norm2))")
            } else {
                check(false, "Expected bare 127.0.0.1:7890 to succeed")
            }
            if case .success(let norm3) = SystemProxyResolver.normalizeManualProxyUrl("https://proxy.local:8443") {
                check(norm3 == "https://proxy.local:8443", "Valid https URL must normalize cleanly")
            } else {
                check(false, "Expected https://proxy.local:8443 to succeed")
            }
            for invalidInput in ["socks5://127.0.0.1:1080", "not a url", "http://127.0.0.1:99999", ""] {
                if case .success(let unexpected) = SystemProxyResolver.normalizeManualProxyUrl(invalidInput) {
                    check(false, "Invalid manual proxy '\(invalidInput)' must fail validation (unexpectedly got \(unexpected))")
                }
            }

            // 3. ConfigurationStore round-trip persistence
            let proxyStateDir = state.appendingPathComponent("proxy-config-test", isDirectory: true)
            try? FileManager.default.removeItem(at: proxyStateDir)
            let store1 = try ConfigurationStore(state: proxyStateDir)
            check(store1.value.antigravityProxyMode == "off" && store1.value.antigravityProxyManualUrl == "", "Fresh ConfigurationStore must default proxy mode to off and manualUrl to empty")
            store1.value.antigravityProxyMode = "manual"
            store1.value.antigravityProxyManualUrl = "http://127.0.0.1:7890"
            try store1.save()
            let store2 = try ConfigurationStore(state: proxyStateDir)
            check(store2.value.antigravityProxyMode == "manual" && store2.value.antigravityProxyManualUrl == "http://127.0.0.1:7890", "ConfigurationStore must round-trip antigravityProxyMode and antigravityProxyManualUrl")

            // 4. PreferencesController UI controls in zh-Hans & en
            let proxyUiStateDir = state.appendingPathComponent("proxy-ui-test", isDirectory: true)
            try? FileManager.default.removeItem(at: proxyUiStateDir)
            let proxyHost = Assistant(state: proxyUiStateDir)
            proxyHost.configuration = try ConfigurationStore(state: proxyUiStateDir)
            proxyHost.configuration.value.navigationVersion = 5
            proxyHost.configuration.value.appLanguage = "zh-Hans"
            proxyHost.bridge = BackendBridge(resources: state, state: proxyUiStateDir)
            proxyHost.reachable = true
            proxyHost.statusValue = LiveStatus(fixtureStatus)
            var proxySetCalls: [[String: Any]] = []
            proxyHost.bridge.fixtureReply = { payload in
                if (payload["command"] as? String) == "proxy_set" {
                    proxySetCalls.append(payload)
                    return ["ok": true]
                }
                return ["ok": true]
            }

            L10n.shared.setLanguage("zh-Hans", notify: false)
            SystemProxyResolver.testSystemProxySettingsOverride = [:]
            SystemProxyResolver.testRunningProxyStateOverride = .notRunning

            let prefs = PreferencesController(app: proxyHost)
            check(prefs.proxyModePopup.numberOfItems == 3, "proxyModePopup must have 3 options (off/system/manual)")
            check(prefs.proxyModePopup.itemTitles == ["关闭", "跟随系统代理", "手动指定"], "proxyModePopup zh-Hans titles mismatch: \(prefs.proxyModePopup.itemTitles)")
            check((prefs.proxyModePopup.selectedItem?.representedObject as? String) == "off", "Initial proxyModePopup must select off")
            check((prefs.proxyModePopup.cell as? DesignPopUpCell)?.fitsSelectedTitleOnly == true, "Settings proxyModePopup must tightly fit selected option per Apple macOS HIG")
            let offProxyWidth = Design.fittedPopUpWidth(prefs.proxyModePopup)
            check(offProxyWidth >= 60 && offProxyWidth <= 72, "Selected '关闭' proxyModePopup must stay compact without long trailing void (got \(offProxyWidth))")
            check(prefs.proxyManualContainer.isHidden, "proxyManualContainer must be hidden in off mode")
            check(prefs.proxyRelaunchBtn.isHidden, "proxyRelaunchBtn must be hidden in off mode")
            check(prefs.proxySubtitleLabel.stringValue.contains("TUN"), "Disabled proxy subtitle must mention no-TUN benefit")

            // Switch to system mode (empty system proxy)
            prefs.proxyModePopup.selectItem(at: 1)
            prefs.proxyModeChanged()
            pump()
            check(Design.fittedPopUpWidth(prefs.proxyModePopup) > offProxyWidth + 24, "Switching proxyModePopup to '跟随系统代理' must expand width to fit selected title")
            check(proxyHost.configuration.value.antigravityProxyMode == "system", "Selecting system mode must persist antigravityProxyMode=system")
            check(proxySetCalls.last?["mode"] as? String == "system", "Selecting system mode must sync proxy_set to backend")
            check(prefs.proxyManualContainer.isHidden, "proxyManualContainer must remain hidden in system mode")
            check(prefs.proxyRelaunchBtn.isHidden, "proxyRelaunchBtn must remain hidden when system proxy not configured")
            check(prefs.proxySubtitleLabel.stringValue.contains("未检测到"), "Empty system proxy must show not-configured hint")

            // PAC unsupported state
            SystemProxyResolver.testSystemProxySettingsOverride = pacRaw
            prefs.update()
            check(prefs.proxyRelaunchBtn.isHidden && prefs.proxySubtitleLabel.stringValue.contains("PAC"), "PAC state must explain Go backend PAC limitation and hide relaunch button")

            // SOCKS-only unsupported state
            SystemProxyResolver.testSystemProxySettingsOverride = socksRaw
            prefs.update()
            check(prefs.proxyRelaunchBtn.isHidden && prefs.proxySubtitleLabel.stringValue.contains("SOCKS5"), "SOCKS-only state must explain SOCKS5 limitation and hide relaunch button")

            // Active system proxy + notRunning / matched / missing / mismatch / overriddenByShell
            SystemProxyResolver.testSystemProxySettingsOverride = httpHttpsRaw
            SystemProxyResolver.testRunningProxyStateOverride = .notRunning
            prefs.update()
            check(prefs.proxyRelaunchBtn.isHidden && prefs.proxySubtitleLabel.stringValue.contains("下次通过 GravityBox 启动生效"), "Active + notRunning must show next-launch subtitle and hide relaunch button")

            SystemProxyResolver.testRunningProxyStateOverride = .matched(activeUrl: "http://127.0.0.1:7891")
            prefs.update()
            check(prefs.proxyRelaunchBtn.isHidden && prefs.proxySubtitleLabel.stringValue.contains("当前生效") && prefs.proxySubtitleLabel.stringValue.contains("7891"), "Active + matched must show active URL and hide relaunch button")

            SystemProxyResolver.testRunningProxyStateOverride = .missing
            prefs.update()
            check(!prefs.proxyRelaunchBtn.isHidden && prefs.proxyRelaunchBtn.title == "安全重启生效", "Active + missing must show proxyRelaunchBtn")
            check(prefs.proxySubtitleLabel.stringValue.contains("未加载代理"), "Active + missing must show missing proxy prompt")

            SystemProxyResolver.testRunningProxyStateOverride = .mismatch(actualUrl: "http://127.0.0.1:1087", expectedUrl: "http://127.0.0.1:7891")
            prefs.update()
            check(!prefs.proxyRelaunchBtn.isHidden, "Active + mismatch must show proxyRelaunchBtn")
            check(prefs.proxySubtitleLabel.stringValue.contains("7891") && prefs.proxySubtitleLabel.stringValue.contains("1087"), "Active + mismatch must show expected and actual URLs")

            SystemProxyResolver.testRunningProxyStateOverride = .overriddenByShell(lsActualUrl: "http://127.0.0.1:9999", appInjectedUrl: "http://127.0.0.1:7891", expectedUrl: "http://127.0.0.1:7891")
            prefs.update()
            check(prefs.proxyRelaunchBtn.isHidden, "Active + overriddenByShell must hide proxyRelaunchBtn")
            check(prefs.proxySubtitleLabel.stringValue.contains("Shell") && prefs.proxySubtitleLabel.stringValue.contains("9999"), "Active + overriddenByShell must explain shell override")

            // Switch to manual mode (empty field -> shows manual input container without snapping back)
            autoreleasepool {
                let prefsHostWin = makeHeadlessHostWindow(width: 780, height: 640)
                prefsHostWin.contentView = prefs.view
                // Simulate initial window layout while still in non-manual (system) mode (proxyManualContainer detached & unlaid-out)
                prefs.view.layoutSubtreeIfNeeded()
                check(prefs.proxyManualContainer.isHidden, "proxyManualContainer must be hidden before first manual reveal")

                prefs.proxyModePopup.selectItem(at: 2)
                prefs.proxyModeChanged()
                check(!prefs.proxyManualContainer.isHidden, "Selecting manual mode must reveal proxyManualContainer")
                check((prefs.proxyModePopup.selectedItem?.representedObject as? String) == "manual", "proxyModePopup must stay on manual while entering URL")
                let manualPopupConstraintW = prefs.proxyModePopup.constraints.first(where: { $0.identifier == "design-control-width" })?.constant ?? 0
                let expectedManualPopupW = Design.fittedPopUpWidth(prefs.proxyModePopup)
                check(abs(manualPopupConstraintW - expectedManualPopupW) < 0.5 && manualPopupConstraintW > offProxyWidth + 12, "Selecting manual mode must immediately sync proxyModePopup width constraint (got \(manualPopupConstraintW), expected \(expectedManualPopupW))")
                check(prefs.proxyManualField.frame.width > 200 && prefs.proxyManualField.frame.height >= 28, "First reveal of manual proxy input must synchronously lay out non-zero proxyManualField frame before focus (got \(prefs.proxyManualField.frame))")
                if let textCell = prefs.proxyManualField.cell as? DesignTextCell {
                    let bounds = prefs.proxyManualField.bounds
                    let drawRect = textCell.drawingRect(forBounds: bounds)
                    let titleRect = textCell.titleRect(forBounds: bounds)
                    check(abs(drawRect.minX - 6.0) < 0.01 && abs(drawRect.width - (bounds.width - 12.0)) < 0.01 && drawRect.minY >= 5.0 && abs(drawRect.midY - bounds.midY) < 1.0, "DesignTextCell.drawingRect must inset horizontally by 6pt once and center vertically without double-insetting (got \(drawRect) in bounds \(bounds))")
                    check(drawRect == titleRect, "DesignTextCell.titleRect must match drawingRect (got \(titleRect) vs \(drawRect))")
                } else {
                    check(false, "proxyManualField must use DesignTextCell")
                }
                _ = prefsHostWin.makeFirstResponder(prefs.proxyManualField)
                if let editor = prefs.proxyManualField.currentEditor() {
                    let editorRectInField = prefs.proxyManualField.convert(editor.bounds, from: editor)
                    check(abs(editorRectInField.minX - 6.0) < 0.5 && abs(editorRectInField.width - (prefs.proxyManualField.bounds.width - 12.0)) < 1.0 && editorRectInField.minY >= 5.0, "Active field editor in proxyManualField must lock to single 6pt inset and centered Y without jumping or double-insetting (got \(editorRectInField), bounds=\(prefs.proxyManualField.bounds))")
                } else {
                    check(false, "makeFirstResponder(proxyManualField) must attach active field editor")
                }
                _ = prefsHostWin.makeFirstResponder(nil)
                prefsHostWin.endEditing(for: nil)
                pump()
                prefsHostWin.contentView = nil
                prefsHostWin.orderOut(nil)
            }

            // Invalid manual URL shows error and keeps manual container visible
            prefs.proxyManualField.stringValue = "socks5://127.0.0.1:1080"
            prefs.applyManualProxy()
            check(!prefs.proxyManualContainer.isHidden, "Invalid manual URL must keep proxyManualContainer visible")
            check(proxyHost.configuration.value.antigravityProxyMode == "system", "Invalid manual URL must not overwrite persisted proxy mode")
            check(!prefs.proxySubtitleLabel.stringValue.isEmpty, "Invalid manual URL must display validation error")

            // Valid manual URL normalizes, persists, syncs backend, and updates UI
            SystemProxyResolver.testRunningProxyStateOverride = .missing
            prefs.proxyManualField.stringValue = "127.0.0.1:7890"
            prefs.applyManualProxy()
            pump()
            check(proxyHost.configuration.value.antigravityProxyMode == "manual", "Valid manual URL must persist manual mode")
            check(proxyHost.configuration.value.antigravityProxyManualUrl == "http://127.0.0.1:7890", "Valid bare manual URL must persist normalized http:// URL")
            check(prefs.proxyManualField.stringValue == "http://127.0.0.1:7890", "proxyManualField must reflect normalized URL")
            check(proxySetCalls.last?["mode"] as? String == "manual" && proxySetCalls.last?["manualUrl"] as? String == "http://127.0.0.1:7890", "Applying manual proxy must sync proxy_set to backend")
            check(!prefs.proxyManualContainer.isHidden && !prefs.proxyRelaunchBtn.isHidden, "Manual mode + missing running state must show both manual input and relaunch button")

            // Switch back to off hides manual container & relaunch button
            prefs.proxyModePopup.selectItem(at: 0)
            prefs.proxyModeChanged()
            pump()
            check(prefs.proxyManualContainer.isHidden && prefs.proxyRelaunchBtn.isHidden, "Switching back to off must hide manual container and relaunch button")
            check(proxySetCalls.last?["mode"] as? String == "off", "Switching back to off must sync proxy_set mode=off")

            // English locale verification across states (zero Han leakage)
            L10n.shared.setLanguage("en", notify: false)
            let enPrefs = PreferencesController(app: proxyHost)
            check(enPrefs.proxyModePopup.itemTitles == ["Off", "Follow System Proxy", "Manual Proxy"], "English proxyModePopup titles mismatch: \(enPrefs.proxyModePopup.itemTitles)")
            check(enPrefs.proxyManualApplyBtn.title == "Apply", "English apply button title mismatch")
            check(enPrefs.proxyRelaunchBtn.title == "Relaunch to Apply", "English relaunch button title mismatch")
            let hanRegex = "[\\u4E00-\\u9FFF]"
            func assertNoHan(_ text: String, _ context: String) {
                check(text.range(of: hanRegex, options: .regularExpression) == nil, "English \(context) leaked Chinese characters: \(text)")
            }
            assertNoHan(enPrefs.proxySubtitleLabel.stringValue, "disabled subtitle")
            enPrefs.proxyModePopup.selectItem(at: 1)
            enPrefs.proxyModeChanged()
            for (label, rawMap, runState): (String, [String: Any], RunningAntigravityProxyState) in [
                ("systemNotConfigured", [:], .notRunning),
                ("pac", pacRaw, .notRunning),
                ("socksOnly", socksRaw, .notRunning),
                ("notRunning", httpHttpsRaw, .notRunning),
                ("matched", httpHttpsRaw, .matched(activeUrl: "http://127.0.0.1:7891")),
                ("missing", httpHttpsRaw, .missing),
                ("mismatch", httpHttpsRaw, .mismatch(actualUrl: "http://127.0.0.1:1087", expectedUrl: "http://127.0.0.1:7891")),
                ("overriddenByShell", httpHttpsRaw, .overriddenByShell(lsActualUrl: "http://127.0.0.1:9999", appInjectedUrl: "http://127.0.0.1:7891", expectedUrl: "http://127.0.0.1:7891"))
            ] {
                SystemProxyResolver.testSystemProxySettingsOverride = rawMap
                SystemProxyResolver.testRunningProxyStateOverride = runState
                enPrefs.update()
                assertNoHan(enPrefs.proxySubtitleLabel.stringValue, "state=\(label)")
            }
            check(enPrefs.proxyRelaunchBtn.isHidden, "English overriddenByShell must hide relaunch button")
            enPrefs.proxyModePopup.selectItem(at: 2)
            enPrefs.proxyModeChanged()
            assertNoHan(enPrefs.proxySubtitleLabel.stringValue, "manual prompt")
            enPrefs.proxyManualField.stringValue = "socks5://127.0.0.1:1080"
            enPrefs.applyManualProxy()
            assertNoHan(enPrefs.proxySubtitleLabel.stringValue, "invalid manual error")

            // Startup automation switch: default off, legacy compatibility, persistence, zh-Hans & en copy
            let lifecycleCfgState = state.appendingPathComponent("lifecycle-prefs-state")
            try FileManager.default.createDirectory(at: lifecycleCfgState, withIntermediateDirectories: true)
            let legacyConfigJSON = #"{"schema":2,"syncAntigravityLifecycle":true}"#
            try legacyConfigJSON.write(to: lifecycleCfgState.appendingPathComponent("config.json"), atomically: true, encoding: .utf8)
            let lifecycleHost = Assistant(state: lifecycleCfgState)
            lifecycleHost.configuration = try ConfigurationStore(state: lifecycleCfgState)
            check(
                lifecycleHost.configuration.value.launchAntigravityOnStart == false,
                "launchAntigravityOnStart must default to false even when legacy syncAntigravityLifecycle was true"
            )
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let lifecyclePrefsZh = PreferencesController(app: lifecycleHost)
            check(lifecyclePrefsZh.launchAntigravityOnStartSwitch.state == .off, "launchAntigravityOnStartSwitch must initialize to .off")
            let zhPrefTexts = allTextValues(lifecyclePrefsZh.view)
            check(
                zhPrefTexts.contains("启动时自动打开 Antigravity") &&
                !zhPrefTexts.contains("原生冷启动自动开启调试端口"),
                "Preferences must show startup launch title and omit removed native cold-launch switch"
            )
            lifecyclePrefsZh.launchAntigravityOnStartSwitch.state = .on
            lifecyclePrefsZh.toggleLaunchAntigravityOnStart()
            let reloadedLifecycleCfg = try ConfigurationStore(state: lifecycleCfgState)
            check(
                reloadedLifecycleCfg.value.launchAntigravityOnStart == true,
                "Toggling launchAntigravityOnStartSwitch must persist launchAntigravityOnStart"
            )
            L10n.shared.setLanguage("en", notify: false)
            let lifecyclePrefsEn = PreferencesController(app: lifecycleHost)
            let enPrefTexts = allTextValues(lifecyclePrefsEn.view)
            check(
                enPrefTexts.contains("Auto-Open Antigravity on Launch") &&
                !enPrefTexts.contains("Auto-Enable Debug Port on Native Launch"),
                "English Preferences must display localized startup launch title and omit removed switch"
            )
            L10n.shared.setLanguage("zh-Hans", notify: false)
            pump()
        }

        // Wave 1-2 SSH 全端适配契约测试（多窗口去重、picker 0/1/2 自适应、总览伴生条、账号占用/只读区/并发刷新、切号共享提示、菜单栏微标/跟随焦点/Tab2跳转）
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            defer { L10n.shared.setLanguage("zh-Hans", notify: false) }
            let nowTs = Date().timeIntervalSince1970

            func collectViews<T: NSView>(_ root: NSView, as type: T.Type) -> [T] {
                var out: [T] = []
                if let match = root as? T { out.append(match) }
                for sub in root.subviews { out.append(contentsOf: collectViews(sub, as: type)) }
                return out
            }
            func firstEmptyTooltipViolation(_ v: NSView) -> String? {
                if let tip = v.toolTip, !tip.isEmpty { return "\(type(of: v)): \(tip)" }
                for sub in v.subviews {
                    if let found = firstEmptyTooltipViolation(sub) { return found }
                }
                return nil
            }
            func makeSshSession(
                remoteKey: String,
                envId: String,
                hostLabel: String,
                state: String,
                email: String,
                name: String = "",
                tier: String = "PRO",
                matchedLocalAccountId: String? = nil,
                lastFocusedAt: Double = 100,
                observedAt: Double = 1000,
                windowCount: Int? = nil,
                lastError: String = "",
                geminiPct: Double? = 88.0
            ) -> [String: Any] {
                var groups: [[String: Any]] = []
                if let geminiPct {
                    groups.append([
                        "key": "gemini",
                        "displayName": "Gemini",
                        "summaryLabel": "Gemini",
                        "brands": ["gemini"],
                        "isStandalone": false,
                        "availability": "available",
                        "quotaState": "known",
                        "windows": [
                            ["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": geminiPct / 100.0, "stale": false, "resetCountdown": "3 小时后重置"],
                            ["id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.85, "stale": false, "resetCountdown": "5 天后重置"]
                        ]
                    ])
                }
                var row: [String: Any] = [
                    "remoteKey": remoteKey,
                    "environmentId": envId,
                    "hostLabel": hostLabel,
                    "state": state,
                    "email": email,
                    "name": name,
                    "subscription_tier": tier,
                    "matchedLocalAccountId": matchedLocalAccountId ?? NSNull(),
                    "lastFocusedAt": lastFocusedAt,
                    "observedAt": observedAt,
                    "quotaLastUpdated": nowTs,
                    "lastError": lastError,
                    "quotaGroups": groups
                ]
                if let windowCount {
                    row["windowCount"] = windowCount
                }
                return row
            }

            // 1. SshEnvironmentResolver 契约：同主机多窗口去重与窗口数累加、大小写无关匹配、未纳管宿主分离、同号判断
            let resolverSessions: [[String: Any]] = [
                makeSshSession(remoteKey: "rk-alpha-1", envId: "host:alpha", hostLabel: "alpha-gpu", state: "offline_recent", email: "old@example.invalid", lastFocusedAt: 500, observedAt: 5000),
                makeSshSession(remoteKey: "rk-alpha-2", envId: "host:alpha", hostLabel: "alpha-gpu", state: "connected", email: "Alice@Example.INVALID", lastFocusedAt: 200, observedAt: 2000),
                makeSshSession(remoteKey: "rk-alpha-3", envId: "host:alpha", hostLabel: "alpha-gpu", state: "connected", email: "Alice@Example.INVALID", lastFocusedAt: 400, observedAt: 4000),
                makeSshSession(remoteKey: "rk-beta", envId: "host:beta", hostLabel: "beta-box", state: "auth_expired", email: "unmanaged@example.invalid", lastFocusedAt: 900, observedAt: 9000),
                makeSshSession(remoteKey: "rk-gamma", envId: "host:gamma", hostLabel: "gamma-hist", state: "historical_only", email: "hist@example.invalid", lastFocusedAt: 999, observedAt: 9999)
            ]
            let aggregated = SshEnvironmentResolver.aggregateHosts(from: resolverSessions) { row in
                (row["environmentId"] as? String) ?? ""
            }
            check(aggregated.count == 3, "SshEnvironmentResolver.aggregateHosts must deduplicate same-environmentId windows (got \(aggregated.count))")
            check(aggregated[0].environmentId == "host:alpha" && aggregated[0].windowCount == 2 && aggregated[0].primaryRemoteKey == "rk-alpha-3", "aggregateHosts must rank online host first, win by lastFocusedAt, and sum active windowCount (got id=\(aggregated[0].environmentId), win=\(aggregated[0].windowCount), key=\(aggregated[0].primaryRemoteKey))")
            check(aggregated[1].environmentId == "host:beta" && aggregated[1].state == .authExpired, "aggregateHosts must rank authExpired before historicalOnly")
            check(aggregated[2].environmentId == "host:gamma" && aggregated[2].state == .historicalOnly && aggregated[2].windowCount == 0, "aggregateHosts historicalOnly must have 0 active windows")

            let localAccs: [[String: Any]] = [
                ["id": "acc-alice", "email": "alice@example.invalid"],
                ["id": "acc-bob", "email": "bob@example.invalid"]
            ]
            let matchedAlice = SshEnvironmentResolver.matchingHosts(forAccount: localAccs[0], hosts: aggregated)
            check(matchedAlice.count == 1 && matchedAlice[0].environmentId == "host:alpha", "matchingHosts must match email case-insensitively")
            let idOnlyMatch = SshEnvironmentResolver.matchingHosts(forAccount: ["id": "acc-id-match", "email": "other@example.invalid"], hosts: [
                SshEnvironmentResolver.aggregateHosts(from: [
                    makeSshSession(remoteKey: "rk-id", envId: "host:id", hostLabel: "id-box", state: "connected", email: "diff@example.invalid", matchedLocalAccountId: "acc-id-match")
                ]) { ($0["environmentId"] as? String) ?? "" }[0]
            ])
            check(idOnlyMatch.count == 1, "matchingHosts must match via matchedLocalAccountId")
            let unmanaged = SshEnvironmentResolver.unmanagedHosts(accounts: localAccs, hosts: aggregated)
            check(unmanaged.count == 1 && unmanaged[0].environmentId == "host:beta", "unmanagedHosts must exclude matched local accounts and historicalOnly hosts (got \(unmanaged.map(\.environmentId)))")
            check(SshEnvironmentResolver.isSameAccountAsLocal(host: aggregated[0], localEmail: "alice@example.invalid") == true, "isSameAccountAsLocal must compare case-insensitively")
            check(SshEnvironmentResolver.isSameAccountAsLocal(host: aggregated[1], localEmail: "alice@example.invalid") == false, "isSameAccountAsLocal must return false for different email")
            check(SshEnvironmentResolver.isSameAccountAsLocal(host: aggregated[1], localEmail: "") == nil, "isSameAccountAsLocal must return nil when localEmail is empty")

            // 1.5 SshTerminalIcon 缓存一致性 & DesignPopUpCell.fitsSelectedTitleOnly 宽度契约
            let icon12a = SshTerminalIcon.image(pointSize: 12.5)
            let icon12b = SshTerminalIcon.image(pointSize: 12.5)
            let icon12Rounded = SshTerminalIcon.image(pointSize: 12.4)
            let icon16 = SshTerminalIcon.image(pointSize: 16.0)
            check(icon12a === icon12b && icon12a === icon12Rounded, "SshTerminalIcon.image(pointSize:) must return cached identical NSImage instance for matching 0.5pt keys")
            check(icon12a !== icon16 && icon12a.isTemplate && icon16.isTemplate, "SshTerminalIcon.image(pointSize:) must cache distinct template instances across pointSizes")

            let fitPopup = NSPopUpButton(frame: .zero, pullsDown: false)
            fitPopup.addItems(withTitles: [
                "本机",
                "very-long-remote-cluster-hostname-01.us-west.internal.example.com"
            ])
            fitPopup.selectItem(at: 0)
            Design.applyControls(fitPopup)
            let fullAllOptionsWidth = Design.fittedPopUpWidth(fitPopup)
            if let fitCell = fitPopup.cell as? DesignPopUpCell {
                fitCell.fitsSelectedTitleOnly = true
                let selectedOnlyNoIconWidth = Design.fittedPopUpWidth(fitPopup)
                let cellSizeNoIcon = fitCell.cellSize(forBounds: NSRect(x: 0, y: 0, width: 400, height: 28))
                check(selectedOnlyNoIconWidth < fullAllOptionsWidth - 120, "DesignPopUpCell.fitsSelectedTitleOnly must yield significantly narrower fitted width than longest option (got selected=\(selectedOnlyNoIconWidth), full=\(fullAllOptionsWidth))")
                check(cellSizeNoIcon.width < fullAllOptionsWidth - 120, "DesignPopUpCell.cellSize(forBounds:) must also shrink to selected title when fitsSelectedTitleOnly is true (got \(cellSizeNoIcon.width))")
                fitCell.leadingImage = icon12a
                let selectedOnlyWithIconWidth = Design.fittedPopUpWidth(fitPopup)
                let cellSizeWithIcon = fitCell.cellSize(forBounds: NSRect(x: 0, y: 0, width: 400, height: 28))
                check(selectedOnlyWithIconWidth >= selectedOnlyNoIconWidth, "Design.fittedPopUpWidth must account for leadingImage width")
                check(cellSizeWithIcon.width >= cellSizeNoIcon.width, "DesignPopUpCell.cellSize must account for leadingImage width")
            } else {
                check(false, "Design.applyControls must install DesignPopUpCell on fitPopup")
            }

            // 2. EnvironmentPickerControl 0 / 1 / 2 台主机自适应切换与分组菜单
            let picker = EnvironmentPickerControl(includeAll: true, compact: true, maxSegmentedRemoteCount: 1, maxSegmentedWidth: 320)
            picker.frame = NSRect(x: 0, y: 0, width: 320, height: 28)
            var pickerSelected: [String] = []
            picker.onSelect = { pickerSelected.append($0) }
            picker.update(options: [
                .init(id: "all", hostLabel: "总计", kind: .all),
                .init(id: "local", hostLabel: "本机", kind: .local)
            ], selectedId: "all")
            check(picker.isHidden == true, "EnvironmentPickerControl with 0 SSH hosts must be hidden")

            picker.update(options: [
                .init(id: "all", hostLabel: "总计", kind: .all),
                .init(id: "local", hostLabel: "本机", kind: .local),
                .init(id: "host:alpha", hostLabel: "alpha-gpu", kind: .ssh, state: .online, windowCount: 2)
            ], selectedId: "all")
            check(!picker.isHidden && !picker.isUsingPopUp && !picker.segmentedControl.isHidden && picker.popUpButton.isHidden, "EnvironmentPickerControl with 1 SSH host must use segmentedControl")
            check(picker.segmentedControl.segmentCount == 3, "EnvironmentPickerControl 1-host segmentedControl must have 3 segments")

            picker.update(options: [
                .init(id: "all", hostLabel: "总计", kind: .all),
                .init(id: "local", hostLabel: "本机", kind: .local),
                .init(id: "host:alpha", hostLabel: "alpha-gpu", kind: .ssh, state: .online, windowCount: 2),
                .init(id: "host:beta", hostLabel: "beta-box", kind: .ssh, state: .offlineRecent, windowCount: 0)
            ], selectedId: "host:alpha")
            check(!picker.isHidden && picker.isUsingPopUp && picker.segmentedControl.isHidden && !picker.popUpButton.isHidden, "EnvironmentPickerControl with >=2 SSH hosts must auto-switch to grouped popUpButton")
            let popupTitles = picker.popUpButton.menu?.items.map(\.title) ?? []
            check(popupTitles.contains(L10n.t("ssh.picker.group.online", fallback: "在线 SSH")) && popupTitles.contains(L10n.t("ssh.picker.group.offline", fallback: "离线 / 历史 SSH")), "Grouped popUpButton must render online and offline section headers: \(popupTitles)")
            check(popupTitles.contains { $0.contains("alpha-gpu") && $0.contains("(2)") }, "Grouped popUpButton must show multi-window count for alpha-gpu: \(popupTitles)")
            picker.popUpButton.selectItem(at: 0)
            if let action = picker.popUpButton.action {
                NSApp.sendAction(action, to: picker.popUpButton.target, from: picker.popUpButton)
            }
            check(pickerSelected.last == "all", "EnvironmentPickerControl popUp selection must invoke onSelect")

            // 2.5 EnvironmentContextPill, EnvironmentScope, SshEnvironmentVisuals, SshHostTagBadge(showStatusDot:), QuotaFreshness, and fuseAccountQuota contracts
            let ctxPill = EnvironmentContextPill(compact: true, minWidth: 72, maxWidth: 154, height: 24)
            var pillSelectedScopes: [EnvironmentScope] = []
            ctxPill.onSelectScope = { pillSelectedScopes.append($0) }
            ctxPill.update(items: [
                .init(scope: .all, hostLabel: "全部"),
                .init(scope: .local, hostLabel: "本机")
            ], selectedScope: .all)
            check(ctxPill.isHidden == true, "EnvironmentContextPill with 0 SSH items must be hidden")

            ctxPill.update(items: [
                .init(scope: .all, hostLabel: "全部"),
                .init(scope: .local, hostLabel: "本机"),
                .init(scope: .remote(environmentId: "ssh:very-long-cluster"), hostLabel: "SSH: very-long-cluster-hostname.us-west.internal.example.com", state: .online, windowCount: 2, email: "alice@example.invalid", secondaryText: "36%")
            ], selectedScope: .remote(environmentId: "ssh:very-long-cluster"))
            check(!ctxPill.isHidden && ctxPill.isActive && ctxPill.selectedScope == .remote(environmentId: "ssh:very-long-cluster"), "EnvironmentContextPill with SSH item must be visible and active")
            check(ctxPill.intrinsicContentSize.width <= 154.0, "EnvironmentContextPill intrinsic width must cap at maxWidth 154pt (got \(ctxPill.intrinsicContentSize.width))")
            let ctxMenuTitles = ctxPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(ctxMenuTitles.contains { $0.contains("very-long-cluster-hostname.us-west.internal.example.com") && $0.contains("36%") } && ctxMenuTitles.allSatisfy { !$0.contains("SSH:") }, "EnvironmentContextPill menu must strip SSH prefix and preserve full clean hostname + secondaryText: \(ctxMenuTitles)")

            check(SshEnvironmentVisuals.statusDotChar(for: .online) == "●" && SshEnvironmentVisuals.isStatusDotFilled(for: .online), "online state dot must be filled ●")
            check(SshEnvironmentVisuals.statusDotChar(for: .authExpired) == "●" && SshEnvironmentVisuals.isStatusDotFilled(for: .authExpired), "authExpired state dot must be filled ●")
            check(SshEnvironmentVisuals.statusDotChar(for: .offlineRecent) == "○" && !SshEnvironmentVisuals.isStatusDotFilled(for: .offlineRecent), "offlineRecent state dot must be hollow ○")
            check(SshEnvironmentVisuals.statusDotChar(for: .historicalOnly) == "○" && !SshEnvironmentVisuals.isStatusDotFilled(for: .historicalOnly), "historicalOnly state dot must be hollow ○")

            let tagWithDot = SshHostTagBadge(hostLabel: "SSH: alpha-node", state: .offlineRecent, showStatusDot: true)
            let tagWithoutDot = SshHostTagBadge(hostLabel: "SSH · alpha-node", state: .offlineRecent, scale: .compact, showStatusDot: false)
            check(tagWithDot.hostLabel == "alpha-node" && tagWithoutDot.hostLabel == "alpha-node", "SshHostTagBadge must strip SSH prefix")
            check(tagWithoutDot.showStatusDot == false && tagWithoutDot.intrinsicContentSize.width < tagWithDot.intrinsicContentSize.width, "SshHostTagBadge(showStatusDot: false) must omit dot width for historical rows")

            // 3. DashboardPage + AccountsPage + AssistantAccountUsage + MenuPanelController 集成契约
            let w3State = state.appendingPathComponent("wave3-ssh-contracts", isDirectory: true)
            try? FileManager.default.removeItem(at: w3State)
            let w3Host = Assistant(state: w3State)
            w3Host.configuration = try ConfigurationStore(state: w3State)
            w3Host.bridge = BackendBridge(resources: state, state: w3State)
            w3Host.reachable = true
            let w3Accounts: [[String: Any]] = [
                [
                    "id": "acc-a", "name": "Alice", "email": "alice@example.invalid", "subscription_tier": "PRO", "revision": "r-a",
                    "quota": ["last_updated": nowTs - 3600],
                    "quotaGroups": [["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.35, "stale": false, "resetCountdown": "4 小时后重置"]]]]
                ],
                [
                    "id": "acc-b", "name": "Bob", "email": "bob@example.invalid", "subscription_tier": "PRO", "revision": "r-b",
                    "quota": ["last_updated": nowTs],
                    "quotaGroups": [["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.70, "stale": false, "resetCountdown": "3 小时后重置"]]]]
                ]
            ]
            w3Host.cachedAccounts = w3Accounts
            w3Host.activeAccountId = "acc-a"
            w3Host.statusValue = LiveStatus([
                "mode": "connected",
                "running": true,
                "runningChannel": "stable",
                "activeAccountEmail": "alice@example.invalid",
                "liveAccountEmail": "alice@example.invalid",
                "accountsRevision": "r-w3"
            ])

            var w3Commands: [[String: Any]] = []
            let w3BaseAccount = w3Accounts[0].merging([
                "activeName": "Alice",
                "activeEmail": "alice@example.invalid",
                "activeTier": "PRO",
                "liveAccountEmail": "alice@example.invalid",
                "isLiveVerified": true
            ]) { _, new in new }
            let w3Usage: [String: Any] = [
                "selectedEnvironmentId": "all",
                "todayTokens": 5000, "totalTokens": 10000,
                "estimatedUsd": 0.05, "allTimeEstimatedUsd": 0.10,
                "requestCount": 2, "totalRequestCount": 5,
                "todayPricedModels": 1, "todayUnpricedModels": 0,
                "pricedModels": 1, "unpricedModels": 0,
                "databasesScanned": 1, "databasesDiscovered": 1,
                "availability": "complete",
                "todayByModel": [["model": "gemini-3.8-flash-n", "totalTokens": 5000, "requestCount": 2, "estimatedUsd": 0.05, "priced": true]]
            ]
            w3Host.bridge.fixtureReply = { payload in
                w3Commands.append(payload)
                let cmd = payload["command"] as? String ?? ""
                switch cmd {
                case "account_list":
                    return ["ok": true, "activeId": "acc-a", "currentAccountId": "acc-a", "accounts": w3Accounts, "pendingSwitch": false]
                case "auto_switch_get":
                    return ["ok": true, "config": ["enabled": false, "strategy": "priority", "monitored_model": "all"]]
                case "dashboard_summary":
                    let envId = (payload["environmentId"] as? String) ?? "all"
                    var usg = w3Usage
                    usg["selectedEnvironmentId"] = envId
                    return ["ok": true, "accounts": w3BaseAccount, "usage": usg, "remoteSessions": w3Host.remoteSessions, "focusedContextKey": w3Host.statusValue.focusedContextKey]
                case "quota_refresh_start":
                    return ["ok": true, "taskId": "w3-task-1"]
                case "remote_quota_refresh":
                    return ["ok": true, "remoteObservedVersion": w3Host.statusValue.remoteObservedVersion + 1, "focusedContextKey": w3Host.statusValue.focusedContextKey, "remoteSessions": w3Host.remoteSessions]
                case "account_switch_preflight":
                    return ["ok": true, "safe": true, "appRunning": true, "stableRunning": true, "hasRunningTask": false, "activeSshWindowsCount": 1, "activeSshHosts": ["bob-host-1"]]
                default:
                    return ["ok": true]
                }
            }

            autoreleasepool {
            let w3Win = makeHeadlessHostWindow(width: 960, height: 680)
            w3Host.window = w3Win
            let w3Overview = DashboardPage(app: w3Host)
            w3Host.overview = w3Overview
            let w3AccountsPage = AccountsPage(app: w3Host)
            w3Host.accountsPage = w3AccountsPage
            let w3Menu = w3Host.ensureMenuPanelController()
            let w3MenuWin = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            w3MenuWin.contentViewController = w3Menu
            w3Menu.panelWillOpen()
            defer {
                w3Host.failPendingQuotaRefresh("", cancelBackendTask: false)
                w3Host.bridge.fixtureReply = nil
                w3Host.accountsPage = nil
                w3Host.overview = nil
                w3Host.menuPanelController = nil
                w3Host.window = nil
                w3Win.contentView = nil
                w3Win.orderOut(nil)
                w3MenuWin.contentViewController = nil
                w3MenuWin.orderOut(nil)
            }

            w3Win.contentView = w3Overview.view
            w3Overview.renderSummary(["ok": true, "accounts": w3BaseAccount, "usage": w3Usage, "remoteSessions": [], "focusedContextKey": "local"], isStaleFallback: false)
            w3AccountsPage.fetch(["accounts": w3Accounts, "activeId": "acc-a", "pendingSwitch": false])
            pump()

            // A. 无 SSH 基线：四端全隐藏、无残留 tooltip
            check(w3Overview.contextPill.isHidden && w3Overview.contextMetaLabel.isHidden && w3Overview.heroRemoteHostBadge.isHidden && w3Overview.companionMoreButton.isHidden, "Wave3: Pure-local Overview must hide contextPill, contextMetaLabel, heroRemoteHostBadge, and companionMoreButton")
            check(w3AccountsPage.localSectionHeaderRow.isHidden && w3AccountsPage.remoteSectionStack.isHidden && w3AccountsPage.cardsStack.arrangedSubviews.count == 2, "Wave3: Pure-local AccountsPage must hide localSectionHeaderRow and remoteSectionStack")
            check(!visibleTextValues(w3AccountsPage.cardsStack).contains(L10n.t("ssh.presence.active_locally", fallback: "本机使用中")), "Wave3: Pure-local AccountsPage must hide 本机使用中 badge when no SSH exists")
            check(firstEmptyTooltipViolation(w3AccountsPage.view) == nil, "Wave3: Pure-local AccountsPage must have zero static tooltips")
            check(w3Menu.contextPill.isHidden && w3Menu.headerContextDivider.isHidden && w3Menu.accountsLocalOnlyNoteLabel.isHidden && w3Menu.accountsRemoteSectionStack.isHidden, "Wave3: Pure-local MenuPanel must hide contextPill, divider, local-only note, and remote section")
            check(firstEmptyTooltipViolation(w3Menu.view) == nil, "Wave3: Pure-local MenuPanel must have zero static tooltips (found: \(firstEmptyTooltipViolation(w3Menu.view) ?? ""))")

            // B. 同号健康场景 A：总览顶栏挂载 EnvironmentContextPill，伴生区展示「查看」按钮；点击进入远端视角，选「全部」恢复
            let sceneASessions = [
                makeSshSession(remoteKey: "rk-same-1", envId: "host:same-a", hostLabel: "same-a", state: "connected", email: "Alice@Example.INVALID", matchedLocalAccountId: "acc-a", lastFocusedAt: 300, geminiPct: 92)
            ]
            w3Host.syncRemoteSessionsFromPayload(sceneASessions, focusedKey: "remote:rk-same-1")
            pump()
            w3Win.contentView?.layoutSubtreeIfNeeded()
            check(!w3Overview.contextPill.isHidden && w3Overview.contextPill.selectedScope == .all && !w3Overview.contextPill.isActive, "Wave3 Scene A: Overview must show unscoped EnvironmentContextPill")
            if let heroBox = findEnclosingBox(w3Overview.refreshQuotaButton) {
                let heroTexts = visibleTextValues(heroBox)
                check(heroTexts.contains("same-a") && heroTexts.contains("查看"), "Wave3 Scene A: Overview default state must show companion row with clean same-a and 查看 even for healthy same-account SSH (got \(heroTexts))")
                let viewBtn = collectViews(heroBox, as: NSButton.self).first { $0.title == "查看" }
                viewBtn?.performClick(nil)
                pump()
                w3Win.contentView?.layoutSubtreeIfNeeded()
                check(w3Host.overviewEnvironmentKey == "env:host:same-a" && !w3Overview.heroRemoteHostBadge.isHidden && w3Overview.heroRemoteHostBadge.label.stringValue == "same-a", "Wave3 Scene A: Clicking 查看 must enter remote view for host:same-a with heroRemoteHostBadge")
                check(!visibleTextValues(heroBox).contains("查看"), "Wave3 Scene A: Remote view must hide companion 查看 rows")
                if let allItem = w3Overview.contextPill.buildMenu().items.first(where: { ($0.representedObject as? String) == "all" }),
                   let action = allItem.action {
                    NSApp.sendAction(action, to: allItem.target, from: allItem)
                    pump()
                } else {
                    check(false, "Wave3 Scene A: Overview contextPill menu must include all item")
                    w3Host.selectOverviewEnvironment("all")
                    pump()
                }
                w3Win.contentView?.layoutSubtreeIfNeeded()
                check(w3Host.overviewEnvironmentKey == "all" && w3Overview.heroRemoteHostBadge.isHidden && visibleTextValues(heroBox).contains("查看"), "Wave3 Scene A: Selecting 全部 in Overview contextPill must restore default overview with companion rows")
            } else {
                check(false, "Wave3 Scene A: Overview must locate hero box")
            }

            // C. 菜单栏 424pt 顶栏 EnvironmentContextPill 在单主机/中主机名/超长主机名下恒定 <=154pt、[刷新]/[···] 恒定原位、跟随焦点页脚、以及重连换端口保留锁定
            w3Menu.selectTab(1, persist: false)
            pump()
            w3MenuWin.contentView?.layoutSubtreeIfNeeded()
            let w3RefreshBaseX = w3Menu.headerRefreshButton.frame.minX
            let w3MoreBaseX = w3Menu.moreButton.frame.minX
            check(!w3Menu.contextPill.isHidden && !w3Menu.headerContextDivider.isHidden && w3Menu.contextPill.isActive && w3Menu.contextPill.selectedScope == .remote(environmentId: "host:same-a"), "Wave3: MenuPanel Tab 1 with focused SSH host must activate contextPill")
            check(w3Menu.contextPill.frame.width <= 154.5, "Wave3: MenuPanel Tab 1 contextPill width must stay <= 154pt (got \(w3Menu.contextPill.frame.width))")
            check(w3Menu.quotaStatusBadge.isHidden, "Wave3: MenuPanel Tab 1 must hide redundant quotaStatusBadge when contextPill shows SSH host")
            check(w3Menu.quotaFooterLabel.stringValue.contains(L10n.t("menu_panel.ssh.following_focus_footer", fallback: "跟随当前窗口")), "Wave3: MenuPanel Tab 1 footer must show 跟随当前窗口 when auto-following focused SSH window (got \(w3Menu.quotaFooterLabel.stringValue))")
            check(!w3Menu.headerRefreshButton.isHidden && w3Menu.headerRefreshButton.alphaValue == 1.0 && w3Menu.headerRefreshButton.isEnabled && abs(w3Menu.headerRefreshButton.frame.minX - w3RefreshBaseX) <= 0.5, "Wave3: headerRefreshButton must remain fixed, enabled, and opaque")
            check(!w3Menu.moreButton.isHidden && w3Menu.moreButton.alphaValue == 1.0 && w3Menu.moreButton.isEnabled && abs(w3Menu.moreButton.frame.minX - w3MoreBaseX) <= 0.5, "Wave3: moreButton must remain fixed, enabled, and opaque")

            // 手动切换后清除「跟随当前窗口」
            w3Host.setActiveNodeScope(.remote(environmentId: "host:same-a"), userInitiated: true)
            pump()
            check(!w3Menu.quotaFooterLabel.stringValue.contains(L10n.t("menu_panel.ssh.following_focus_footer", fallback: "跟随当前窗口")), "Wave3: MenuPanel Tab 1 must clear 跟随当前窗口 after user manually pins host")

            // 后端 SSOT `environments` 下发 + 重连换端口（primaryRemoteKey 变化但 environmentId 不变）保留 activeNodeScope 锁定
            let reconnectEnvV1: [[String: Any]] = [
                ["environmentId": "local", "kind": "local", "hostLabel": "本机", "lifecycleState": "online", "focused": true],
                ["environmentId": "host:port-lock", "kind": "ssh", "hostLabel": "port-lock-node", "primaryRemoteKey": "127.0.0.1:9101", "lifecycleState": "online", "windowCount": 1, "focused": false, "accountEmail": "remote-port@example.invalid", "lastQuotaObservedAt": nowTs - 10]
            ]
            w3Host.syncEnvironmentsFromPayload(["environments": reconnectEnvV1, "environmentsRevision": 10, "focusedEnvironmentId": "local"], notifyUI: true)
            w3Host.setActiveNodeScope(.remote(environmentId: "host:port-lock"), userInitiated: true)
            pump()
            check(w3Host.activeNodeScope == .remote(environmentId: "host:port-lock") && w3Host.selectedContextKey == "remote:127.0.0.1:9101", "Wave3: Locking host:port-lock must track initial primaryRemoteKey")
            let reconnectEnvV2: [[String: Any]] = [
                ["environmentId": "local", "kind": "local", "hostLabel": "本机", "lifecycleState": "online", "focused": true],
                ["environmentId": "host:port-lock", "kind": "ssh", "hostLabel": "port-lock-node", "primaryRemoteKey": "127.0.0.1:9202", "lifecycleState": "online", "windowCount": 1, "focused": false, "accountEmail": "remote-port@example.invalid", "lastQuotaObservedAt": nowTs]
            ]
            w3Host.syncEnvironmentsFromPayload(["environments": reconnectEnvV2, "environmentsRevision": 11, "focusedEnvironmentId": "local"], notifyUI: true)
            pump()
            check(w3Host.activeNodeScope == .remote(environmentId: "host:port-lock") && w3Host.selectedContextKey == "remote:127.0.0.1:9202", "Wave3: Reconnecting on a new SSH port must preserve activeNodeScope lock by environmentId")

            // 中等 & 超宽单主机名：424pt 顶栏恒定防挤压/防偏移
            for (envId, hostName) in [("host:med-a", "alpha-node-01"), ("host:ultra-a", "alpha-cluster-node01-01-very-long.internal")] {
                w3Host.syncRemoteSessionsFromPayload([
                    makeSshSession(remoteKey: "rk-\(envId)", envId: envId, hostLabel: hostName, state: "connected", email: "Alice@Example.INVALID", matchedLocalAccountId: "acc-a", lastFocusedAt: 300, geminiPct: 90)
                ], focusedKey: "local")
                w3Menu.selectTab(0, persist: false)
                pump()
                w3MenuWin.contentView?.layoutSubtreeIfNeeded()
                check(!w3Menu.contextPill.isHidden && w3Menu.contextPill.frame.width <= 154.5, "Wave3: contextPill for \(hostName) must stay <= 154pt (got \(w3Menu.contextPill.frame.width))")
                check(w3Menu.contextPill.frame.maxX <= w3Menu.headerRefreshButton.frame.minX + 0.5, "Wave3: contextPill for \(hostName) must not overlap headerRefreshButton")
                check(abs(w3Menu.headerRefreshButton.frame.minX - w3RefreshBaseX) <= 0.5 && w3Menu.headerRefreshButton.alphaValue == 1.0 && w3Menu.headerRefreshButton.isEnabled, "Wave3: headerRefreshButton must remain fixed and enabled for \(hostName)")
                check(abs(w3Menu.moreButton.frame.minX - w3MoreBaseX) <= 0.5 && w3Menu.moreButton.alphaValue == 1.0 && w3Menu.moreButton.isEnabled, "Wave3: moreButton must remain fixed and enabled for \(hostName)")
            }

            // D. 场景 B + >=2 台主机 + 多窗口去重 + 伴生区 +3 可点菜单 + 同号配额融合 + 3+ 台远端折叠 + 菜单栏 Tab 0/1/2 对称联动 + 历史主机回退
            let sceneBSessions = [
                makeSshSession(remoteKey: "rk-alice-w1", envId: "host:alice-dev", hostLabel: "alice-dev", state: "connected", email: "ALICE@example.invalid", matchedLocalAccountId: "acc-a", lastFocusedAt: 200, observedAt: (nowTs - 10) * 1000.0, geminiPct: 85),
                makeSshSession(remoteKey: "rk-alice-w2", envId: "host:alice-dev", hostLabel: "alice-dev", state: "connected", email: "ALICE@example.invalid", matchedLocalAccountId: "acc-a", lastFocusedAt: 400, observedAt: (nowTs - 20) * 1000.0, geminiPct: 85),
                makeSshSession(remoteKey: "rk-bob-1", envId: "host:bob-1", hostLabel: "bob-1", state: "connected", email: "bob@example.invalid", matchedLocalAccountId: "acc-b", lastFocusedAt: 350, geminiPct: 80),
                makeSshSession(remoteKey: "rk-bob-2", envId: "host:bob-2", hostLabel: "bob-2", state: "connected", email: "bob@example.invalid", matchedLocalAccountId: "acc-b", lastFocusedAt: 340, geminiPct: 75),
                makeSshSession(remoteKey: "rk-bob-3", envId: "host:bob-3", hostLabel: "bob-3", state: "offline_recent", email: "bob@example.invalid", matchedLocalAccountId: "acc-b", lastFocusedAt: 100, geminiPct: 60),
                makeSshSession(remoteKey: "rk-unmanaged-1", envId: "host:gpu-err", hostLabel: "gpu-err", state: "auth_expired", email: "guest1@example.invalid", name: "Guest1", tier: "ULTRA", matchedLocalAccountId: nil, lastFocusedAt: 900, windowCount: 2, geminiPct: 15),
                makeSshSession(remoteKey: "rk-unmanaged-2", envId: "host:gpu-extra-1", hostLabel: "gpu-extra-1", state: "connected", email: "guest2@example.invalid", name: "Guest2", tier: "PRO", matchedLocalAccountId: nil, lastFocusedAt: 800, windowCount: 1, geminiPct: 62),
                makeSshSession(remoteKey: "rk-unmanaged-3", envId: "host:gpu-extra-2", hostLabel: "gpu-extra-2", state: "offline_recent", email: "guest3@example.invalid", name: "Guest3", tier: "PRO", matchedLocalAccountId: nil, lastFocusedAt: 700, windowCount: 1, geminiPct: 48)
            ]
            w3Host.syncRemoteSessionsFromPayload(sceneBSessions, focusedKey: "local")
            pump()
            w3Win.contentView?.layoutSubtreeIfNeeded()
            check(firstEmptyTooltipViolation(w3Overview.view) == nil, "Wave3 Scene B: Overview with active SSH hosts must have zero hover tooltips (found: \(firstEmptyTooltipViolation(w3Overview.view) ?? ""))")
            check(firstEmptyTooltipViolation(w3AccountsPage.view) == nil, "Wave3 Scene B: AccountsPage with active SSH hosts and remote cards must have zero hover tooltips (found: \(firstEmptyTooltipViolation(w3AccountsPage.view) ?? ""))")
            for tabIdx in 0...2 {
                w3Menu.selectTab(tabIdx, persist: false)
                pump()
                check(firstEmptyTooltipViolation(w3Menu.view) == nil, "Wave3 Scene B: MenuPanel tab \(tabIdx) with active SSH hosts must have zero hover tooltips (found: \(firstEmptyTooltipViolation(w3Menu.view) ?? ""))")
            }

            // 总览：顶栏挂载 EnvironmentContextPill，伴生区显示最多 2 行 + 可点击 "+5 台主机" 菜单按钮，点击「查看」进入远端视角
            check(!w3Overview.contextPill.isHidden, "Wave3 Scene B: Overview must display contextPill")
            check(!w3Overview.companionMoreButton.isHidden && w3Overview.companionMoreButton.isEnabled && w3Overview.companionMoreButton.title == "+5 台主机" && w3Overview.companionMoreButton.image != nil && w3Overview.companionMoreButton.target != nil && w3Overview.companionMoreButton.action != nil, "Wave3 Scene B: Overview companionMoreButton must be clickable with +5 台主机 and chevron icon (got title=\(w3Overview.companionMoreButton.title))")
            if let heroBox = findEnclosingBox(w3Overview.refreshQuotaButton) {
                let viewBtns = collectViews(heroBox, as: NSButton.self).filter { $0.title == "查看" }
                check(viewBtns.count == 2, "Wave3 Scene B: Overview companion section must show at most 2 jump buttons (got \(viewBtns.count))")
                viewBtns.first?.performClick(nil)
                pump()
                w3Win.contentView?.layoutSubtreeIfNeeded()
                check(w3Host.overviewEnvironmentKey.hasPrefix("env:"), "Wave3 Scene B: Clicking companion 查看 must jump Overview to target SSH env (got \(w3Host.overviewEnvironmentKey))")
                if w3Host.overviewEnvironmentKey == "env:host:gpu-err" {
                    check(!w3Overview.heroRemoteHostBadge.isHidden && w3Overview.heroRemoteHostBadge.label.stringValue == "gpu-err", "Wave3 Scene B: Multi-window SSH host heroRemoteHostBadge must show gpu-err")
                    check(w3Overview.contextMetaLabel.stringValue.contains("2 窗口"), "Wave3 Scene B: Multi-window SSH host contextMetaLabel must show 2 窗口 (got \(w3Overview.contextMetaLabel.stringValue))")
                }
                w3Host.selectOverviewEnvironment("all")
                pump()
                check(w3Host.overviewEnvironmentKey == "all", "Wave3 Scene B: Returning to all must reset Overview to all")
            }

            // 账号页：本机分区头 + 本机使用中微标 + 同号跨机配额新鲜度融合(85% + 同步自 alice-dev) + 去重复「远程只读」 + 3+ 台远端第 3 台默认折叠
            check(!w3AccountsPage.localSectionHeaderRow.isHidden && w3AccountsPage.localSectionTitleLabel.stringValue == "本机已保存账号" && w3AccountsPage.localSectionMetaLabel.stringValue.contains("仅作用于本机"), "Wave3: AccountsPage must show localSectionHeaderRow with local-only hint")
            check(w3AccountsPage.cardsStack.arrangedSubviews.count == 2, "Wave3: AccountsPage cardsStack must only hold local accounts")
            let accStackTexts = visibleTextValues(w3AccountsPage.cardsStack)
            check(accStackTexts.contains(L10n.t("ssh.presence.active_locally", fallback: "本机使用中")), "Wave3: AccountsPage active card must display 本机使用中 micro badge when SSH hosts exist (got \(accStackTexts))")
            check(accStackTexts.contains { $0.contains("同步自 alice-dev") }, "Wave3: Alice card must fuse fresher remote quota and display 同步自 alice-dev (got \(accStackTexts))")
            if let aliceCardView = w3AccountsPage.cardsStack.arrangedSubviews.first {
                let aliceQuotaBars = collectViews(aliceCardView, as: QuotaBarView.self)
                let aliceQuotaText = aliceQuotaBars.map { "\($0.titleLabel.stringValue):\($0.percentage)" }
                check(aliceQuotaBars.contains { $0.percentage == 85 }, "Wave3: Alice card must display fused fresher remote quota 85% instead of stale local 35% (got \(aliceQuotaText))")
            }
            let localCardHostBadges = collectViews(w3AccountsPage.cardsStack, as: SshHostTagBadge.self).filter { !$0.isHidden }
            check(localCardHostBadges.count == 2 && localCardHostBadges.allSatisfy { $0.scale == .regular && $0.intrinsicContentSize.height == 19.0 }, "Wave3: AccountsPage local cards must render regular SshHostTagBadge (19pt height)")
            check(localCardHostBadges.contains { $0.label.stringValue == "alice-dev" }, "Wave3: Alice card SshHostTagBadge must display clean alice-dev without SSH prefix: \(localCardHostBadges.map(\.label.stringValue))")
            check(localCardHostBadges.contains { $0.label.stringValue == "bob-1 +2" }, "Wave3: Bob card SshHostTagBadge must collapse 3 SSH hosts to bob-1 +2: \(localCardHostBadges.map(\.label.stringValue))")

            check(!w3AccountsPage.remoteSectionStack.isHidden && w3AccountsPage.remoteCardsStack.arrangedSubviews.count == 3, "Wave3: AccountsPage must show 3 unmanaged remote cards in remoteSectionStack")
            check(w3AccountsPage.remoteSectionMetaLabel.stringValue.contains(L10n.t("accounts.ssh.remote_section_readonly_note", fallback: "仅只读查看")), "Wave3: AccountsPage remoteSectionMetaLabel must disclose 仅只读查看 (got \(w3AccountsPage.remoteSectionMetaLabel.stringValue))")
            let remoteBadges = collectViews(w3AccountsPage.remoteCardsStack, as: SshHostTagBadge.self).filter { !$0.isHidden }
            check(remoteBadges.count == 3 && remoteBadges.allSatisfy { $0.scale == .regular }, "Wave3: Unmanaged remote cards must render regular SshHostTagBadge")
            let remoteTexts = visibleTextValues(w3AccountsPage.remoteCardsStack)
            check(!remoteTexts.contains(L10n.t("ssh.context.remote_readonly_badge", fallback: "远程只读")), "Wave3: Unmanaged remote cards must NOT repeat 远程只读 pill")
            check(remoteTexts.contains { $0.contains("2 个窗口") }, "Wave3: Unmanaged remote card with windowCount=2 must show 2 个窗口")
            check(!remoteTexts.contains(L10n.t("accounts.switch_btn")), "Wave3: Unmanaged remote card must NOT expose switch button")

            // 第 3 台未保存远端默认单行折叠，点击展开后记忆展开态
            check(!w3AccountsPage.collapsedRemoteEnvIds.contains("host:gpu-err") && !w3AccountsPage.collapsedRemoteEnvIds.contains("host:gpu-extra-1") && w3AccountsPage.collapsedRemoteEnvIds.contains("host:gpu-extra-2"), "Wave3: 3+ unmanaged remote cards must expand first 2 and collapse 3rd by default (got \(w3AccountsPage.collapsedRemoteEnvIds))")
            if w3AccountsPage.remoteCardsStack.arrangedSubviews.count >= 3 {
                let thirdCard = w3AccountsPage.remoteCardsStack.arrangedSubviews[2]
                let thirdRefreshBtn = collectViews(thirdCard, as: InlineRefreshButton.self).first
                check(thirdRefreshBtn?.isHidden == true, "Wave3: Collapsed 3rd remote card must hide singleRefreshBtn")
                check(visibleTextValues(thirdCard).contains { $0.contains("48%") }, "Wave3: Collapsed 3rd remote card must display inline quota summary 48% (got \(visibleTextValues(thirdCard)))")
                if let toggleBtn = collectViews(thirdCard, as: NSButton.self).first(where: { $0.identifier?.rawValue == "host:gpu-extra-2" }) {
                    toggleBtn.performClick(nil)
                    pump()
                    check(!w3AccountsPage.collapsedRemoteEnvIds.contains("host:gpu-extra-2") && thirdRefreshBtn?.isHidden == false, "Wave3: Clicking 3rd remote card collapse button must expand it and reveal refresh button")
                } else {
                    check(false, "Wave3: 3rd remote card must expose collapse button with identifier host:gpu-extra-2")
                }
            }

            w3Commands.removeAll()
            if let remoteRefreshBtn = collectViews(w3AccountsPage.remoteCardsStack.arrangedSubviews[1], as: InlineRefreshButton.self).first {
                remoteRefreshBtn.performClick(nil)
                waitUntil(step: 0.01, description: "Wave3 single remote card refresh") {
                    !w3Host.remoteQuotaRefreshing && w3Commands.contains { ($0["command"] as? String) == "remote_quota_refresh" }
                }
                let remoteReq = w3Commands.last { ($0["command"] as? String) == "remote_quota_refresh" }
                check(remoteReq?["remoteKey"] as? String == "rk-unmanaged-1", "Wave3: Remote card refresh must pass host.primaryRemoteKey (got \(String(describing: remoteReq)))")
            } else {
                check(false, "Wave3: Unmanaged remote card gpu-err must mount InlineRefreshButton")
            }

            w3Commands.removeAll()
            w3AccountsPage.refreshAllQuotas()
            waitUntil(step: 0.01, description: "Wave3 refreshAllQuotas concurrent local + remote") {
                w3Commands.contains { ($0["command"] as? String) == "quota_refresh_start" }
                    && w3Commands.contains { ($0["command"] as? String) == "remote_quota_refresh" }
            }
            let allRemoteReq = w3Commands.last { ($0["command"] as? String) == "remote_quota_refresh" }
            check(allRemoteReq?["remoteKey"] == nil, "Wave3: refreshAllQuotasIncludingRemotes must trigger global remote_quota_refresh without single remoteKey")

            // 切号确认弹窗：目标账号被在线 SSH 占用时追加共享提示
            w3Host.confirmSwitchForTesting = nil
            w3Host.requestInteractiveAccountSwitch(id: "acc-b", email: "bob@example.invalid", name: "Bob")
            waitUntil(step: 0.01, description: "Wave3 shared switch confirmation sheet") {
                w3Win.attachedSheet != nil
            }
            if let sheetWin = w3Win.attachedSheet, let sheetContent = sheetWin.contentView {
                let sheetTexts = allTextValues(sheetContent).joined(separator: "\n")
                check(sheetTexts.contains("bob-1") && sheetTexts.contains("不会修改远端登录态"), "Wave3: Switch confirmation alert must append shared SSH usage note (got: \(sheetTexts))")
                w3Win.endSheet(sheetWin, returnCode: .alertSecondButtonReturn)
                waitForSheetDetach(on: w3Win, description: "Wave3 shared switch confirmation sheet detach")
            }

            // 菜单栏：多主机顶栏 EnvironmentContextPill 分组菜单 + Tab 0 <-> Tab 1 对称联动 + 历史主机回退 + Tab 2 隐藏顶栏 Pill / 同号融合 / 跳转行 & +N台按钮跳 Tab 1
            w3Menu.selectTab(0, persist: false); pump()
            check(!w3Menu.contextPill.isHidden && !w3Menu.headerContextDivider.isHidden && w3Menu.contextPill.frame.width <= 154.5, "Wave3: MenuPanel Tab 0 with 8 SSH hosts must show contextPill <= 154pt")
            let multiOverflowTitles = w3Menu.contextPill.buildMenu().items.map { $0.attributedTitle?.string ?? $0.title }
            check(multiOverflowTitles.contains(L10n.t("ssh.picker.group.online", fallback: "在线 SSH")) && multiOverflowTitles.contains(L10n.t("ssh.picker.group.offline", fallback: "离线 / 历史 SSH")), "Wave3: Multi-host MenuPanel contextPill NSMenu must contain online and offline group headers: \(multiOverflowTitles)")
            check(multiOverflowTitles.allSatisfy { !$0.contains("SSH:") && !$0.contains("SSH ·") }, "Wave3: Multi-host MenuPanel contextPill NSMenu must strip SSH prefix: \(multiOverflowTitles)")

            // Tab 0 选 gpu-err -> 切到 Tab 1 自动同步 host:gpu-err
            w3Menu.selectUsageEnvironment("host:gpu-err", persist: false); pump()
            w3Menu.selectTab(1, persist: false); pump()
            check(w3Host.selectedMenuQuotaHost()?.environmentId == "host:gpu-err", "Wave3: Switching from Tab 0 (host:gpu-err) to Tab 1 must sync quota host to host:gpu-err (got \(w3Host.selectedMenuQuotaHost()?.environmentId ?? "nil"))")
            check(w3Menu.quotaFooterLabel.stringValue.contains("2 个窗口"), "Wave3: MenuPanel Tab 1 must show multi-window count in footer (got \(w3Menu.quotaFooterLabel.stringValue))")

            // Tab 1 选 host:alice-dev -> 切到 Tab 0 同步 selectedEnvironmentId；Tab 1 切回 local -> Tab 0 对称切回 local
            w3Host.selectMenuQuotaHost("host:alice-dev", userInitiated: true); pump()
            w3Menu.selectTab(0, persist: false); pump()
            check(w3Menu.selectedEnvironmentId == "host:alice-dev", "Wave3: Switching from Tab 1 (pinned host:alice-dev) to Tab 0 must sync selectedEnvironmentId to host:alice-dev (got \(w3Menu.selectedEnvironmentId))")
            w3Menu.selectTab(1, persist: false); pump()
            w3Host.setActiveNodeScope(.local, userInitiated: true); pump()
            w3Menu.selectTab(0, persist: false); pump()
            check(w3Menu.selectedEnvironmentId == "local", "Wave3: Switching from Tab 1 (pinned local) to Tab 0 must symmetrically sync selectedEnvironmentId to local (got \(w3Menu.selectedEnvironmentId))")

            // Tab 0 切回 all -> 切到 Tab 1 回落本机
            w3Menu.selectUsageEnvironment("all", persist: false); pump()
            w3Menu.selectTab(1, persist: false); pump()
            check(w3Host.selectedMenuQuotaHost() == nil && w3Host.selectedContextKey == "local", "Wave3: Switching from Tab 0 (all) to Tab 1 must fall back to local when focusedContextKey is local (got \(w3Host.selectedContextKey))")

            // Tab 0 选中 historical_only 主机 -> 切到 Tab 1 安全回退到本机并展示 fallback 提示
            w3Menu.selectTab(0, persist: false); pump()
            w3Host.setUsageFilterScope(.remote(environmentId: "host:hist-legacy"), persist: false, syncOverview: false, syncUsagePage: false, syncMenuPanel: true)
            pump()
            w3Menu.selectTab(1, persist: false); pump()
            check(w3Host.activeNodeScope == .local && !w3Menu.quotaWarningLabel.isHidden && w3Menu.quotaWarningLabel.stringValue.contains(L10n.t("usage.env.historical_fallback_notice", fallback: "历史主机暂无实时配额，已切回本机配额。")), "Wave3: Switching from Tab 0 (historical_only) to Tab 1 must fall back to local with historical_fallback_notice (got \(w3Menu.quotaWarningLabel.stringValue))")

            // Tab 2：顶栏隐藏 Pill 与竖线 + 同号融合配额(85%) + 本机当前微标 + SshHostTagBadge(.compact) + 前 2 台跳转行 + 第 3 台 accountsRemoteMoreHostsButton 可达
            w3Menu.selectTab(2, persist: false); pump()
            check(w3Menu.contextPill.isHidden && w3Menu.headerContextDivider.isHidden, "Wave3: MenuPanel Tab 2 must hide top bar contextPill and headerContextDivider")
            check(!w3Menu.accountsLocalOnlyNoteLabel.isHidden && w3Menu.accountsLocalOnlyNoteLabel.stringValue == "· 切换仅作用于本机", "Wave3: MenuPanel Tab 2 must show compact single-line local-only note")
            let menuCards = w3Menu.accountsCardsStack.arrangedSubviews.compactMap { $0 as? MenuExpandableAccountCardView }
            let menuAlice = menuCards.first { $0.accountId == "acc-a" }
            let menuBob = menuCards.first { $0.accountId == "acc-b" }
            check(menuAlice?.sshPresenceBadge.isHidden == false && menuAlice?.sshPresenceBadge.scale == .compact && menuAlice?.sshPresenceBadge.title == "alice-dev", "Wave3: MenuPanel Tab 2 Alice card must show compact SshHostTagBadge alice-dev (got \(menuAlice?.sshPresenceBadge.title ?? "nil"))")
            check(menuAlice.map { visibleTextValues($0).contains { $0.contains("85%") } } == true, "Wave3: MenuPanel Tab 2 Alice card must show fused fresher remote quota 85%")
            check(menuAlice.map { visibleTextValues($0).contains(L10n.t("ssh.presence.current_local", fallback: "本机当前")) } == true, "Wave3: MenuPanel Tab 2 active card must show 本机当前 badge")
            check(menuBob?.sshPresenceBadge.isHidden == false && menuBob?.sshPresenceBadge.scale == .compact && menuBob?.sshPresenceBadge.title == "bob-1 +2", "Wave3: MenuPanel Tab 2 Bob card must collapse 3 active/offlineRecent SSH hosts to bob-1 +2 (got \(menuBob?.sshPresenceBadge.title ?? "nil"))")

            check(!w3Menu.accountsRemoteSectionStack.isHidden, "Wave3: MenuPanel Tab 2 must show accountsRemoteSectionStack for unmanaged hosts")
            let jumpRows = collectViews(w3Menu.accountsRemoteSectionStack, as: MenuRemoteHostJumpRow.self)
            check(jumpRows.count == 2 && jumpRows.map(\.environmentId) == ["host:gpu-extra-1", "host:gpu-err"], "Wave3: MenuPanel Tab 2 must render 2 MenuRemoteHostJumpRow items sorted by state priority (got \(jumpRows.map(\.environmentId)))")
            check(!w3Menu.accountsRemoteMoreHostsButton.isHidden && w3Menu.accountsRemoteMoreHostsButton.title.contains("+1"), "Wave3: MenuPanel Tab 2 must render accountsRemoteMoreHostsButton for 3rd+ unmanaged host (got \(w3Menu.accountsRemoteMoreHostsButton.title))")
            let moreHostsMenu = w3Menu.accountsRemoteMoreHostsButton.buildMenu()
            if let extraItem = moreHostsMenu.items.first(where: { ($0.representedObject as? String) == "host:gpu-extra-2" }),
               let action = extraItem.action {
                NSApp.sendAction(action, to: extraItem.target, from: extraItem)
                pump()
                check(w3Menu.selectedTab == 1 && w3Host.selectedMenuQuotaHost()?.environmentId == "host:gpu-extra-2", "Wave3: Selecting 3rd+ unmanaged host from accountsRemoteMoreHostsButton must jump to Tab 1 and select host:gpu-extra-2")
            } else {
                check(false, "Wave3: accountsRemoteMoreHostsButton menu must include 3rd unmanaged host host:gpu-extra-2")
            }

            w3Menu.selectTab(2, persist: false); pump()
            let jumpRowsAfter = collectViews(w3Menu.accountsRemoteSectionStack, as: MenuRemoteHostJumpRow.self)
            if let gpuErrJump = jumpRowsAfter.first(where: { $0.environmentId == "host:gpu-err" }),
               let jumpBtn = collectViews(gpuErrJump, as: NSButton.self).first {
                jumpBtn.performClick(nil); pump()
                check(w3Menu.selectedTab == 1 && w3Host.selectedMenuQuotaHost()?.environmentId == "host:gpu-err", "Wave3: Clicking MenuRemoteHostJumpRow must jump to Tab 1 and select host:gpu-err")
            } else {
                check(false, "Wave3: MenuPanel Tab 2 must expose MenuRemoteHostJumpRow button for host:gpu-err after returning from Tab 1")
            }

            // 断开全部 SSH 后恢复单机干净状态（无残留控件、无残留 tooltip）
            w3Host.syncRemoteSessionsFromPayload([], focusedKey: "local")
            pump()
            w3Win.contentView?.layoutSubtreeIfNeeded()
            check(w3Overview.contextPill.isHidden && w3Overview.contextMetaLabel.isHidden && w3Overview.heroRemoteHostBadge.isHidden && w3Overview.companionMoreButton.isHidden, "Wave3: Disconnecting all SSH must hide Overview contextPill, meta, and badges")
            if let heroBox = findEnclosingBox(w3Overview.refreshQuotaButton) {
                check(!visibleTextValues(heroBox).contains("查看"), "Wave3: Disconnecting all SSH must hide Overview companion rows")
            }
            check(w3AccountsPage.localSectionHeaderRow.isHidden && w3AccountsPage.remoteSectionStack.isHidden, "Wave3: Disconnecting all SSH must hide AccountsPage local section header and remote section")
            check(!visibleTextValues(w3AccountsPage.cardsStack).contains(L10n.t("ssh.presence.active_locally", fallback: "本机使用中")), "Wave3: Disconnecting all SSH must hide 本机使用中 badge")
            check(firstEmptyTooltipViolation(w3AccountsPage.view) == nil, "Wave3: Disconnecting all SSH must leave zero static tooltips on AccountsPage")
            check(w3Menu.contextPill.isHidden && w3Menu.headerContextDivider.isHidden && w3Menu.accountsLocalOnlyNoteLabel.isHidden && w3Menu.accountsRemoteSectionStack.isHidden, "Wave3: Disconnecting all SSH must hide MenuPanel SSH controls")
            check(firstEmptyTooltipViolation(w3Menu.view) == nil, "Wave3: Disconnecting all SSH must leave zero static tooltips on MenuPanel (found: \(firstEmptyTooltipViolation(w3Menu.view) ?? ""))")
            }
            pump()
        }

        // P1-4 & P0-1 回归验证：菜单栏配额页 SSH 主机「打开总览页」同步环境 + 缓存合成总览不误用今日值填充累计字段
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let p14State = state.appendingPathComponent("p14-p01-contracts", isDirectory: true)
            try? FileManager.default.removeItem(at: p14State)
            let p14Host = Assistant(state: p14State)
            p14Host.configuration = try ConfigurationStore(state: p14State)
            p14Host.bridge = BackendBridge(resources: state, state: p14State)
            p14Host.reachable = true
            p14Host.cachedAccounts = accounts
            p14Host.activeAccountId = "a"
            p14Host.statusValue = LiveStatus([
                "mode": "connected",
                "running": true,
                "runningChannel": "stable",
                "activeAccountEmail": "alex@example.invalid",
                "liveAccountEmail": "alex@example.invalid",
                "accountsRevision": "r-p14"
            ])
            let remoteSession: [String: Any] = [
                "remoteKey": "rk-p14",
                "environmentId": "host:p14-gpu",
                "hostLabel": "p14-gpu",
                "state": "connected",
                "email": "remote-p14@example.invalid",
                "name": "RemoteGPU",
                "tier": "PRO",
                "quotaGroups": [
                    ["key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known", "windows": [["id": "5h", "period": "5h", "label": "5 小时", "known": true, "remaining": 0.72, "stale": false, "resetCountdown": "2 小时后重置"]]]
                ]
            ]
            p14Host.syncRemoteSessionsFromPayload([remoteSession], focusedKey: "local", notifyUI: false)
            p14Host.cachedUsageReportsByPeriod["today|env=host:p14-gpu|acc=all"] = [
                "ok": true,
                "period": "today",
                "summary": [
                    "totalTokens": 6000,
                    "estimatedUsd": 0.08,
                    "requestCount": 3,
                    "pricedModels": 1,
                    "unpricedModels": 0,
                    "databasesScanned": 1,
                    "databasesDiscovered": 1,
                    "availability": "complete"
                ],
                "byModel": [["model": "gemini-3.8-flash-n", "totalTokens": 6000, "requestCount": 3, "estimatedUsd": 0.08, "priced": true]],
                "todayHourly": []
            ]
            p14Host.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                if cmd == "dashboard_summary" {
                    // Return usageError when explicitly queried later only if needed; for synchronous synthetic check we assert before async update arrives
                    return [
                        "ok": true,
                        "accounts": accounts[0].merging(["activeName": "Alex", "activeEmail": "alex@example.invalid", "activeTier": "PRO", "isLiveVerified": true]) { _, n in n },
                        "usageError": "simulated pending",
                        "remoteSessions": p14Host.remoteSessions,
                        "focusedContextKey": "local"
                    ]
                }
                return ["ok": true]
            }

            // 1. P1-4: 菜单栏配额 Tab 选中 SSH 主机，点击「打开总览页 ↗」后 overviewEnvironmentKey 应切至 env:host:p14-gpu（即使 overview 尚未创建）
            autoreleasepool {
            let p14Menu = p14Host.ensureMenuPanelController()
            let p14MenuWin = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            p14MenuWin.contentViewController = p14Menu
            p14Menu.panelWillOpen()
            defer {
                p14Host.bridge.fixtureReply = nil
                p14Host.accountsPage = nil
                p14Host.overview = nil
                p14Host.menuPanelController = nil
                p14Host.window?.orderOut(nil)
                p14Host.window = nil
                p14MenuWin.contentViewController = nil
                p14MenuWin.orderOut(nil)
            }
            p14Menu.selectTab(1, persist: false)
            p14Host.selectMenuQuotaHost("host:p14-gpu", userInitiated: true)
            pump()
            check(p14Menu.openMainBtn.title == L10n.t("menu_panel.footer.open_overview", fallback: "打开总览页 ↗"), "P1-4: Quota tab footer button must show 打开总览页 ↗")
            p14Menu.openMainBtn.performClick(nil)
            check(p14Host.overviewEnvironmentKey == "env:host:p14-gpu", "P1-4: Clicking 打开总览页 from Quota tab with SSH host selected must set overviewEnvironmentKey to env:host:p14-gpu (got \(p14Host.overviewEnvironmentKey))")
            check(p14Host.currentPage == 0, "P1-4: Clicking 打开总览页 must switch main window to Overview page 0")

            // 2. P0-1: 仅有 today 缓存而无 all 缓存时，syntheticSummaryFromUsageCache 不得将今日值填入累计字段
            let p14Overview = p14Host.overview ?? DashboardPage(app: p14Host)
            p14Host.overview = p14Overview
            p14Overview.handleOverviewEnvironmentChanged()
            check(p14Overview.todayTokensMetric.stringValue == "6K", "P0-1: Synthetic cache fallback must still render today tokens (6K, got \(p14Overview.todayTokensMetric.stringValue))")
            check(p14Overview.usageMetric.stringValue == "$0.08", "P0-1: Synthetic cache fallback must still render today cost ($0.08, got \(p14Overview.usageMetric.stringValue))")
            check(p14Overview.todayRequestsMetric.stringValue == "3", "P0-1: Synthetic cache fallback must still render today requests (3, got \(p14Overview.todayRequestsMetric.stringValue))")
            check(p14Overview.todayTokensDetail.stringValue == "累计 — Token" && !p14Overview.todayTokensDetail.stringValue.contains("6K"), "P0-1: Missing all-time cache must show pending '累计 — Token' instead of today's 6K (got \(p14Overview.todayTokensDetail.stringValue))")
            check(p14Overview.usageDetail.stringValue == "累计 —" && !p14Overview.usageDetail.stringValue.contains("0.08"), "P0-1: Missing all-time cache must show pending '累计 —' instead of today's $0.08 (got \(p14Overview.usageDetail.stringValue))")
            check(p14Overview.todayRequestsDetail.stringValue == "累计 — 次" && !p14Overview.todayRequestsDetail.stringValue.contains("3"), "P0-1: Missing all-time cache must show pending '累计 — 次' instead of today's 3 (got \(p14Overview.todayRequestsDetail.stringValue))")

            // 3. P0-1: 补充真实 all 缓存后（且验证 max(total, today)），应正确渲染真实累计数值
            p14Host.cachedUsageReportsByPeriod["all|env=host:p14-gpu|acc=all"] = [
                "ok": true,
                "period": "all",
                "summary": [
                    "totalTokens": 120000,
                    "estimatedUsd": 1.50,
                    "requestCount": 2, // intentionally < today(3) to test max(total, today)
                    "pricedModels": 1,
                    "unpricedModels": 0
                ]
            ]
            p14Overview.handleOverviewEnvironmentChanged()
            check(p14Overview.todayTokensDetail.stringValue == "累计 120K Token", "P0-1: With all-time cache present, total tokens detail must show 累计 120K Token (got \(p14Overview.todayTokensDetail.stringValue))")
            check(p14Overview.usageDetail.stringValue == "累计 $1.50", "P0-1: With all-time cache present, total cost detail must show 累计 $1.50 (got \(p14Overview.usageDetail.stringValue))")
            check(p14Overview.todayRequestsDetail.stringValue == "累计 3 次", "P0-1: Total requests must clamp to max(total, today) = 3 (got \(p14Overview.todayRequestsDetail.stringValue))")

            // 4. P1-4: 存在 SSH 时切回本机配额再点「打开总览页 ↗」应沿用本机视角（carryLocalToOverview=true）；断开 SSH 后自动回落 all
            p14Host.setActiveNodeScope(.local, userInitiated: true)
            p14Menu.openMainBtn.performClick(nil)
            check(p14Host.overviewEnvironmentKey == "local", "P1-4: Clicking 打开总览页 from Quota tab with local selected while SSH exists must carry local scope to Overview (got \(p14Host.overviewEnvironmentKey))")
            p14Host.syncRemoteSessionsFromPayload([], focusedKey: "local")
            check(p14Host.overviewEnvironmentKey == "all", "P1-4: Disconnecting SSH must reset Overview overviewEnvironmentKey back to all (got \(p14Host.overviewEnvironmentKey))")
            }
            pump()
        }

        // Wave 1 专项验收：EnvironmentContextPill 自绘胶囊/菜单保留、MenuFloatingPanel & First-Mouse、顶栏三控件显隐保活、以及 UsagePage/UsageLogController 单账号+未关联自动隐藏
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)

            // 1. EnvironmentContextPill .headerPill (26pt) vs .menuHeaderPill (24pt)、displayTitle 纯净度、菜单保留百分比和邮箱、selectItem(id:notify:) 与 buildMenu() 动作触发
            let headerPill = EnvironmentContextPill(style: .headerPill, compact: false, minWidth: 68, maxWidth: 168)
            let menuPill = EnvironmentContextPill(style: .menuHeaderPill, compact: true, minWidth: 68, maxWidth: 154)
            check(headerPill.style == .headerPill && headerPill.pillHeight == 26, "Wave1: headerPill default height must be 26pt (got \(headerPill.pillHeight))")
            check(menuPill.style == .menuHeaderPill && menuPill.pillHeight == 24, "Wave1: menuHeaderPill default height must be 24pt (got \(menuPill.pillHeight))")

            let pillItems: [EnvironmentContextPill.Item] = [
                EnvironmentContextPill.Item(scope: .all, hostLabel: "全部", secondaryText: "100%"),
                EnvironmentContextPill.Item(scope: .local, hostLabel: "本机", secondaryText: "64%"),
                EnvironmentContextPill.Item(
                    scope: .remote(environmentId: "ssh:gpu-node"),
                    hostLabel: "SSH · gpu-node-01",
                    state: .online,
                    windowCount: 2,
                    email: "alice@example.com",
                    secondaryText: "36%"
                )
            ]
            var scopeEvents: [EnvironmentScope] = []
            var idEvents: [String] = []
            menuPill.onSelectScope = { scopeEvents.append($0) }
            menuPill.onSelectId = { idEvents.append($0) }

            menuPill.update(items: pillItems, selectedScope: .all, isActive: false)
            check(menuPill.displayTitle == "全部" && !menuPill.displayTitle.contains("100%") && !menuPill.displayTitle.contains("●"), "Wave1: Selecting 全部 with secondaryText=100% must keep displayTitle == 全部 (got \(menuPill.displayTitle))")
            check(menuPill.triggerButton.itemKind == .all && menuPill.triggerButton.acceptsFirstMouse(for: nil), "Wave1: all-scope TriggerButton must use .all kind and acceptsFirstMouse")

            let builtMenu = menuPill.buildMenu()
            let builtTitles = builtMenu.items.map { $0.attributedTitle?.string ?? $0.title }
            check(builtTitles.contains { $0.contains("全部") && $0.contains("100%") }, "Wave1: buildMenu() must retain 100% secondary text for 全部: \(builtTitles)")
            check(builtTitles.contains { $0.contains("gpu-node-01") && $0.contains("alice@example.com") && $0.contains("36%") }, "Wave1: buildMenu() must retain email and 36% for SSH item: \(builtTitles)")

            if let sshMenuItem = builtMenu.items.first(where: { ($0.representedObject as? String) == "ssh:gpu-node" }),
               let action = sshMenuItem.action {
                NSApp.sendAction(action, to: sshMenuItem.target, from: sshMenuItem)
            } else {
                check(false, "Wave1: buildMenu() must expose actionable ssh:gpu-node menu item")
            }
            check(menuPill.selectedScope == .remote(environmentId: "ssh:gpu-node") && menuPill.isActive, "Wave1: buildMenu() item action must select ssh:gpu-node and activate pill")
            check(menuPill.displayTitle == "gpu-node-01" && !menuPill.displayTitle.contains("●") && !menuPill.displayTitle.contains("alice@example.com") && !menuPill.displayTitle.contains("36%"), "Wave1: SSH collapsed displayTitle must be pure hostname gpu-node-01 without dot/email/pct (got \(menuPill.displayTitle))")
            check(menuPill.triggerButton.itemKind == .ssh, "Wave1: SSH TriggerButton must have itemKind == .ssh")
            check(scopeEvents == [.remote(environmentId: "ssh:gpu-node")] && idEvents == ["ssh:gpu-node"], "Wave1: buildMenu() action must notify onSelectScope and onSelectId")

            check(menuPill.selectItem(id: "local", notify: false), "Wave1: selectItem(id: local, notify: false) must succeed")
            check(menuPill.selectedScope == .local && menuPill.displayTitle == "本机" && scopeEvents.count == 1 && idEvents.count == 1, "Wave1: selectItem(notify: false) must update displayTitle without firing callbacks")
            check(menuPill.selectItem(id: "all", notify: true), "Wave1: selectItem(id: all, notify: true) must succeed")
            check(menuPill.selectedScope == .all && !menuPill.isActive && menuPill.displayTitle == "全部" && scopeEvents.last == .all && idEvents.last == "all", "Wave1: selectItem(notify: true) must reset to all and fire callbacks")

            // 2. First-Mouse 全控件校验 + MenuFloatingPanel.worksWhenModal + 菜单栏顶栏三控件在 Tab 切换与显隐后全部 isEnabled == true && alphaValue == 1.0
            let testDesignBtn = DesignButton(title: "Test", target: nil, action: nil)
            let testSegTabs = MenuSegmentedTabsView(items: ["A", "B"], style: .primaryTabs, accessibilityLabel: "Wave1TestTabs")
            let segButtons = findButtons(testSegTabs).compactMap { $0 as? MenuSegmentedTabsView.SegmentItemButton }
            let testPlainBtn = MenuPlainClickButton(frame: .zero)
            check(testDesignBtn.acceptsFirstMouse(for: nil), "Wave1: DesignButton must return acceptsFirstMouse == true")
            check(!segButtons.isEmpty && segButtons.allSatisfy { $0.acceptsFirstMouse(for: nil) }, "Wave1: SegmentItemButton must return acceptsFirstMouse == true")
            check(testPlainBtn.acceptsFirstMouse(for: nil), "Wave1: MenuPlainClickButton must return acceptsFirstMouse == true")

            let w1Host = Assistant(state: state.appendingPathComponent("wave1-menu-topbar-audit"))
            w1Host.configuration = try ConfigurationStore(state: w1Host.state)
            w1Host.bridge = BackendBridge(resources: state, state: w1Host.state)
            w1Host.reachable = true
            w1Host.cachedAccounts = [
                ["id": "acc-1", "name": "User", "email": "user@example.invalid", "subscription_tier": "PRO"]
            ]
            w1Host.activeAccountId = "acc-1"
            w1Host.statusValue = LiveStatus(["mode": "connected", "running": true, "runningChannel": "stable", "remoteSyncRevision": 1])
            w1Host.cachedUsageReportsByPeriod["today"] = [
                "ok": true,
                "period": "today",
                "selectedEnvironmentId": "all",
                "selectedAccountId": "all",
                "availableEnvironments": [
                    ["id": "all", "kind": "all", "label": "全部", "online": true, "total_tokens": 2000],
                    ["id": "local", "kind": "local", "label": "本机", "online": true, "total_tokens": 1000],
                    ["id": "ssh:w1-host", "kind": "ssh", "label": "w1-host", "online": true, "total_tokens": 1000]
                ],
                "summary": ["availability": "complete", "totalTokens": 2000, "requestCount": 2, "estimatedUsd": 0.02],
                "byModel": []
            ]
            w1Host.syncRemoteSessionsFromPayload([
                [
                    "remoteKey": "rk-w1",
                    "environmentId": "ssh:w1-host",
                    "hostLabel": "w1-host",
                    "state": "connected",
                    "email": "user@example.invalid",
                    "matchedLocalAccountId": "acc-1",
                    "focused": true,
                    "quota": ["models": ["gemini": ["remaining": 90]]]
                ]
            ], focusedKey: "remote:rk-w1", notifyUI: false)

            let w1Ctrl = w1Host.ensureMenuPanelController()
            let w1Panel = w1Host.ensureMenuPanel(hosting: w1Ctrl)
            Assistant.configureHeadlessWindowIfNeeded(w1Panel)
            defer {
                w1Host.bridge.fixtureReply = nil
                w1Host.menuPanelController = nil
                w1Panel.contentView = nil
                w1Panel.orderOut(nil)
                w1Host.window?.orderOut(nil)
            }
            check(w1Panel.worksWhenModal, "Wave1: MenuFloatingPanel must set worksWhenModal == true")
            check(w1Ctrl.headerRefreshButton.acceptsFirstMouse(for: nil) && w1Ctrl.moreButton.acceptsFirstMouse(for: nil) && w1Ctrl.contextPill.triggerButton.acceptsFirstMouse(for: nil), "Wave1: MenuPanel top bar 3 controls must all accept first mouse")

            w1Ctrl.panelWillOpen()
            pump()
            for tab in [0, 2, 0, 1, 2, 0] {
                w1Ctrl.selectTab(tab, persist: false)
                pump()
                check(w1Ctrl.headerRefreshButton.isEnabled && w1Ctrl.headerRefreshButton.alphaValue == 1.0 && !w1Ctrl.headerRefreshButton.isHidden, "Wave1: Tab \(tab) must keep headerRefreshButton enabled and alphaValue == 1.0")
                check(w1Ctrl.moreButton.isEnabled && w1Ctrl.moreButton.alphaValue == 1.0 && !w1Ctrl.moreButton.isHidden, "Wave1: Tab \(tab) must keep moreButton enabled and alphaValue == 1.0")
                check(w1Ctrl.contextPill.isEnabled && w1Ctrl.contextPill.alphaValue == 1.0, "Wave1: Tab \(tab) must keep contextPill enabled and alphaValue == 1.0")
                if tab == 2 {
                    check(w1Ctrl.contextPill.isHidden, "Wave1: Tab 2 must hide contextPill without disabling it")
                } else {
                    check(!w1Ctrl.contextPill.isHidden, "Wave1: Tab \(tab) with SSH present must show contextPill")
                }
            }

            // 3. UsagePage 与 UsageLogController 在仅单真实账号且 unattributedRequests > 0 时自动隐藏 accountPopup，且彻底无未关联账号项
            let w1UsageHost = Assistant(state: state.appendingPathComponent("wave1-single-account-hide"))
            w1UsageHost.configuration = try ConfigurationStore(state: w1UsageHost.state)
            w1UsageHost.bridge = BackendBridge(resources: state, state: w1UsageHost.state)
            w1UsageHost.reachable = true
            w1UsageHost.cachedAccounts = [
                ["id": "acc-only", "name": "Only", "email": "only@example.invalid", "subscription_tier": "PRO"]
            ]
            w1UsageHost.usageSelectedAccount = "unattributed"
            w1UsageHost.statusValue = LiveStatus(["mode": "connected", "running": true, "runningChannel": "stable"])
            let w1UsageWin = makeHeadlessHostWindow(width: 900, height: 600)
            w1UsageHost.window = w1UsageWin
            defer {
                w1UsageHost.bridge.fixtureReply = nil
                w1UsageHost.window = nil
                w1UsageWin.orderOut(nil)
            }
            w1UsageHost.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String ?? ""
                let singleAccs: [[String: Any]] = [
                    ["id": "all", "email": "全部账号", "label": "全部账号", "total_tokens": 5000, "request_count": 2],
                    ["id": "acc-only", "email": "only@example.invalid", "label": "only@example.invalid", "total_tokens": 2000, "request_count": 1]
                ]
                let envs: [[String: Any]] = [
                    ["id": "all", "kind": "all", "label": "全部", "online": true, "total_tokens": 5000, "request_count": 2],
                    ["id": "local", "kind": "local", "label": "本机", "online": true, "total_tokens": 3000, "request_count": 1],
                    ["id": "ssh:only-ssh", "kind": "ssh", "label": "only-ssh", "online": true, "total_tokens": 2000, "request_count": 1]
                ]
                if cmd == "usage_summary" {
                    return [
                        "ok": true,
                        "period": "today",
                        "snapshotId": "w1-single-acc",
                        "selectedEnvironmentId": payload["environmentId"] as? String ?? "all",
                        "selectedAccountId": payload["accountId"] as? String ?? "all",
                        "unattributedRequests": 5,
                        "unattributedTokens": 3000,
                        "availableEnvironments": envs,
                        "availableAccounts": singleAccs,
                        "environmentBreakdown": ["local_tokens": 3000, "ssh_tokens": 2000, "local_share_pct": 60, "ssh_share_pct": 40, "has_ssh_data": true],
                        "summary": ["availability": "complete", "totalTokens": 5000, "requestCount": 2, "estimatedUsd": 0.05, "unattributedRequests": 5, "unattributedTokens": 3000],
                        "byModel": [],
                        "hourly": [],
                        "daily": []
                    ]
                }
                if cmd == "usage_events" {
                    return [
                        "ok": true,
                        "snapshot_id": "w1-single-ev",
                        "generated_at": Int(Date().timeIntervalSince1970),
                        "period": "today",
                        "selectedEnvironmentId": payload["environmentId"] as? String ?? "all",
                        "selectedAccountId": payload["accountId"] as? String ?? "all",
                        "total": 0,
                        "rows": [],
                        "availableEnvironments": envs,
                        "availableAccounts": singleAccs
                    ]
                }
                return ["ok": true]
            }

            let w1UsagePage = UsagePage(app: w1UsageHost)
            _ = w1UsagePage.view
            w1UsageHost.usagePage = w1UsagePage
            w1UsageWin.contentView = w1UsagePage.view
            w1UsagePage.update(force: true)
            waitUntil(step: 0.01, description: "Wave1 single-account UsagePage fetch") { !w1UsagePage.loading && !w1UsagePage.environmentPill.isHidden }
            check(w1UsagePage.selectedAccountId == "all" && w1UsageHost.usageSelectedAccount == "all", "Wave1: Legacy unattributed in UsagePage must normalize to all")
            let w1PageAccIds = (w1UsagePage.accountPopup.menu?.items ?? []).compactMap { $0.representedObject as? String }
            check(w1PageAccIds == ["all", "acc-only"] && !w1UsagePage.accountPopup.itemTitles.contains(L10n.t("usage.account.unattributed")), "Wave1: Single-account UsagePage accountPopup must only have all + real account without unattributed (got \(w1PageAccIds))")
            check(w1UsagePage.accountPopup.isHidden, "Wave1: UsagePage with only 1 real account must hide accountPopup even when unattributedRequests > 0")
            let w1PageCell = w1UsagePage.accountPopup.cell as? DesignPopUpCell
            check(w1PageCell?.visualStyle == .headerPill && w1PageCell?.customHeight == 26 && w1PageCell?.fitsSelectedTitleOnly == true, "Wave1: Single-account UsagePage accountPopup cell must still configure .headerPill 26pt fitsSelectedTitleOnly")

            let w1LogCtrl = UsageLogController(app: w1UsageHost, period: "today", environmentId: "all", accountId: "unattributed")
            w1LogCtrl.show(in: w1UsageWin) {}
            waitUntil(step: 0.01, description: "Wave1 single-account UsageLogController fetch") { !w1LogCtrl.loading }
            check(w1LogCtrl.selectedAccountId == "all", "Wave1: UsageLogController with accountId=unattributed must normalize to all")
            let w1LogAccIds = (w1LogCtrl.accountPopup.menu?.items ?? []).compactMap { $0.representedObject as? String }
            check(w1LogAccIds == ["all", "acc-only"] && !w1LogCtrl.accountPopup.itemTitles.contains(L10n.t("usage.account.unattributed")), "Wave1: Single-account UsageLogController accountPopup must exclude unattributed (got \(w1LogAccIds))")
            check(w1LogCtrl.accountPopup.isHidden, "Wave1: UsageLogController with only 1 real account must hide accountPopup even when unattributedRequests > 0")
            let w1LogCell = w1LogCtrl.accountPopup.cell as? DesignPopUpCell
            check(w1LogCell?.visualStyle == .headerPill && w1LogCell?.customHeight == 26 && w1LogCell?.fitsSelectedTitleOnly == true, "Wave1: Single-account UsageLogController accountPopup cell must configure .headerPill 26pt fitsSelectedTitleOnly")
            w1LogCtrl.closeSheet()
            waitForSheetDetach(on: w1UsageWin, description: "Wave1 single-account UsageLogController detach")
        }

        // 4. Online SSH standby account must never leak "切换后同步 / 切换后更新 / 预计已重置 · 切换后更新"
        do {
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let remoteQuotaGroups: [[String: Any]] = [[
                "key": "gemini", "displayName": "Gemini", "summaryLabel": "Gemini", "brands": ["gemini"], "isStandalone": false, "availability": "available", "quotaState": "known",
                "windows": [[
                    "id": "weekly", "period": "weekly", "label": "每周", "known": true, "remaining": 0.97, "stale": false,
                    "resetTime": ISO8601DateFormatter().string(from: Date().addingTimeInterval(-600)),
                    "resetCountdown": "已过"
                ]]
            ]]
            let equalStamp = Double(Int(Date().timeIntervalSince1970))
            let rawSshStandbyAccount: [String: Any] = [
                "id": "acc-ssh-standby",
                "name": "SSH Standby User",
                "email": "ssh-standby@example.invalid",
                "subscription_tier": "FREE",
                "quota_last_updated": equalStamp,
                "quota": ["last_updated": equalStamp],
                "quotaGroups": remoteQuotaGroups,
                "standbyRefreshStatus": ["mode": "snapshot_cooling"]
            ]
            let onlineSshHost = CanonicalHostEnvironment(
                environmentId: "ssh:remote-ssh-node",
                hostLabel: "SSH: remote-ssh-node",
                primaryRemoteKey: "rk-node",
                windowCount: 1,
                state: .online,
                email: "ssh-standby@example.invalid",
                name: "SSH Standby User",
                tier: "FREE",
                matchedLocalAccountId: "acc-ssh-standby",
                lastError: "",
                quotaLastUpdated: equalStamp,
                observedAt: equalStamp,
                lastFocusedAt: equalStamp,
                rawSession: ["quotaGroups": remoteQuotaGroups, "quota_last_updated": equalStamp, "quota": ["last_updated": equalStamp]],
                quotaFreshness: .fresh
            )
            let fusedTie = SshEnvironmentResolver.fuseAccountQuota(account: rawSshStandbyAccount, hosts: [onlineSshHost])
            check(fusedTie["standbyRefreshStatus"] == nil, "fuseAccountQuota tie-break with online SSH must strip standbyRefreshStatus")
            check((fusedTie["quotaSourceEnvironmentId"] as? String) == "ssh:remote-ssh-node", "fuseAccountQuota tie-break must attach remote quotaSourceEnvironmentId (got \(String(describing: fusedTie["quotaSourceEnvironmentId"])))")

            var contractWithActiveRemote = rawSshStandbyAccount
            contractWithActiveRemote["standbyRefreshStatus"] = ["mode": "snapshot_cooldown_elapsed"]
            contractWithActiveRemote["activeRemoteEnvIds"] = ["ssh:remote-ssh-node"]
            let suppressedContract = QuotaPresentation.contract(contractWithActiveRemote)
            check(suppressedContract.standbyMode == nil, "QuotaPresentation.contract with activeRemoteEnvIds must suppress standbyMode")
            let overdueResetText = suppressedContract.displayGroups.first?.windows.first?.effectiveResetText(at: Date(), compact: false) ?? ""
            check(!overdueResetText.contains("切换后更新") && !overdueResetText.contains("预计已重置"), "Overdue window on online SSH account must not show 预计已重置 · 切换后更新 (got \(overdueResetText))")

            let sshMenuCard = MenuExpandableAccountCardView(accountId: "acc-ssh-standby")
            sshMenuCard.apply(
                account: rawSshStandbyAccount,
                isCurrent: false,
                isLiveVerified: false,
                isRecommended: false,
                isExpanded: true,
                reachable: true,
                switchInFlight: false,
                globalBusy: false,
                singleBusy: false,
                singleError: nil,
                matchingSshHosts: [onlineSshHost],
                hasSshHosts: true
            )
            check(sshMenuCard.timestampLabel.stringValue.contains("同步自 remote-ssh-node"), "MenuExpandableAccountCardView for online SSH standby must display 同步自 remote-ssh-node (got \(sshMenuCard.timestampLabel.stringValue))")
            check(!sshMenuCard.timestampLabel.stringValue.contains("切换后同步") && !sshMenuCard.timestampLabel.stringValue.contains("切换后更新"), "MenuExpandableAccountCardView for online SSH standby must not show 切换后同步/更新 (got \(sshMenuCard.timestampLabel.stringValue))")

            let offlineMenuCard = MenuExpandableAccountCardView(accountId: "acc-ssh-standby")
            offlineMenuCard.apply(
                account: rawSshStandbyAccount,
                isCurrent: false,
                isLiveVerified: false,
                isRecommended: false,
                isExpanded: true,
                reachable: true,
                switchInFlight: false,
                globalBusy: false,
                singleBusy: false,
                singleError: nil,
                matchingSshHosts: [],
                hasSshHosts: true
            )
            check(offlineMenuCard.timestampLabel.stringValue.contains("切换后更新"), "MenuExpandableAccountCardView for truly offline standby must retain 切换后更新 (got \(offlineMenuCard.timestampLabel.stringValue))")
        }

        // MARK: - P0-1 & P0-6 Regression Guards (Breathing Pulse Reduce-Motion Safety & Proxy URL Redaction)
        do {
            // P0-1: startBreathingPulse must never infinitely recurse when animations are disabled or button has no window
            let detachedStatusBtn = NSButton(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
            detachedStatusBtn.alphaValue = 0.55
            assistant.triggerBreathingPulseForTesting(baseAlpha: 1.0, button: detachedStatusBtn)
            check(!assistant.isBreathing, "P0-1: startBreathingPulse must reset isBreathing when button has no window or animations are disabled")
            check(abs(detachedStatusBtn.alphaValue - 1.0) < 0.001, "P0-1: startBreathingPulse must restore baseAlpha on non-animated exit (got \(detachedStatusBtn.alphaValue))")

            let attachedStatusBtn = NSButton(frame: NSRect(x: 0, y: 0, width: 22, height: 22))
            attachedStatusBtn.alphaValue = 0.40
            window.contentView?.addSubview(attachedStatusBtn)
            defer { attachedStatusBtn.removeFromSuperview() }
            assistant.triggerBreathingPulseForTesting(baseAlpha: 0.85, button: attachedStatusBtn)
            check(!assistant.isBreathing, "P0-1: startBreathingPulse must not recurse when Design.shouldAnimate is false")
            check(abs(attachedStatusBtn.alphaValue - 0.85) < 0.001, "P0-1: attached button must restore baseAlpha when Design.shouldAnimate is false (got \(attachedStatusBtn.alphaValue))")

            // P0-6: Proxy URL redaction for UI display while preserving launchEnvironment credentials
            check(SystemProxyResolver.redactProxyUrl("http://127.0.0.1:7890") == "http://127.0.0.1:7890", "P0-6: credential-free HTTP proxy must remain unchanged")
            check(SystemProxyResolver.redactProxyUrl("https://proxy.local:8443") == "https://proxy.local:8443", "P0-6: credential-free HTTPS proxy must remain unchanged")
            check(SystemProxyResolver.redactProxyUrl("http://[::1]:7890") == "http://[::1]:7890", "P0-6: IPv6 credential-free proxy must remain unchanged")
            check(SystemProxyResolver.redactProxyUrl("http://alice:s3cr3t@127.0.0.1:7890") == "http://alice:[REDACTED]@127.0.0.1:7890", "P0-6: user:pass must redact password")
            check(SystemProxyResolver.redactProxyUrl("http://alice:p@ss:123@127.0.0.1:8080") == "http://alice:[REDACTED]@127.0.0.1:8080", "P0-6: password containing @ and : must redact cleanly")
            check(SystemProxyResolver.redactProxyUrl("http://tok_xyz@127.0.0.1:7890") == "http://[REDACTED]@127.0.0.1:7890", "P0-6: bare token userinfo must be redacted")
            check(SystemProxyResolver.redactProxyUrl("http://:secret@127.0.0.1:7890") == "http://[REDACTED]@127.0.0.1:7890", "P0-6: empty-user password must be redacted")
            check(SystemProxyResolver.redactProxyUrl("socks5://bob:pw@127.0.0.1:1080") == "socks5://bob:[REDACTED]@127.0.0.1:1080", "P0-6: socks5 credentials must be redacted")

            let emptySnap = SystemProxyResolver.readSystemProxySnapshot(rawSettings: [:])
            let credRes = SystemProxyResolver.resolve(mode: .manual, manualUrl: "http://alice:s3cr3t@127.0.0.1:7890", snapshot: emptySnap)
            if case .active(let httpUrl, let httpsUrl, _, let displayUrl) = credRes {
                check(httpUrl == "http://alice:s3cr3t@127.0.0.1:7890" && httpsUrl == "http://alice:s3cr3t@127.0.0.1:7890", "P0-6: launch URLs must preserve full credentials for env injection")
                check(displayUrl == "http://alice:[REDACTED]@127.0.0.1:7890" && !displayUrl.contains("s3cr3t"), "P0-6: displayUrl must redact password (got \(displayUrl))")
                let env = SystemProxyResolver.launchEnvironment(for: credRes)
                check(env["HTTP_PROXY"] == "http://alice:s3cr3t@127.0.0.1:7890" && env["HTTPS_PROXY"] == "http://alice:s3cr3t@127.0.0.1:7890", "P0-6: launchEnvironment must keep real credentials")
            } else {
                check(false, "P0-6: expected .active resolution for manual proxy with credentials (got \(credRes))")
            }

            let matchedState = SystemProxyResolver.classifyRunningProxyState(
                expectedHttp: "http://alice:s3cr3t@127.0.0.1:7890",
                expectedHttps: "http://alice:s3cr3t@127.0.0.1:7890",
                appEnv: ["HTTPS_PROXY": "http://alice:s3cr3t@127.0.0.1:7890"],
                languageServerEnvs: [["HTTPS_PROXY": "http://alice:s3cr3t@127.0.0.1:7890"]]
            )
            if case .matched(let activeUrl) = matchedState {
                check(activeUrl == "http://alice:[REDACTED]@127.0.0.1:7890" && !activeUrl.contains("s3cr3t"), "P0-6: .matched activeUrl must be redacted (got \(activeUrl))")
            } else {
                check(false, "P0-6: expected .matched state (got \(matchedState))")
            }

            let overrideState = SystemProxyResolver.classifyRunningProxyState(
                expectedHttp: "http://alice:s3cr3t@127.0.0.1:7890",
                expectedHttps: "http://alice:s3cr3t@127.0.0.1:7890",
                appEnv: ["HTTPS_PROXY": "http://alice:s3cr3t@127.0.0.1:7890"],
                languageServerEnvs: [["HTTPS_PROXY": "http://shelluser:shellpass@127.0.0.1:9999"]]
            )
            if case .overriddenByShell(let lsActualUrl, let appInjectedUrl, let expectedUrl) = overrideState {
                check(!lsActualUrl.contains("shellpass") && lsActualUrl.contains("[REDACTED]"), "P0-6: overriddenByShell lsActualUrl must be redacted (got \(lsActualUrl))")
                check(!appInjectedUrl.contains("s3cr3t") && appInjectedUrl.contains("[REDACTED]"), "P0-6: overriddenByShell appInjectedUrl must be redacted (got \(appInjectedUrl))")
                check(!expectedUrl.contains("s3cr3t") && expectedUrl.contains("[REDACTED]"), "P0-6: overriddenByShell expectedUrl must be redacted (got \(expectedUrl))")
            } else {
                check(false, "P0-6: expected .overriddenByShell state (got \(overrideState))")
            }
        }

        // MARK: - P1-16 ~ P1-29 Regression Guards (Menu Consistency, Focus Rings, Accessibility, Error States & Update State)
        do {
            // P1-16: Disabled / validation_blocked account card must disable stateButton and block clicks
            let disabledCard = MenuExpandableAccountCardView(accountId: "acc-disabled-p1")
            var triggeredDisabledSwitch = false
            disabledCard.onSwitchAccount = { _ in triggeredDisabledSwitch = true }
            disabledCard.apply(
                account: ["id": "acc-disabled-p1", "email": "disabled@example.invalid", "disabled": true],
                isCurrent: false,
                isLiveVerified: false,
                isRecommended: false,
                isExpanded: true,
                reachable: true,
                switchInFlight: false,
                globalBusy: false,
                singleBusy: false,
                singleError: nil
            )
            check(!disabledCard.stateButton.isEnabled && !disabledCard.switchButton.isEnabled, "P1-16: disabled account must disable both stateButton and switchButton")
            disabledCard.stateButton.performClick(nil)
            check(!triggeredDisabledSwitch, "P1-16: clicking stateButton on disabled account must not trigger switch")

            let blockedCard = MenuExpandableAccountCardView(accountId: "acc-blocked-p1")
            var triggeredBlockedSwitch = false
            blockedCard.onSwitchAccount = { _ in triggeredBlockedSwitch = true }
            blockedCard.apply(
                account: ["id": "acc-blocked-p1", "email": "blocked@example.invalid", "validation_blocked": true],
                isCurrent: false,
                isLiveVerified: false,
                isRecommended: false,
                isExpanded: true,
                reachable: true,
                switchInFlight: false,
                globalBusy: false,
                singleBusy: false,
                singleError: nil
            )
            check(!blockedCard.stateButton.isEnabled && !blockedCard.switchButton.isEnabled, "P1-16: validation_blocked account must disable both stateButton and switchButton")
            blockedCard.stateButton.performClick(nil)
            check(!triggeredBlockedSwitch, "P1-16: clicking stateButton on validation_blocked account must not trigger switch")

            // P1-17: Shared UsageMetricsPresentation contract (empty cache hit, folded unpriced cost, missing priced fallback)
            check(UsageMetricsPresentation.formatCacheHitRate(denom: 0, cacheHitRate: 0) == "—", "P1-17: zero-denominator cache hit rate must format as —")
            check(UsageMetricsPresentation.formatCacheHitRate(denom: 100, cacheHitRate: 42.5) == "42.5%", "P1-17: positive-denominator cache hit rate must format with 1 decimal")
            check(!UsageMetricsPresentation.isModelRowPriced(["model": "m1", "estimatedUsd": 0.0]), "P1-17: missing priced key with 0 USD must evaluate unpriced")
            check(UsageMetricsPresentation.isModelRowPriced(["model": "m1", "estimatedUsd": 1.25]), "P1-17: missing priced key with positive USD must evaluate priced")
            let foldedCost = UsageMetricsPresentation.evaluateCost(
                foldedModels: [["model": "m1", "priced": false, "estimatedUsd": 0.0]],
                pricedCount: 0,
                unpricedCount: 0,
                usd: 0.0
            )
            check(foldedCost.displayUnpricedCount == 1 && foldedCost.isAllUnpriced && !foldedCost.isPartialCost, "P1-17: evaluateCost must derive isAllUnpriced from folded models even when summary unpricedCount is 0")
            let zeroTotalUnpriced = UsageMetricsPresentation.evaluateCost(
                foldedModels: [],
                pricedCount: 0,
                unpricedCount: 1,
                usd: 0.0
            )
            check(zeroTotalUnpriced.isAllUnpriced && !zeroTotalUnpriced.isPartialCost, "P1-17: unpricedCount>0 with pricedCount==0 and usd==0 must be isAllUnpriced, not partial")

            // P1-19: MenuSegmentedTabsView VoiceOver children & MenuPanel focus rings
            let p19Tabs = MenuSegmentedTabsView(items: ["Usage", "Quota", "Accounts"], style: .primaryTabs, accessibilityLabel: "P19Tabs")
            check(!p19Tabs.isAccessibilityElement(), "P1-19: MenuSegmentedTabsView container must not block VoiceOver traversal of child buttons")
            let a11yChildren = p19Tabs.accessibilityChildren() ?? []
            check(a11yChildren.count == 3, "P1-19: MenuSegmentedTabsView accessibilityChildren must expose all 3 tab buttons (got \(a11yChildren.count))")
            check(disabledCard.headerButton.focusRingType == .exterior && disabledCard.stateButton.focusRingType == .exterior, "P1-19: account card headerButton and stateButton must use .exterior focus rings")

            // P1-24: DesignSwitch exterior focus ring inside bounds, NSPopUpButton single focus ring, custom button accessibilityPerformPress
            let p24Switch = DesignSwitch(frame: NSRect(x: 0, y: 0, width: 34, height: 20))
            check(p24Switch.focusRingType == .exterior, "P1-24: DesignSwitch must use .exterior focusRingType")
            check(p24Switch.bounds.contains(p24Switch.focusRingMaskBounds), "P1-24: DesignSwitch focusRingMaskBounds must stay within bounds (got \(p24Switch.focusRingMaskBounds))")

            let p24Popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 120, height: 28), pullsDown: false)
            p24Popup.addItems(withTitles: ["One", "Two"])
            Design.applyControls(p24Popup)
            check(p24Popup.focusRingType == .none && p24Popup.cell?.focusRingType == NSFocusRingType.none, "P1-24: Design.applyControls must disable system square focus ring on NSPopUpButton")

            final class P24PressTarget: NSObject {
                var pressed = false
                @objc func handlePress(_ sender: Any?) { pressed = true }
            }
            let pressTarget = P24PressTarget()
            let p24Card = MetricCardBox()
            p24Card.clickTarget = pressTarget
            p24Card.clickAction = #selector(P24PressTarget.handlePress(_:))
            check(p24Card.accessibilityPerformPress() && pressTarget.pressed, "P1-24: MetricCardBox.accessibilityPerformPress must forward click action")

            var groupActivated = false
            let p24Group = MaintenanceInteractiveGroup(content: NSView(), accessibilityLabel: "P24Group") { _ in
                groupActivated = true
            }
            check(p24Group.focusRingType == .exterior && p24Group.accessibilityPerformPress() && groupActivated, "P1-24: MaintenanceInteractiveGroup must support .exterior focus ring and accessibilityPerformPress")
            let p24InfoBtn = MaintenanceInfoButton(accessibilityLabel: "P24Info", target: pressTarget, action: #selector(P24PressTarget.handlePress(_:)))
            check(p24InfoBtn.focusRingType == .exterior, "P1-24: MaintenanceInfoButton must use .exterior focus ring")

            // P1-25: AccountsPage must keep error banner visible at top when cached accounts are non-empty
            let p25State = state.appendingPathComponent("p25-accounts-error", isDirectory: true)
            try? FileManager.default.removeItem(at: p25State)
            let p25Host = Assistant(state: p25State)
            p25Host.configuration = try ConfigurationStore(state: p25State)
            p25Host.bridge = BackendBridge(resources: state, state: p25State)
            p25Host.reachable = true
            var p25ShouldFail = false
            p25Host.bridge.fixtureReply = { payload in
                if (payload["command"] as? String) == "account_list" {
                    if p25ShouldFail {
                        return ["ok": false, "error": "Simulated read failure"]
                    }
                    return ["ok": true, "accounts": [["id": "acc-p25", "email": "cached@example.invalid", "name": "Cached"]], "activeId": "acc-p25", "currentAccountId": "acc-p25"]
                }
                return ["ok": true]
            }
            let p25Page = AccountsPage(app: p25Host)
            p25Page.fetch()
            pump(0.05)
            check(p25Page.cardsStack.arrangedSubviews.count == 1, "P1-25: initial cached account list must render 1 account card")
            p25ShouldFail = true
            p25Page.fetch()
            pump(0.05)
            check(p25Page.cardsStack.arrangedSubviews.count == 2, "P1-25: AccountsPage with cached accounts + read error must keep error card AND account card (got \(p25Page.cardsStack.arrangedSubviews.count))")
            if let firstCard = p25Page.cardsStack.arrangedSubviews.first {
                func collectLabels(_ v: NSView) -> [String] {
                    let own = (v as? NSTextField).map { [$0.stringValue] } ?? []
                    return own + v.subviews.flatMap { collectLabels($0) }
                }
                let errTexts = collectLabels(firstCard)
                check(errTexts.contains(where: { $0.contains("Simulated read failure") }), "P1-25: first card in cardsStack must display accountReadError (got \(errTexts))")
            }

            // P1-26: Silent checkForUpdates must preserve valid .readyToInstall state on failure
            let p26State = state.appendingPathComponent("p26-update-ready", isDirectory: true)
            try? FileManager.default.removeItem(at: p26State)
            try FileManager.default.createDirectory(at: p26State, withIntermediateDirectories: true)
            let p26Host = Assistant(state: p26State)
            p26Host.configuration = try ConfigurationStore(state: p26State)
            p26Host.bridge = BackendBridge(resources: state, state: p26State)
            let p26Mgr = AppUpdateManager(app: p26Host)
            let fakeDmg = p26State.appendingPathComponent("GravityBox-9.9.9-arm64.dmg")
            try Data("dmg".utf8).write(to: fakeDmg)
            let fakeRelease = AppReleaseInfo(
                version: "9.9.9",
                tagName: "v9.9.9",
                title: "GravityBox 9.9.9",
                changelog: "Test",
                publishedDate: "2026-11-22",
                htmlURL: AppUpdateManager.releasesPageURL,
                dmgURL: nil,
                sha256URL: nil
            )
            p26Mgr.simulateReadyToInstall(fakeRelease, dmgURL: fakeDmg)
            var sawCheckingState = false
            p26Mgr.onStateChanged = { [weak p26Mgr] in
                if let s = p26Mgr?.state, case .checking = s {
                    sawCheckingState = true
                }
            }
            p26Mgr.checkTransport = { _, completion in
                completion(nil, nil, NSError(domain: NSURLErrorDomain, code: NSURLErrorNotConnectedToInternet))
            }
            p26Mgr.checkForUpdates(silent: true)
            pump(0.05)
            check(!sawCheckingState, "P1-26: silent checkForUpdates must not transition to .checking when valid .readyToInstall is active")
            if case .readyToInstall(let rel, let dmg) = p26Mgr.state {
                check(rel.version == "9.9.9" && dmg.path == fakeDmg.path, "P1-26: silent failure must preserve .readyToInstall state")
            } else {
                check(false, "P1-26: expected .readyToInstall to be preserved after silent check failure (got \(p26Mgr.state))")
            }

            // MARK: - P2-10 ~ P2-16 Regression Guards (Dynamic a11y labels, ms timestamp normalization, Sidebar badge a11y)
            let dynBtn = button("初始标题", target: nil, action: #selector(Assistant.quit))
            check(dynBtn.accessibilityLabel() == "初始标题", "P2-10: DesignButton accessibilityLabel must reflect initial title")
            dynBtn.title = "动态更新标题"
            check(dynBtn.accessibilityLabel() == "动态更新标题", "P2-10: DesignButton accessibilityLabel must track dynamic title changes (got \(String(describing: dynBtn.accessibilityLabel())))")

            let sidebarUpdateBtn = SidebarLaunchButton(title: "安装更新", symbolName: "arrow.down.circle", isUpdatePrompt: true, target: nil, action: #selector(Assistant.quit))
            sidebarUpdateBtn.badgeText = "v1.2.0"
            check(sidebarUpdateBtn.accessibilityLabel()?.contains("v1.2.0") == true, "P2-10: SidebarLaunchButton accessibilityLabel must include badgeText (got \(String(describing: sidebarUpdateBtn.accessibilityLabel())))")

            let p212State = state.appendingPathComponent("p212-ms-stamp", isDirectory: true)
            try? FileManager.default.removeItem(at: p212State)
            let p212Host = Assistant(state: p212State)
            p212Host.configuration = try ConfigurationStore(state: p212State)
            p212Host.bridge = BackendBridge(resources: state, state: p212State)
            let nowSec = Date().timeIntervalSince1970
            p212Host.cachedAccounts = [[
                "id": "acc-ms",
                "email": "ms@example.invalid",
                "persisted_quota_last_updated": (nowSec - 120.0) * 1000.0
            ]]
            if let oldest = p212Host.oldestEnabledAccountQuotaTimestamp() {
                check(abs(oldest - (nowSec - 120.0)) < 2.0, "P2-12: oldestEnabledAccountQuotaTimestamp must normalize millisecond timestamps to seconds (got \(oldest))")
            } else {
                check(false, "P2-12: oldestEnabledAccountQuotaTimestamp must return normalized timestamp")
            }

            // MARK: - Batch D Regression Guards (#16, #21, #22, #23)
            // P1-16: Ultra 账号无模型证据时不得臆造 Argon/Carbon
            L10n.shared.setLanguage("zh-Hans", notify: false)
            let ultraNoEvidence: [String: Any] = ["id": "u1", "email": "ultra@example.invalid", "subscription_tier": "ULTRA", "models": []]
            let subAll = QuotaPresentation.monitoredScopeSubtitle(for: "all", activeAccount: ultraNoEvidence)
            let subGem = QuotaPresentation.monitoredScopeSubtitle(for: "gemini", activeAccount: ultraNoEvidence)
            check(!subAll.contains("Argon") && !subAll.contains("Carbon"), "P1-16: Ultra without model evidence must not claim Argon/Carbon (got \(subAll))")
            check(!subGem.contains("Argon") && !subGem.contains("Carbon"), "P1-16: Ultra gemini without model evidence must not claim Argon/Carbon (got \(subGem))")

            // P1-21 & P1-22: 菜单栏 cache-miss 清旧值 + 失败后冷却到期自动恢复 + Usage.swift 跨 scope 失败清旧值
            let batchDState = state.appendingPathComponent("batch-d-state", isDirectory: true)
            try? FileManager.default.removeItem(at: batchDState)
            let dHost = Assistant(state: batchDState)
            dHost.configuration = try ConfigurationStore(state: batchDState)
            dHost.bridge = BackendBridge(resources: state, state: batchDState)
            dHost.reachable = true
            var failUsageCall = false
            var dUsageCalls = 0
            var dAccountListCalls = 0
            dHost.bridge.fixtureReply = { payload in
                let cmd = payload["command"] as? String
                if cmd == "account_list" {
                    dAccountListCalls += 1
                    return ["ok": true, "activeId": "", "accounts": [], "pendingSwitch": false]
                }
                if cmd == "usage_summary" {
                    dUsageCalls += 1
                    if failUsageCall {
                        return ["ok": false, "error": "temporary rpc failure"]
                    }
                    let period = payload["period"] as? String ?? "today"
                    let envId = payload["environmentId"] as? String ?? "all"
                    let accId = payload["accountId"] as? String ?? "all"
                    return [
                        "ok": true,
                        "period": period,
                        "selectedEnvironmentId": envId,
                        "selectedAccountId": accId,
                        "snapshotId": "snap-\(period)-\(envId)-\(accId)",
                        "summary": [
                            "totalTokens": envId == "local" ? 1000 : 2000,
                            "promptTokens": 400,
                            "cachedTokens": envId == "local" ? 500 : 1500,
                            "candidatesTokens": 100,
                            "requestCount": envId == "local" ? 5 : 10,
                            "estimatedUsd": 0.5,
                            "pricedModels": 1,
                            "unpricedModels": 0,
                            "availability": "complete",
                        ],
                        "byModel": [["model": "gemini-3.8-flash-n", "totalTokens": envId == "local" ? 1000 : 2000, "requestCount": 5, "estimatedUsd": 0.5, "priced": true]],
                        "todayHourly": [],
                        "dailyTrends": [],
                    ]
                }
                return ["ok": true]
            }

            let dMenu = dHost.ensureMenuPanelController()
            let dMenuWin = makeHeadlessHostWindow(width: MenuPanelController.panelWidth, height: MenuPanelController.defaultPanelHeight)
            dMenuWin.contentViewController = dMenu
            dHost.menuTracking = true
            dMenu.selectTab(0, persist: false)
            dMenu.panelWillOpen()
            pump(0.05)
            check(dMenu.tokensTile.valueLabel.stringValue == "2K", "P1-21 setup: today cache should populate 2K")

            // 模拟切周期出现 cache miss，验证旧值被立刻清空为 "—" 而非保留上周期值
            failUsageCall = true
            dHost.usageInFlightByPeriod["7d"] = true // 阻止立刻落地成功，保留在线 cache-miss 态检查
            dMenu.selectPeriod(1, persist: false)
            pump(0.02)
            check(dMenu.tokensTile.valueLabel.stringValue == "—", "P1-21: online cache-miss must clear previous tokensTile to — (got \(dMenu.tokensTile.valueLabel.stringValue))")
            dHost.usageInFlightByPeriod["7d"] = false

            // 触发失败后检查 15s 冷却期内不重复拉取，冷却过期且恢复正常后自动恢复
            let callsBeforeFail = dUsageCalls
            dMenu.syncFromAssistant(updateSize: false)
            pump(0.05)
            check(dUsageCalls == callsBeforeFail + 1, "P1-22: should issue one failing usage_summary request")
            check(dHost.usageNextRetryAtByPeriod["7d"] != nil, "P1-22: failure must set 15s usageNextRetryAtByPeriod")
            dMenu.syncFromAssistant(updateSize: false)
            pump(0.02)
            check(dUsageCalls == callsBeforeFail + 1, "P1-22: must respect 15s retry cooldown before retrying")

            failUsageCall = false
            dHost.usageNextRetryAtByPeriod["7d"] = Date(timeIntervalSinceNow: -1)
            dMenu.syncFromAssistant(updateSize: false)
            pump(0.05)
            check(dUsageCalls >= callsBeforeFail + 2, "P1-22: expired cooldown with open menu must auto-retry usage_summary")
            check(dHost.usageFetchErrorsByPeriod["7d"] == nil && dMenu.tokensTile.valueLabel.stringValue == "2K", "P1-22: auto-retry success must clear error and restore 2K metrics")

            // Usage.swift 跨 scope 失败清旧值（P1-21）
            let dUsagePage = UsagePage(app: dHost)
            let dUsageWin = makeHeadlessHostWindow(width: 900, height: 680)
            dUsageWin.contentView = dUsagePage.view
            dUsagePage.update(force: true)
            pump(0.05)
            check(dUsagePage.totalTokensMetric.stringValue == "2K", "P1-21 setup: UsagePage initial scope (all) loads 2K")

            failUsageCall = true
            dUsagePage.selectedEnvironmentId = "ssh-remote-b"
            dUsagePage.fetch(force: true, interruptInFlight: true)
            pump(0.05)
            check(dUsagePage.totalTokensMetric.stringValue == "—", "P1-21: cross-scope failure in UsagePage must clear previous environment metrics to — (got \(dUsagePage.totalTokensMetric.stringValue))")
            check(dUsagePage.latestReport.isEmpty && dUsagePage.latestReportIdentity == nil, "P1-21: cross-scope failure must reset latestReport and latestReportIdentity")

            // P1-23: 空号池首次加载置 hasLoadedAccountsOnce=true 不在 3s refresh 循环内重复狂刷
            dHost.fetchAccountList(notifyPage: false)
            pump(0.05)
            check(dHost.hasLoadedAccountsOnce == true && dHost.cachedAccounts.isEmpty, "P1-23: empty account_list must still mark hasLoadedAccountsOnce=true")
            let callsAfterFirstEmpty = dAccountListCalls
            let fakeStatusPayload: [String: Any] = ["accountsRevision": "", "liveAccountEmail": "", "remoteSyncRevision": 0]
            dHost.statusValue = LiveStatus(fakeStatusPayload)
            if (!dHost.hasLoadedAccountsOnce && !dHost.accountListInFlight) {
                dHost.fetchAccountList(notifyPage: true)
            }
            check(dAccountListCalls == callsAfterFirstEmpty, "P1-23: empty pool after first load must not re-fetch on unchanged status")

            // P1-23: 慢响应期间即使触发 pendingRefetch，首个有效返回仍先更新 UI 与 waiters，绝不活锁丢弃
            var slowAccountWaiterCount = 0
            dHost.fetchAccountList(notifyPage: false) { res in
                if case .success = res { slowAccountWaiterCount += 1 }
            }
            check(dHost.accountListInFlight == true, "P1-23: slow account_list should enter in-flight")
            dHost.fetchAccountList(notifyPage: false) // 排队 pendingRefetch
            waitUntil(timeout: 2.0, step: 0.01, description: "slow account_list and queued refetch to finish") {
                !dHost.accountListInFlight && !dHost.accountListPendingRefetch
            }
            check(slowAccountWaiterCount == 1, "P1-23: original waiter must receive response before queued refetch instead of being dropped")
        }

        // 1.2.0 按钮点击无响应根因回归防护：First-Mouse 全覆盖、PopUpMenu 追踪保护、禁止裸协作激活 NSApp.activate()
        do {
            let fmHost = Assistant(state: state.appendingPathComponent("first-mouse-and-activation-regression"))
            fmHost.configuration = try ConfigurationStore(state: fmHost.state)
            fmHost.bridge = BackendBridge(resources: state, state: fmHost.state)
            fmHost.reachable = true
            fmHost.statusValue = LiveStatus(["mode": "connected", "running": true, "runningChannel": "stable"])

            let fmPrefs = PreferencesController(app: fmHost)
            check(fmPrefs.languagePopup.acceptsFirstMouse(for: nil), "Regression: Preferences languagePopup must accept first mouse")
            check(fmPrefs.proxyModePopup.acceptsFirstMouse(for: nil), "Regression: Preferences proxyModePopup must accept first mouse")
            check(fmPrefs.refresh.acceptsFirstMouse(for: nil), "Regression: Preferences refresh popup must accept first mouse")

            let fmUsage = UsagePage(app: fmHost)
            check(fmUsage.accountPopup.acceptsFirstMouse(for: nil), "Regression: UsagePage accountPopup must accept first mouse")
            let fmPeriodSegButtons = findButtons(fmUsage.periodSegment)
            check(!fmPeriodSegButtons.isEmpty && fmPeriodSegButtons.allSatisfy { $0.acceptsFirstMouse(for: nil) }, "Regression: DesignSegmentedControl SegmentButton must accept first mouse")

            let fmCache = CachePage(app: fmHost)
            check(fmCache.retentionPopup.acceptsFirstMouse(for: nil), "Regression: CachePage retentionPopup must accept first mouse")
            check(fmCache.runtimeInfoButton.acceptsFirstMouse(for: nil) && fmCache.historyInfoButton.acceptsFirstMouse(for: nil), "Regression: MaintenanceInfoButton must accept first mouse")

            let fmSshPicker = EnvironmentPickerControl()
            check(fmSshPicker.popUpButton.acceptsFirstMouse(for: nil), "Regression: EnvironmentPickerControl popUpButton must accept first mouse")

            let fmSidebarBtn = SidebarLaunchButton(title: "打开 Antigravity", target: nil, action: #selector(Assistant.openAntigravity))
            check(fmSidebarBtn.acceptsFirstMouse(for: nil), "Regression: SidebarLaunchButton must accept first mouse")
            let fmInlineBtn = DesignInlineButton(title: "查看", target: nil, action: #selector(Assistant.openAntigravity))
            check(fmInlineBtn.acceptsFirstMouse(for: nil), "Regression: DesignInlineButton must accept first mouse")

            let fmOverview = DashboardPage(app: fmHost)
            check(fmOverview.companionMoreButton.acceptsFirstMouse(for: nil), "Regression: DashboardPage companionMoreButton must accept first mouse")

            let fmPolicySheet = AccountPolicySheet(app: fmHost, config: [:]) { }
            check(fmPolicySheet.strategyPopup.acceptsFirstMouse(for: nil) && fmPolicySheet.modelPopup.acceptsFirstMouse(for: nil), "Regression: AccountPolicySheet popups must accept first mouse")

            let fmUsageLog = UsageLogController(app: fmHost, period: "today")
            check(fmUsageLog.accountPopup.acceptsFirstMouse(for: nil), "Regression: UsageLogController accountPopup must accept first mouse")

            check(!Design.isTrackingPopUpMenu, "Regression: Design.isTrackingPopUpMenu must default to false")
            check(Assistant.shouldSuppressMenuPopoverDismiss(isTrackingPopUpMenu: true), "Regression: MenuFloatingPanel dismissal must be suppressed while tracking popup menu")
            check(!Assistant.shouldSuppressMenuPopoverDismiss(isTrackingPopUpMenu: false), "Regression: MenuFloatingPanel dismissal must be allowed when no popup menu is tracking")
            check(Assistant.shouldSuppressMenuPopoverDismiss() == Design.isTrackingPopUpMenu, "Regression: default shouldSuppressMenuPopoverDismiss must mirror Design.isTrackingPopUpMenu")

            // 跨 Space / 全屏空间下 NSMenu 弹窗子窗口挂载与层级保持回归保护
            let hostForPopup = NSWindow(contentRect: NSRect(x: -24000, y: -24000, width: 320, height: 220), styleMask: [.titled], backing: .buffered, defer: false)
            Assistant.configureHeadlessWindowIfNeeded(hostForPopup)
            hostForPopup.level = .statusBar
            hostForPopup.orderFront(nil)

            let fakePopupContainer = NSWindow(contentRect: NSRect(x: -24000, y: -24000, width: 120, height: 90), styleMask: [.borderless], backing: .buffered, defer: false)
            Assistant.configureHeadlessWindowIfNeeded(fakePopupContainer)
            fakePopupContainer.level = .popUpMenu
            fakePopupContainer.orderFront(nil)

            let fakePopupGlassChild = NSWindow(contentRect: NSRect(x: -24000, y: -24000, width: 140, height: 110), styleMask: [.borderless], backing: .buffered, defer: false)
            Assistant.configureHeadlessWindowIfNeeded(fakePopupGlassChild)
            fakePopupContainer.addChildWindow(fakePopupGlassChild, ordered: .above)
            fakePopupGlassChild.level = .popUpMenu

            let fakeStatusBarWin = NSWindow(contentRect: NSRect(x: -24000, y: -24000, width: 28, height: 24), styleMask: [.borderless], backing: .buffered, defer: false)
            Assistant.configureHeadlessWindowIfNeeded(fakeStatusBarWin)
            fakeStatusBarWin.level = .statusBar
            fakeStatusBarWin.orderFront(nil)

            check(Design.isTrackedPopUpContainerWindow(fakePopupContainer, excluding: hostForPopup), "Regression: visible .popUpMenu container window must match popup anchoring")
            check(!Design.isTrackedPopUpContainerWindow(hostForPopup, excluding: hostForPopup), "Regression: hostWindow must never be treated as its own popup window")
            check(!Design.isTrackedPopUpContainerWindow(fakeStatusBarWin, excluding: hostForPopup), "Regression: .statusBar windows must not be captured as popup containers")

            var anchoredList: [NSWindow] = []
            let newlyAnchored = Design.anchorTrackedPopUpWindows(to: hostForPopup, in: [hostForPopup, fakeStatusBarWin, fakePopupContainer, fakePopupGlassChild], alreadyAnchored: &anchoredList)
            check(newlyAnchored.count == 1 && newlyAnchored.first === fakePopupContainer, "Regression: anchorTrackedPopUpWindows must attach the popup container window to hostWindow")
            check(fakePopupContainer.parent === hostForPopup, "Regression: popup container window must become child of hostWindow so WindowServer syncs its Space")
            check(fakePopupContainer.level == .popUpMenu, "Regression: popup container window must keep .popUpMenu level above statusBar host")
            check(fakePopupGlassChild.level == .popUpMenu, "Regression: popup glass child window must keep .popUpMenu level above statusBar host")

            let repeatAnchored = Design.anchorTrackedPopUpWindows(to: hostForPopup, in: [hostForPopup, fakeStatusBarWin, fakePopupContainer, fakePopupGlassChild], alreadyAnchored: &anchoredList)
            check(repeatAnchored.isEmpty, "Regression: already-anchored popup container must not be re-anchored repeatedly")

            Design.detachTrackedPopUpWindows(anchoredList, from: hostForPopup)
            check(fakePopupContainer.parent == nil, "Regression: detachTrackedPopUpWindows must cleanly remove popup child from hostWindow")
            fakePopupContainer.removeChildWindow(fakePopupGlassChild)
            fakePopupGlassChild.orderOut(nil)
            fakePopupContainer.orderOut(nil)
            fakeStatusBarWin.orderOut(nil)
            hostForPopup.orderOut(nil)

            let nativeDir = URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .appendingPathComponent("native", isDirectory: true)
            let nativeFiles = (try? FileManager.default.contentsOfDirectory(at: nativeDir, includingPropertiesForKeys: nil)
                .filter { $0.pathExtension == "swift" }) ?? []
            check(!nativeFiles.isEmpty, "Regression: must locate native/*.swift files for activation guard")
            for swiftFile in nativeFiles {
                let source = try String(contentsOf: swiftFile, encoding: .utf8)
                check(!source.contains("NSApp.activate()"), "Regression: bare cooperative NSApp.activate() is forbidden in \(swiftFile.lastPathComponent); use Design.activateApplicationForcingFront()")
                if swiftFile.lastPathComponent != "Design.swift" {
                    check(!source.contains("NSApp.activate(ignoringOtherApps:"), "Regression: direct NSApp.activate(ignoringOtherApps:) outside Design.swift is forbidden in \(swiftFile.lastPathComponent); use Design.activateApplicationForcingFront()")
                }
            }
        }

        let result:[String:Any] = ["stableOnlySelectionPassed":true,"nativeLayouts":captures.count,"captures":captures,"enCaptures":enCaptures,"enExtraCaptures":enExtraCaptures,"menuCaptures":6,"safeSwitchSharedFlowPassed":true,"emailWidthPassed":true,"partialPricingPassed":true,"headlessNoVisibleWindowLeaksPassed":true,"nativeAssertions":assertionCount,"scope":"isolated synthetic AppKit fixture; not installed-app acceptance"]
        window.orderOut(nil)
        assertNoVisibleWindowsOnScreen("after-main-window-orderOut")
        try JSONSerialization.data(withJSONObject:result,options:[.prettyPrinted,.sortedKeys]).write(to:output.appendingPathComponent("native-ui-results.json"))
        print("\(captures.count) current-page native layouts, \(enCaptures.count) English layouts, and 6 menu states; fixture checks passed")
    }
}
