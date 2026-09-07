// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "ZeroPairing",
    platforms: [.macOS(.v12), .iOS(.v15), .watchOS(.v8)],
    products: [.library(name: "ZeroPairing", targets: ["ZeroPairing"])],
    targets: [.target(name: "ZeroPairing"), .testTarget(name: "ZeroPairingTests", dependencies: ["ZeroPairing"])]
)
