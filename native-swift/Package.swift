// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "LocalOutlineNative",
    defaultLocalization: "zh-Hans",
    platforms: [
        .macOS(.v15)
    ],
    products: [
        .executable(name: "LocalOutlineNative", targets: ["LocalOutlineNative"])
    ],
    targets: [
        .executableTarget(
            name: "LocalOutlineNative",
            path: "Sources/LocalOutlineNative",
            exclude: [
                "Resources/Info.plist",
                "Resources/LocalOutlineNative.entitlements"
            ],
            swiftSettings: [
                .define("LOCAL_OUTLINE_CLI_BUILD")
            ]
        )
    ]
)
