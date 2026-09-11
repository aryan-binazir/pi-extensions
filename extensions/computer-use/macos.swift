import Foundation
import CoreGraphics
import ApplicationServices

// A session-local JSON-lines transport. Pi owns planning and consent.
func fail(_ message: String) throws -> Never { throw NSError(domain: "PiDesktop", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
func attribute(_ element: AXUIElement, _ name: CFString) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name, &value) == .success ? value : nil
}
func tree(_ element: AXUIElement, _ depth: Int, _ count: inout Int) -> [String: Any] {
    count += 1
    var result: [String: Any] = [:]
    for (key, name) in [("role", kAXRoleAttribute), ("title", kAXTitleAttribute), ("description", kAXDescriptionAttribute)] {
        if let value = attribute(element, name as CFString) as? String { result[key] = String(value.prefix(500)) }
    }
    if depth < 6, count < 200, let children = attribute(element, kAXChildrenAttribute as CFString) as? [AXUIElement] {
        var nodes: [[String: Any]] = []
        for child in children.prefix(50) { if count >= 200 { break }; nodes.append(tree(child, depth + 1, &count)) }
        result["children"] = nodes
    }
    return result
}
func run(_ request: [String: Any]) throws -> [String: Any] {
    guard let action = request["action"] as? String else { try fail("Invalid desktop action") }
    if let output = request["output"] as? String, output != "main" { try fail("macOS backend supports output main only") }
    if action == "screenshot" {
        guard CGPreflightScreenCaptureAccess() else { try fail("Screen Recording permission unavailable; grant it to the hosting terminal in macOS settings") }
        guard let folder = ProcessInfo.processInfo.environment["PI_DESKTOP_TMP"] else { try fail("Missing session screenshot directory") }
        let path = URL(fileURLWithPath: folder).appendingPathComponent(UUID().uuidString + ".png")
        defer { try? FileManager.default.removeItem(at: path) }
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        process.arguments = ["-x", "-m", "-t", "png", path.path]
        process.standardOutput = FileHandle.nullDevice; process.standardError = FileHandle.nullDevice
        try process.run(); process.waitUntilExit()
        guard process.terminationStatus == 0 else { try fail("macOS screen capture failed") }
        let data = try Data(contentsOf: path)
        guard data.count <= 16 * 1024 * 1024 else { try fail("Screenshot exceeds output limit") }
        return ["image": data.base64EncodedString(), "output": "main"]
    }
    guard AXIsProcessTrusted() else { try fail("Accessibility permission unavailable; grant it to the hosting terminal in macOS settings") }
    if action == "accessibility" {
        let system = AXUIElementCreateSystemWide()
        guard let value = attribute(system, kAXFocusedApplicationAttribute as CFString), CFGetTypeID(value) == AXUIElementGetTypeID() else { try fail("No accessible focused application") }
        let focused = unsafeBitCast(value, to: AXUIElement.self)
        var count = 0
        return ["available": true, "kind": "accessibility", "root": tree(focused, 0, &count), "limit": 200]
    }
    if action == "click" {
        guard let x = request["x"] as? Double, let y = request["y"] as? Double, x >= 0, x <= 1, y >= 0, y <= 1 else { try fail("Invalid coordinates") }
        let bounds = CGDisplayBounds(CGMainDisplayID())
        let point = CGPoint(x: bounds.minX + x * max(0, bounds.width - 1), y: bounds.minY + y * max(0, bounds.height - 1))
        let name = request["button"] as? String ?? "left"
        let button: CGMouseButton = name == "right" ? .right : name == "middle" ? .center : .left
        let down: CGEventType = name == "right" ? .rightMouseDown : name == "middle" ? .otherMouseDown : .leftMouseDown
        let up: CGEventType = name == "right" ? .rightMouseUp : name == "middle" ? .otherMouseUp : .leftMouseUp
        guard let press = CGEvent(mouseEventSource: nil, mouseType: down, mouseCursorPosition: point, mouseButton: button), let release = CGEvent(mouseEventSource: nil, mouseType: up, mouseCursorPosition: point, mouseButton: button) else { try fail("Could not create pointer events") }
        press.post(tap: .cghidEventTap); release.post(tap: .cghidEventTap)
    } else if action == "type" {
        guard let text = request["text"] as? String, text.count <= 10000 else { try fail("Invalid text") }
        // Small UTF-16 batches stay below the event string limit.
        for scalar in text.unicodeScalars {
            let units = Array(String(scalar).utf16)
            guard let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true), let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) else { try fail("Could not create keyboard event") }
            units.withUnsafeBufferPointer { p in down.keyboardSetUnicodeString(stringLength: units.count, unicodeString: p.baseAddress); up.keyboardSetUnicodeString(stringLength: units.count, unicodeString: p.baseAddress) }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
        }
    } else if action == "scroll" {
        guard let dx = request["dx"] as? Double, let dy = request["dy"] as? Double, abs(dx) <= 1000, abs(dy) <= 1000 else { try fail("Invalid scroll") }
        guard let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: Int32(-dy), wheel2: Int32(-dx), wheel3: 0) else { try fail("Could not create scroll event") }
        event.post(tap: .cghidEventTap)
    } else { try fail("Unsupported desktop action") }
    return ["dispatched": true, "applicationOutcome": "Inspect to verify application response"]
}
while let line = readLine() {
    var id: Any = NSNull()
    do {
        guard line.utf8.count < 100000, let data = line.data(using: .utf8), let request = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("Invalid request") }
        id = request["id"] ?? NSNull()
        let result = try run(request)
        let response = try JSONSerialization.data(withJSONObject: ["id": id, "ok": true, "result": result], options: [.sortedKeys])
        print(String(decoding: response, as: UTF8.self))
    } catch {
        let response = try! JSONSerialization.data(withJSONObject: ["id": id, "ok": false, "error": error.localizedDescription])
        print(String(decoding: response, as: UTF8.self))
    }
    fflush(stdout)
}
