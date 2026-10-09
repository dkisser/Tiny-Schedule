// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "event-helper",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "event-helper", targets: ["event-helper"]),
    ],
    targets: [
        .executableTarget(
            name: "event-helper",
            path: "Sources/event-helper"
        ),
    ]
)