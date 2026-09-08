// Rasterize the repository's existing Zero mark (apps/mail/public/white-icon.svg)
// directly from its vector geometry for Apple asset catalogs; no third-party art.
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers
import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? "Configuration/Assets.xcassets")
let fm = FileManager.default
let outer: [(CGFloat, CGFloat)] = [(38.125,190.625),(38.125,152.5),(0,152.5),(0,38.125),(38.125,38.125),(38.125,0),(152.5,0),(152.5,38.125),(190.625,38.125),(190.625,152.5),(152.5,152.5),(152.5,190.625)]
let inner: [(CGFloat, CGFloat)] = [(38.125,114.375),(76.25,114.375),(76.25,150.975),(152.5,150.975),(152.5,76.25),(114.375,76.25),(114.375,114.375),(76.25,114.375),(76.25,76.25),(114.375,76.25),(114.375,39.65),(38.125,39.65)]
func render(_ size: Int, at url: URL) throws {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    context.setFillColor(CGColor(gray: 0, alpha: 1)); context.fill(CGRect(x: 0, y: 0, width: size, height: size))
    let path = CGMutablePath(), scale = CGFloat(size) * 0.51 / 190.625, padding = CGFloat(size) * 0.245
    for points in [outer, inner] {
        for (index, point) in points.enumerated() {
            let p = CGPoint(x: padding + point.0 * scale, y: CGFloat(size) - padding - point.1 * scale)
            if index == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
    }
    context.setFillColor(CGColor(gray: 1, alpha: 1)); context.addPath(path); context.fillPath()
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(destination, context.makeImage()!, nil)
    guard CGImageDestinationFinalize(destination) else { throw CocoaError(.fileWriteUnknown) }
}
try fm.createDirectory(at: root, withIntermediateDirectories: true)
try Data("{\"info\":{\"author\":\"xcode\",\"version\":1}}\n".utf8).write(to: root.appendingPathComponent("Contents.json"))
for (name, idiom) in [("AppIcon", "universal"), ("MacIcon", "mac"), ("WatchIcon", "watch-marketing")] {
    let directory = root.appendingPathComponent(name + ".appiconset")
    try fm.createDirectory(at: directory, withIntermediateDirectories: true)
    var images: [[String: Any]] = []
    if idiom == "mac" {
        for size in [16, 32, 128, 256, 512] {
            for scale in [1, 2] {
                let filename = "icon-\(size)@\(scale)x.png"
                try render(size * scale, at: directory.appendingPathComponent(filename))
                images.append(["idiom": idiom, "size": "\(size)x\(size)", "scale": "\(scale)x", "filename": filename])
            }
        }
    } else {
        try render(1024, at: directory.appendingPathComponent("icon-1024.png"))
        images = [["idiom": "universal", "platform": idiom == "universal" ? "ios" : "watchos", "size": "1024x1024", "filename": "icon-1024.png"]]
    }
    try JSONSerialization.data(withJSONObject: ["images": images, "info": ["author": "xcode", "version": 1]], options: [.prettyPrinted, .sortedKeys]).write(to: directory.appendingPathComponent("Contents.json"))
}
