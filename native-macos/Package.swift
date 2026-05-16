// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LocalOutlineNative",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "LocalOutlineNative", targets: ["LocalOutlineNative"])
    ],
    targets: [
        .executableTarget(
            name: "LocalOutlineNative"
        )
    ]
)
