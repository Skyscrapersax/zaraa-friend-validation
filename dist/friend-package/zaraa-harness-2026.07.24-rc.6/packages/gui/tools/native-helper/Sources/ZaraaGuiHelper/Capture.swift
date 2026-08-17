import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

enum CaptureError: Error { case noDisplay, noImage, encodeFailed, unsupportedOS }

@available(macOS 14.0, *)
func captureFullScreenPNG(region: Region?) async throws -> (data: Data, width: Int, height: Int) {
    let content = try await SCShareableContent.current
    guard let display = content.displays.first else { throw CaptureError.noDisplay }

    let filter = SCContentFilter(display: display, excludingWindows: [])
    let cfg = SCStreamConfiguration()
    cfg.width = display.width
    cfg.height = display.height
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: 1)
    cfg.pixelFormat = kCVPixelFormatType_32BGRA
    cfg.showsCursor = true

    let cgImage: CGImage = try await SCScreenshotManager.captureImage(
        contentFilter: filter,
        configuration: cfg
    )

    let cropped: CGImage
    if let region {
        let rect = CGRect(x: region.x, y: region.y, width: region.w, height: region.h)
        guard let r = cgImage.cropping(to: rect) else { throw CaptureError.noImage }
        cropped = r
    } else {
        cropped = cgImage
    }

    let mutableData = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(mutableData, UTType.png.identifier as CFString, 1, nil) else {
        throw CaptureError.encodeFailed
    }
    CGImageDestinationAddImage(dest, cropped, nil)
    guard CGImageDestinationFinalize(dest) else { throw CaptureError.encodeFailed }
    return (mutableData as Data, cropped.width, cropped.height)
}
