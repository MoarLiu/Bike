// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "BikeiOS",
    defaultLocalization: "zh-Hans",
    platforms: [
        .iOS(.v17),
        .macOS(.v14)
    ],
    products: [
        .library(name: "BikeCore", targets: ["BikeCore"]),
        .executable(name: "BikeiOSApp", targets: ["BikeiOSApp"]),
        .executable(name: "BikeCoreChecks", targets: ["BikeCoreChecks"])
    ],
    targets: [
        .target(
            name: "BikeCore",
            path: "Sources/BikeCore"
        ),
        .executableTarget(
            name: "BikeiOSApp",
            dependencies: ["BikeCore"],
            path: "Sources/BikeiOSApp"
        ),
        .executableTarget(
            name: "BikeCoreChecks",
            dependencies: ["BikeCore"],
            path: "Sources/BikeCoreChecks"
        )
    ]
)
