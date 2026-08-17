// swift-tools-version:5.9
import PackageDescription

let package = Package(
    name: "ZaraaGuiHelper",
    platforms: [.macOS(.v13)],
    targets: [
        .executableTarget(
            name: "ZaraaGuiHelper",
            path: "Sources/ZaraaGuiHelper"
        )
    ]
)
