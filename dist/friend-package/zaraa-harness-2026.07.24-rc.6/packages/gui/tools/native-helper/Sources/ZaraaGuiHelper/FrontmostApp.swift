import Foundation
import AppKit

func frontmostBundleId() -> String? {
    return NSWorkspace.shared.frontmostApplication?.bundleIdentifier
}
