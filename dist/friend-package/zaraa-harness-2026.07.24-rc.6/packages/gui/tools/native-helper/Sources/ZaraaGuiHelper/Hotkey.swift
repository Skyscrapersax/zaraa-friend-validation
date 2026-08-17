import Foundation
import Carbon

// Default kill-switch: Ctrl+Shift+Esc.
let DEFAULT_KILL_MODIFIERS: UInt32 = UInt32(controlKey | shiftKey)
let DEFAULT_KILL_KEY: UInt32 = 0x35 // kVK_Escape

final class Hotkey {
    private var ref: EventHotKeyRef?
    private static var sharedHandler: (() -> Void)?

    /// Install a global hotkey. Returns true on success.
    /// NOTE: events only fire when the main run loop is running.
    @discardableResult
    func install(modifiers: UInt32, virtualKey: UInt32, onPress: @escaping () -> Void) -> Bool {
        Hotkey.sharedHandler = onPress
        let id = EventHotKeyID(signature: OSType(0x5A475549), id: 1) // 'ZGUI'
        let status = RegisterEventHotKey(
            virtualKey,
            modifiers,
            id,
            GetEventDispatcherTarget(),
            0,
            &ref
        )
        guard status == noErr else { return false }

        var spec = EventTypeSpec(
            eventClass: OSType(kEventClassKeyboard),
            eventKind: UInt32(kEventHotKeyPressed)
        )
        InstallEventHandler(
            GetEventDispatcherTarget(),
            { (_, _, _) -> OSStatus in
                Hotkey.sharedHandler?()
                return noErr
            },
            1,
            &spec,
            nil,
            nil
        )
        return true
    }
}

struct HotkeyEvent: Encodable {
    let event: String
    let name: String
    init(name: String) {
        self.event = "hotkey"
        self.name = name
    }
}
