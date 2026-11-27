// The helper's socket server: newline-delimited JSON on
// `<root>/run/helper.sock` (0700 dir, 0600 socket and token), a client per
// thread. Exits after ten idle minutes, on the emergency chord, or when told.
import AppKit
import Foundation

let idleLimit: TimeInterval = 600

final class Server {
    let runDir: String
    let socketPath: String
    let tokenPath: String
    let stopPath: String
    let token: String
    var lastActivity = Date()
    let lock = NSLock()

    init(root: String) {
        runDir = (root as NSString).appendingPathComponent("run")
        socketPath = (runDir as NSString).appendingPathComponent("helper.sock")
        tokenPath = (runDir as NSString).appendingPathComponent("helper.token")
        stopPath = (runDir as NSString).appendingPathComponent("stop")
        token = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: "")
    }

    func touch() {
        lock.lock(); lastActivity = Date(); lock.unlock()
    }

    func idleFor() -> TimeInterval {
        lock.lock(); defer { lock.unlock() }
        return Date().timeIntervalSince(lastActivity)
    }

    func cleanupAndExit(_ code: Int32) -> Never {
        unlink(socketPath)
        unlink(tokenPath)
        exit(code)
    }

    func run() -> Never {
        let fm = FileManager.default
        try? fm.createDirectory(atPath: runDir, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
        chmod(runDir, 0o700)
        let listener = bindSocket()
        // Token after the socket: a client that finds the token finds a live socket.
        let tmp = tokenPath + ".tmp"
        fm.createFile(atPath: tmp, contents: token.data(using: .utf8), attributes: [.posixPermissions: 0o600])
        rename(tmp, tokenPath)

        installEmergencyStop(stopPath: stopPath) { [self] in cleanupAndExit(0) }

        Thread.detachNewThread { [self] in
            while true {
                Thread.sleep(forTimeInterval: 10)
                if idleFor() > idleLimit { cleanupAndExit(0) }
            }
        }
        Thread.detachNewThread { [self] in
            while true {
                let client = accept(listener, nil, nil)
                if client < 0 { continue }
                Thread.detachNewThread { [self] in serve(client) }
            }
        }
        signal(SIGTERM) { _ in exit(0) }
        // The event tap needs a run loop; the app has no UI.
        NSApplication.shared.setActivationPolicy(.prohibited)
        CFRunLoopRun()
        cleanupAndExit(0)
    }

    func bindSocket() -> Int32 {
        // A live helper answers a connect: leave it alone.
        if FileManager.default.fileExists(atPath: socketPath) {
            let probe = socket(AF_UNIX, SOCK_STREAM, 0)
            if connectUnix(probe, socketPath) == 0 {
                close(probe)
                FileHandle.standardError.write("another helper is serving \(socketPath)\n".data(using: .utf8)!)
                exit(3)
            }
            close(probe)
            unlink(socketPath)
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(socketPath.utf8CString)
        guard bytes.count <= MemoryLayout.size(ofValue: addr.sun_path) else {
            FileHandle.standardError.write("socket path too long\n".data(using: .utf8)!)
            exit(2)
        }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            for (i, b) in bytes.enumerated() { raw[i] = UInt8(bitPattern: b) }
        }
        let size = socklen_t(MemoryLayout<sockaddr_un>.size)
        let bound = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, size) }
        }
        guard bound == 0, listen(fd, 4) == 0 else {
            FileHandle.standardError.write("bind \(socketPath): \(errno)\n".data(using: .utf8)!)
            exit(2)
        }
        chmod(socketPath, 0o600)
        return fd
    }

    func serve(_ fd: Int32) {
        defer { close(fd) }
        var buffer = Data()
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            let n = read(fd, &chunk, chunk.count)
            if n <= 0 { return }
            buffer.append(chunk, count: n)
            while let newline = buffer.firstIndex(of: 0x0A) {
                let line = buffer.subdata(in: buffer.startIndex..<newline)
                buffer.removeSubrange(buffer.startIndex...newline)
                if line.isEmpty { continue }
                touch()
                let (reply, keep) = handle(line)
                var out = (try? JSONSerialization.data(withJSONObject: reply)) ?? Data()
                out.append(0x0A)
                _ = out.withUnsafeBytes { write(fd, $0.baseAddress, out.count) }
                if !keep { return }
            }
        }
    }

    /// Returns the reply and whether the client stays connected.
    func handle(_ line: Data) -> ([String: Any], Bool) {
        guard let request = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
            return (["id": NSNull(), "ok": false, "error": "invalid JSON"], true)
        }
        let id = request["id"] ?? NSNull()
        guard request["token"] as? String == token else {
            return (["id": id, "ok": false, "error": "invalid token"], false)
        }
        if FileManager.default.fileExists(atPath: stopPath) {
            return (["id": id, "ok": false, "error": "stopped by the owner (emergency chord)"], true)
        }
        let method = request["method"] as? String ?? ""
        let params = request["params"] as? [String: Any] ?? [:]
        do {
            let result = try Actions.dispatch(method, params)
            return (["id": id, "ok": true, "result": result], true)
        } catch let error as HelperError {
            return (["id": id, "ok": false, "error": error.message], true)
        } catch {
            return (["id": id, "ok": false, "error": "\(error)"], true)
        }
    }
}

func connectUnix(_ fd: Int32, _ path: String) -> Int32 {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8CString)
    if bytes.count > MemoryLayout.size(ofValue: addr.sun_path) { return -1 }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        for (i, b) in bytes.enumerated() { raw[i] = UInt8(bitPattern: b) }
    }
    let size = socklen_t(MemoryLayout<sockaddr_un>.size)
    return withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, size) }
    }
}

struct HelperError: Error {
    let message: String
    init(_ message: String) { self.message = message }
}

// ── Emergency chord: ctrl+option+cmd+. ────────────────────────────────────

var emergencyHandler: (() -> Void)?
var emergencyStopPath = ""
var emergencyTap: CFMachPort?

func installEmergencyStop(stopPath: String, onStop: @escaping () -> Void) {
    emergencyHandler = onStop
    emergencyStopPath = stopPath
    let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
    let callback: CGEventTapCallBack = { _, type, event, _ in
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            if let tap = emergencyTap { CGEvent.tapEnable(tap: tap, enable: true) }
            return Unmanaged.passUnretained(event)
        }
        let flags = event.flags
        let keycode = event.getIntegerValueField(.keyboardEventKeycode)
        let chord = flags.contains(.maskCommand) && flags.contains(.maskControl)
            && flags.contains(.maskAlternate)
        if chord && keycode == 47 /* . */ {
            FileManager.default.createFile(atPath: emergencyStopPath,
                                           contents: "stopped \(Date())\n".data(using: .utf8))
            emergencyHandler?()
        }
        return Unmanaged.passUnretained(event)
    }
    guard let tap = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                      options: .listenOnly, eventsOfInterest: mask,
                                      callback: callback, userInfo: nil) else {
        // Without Input Monitoring there is no chord: refuse to serve at all,
        // since trusted input without a way to stop it is not allowed.
        FileHandle.standardError.write("event tap unavailable: Input Monitoring not granted\n".data(using: .utf8)!)
        exit(4)
    }
    emergencyTap = tap
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, tap, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: tap, enable: true)
}
