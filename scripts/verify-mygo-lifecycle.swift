import Foundation
import CoreGraphics
let owner = Int32(CommandLine.arguments[1])!
let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []).filter { ($0[kCGWindowOwnerPID as String] as? Int32) == owner }
let data = try JSONSerialization.data(withJSONObject: windows, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
