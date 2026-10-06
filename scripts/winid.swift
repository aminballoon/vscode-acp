import CoreGraphics
import Foundation
// Usage: winid <title-substring>  -> prints CGWindowID of first matching on-screen window
let needle = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as? [[String: Any]] ?? []
for w in list {
  let owner = w[kCGWindowOwnerName as String] as? String ?? ""
  let name = w[kCGWindowName as String] as? String ?? ""
  let layer = w[kCGWindowLayer as String] as? Int ?? 0
  if layer == 0 && name.contains(needle) && !name.isEmpty {
    print("\(w[kCGWindowNumber as String]!)\t\(owner)\t\(name)")
  }
}
