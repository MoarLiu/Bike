// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BikeNative",
    defaultLocalization: "zh-Hans",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "BikeNative", targets: ["BikeNative"])
    ],
    targets: [
        .executableTarget(
            name: "BikeNative",
            path: "Sources/BikeNative",
            exclude: [
                "Resources/Info.plist",
                "Resources/BikeNative.entitlements",
                "Resources/AppIcon.icns"
            ]
        )
    ]
)
