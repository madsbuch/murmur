// swift-tools-version:6.1
import PackageDescription

let package = Package(
    name: "MurmurShareCore",
    platforms: [.iOS(.v15), .macOS(.v12)],
    products: [.library(name: "MurmurShareCore", targets: ["MurmurShareCore"])],
    dependencies: [.package(url: "https://github.com/groue/GRDB.swift.git", exact: "7.11.1")],
    targets: [
        .target(name: "MurmurShareCore", dependencies: [.product(name: "GRDB", package: "GRDB.swift")]),
        .testTarget(name: "MurmurShareCoreTests", dependencies: ["MurmurShareCore"]),
    ]
)
