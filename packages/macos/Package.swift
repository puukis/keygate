// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "Keygate",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Keygate", targets: ["Keygate"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle.git", from: "2.6.0"),
    ],
    targets: [
        .executableTarget(
            name: "Keygate",
            dependencies: ["Sparkle"],
            path: "Sources/Keygate",
            resources: [
                .process("Resources"),
            ]
        ),
    ]
)
