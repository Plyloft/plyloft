// What the helper does for ply-test-mcp: trusted mouse and keys (only on the
// target app's window), window screenshots, and the native accessibility
// tree (sheets, NSOpenPanel, menus). Every method names its target `pid`.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

enum Actions {
    static func dispatch(_ method: String, _ p: [String: Any]) throws -> Any {
        switch method {
        case "ping": return ["pid": getpid()]
        case "permissions": return permissionStatus()
        case "windows": return try windows(pid(p))
        case "activate": return try activate(pid(p))
        case "mouse.click": return try click(p)
        case "mouse.drag": return try drag(p)
        case "mouse.scroll": return try scroll(p)
        case "key": return try key(p)
        case "type": return try typeText(p)
        case "screenshot": return try screenshot(p)
        case "ax.tree": return try axTree(p)
        case "ax.press": return try axPress(p)
        case "ax.menu": return try axMenu(p)
        case "shutdown":
            DispatchQueue.global().asyncAfter(deadline: .now() + 0.2) { exit(0) }
            return ["stopping": true]
        default: throw HelperError("unknown method \(method)")
        }
    }

    static func pid(_ p: [String: Any]) throws -> pid_t {
        guard let n = p["pid"] as? NSNumber, n.int32Value > 0 else { throw HelperError("params.pid is required") }
        return n.int32Value
    }

    static func point(_ value: Any?, _ name: String) throws -> CGPoint {
        guard let d = value as? [String: Any], let x = d["x"] as? NSNumber, let y = d["y"] as? NSNumber else {
            throw HelperError("params.\(name) must be {x, y} in screen points")
        }
        return CGPoint(x: x.doubleValue, y: y.doubleValue)
    }

    // ── Windows ──────────────────────────────────────────────────────────

    struct WindowInfo {
        let id: CGWindowID
        let pid: pid_t
        let layer: Int
        let bounds: CGRect
        let alpha: Double
        let title: String
        let owner: String
    }

    /// On-screen windows, front to back.
    static func onScreen() -> [WindowInfo] {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID)
            as? [[String: Any]] ?? []
        return list.compactMap { w in
            guard let id = w[kCGWindowNumber as String] as? NSNumber,
                  let owner = w[kCGWindowOwnerPID as String] as? NSNumber,
                  let boundsDict = w[kCGWindowBounds as String] as? NSDictionary,
                  let bounds = CGRect(dictionaryRepresentation: boundsDict) else { return nil }
            return WindowInfo(
                id: CGWindowID(id.uint32Value),
                pid: owner.int32Value,
                layer: (w[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0,
                bounds: bounds,
                alpha: (w[kCGWindowAlpha as String] as? NSNumber)?.doubleValue ?? 1,
                title: w[kCGWindowName as String] as? String ?? "",
                owner: w[kCGWindowOwnerName as String] as? String ?? ""
            )
        }
    }

    static func windows(_ pid: pid_t) -> [[String: Any]] {
        onScreen().filter { $0.pid == pid }.map { w in
            ["id": w.id, "layer": w.layer, "title": w.title,
             "bounds": ["x": w.bounds.origin.x, "y": w.bounds.origin.y,
                        "width": w.bounds.width, "height": w.bounds.height]]
        }
    }

    static func waitFrontmost(_ pid: pid_t, _ seconds: TimeInterval) {
        let deadline = Date().addingTimeInterval(seconds)
        while frontmostPid() != pid && Date() < deadline { Thread.sleep(forTimeInterval: 0.05) }
    }

    static func frontmostPid() -> pid_t? {
        NSWorkspace.shared.frontmostApplication?.processIdentifier
    }

    static func activate(_ pid: pid_t) throws -> [String: Any] {
        guard let app = NSRunningApplication(processIdentifier: pid) else {
            throw HelperError("no running app with pid \(pid)")
        }
        if frontmostPid() != pid {
            app.activate(options: [.activateAllWindows])
            waitFrontmost(pid, 1)
        }
        // macOS 14+ may ignore an activation asked by a background app (this
        // helper); Accessibility can still make the target frontmost.
        if frontmostPid() != pid && AXIsProcessTrusted() {
            let ax = AXUIElementCreateApplication(pid)
            AXUIElementSetAttributeValue(ax, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
            if let windows = attr(ax, kAXWindowsAttribute) as? [AXUIElement], let main = windows.first {
                AXUIElementPerformAction(main, kAXRaiseAction as CFString)
            }
            waitFrontmost(pid, 2)
        }
        guard frontmostPid() == pid else {
            throw HelperError("refused: could not bring pid \(pid) to the front (is the screensaver on or the screen locked?)")
        }
        return ["frontmost": true]
    }

    /// The target check: the target app is frontmost and the topmost visible
    /// window under `point` belongs to it. Nothing is posted otherwise.
    static func checkTarget(_ pid: pid_t, _ point: CGPoint) throws {
        guard frontmostPid() == pid else {
            throw HelperError("refused: Plyloft Test is not the frontmost app")
        }
        let top = onScreen().first { w in
            w.alpha > 0.01 && w.layer < 1000 && w.bounds.contains(point)
                && !(w.owner == "Window Server" || w.owner == "Dock" && w.layer > 0)
        }
        guard let top else { throw HelperError("refused: no window under (\(point.x), \(point.y))") }
        guard top.pid == pid else {
            throw HelperError("refused: not on the Plyloft Test window — \(top.owner) \"\(top.title)\" is on top there")
        }
    }

    static func checkFrontmost(_ pid: pid_t) throws {
        guard frontmostPid() == pid else {
            throw HelperError("refused: Plyloft Test is not the frontmost app")
        }
    }

    // ── Mouse ────────────────────────────────────────────────────────────

    static func flags(_ value: Any?) throws -> CGEventFlags {
        var f = CGEventFlags()
        for m in value as? [String] ?? [] {
            switch m.lowercased() {
            case "cmd", "command", "meta": f.insert(.maskCommand)
            case "ctrl", "control": f.insert(.maskControl)
            case "alt", "option", "opt": f.insert(.maskAlternate)
            case "shift": f.insert(.maskShift)
            default: throw HelperError("unknown modifier \(m)")
            }
        }
        return f
    }

    /// How events are delivered. `session` (default): the login session's tap,
    /// with a combined-session source. `hid`: the HID tap, as a real device —
    /// on this macOS those events move the pointer but never reach the page
    /// (found on the ship loop's walks: "the page saw: []"). `pid`: straight
    /// to the target app's queue. Set per request with params.via.
    static var deliveryVia = "session"
    static var deliveryPid: pid_t = 0

    static func source() -> CGEventSource? {
        CGEventSource(stateID: deliveryVia == "hid" ? .hidSystemState : .combinedSessionState)
    }

    static func post(_ event: CGEvent?) {
        guard let event else { return }
        switch deliveryVia {
        case "session": event.post(tap: .cgSessionEventTap)
        case "pid": event.postToPid(deliveryPid)
        default: event.post(tap: .cghidEventTap)
        }
    }

    static func setDelivery(_ p: [String: Any], _ pid: pid_t) {
        deliveryVia = (p["via"] as? String).flatMap { ["hid", "session", "pid"].contains($0) ? $0 : nil } ?? "session"
        deliveryPid = pid
    }

    static func click(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        setDelivery(p, pid)
        let at = try point(p["at"], "at")
        let right = (p["button"] as? String) == "right"
        let count = max(1, min(3, (p["count"] as? NSNumber)?.intValue ?? 1))
        let mods = try flags(p["modifiers"])
        _ = try activate(pid)
        try checkTarget(pid, at)
        let source = source()
        let (down, up, button): (CGEventType, CGEventType, CGMouseButton) =
            right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: button))
        Thread.sleep(forTimeInterval: 0.05)
        for n in 1...count {
            for type in [down, up] {
                let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: at, mouseButton: button)
                e?.setIntegerValueField(.mouseEventClickState, value: Int64(n))
                e?.flags = mods
                post(e)
                Thread.sleep(forTimeInterval: 0.02)
            }
        }
        return ["clicked": ["x": at.x, "y": at.y], "count": count, "button": right ? "right" : "left"]
    }

    static func drag(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        setDelivery(p, pid)
        let from = try point(p["from"], "from")
        let to = try point(p["to"], "to")
        let steps = max(4, min(120, (p["steps"] as? NSNumber)?.intValue ?? 24))
        _ = try activate(pid)
        try checkTarget(pid, from)
        try checkTarget(pid, to)
        let source = source()
        post(CGEvent(mouseEventSource: source, mouseType: .mouseMoved, mouseCursorPosition: from, mouseButton: .left))
        Thread.sleep(forTimeInterval: 0.05)
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDown, mouseCursorPosition: from, mouseButton: .left))
        // HTML5 drag starts only after real movement past a threshold.
        Thread.sleep(forTimeInterval: 0.15)
        for i in 1...steps {
            let t = Double(i) / Double(steps)
            let at = CGPoint(x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t)
            post(CGEvent(mouseEventSource: source, mouseType: .leftMouseDragged, mouseCursorPosition: at, mouseButton: .left))
            Thread.sleep(forTimeInterval: 0.016)
        }
        Thread.sleep(forTimeInterval: 0.15)
        post(CGEvent(mouseEventSource: source, mouseType: .leftMouseUp, mouseCursorPosition: to, mouseButton: .left))
        return ["dragged": ["from": ["x": from.x, "y": from.y], "to": ["x": to.x, "y": to.y]], "steps": steps]
    }

    /// Wheel lines at a point: positive `lines` scrolls down (content moves up).
    static func scroll(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        setDelivery(p, pid)
        let at = try point(p["at"], "at")
        let lines = max(-200, min(200, (p["lines"] as? NSNumber)?.intValue ?? 5))
        _ = try activate(pid)
        try checkTarget(pid, at)
        let src = source()
        post(CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: at, mouseButton: .left))
        Thread.sleep(forTimeInterval: 0.05)
        // One line per event, as a wheel does: pages react to each step.
        let step: Int32 = lines > 0 ? -1 : 1
        for _ in 0..<abs(lines) {
            let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 1, wheel1: step, wheel2: 0, wheel3: 0)
            e?.location = at
            post(e)
            Thread.sleep(forTimeInterval: 0.02)
        }
        return ["scrolled": lines, "at": ["x": at.x, "y": at.y]]
    }

    // ── Keys ─────────────────────────────────────────────────────────────

    static let keycodes: [String: CGKeyCode] = [
        "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
        "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
        "3": 20, "4": 21, "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28,
        "0": 29, "]": 30, "o": 31, "u": 32, "[": 33, "i": 34, "p": 35, "enter": 36,
        "return": 36, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42, ",": 43,
        "/": 44, "n": 45, "m": 46, ".": 47, "tab": 48, "space": 49, "`": 50,
        "backspace": 51, "escape": 53, "esc": 53, "delete": 117, "home": 115, "end": 119,
        "pageup": 116, "pagedown": 121, "left": 123, "right": 124, "down": 125, "up": 126,
        "f1": 122, "f2": 120, "f3": 99, "f4": 118, "f5": 96, "f6": 97, "f7": 98, "f8": 100,
        "f9": 101, "f10": 109, "f11": 103, "f12": 111,
    ]

    static func key(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        setDelivery(p, pid)
        guard let keys = p["keys"] as? String, !keys.isEmpty else { throw HelperError("params.keys is required") }
        let parts = keys.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces).lowercased() }
        guard let last = parts.last, let code = keycodes[last] else {
            throw HelperError("unknown key in \"\(keys)\"")
        }
        let mods = try flags(Array(parts.dropLast()))
        if ctrlOptCmdDot(mods, code) { throw HelperError("refused: that is the emergency chord") }
        _ = try activate(pid)
        try checkFrontmost(pid)
        let source = source()
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
            e?.flags = mods
            post(e)
            Thread.sleep(forTimeInterval: 0.02)
        }
        return ["pressed": keys]
    }

    static func ctrlOptCmdDot(_ f: CGEventFlags, _ code: CGKeyCode) -> Bool {
        code == 47 && f.contains(.maskCommand) && f.contains(.maskControl) && f.contains(.maskAlternate)
    }

    static func typeText(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        setDelivery(p, pid)
        guard let text = p["text"] as? String else { throw HelperError("params.text is required") }
        _ = try activate(pid)
        try checkFrontmost(pid)
        let source = source()
        for scalar in text.unicodeScalars {
            if scalar == "\n" || scalar == "\r" {
                for down in [true, false] {
                    post(CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: down))
                }
            } else {
                var units = Array(String(scalar).utf16)
                for down in [true, false] {
                    let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
                    e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: &units)
                    post(e)
                }
            }
            Thread.sleep(forTimeInterval: 0.012)
            // Stop typing into another app if focus moved away mid-string.
            try checkFrontmost(pid)
        }
        return ["typed": text.count]
    }

    // ── Screenshots ──────────────────────────────────────────────────────

    static func screenshot(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        guard let dir = p["dir"] as? String else { throw HelperError("params.dir is required") }
        let stem = p["name"] as? String ?? "shot-\(Int(Date().timeIntervalSince1970 * 1000))"
        let own = onScreen().filter { $0.pid == pid && $0.layer >= 0 && $0.alpha > 0.01 && $0.bounds.width > 40 }
        guard !own.isEmpty else { throw HelperError("no visible window of pid \(pid) to capture") }
        try FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        var files: [[String: Any]] = []
        // Front to back: the first is what the user sees on top (a sheet or dialog).
        for (i, w) in own.enumerated() {
            let path = (dir as NSString).appendingPathComponent(i == 0 ? "\(stem).png" : "\(stem)-\(i).png")
            let task = Process()
            task.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
            task.arguments = ["-x", "-o", "-l", String(w.id), path]
            try task.run()
            task.waitUntilExit()
            guard task.terminationStatus == 0, FileManager.default.fileExists(atPath: path) else {
                throw HelperError("screencapture failed for window \(w.id) (Screen Recording granted?)")
            }
            files.append(["path": path, "window": w.id, "title": w.title])
        }
        return ["files": files]
    }

    // ── Native accessibility (dialogs, panels, menus) ────────────────────

    static var axIndex: [Int: AXUIElement] = [:]
    static var axNext = 0
    static let axLock = NSLock()

    static func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
        var value: AnyObject?
        return AXUIElementCopyAttributeValue(el, name as CFString, &value) == .success ? value : nil
    }

    static func text(_ el: AXUIElement, _ name: String) -> String {
        guard let v = attr(el, name) else { return "" }
        if let s = v as? String { return s }
        if let n = v as? NSNumber { return n.stringValue }
        return ""
    }

    static func clean(_ s: String, _ max: Int = 100) -> String {
        let flat = s.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        return flat.count > max ? String(flat.prefix(max - 1)) + "…" : flat
    }

    static func axTree(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        guard AXIsProcessTrusted() else { throw HelperError("Accessibility is not granted to PlyTestHelper") }
        let maxDepth = (p["max_depth"] as? NSNumber)?.intValue ?? 8
        let includeMenus = p["menus"] as? Bool ?? false
        let app = AXUIElementCreateApplication(pid)
        axLock.lock(); defer { axLock.unlock() }
        axIndex = [:]
        axNext = 0
        var lines: [String] = []
        var count = 0
        func walk(_ el: AXUIElement, _ depth: Int) {
            if count > 800 { return }
            count += 1
            let role = text(el, kAXRoleAttribute)
            let subrole = text(el, kAXSubroleAttribute)
            let title = clean(text(el, kAXTitleAttribute))
            let desc = clean(text(el, kAXDescriptionAttribute))
            let value = clean(text(el, kAXValueAttribute), 60)
            let enabled = (attr(el, kAXEnabledAttribute) as? Bool) ?? true
            axNext += 1
            let id = axNext
            axIndex[id] = el
            var line = String(repeating: "  ", count: depth) + "- \(role)"
            if !subrole.isEmpty { line += "/\(subrole)" }
            let name = title.isEmpty ? desc : title
            if !name.isEmpty { line += " \"\(name)\"" }
            line += " [ax=\(id)]"
            var states: [String] = []
            if !enabled { states.append("disabled") }
            if !value.isEmpty { states.append("value=\"\(value)\"") }
            if !states.isEmpty { line += " (\(states.joined(separator: ", ")))" }
            // The web content has its own tree (ui_snapshot); do not walk it here.
            if role == "AXWebArea" { lines.append(line + " — web content: use ui_snapshot"); return }
            lines.append(line)
            if depth >= maxDepth { return }
            for child in attr(el, kAXChildrenAttribute) as? [AXUIElement] ?? [] { walk(child, depth + 1) }
        }
        for window in attr(app, kAXWindowsAttribute) as? [AXUIElement] ?? [] { walk(window, 0) }
        if includeMenus, let bar = attr(app, kAXMenuBarAttribute) {
            walk(bar as! AXUIElement, 0)
        }
        return ["tree": lines.joined(separator: "\n"), "truncated": count > 800]
    }

    static func axPress(_ p: [String: Any]) throws -> [String: Any] {
        _ = try pid(p)
        guard let id = (p["ax"] as? NSNumber)?.intValue else { throw HelperError("params.ax is required (from ax.tree)") }
        axLock.lock()
        let el = axIndex[id]
        axLock.unlock()
        guard let el else { throw HelperError("ax=\(id) is not in the last native snapshot") }
        let result = AXUIElementPerformAction(el, kAXPressAction as CFString)
        guard result == .success else { throw HelperError("AXPress failed (\(result.rawValue))") }
        return ["pressed": id]
    }

    /// Presses a menu item by its path of titles: ["Plyloft Test", "Quit Plyloft Test"].
    static func axMenu(_ p: [String: Any]) throws -> [String: Any] {
        let pid = try pid(p)
        guard let path = p["path"] as? [String], !path.isEmpty else { throw HelperError("params.path is required") }
        guard AXIsProcessTrusted() else { throw HelperError("Accessibility is not granted to PlyTestHelper") }
        let app = AXUIElementCreateApplication(pid)
        guard let barObject = attr(app, kAXMenuBarAttribute) else { throw HelperError("no menu bar") }
        var current = barObject as! AXUIElement
        for (i, title) in path.enumerated() {
            var candidates = attr(current, kAXChildrenAttribute) as? [AXUIElement] ?? []
            // A menu bar item's items sit under its AXMenu child.
            if i > 0, let menu = candidates.first, text(menu, kAXRoleAttribute) == "AXMenu" {
                candidates = attr(menu, kAXChildrenAttribute) as? [AXUIElement] ?? []
            }
            guard let next = candidates.first(where: { text($0, kAXTitleAttribute) == title }) else {
                let names = candidates.map { text($0, kAXTitleAttribute) }.filter { !$0.isEmpty }
                throw HelperError("no menu item \"\(title)\" (have: \(names.joined(separator: ", ")))")
            }
            current = next
        }
        let result = AXUIElementPerformAction(current, kAXPressAction as CFString)
        guard result == .success else { throw HelperError("AXPress on the menu item failed (\(result.rawValue))") }
        return ["pressed": path]
    }
}
