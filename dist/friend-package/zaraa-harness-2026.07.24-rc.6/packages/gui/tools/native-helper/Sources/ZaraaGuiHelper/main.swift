import Foundation

// --- Hotkey installation (kill-switch) ---
// Run loop must be running on main thread for Carbon events to dispatch.
// Override via env var ZARAA_GUI_KILL_HOTKEY=disabled to skip installation.
let hotkey = Hotkey()
if ProcessInfo.processInfo.environment["ZARAA_GUI_KILL_HOTKEY"] != "disabled" {
    _ = hotkey.install(
        modifiers: DEFAULT_KILL_MODIFIERS,
        virtualKey: DEFAULT_KILL_KEY,
        onPress: {
            writeLine(HotkeyEvent(name: "kill"))
        }
    )
}

// --- Stdin command loop on background queue ---
DispatchQueue.global(qos: .userInitiated).async {
    let stdin = FileHandle.standardInput
    var buffer = Data()
    let dec = JSONDecoder()

    while true {
        let chunk = stdin.availableData
        if chunk.isEmpty {
            // EOF — exit the whole process.
            exit(0)
        }
        buffer.append(chunk)
        while let nlIdx = buffer.firstIndex(of: 0x0A) {
            let lineData = buffer.subdata(in: 0..<nlIdx)
            buffer.removeSubrange(0...nlIdx)
            guard !lineData.isEmpty,
                  let envelope = try? dec.decode(CommandEnvelope.self, from: lineData) else {
                continue
            }
            switch envelope.cmd {
            case "capture":
                let id = envelope.id
                let region = envelope.region
                if #available(macOS 14.0, *) {
                    let group = DispatchGroup()
                    group.enter()
                    Task {
                        defer { group.leave() }
                        do {
                            let (data, w, h) = try await captureFullScreenPNG(region: region)
                            let b64 = data.base64EncodedString()
                            writeLine(CaptureResponse(id: id, png_b64: b64, width: w, height: h))
                        } catch {
                            writeLine(ErrorResponse(id: id, error: "capture failed: \(error)"))
                        }
                    }
                    group.wait()
                } else {
                    writeLine(ErrorResponse(id: id, error: "capture failed: requires macOS 14.0+"))
                }
            case "click":
                let id = envelope.id
                do {
                    try performClick(
                        x: envelope.x ?? 0,
                        y: envelope.y ?? 0,
                        button: envelope.button ?? "left",
                        clicks: envelope.clicks ?? 1
                    )
                    writeLine(OkResponse(id: id))
                } catch {
                    writeLine(ErrorResponse(id: id, error: "click failed: \(error)"))
                }

            case "key":
                let id = envelope.id
                do {
                    try sendKeyChord(envelope.keys ?? [])
                    writeLine(OkResponse(id: id))
                } catch {
                    writeLine(ErrorResponse(id: id, error: "key failed: \(error)"))
                }

            case "type":
                let id = envelope.id
                do {
                    try sendText(envelope.text ?? "")
                    writeLine(OkResponse(id: id))
                } catch {
                    writeLine(ErrorResponse(id: id, error: "type failed: \(error)"))
                }

            case "drag":
                let id = envelope.id
                do {
                    try performDrag(
                        fromX: envelope.fromX ?? 0,
                        fromY: envelope.fromY ?? 0,
                        toX: envelope.toX ?? 0,
                        toY: envelope.toY ?? 0,
                        button: envelope.button ?? "left"
                    )
                    writeLine(OkResponse(id: id))
                } catch {
                    writeLine(ErrorResponse(id: id, error: "drag failed: \(error)"))
                }

            case "frontmost_app":
                writeLine(FrontmostAppResponse(id: envelope.id, bundle_id: frontmostBundleId()))

            case "scroll":
                let id = envelope.id
                do {
                    try performScroll(
                        x: envelope.x ?? 0,
                        y: envelope.y ?? 0,
                        dx: envelope.dx ?? 0,
                        dy: envelope.dy ?? 0
                    )
                    writeLine(OkResponse(id: id))
                } catch {
                    writeLine(ErrorResponse(id: id, error: "scroll failed: \(error)"))
                }
            default:
                writeLine(ErrorResponse(id: envelope.id, error: "unknown cmd: \(envelope.cmd)"))
            }
        }
    }
}

// Run main run loop forever — Carbon hotkey events dispatch here.
RunLoop.main.run()
