// PlyTestHelper — the one process that holds the macOS permissions the
// dev-only app tester needs (Accessibility, Screen Recording, Input
// Monitoring). It runs as its own app (launched through LaunchServices) so
// macOS attributes the permissions to it, not to the terminal or the
// Plyloft that happens to host the calling agent. Never bundled with Plyloft.
// Design: docs/app-tester/DESIGN.md.
//
//   PlyTestHelper status|request [--out FILE]   permissions, as JSON
//   PlyTestHelper serve --root DIR              socket server for ply-test-mcp
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

func permissionStatus() -> [String: Bool] {
    [
        "accessibility": AXIsProcessTrusted(),
        "screenRecording": CGPreflightScreenCaptureAccess(),
        "inputMonitoring": CGPreflightListenEventAccess(),
        // Posting events is its own grant (Accessibility → "post events"):
        // without it CGEvent.post drops every event silently.
        "postEvents": CGPreflightPostEventAccess(),
    ]
}

func writeJSON(_ value: Any, to path: String?) {
    let data = (try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])) ?? Data()
    if let path {
        let url = URL(fileURLWithPath: path)
        let tmp = url.appendingPathExtension("tmp")
        try? data.write(to: tmp)
        _ = try? FileManager.default.replaceItemAt(url, withItemAt: tmp)
    } else {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    }
}

func argument(_ name: String, in args: [String]) -> String? {
    args.firstIndex(of: name).flatMap { $0 + 1 < args.count ? args[$0 + 1] : nil }
}

let args = Array(CommandLine.arguments.dropFirst())
let command = args.first ?? "status"
let outPath = argument("--out", in: args)

switch command {
case "request":
    let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
    _ = AXIsProcessTrustedWithOptions(options)
    _ = CGRequestScreenCaptureAccess()
    _ = CGRequestListenEventAccess()
    _ = CGRequestPostEventAccess()
    writeJSON(permissionStatus(), to: outPath)
case "serve":
    let root = argument("--root", in: args)
        ?? (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/com.mbadv.ply.test/app-tester")
    Server(root: root).run()
default:
    writeJSON(permissionStatus(), to: outPath)
}
