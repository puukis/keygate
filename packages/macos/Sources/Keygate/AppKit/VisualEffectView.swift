import AppKit
import SwiftUI

/// Wraps NSVisualEffectView for native macOS vibrancy/blur effects.
struct VisualEffectView: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    let blendingMode: NSVisualEffectView.BlendingMode
    let state: NSVisualEffectView.State
    let isEmphasized: Bool

    init(
        material: NSVisualEffectView.Material = .sidebar,
        blendingMode: NSVisualEffectView.BlendingMode = .behindWindow,
        state: NSVisualEffectView.State = .active,
        isEmphasized: Bool = false
    ) {
        self.material = material
        self.blendingMode = blendingMode
        self.state = state
        self.isEmphasized = isEmphasized
    }

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = blendingMode
        view.state = state
        view.isEmphasized = isEmphasized
        return view
    }

    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {
        nsView.material = material
        nsView.blendingMode = blendingMode
        nsView.state = state
        nsView.isEmphasized = isEmphasized
    }
}

// MARK: - Window Background Blur (CGS private API)

/// Private CoreGraphics Server connection type.
private typealias CGSConnectionID = UInt32

@_silgen_name("CGSDefaultConnectionForThread")
private func CGSDefaultConnectionForThread() -> CGSConnectionID

@_silgen_name("CGSSetWindowBackgroundBlurRadius")
@discardableResult
private func CGSSetWindowBackgroundBlurRadius(
    _ connection: CGSConnectionID,
    _ windowNumber: Int32,
    _ radius: Int32
) -> Int32

/// Apply a behind-window Gaussian blur to the given window.
/// Radius 0 disables the extra blur. Used by iTerm2, Alacritty, etc.
func applyBackgroundBlur(radius: Int, to window: NSWindow) {
    let connection = CGSDefaultConnectionForThread()
    CGSSetWindowBackgroundBlurRadius(connection, Int32(window.windowNumber), Int32(radius))
}
