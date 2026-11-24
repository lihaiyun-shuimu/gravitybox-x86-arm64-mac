import Cocoa

enum ModelIcons {
    private static var cache: [String:NSImage] = [:]
    static func image(_ name:String) -> NSImage? {
        let canonical = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !canonical.isEmpty else { return nil }
        let resolvedName = canonical == "gpt" ? "openai" : canonical
        if let image=cache[resolvedName] { return image }
        #if NATIVE_UI_TEST
        let root = URL(fileURLWithPath:ProcessInfo.processInfo.environment["GRAVITYBOX_UI_RESOURCES"] ?? "assets")
        #else
        guard let root = Bundle.main.resourceURL else { return nil }
        #endif
        let folder = root.appendingPathComponent("model-icons")
        let file = resolvedName + ".png"
        guard let image=NSImage(contentsOf:folder.appendingPathComponent(file)) else { return nil }
        image.isTemplate = (resolvedName == "openai")
        cache[resolvedName]=image; return image
    }
    static func fallbackIcon(size: CGFloat = 13) -> NSImage? {
        let cfg = NSImage.SymbolConfiguration(pointSize: size, weight: .medium)
        let img = NSImage(systemSymbolName: "hexagon", accessibilityDescription: nil)?.withSymbolConfiguration(cfg)
        img?.isTemplate = true
        return img
    }
    static func tintColor(for image: NSImage) -> NSColor? {
        image.isTemplate ? .labelColor : nil
    }
    static func brands(for title:String) -> [String] {
        let lower=title.lowercased()
        if lower.contains("claude") && (lower.contains("gpt") || lower.contains("openai")) { return ["claude","openai"] }
        if lower.contains("gemini") || lower.contains("orchestrator") || lower.contains("argon") || lower.contains("carbon") || lower.contains("hydrogen") || lower.contains("neon") { return ["gemini"] }
        if lower.contains("claude") { return ["claude"] }
        if lower.contains("gpt") || lower.contains("openai") || lower.range(of: "(?:^|\\b)o[1-9](?:$|[-_\\s])", options: .regularExpression) != nil { return ["openai"] }
        return []
    }
}
