// Focus logger for agent-tabs acceptance tests.
//
// Every 100 ms it records two things and prints a line whenever either changes:
// - the frontmost (active) application, which is what `lsappinfo front` reports. The run loop is
//   spun between samples: NSWorkspace only updates frontmostApplication while it runs.
// - the owner of the topmost on-screen normal window (layer 0)
// The second catches windows that are ordered above the user's work without activating
// Chrome, which a frontmost-app check alone would miss.
//
// Build: swiftc -O tests/focus-log.swift -o bin/focus-log
// Run:   bin/focus-log [seconds]   (default: run until killed)

import AppKit
import CoreGraphics

setvbuf(stdout, nil, _IOLBF, 0)

let limit = CommandLine.arguments.count > 1 ? Double(CommandLine.arguments[1]) ?? 0 : 0
let started = Date()
let formatter = ISO8601DateFormatter()
formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]

func topWindowOwner() -> String {
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    guard let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return "?" }
    for window in windows {
        let layer = window[kCGWindowLayer as String] as? Int ?? -1
        let alpha = window[kCGWindowAlpha as String] as? Double ?? 1
        let bounds = window[kCGWindowBounds as String] as? [String: Double] ?? [:]
        guard layer == 0, alpha > 0, (bounds["Width"] ?? 0) > 100, (bounds["Height"] ?? 0) > 100 else { continue }
        return window[kCGWindowOwnerName as String] as? String ?? "?"
    }
    return "-"
}

// The brief's reference method: `lsappinfo info -only name "$(lsappinfo front)"`.
func lsappinfoFront() -> String {
    func run(_ args: [String]) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/lsappinfo")
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        guard (try? process.run()) != nil else { return "" }
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    let asn = run(["front"])
    let info = run(["info", "-only", "name", asn])
    // Output starts with the quoted app name: "Safari" ASN:0x0-0x11011: (in front)
    return info.components(separatedBy: "\"").dropFirst().first ?? "?"
}

var last = ""
print("\(formatter.string(from: Date())) start")
while limit == 0 || Date().timeIntervalSince(started) < limit {
    let front = NSWorkspace.shared.frontmostApplication?.localizedName ?? "?"
    let line = "front=\(front) lsappinfo=\(lsappinfoFront()) topWindow=\(topWindowOwner())"
    if line != last {
        print("\(formatter.string(from: Date())) \(line)")
        last = line
    }
    RunLoop.current.run(until: Date().addingTimeInterval(0.1))
}
print("\(formatter.string(from: Date())) end")
