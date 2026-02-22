import AppKit
import SwiftUI

/// Opens a floating panel window (like 1Password / Spotlight).
/// Used for the HUD overlay or detachable chat.
final class FloatingPanel: NSPanel {
    init(contentRect: NSRect) {
        super.init(
            contentRect: contentRect,
            styleMask: [.nonactivatingPanel, .titled, .closable, .fullSizeContentView, .resizable],
            backing: .buffered,
            defer: false
        )

        isFloatingPanel = true
        level = .floating
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        isReleasedWhenClosed = false
        animationBehavior = .utilityWindow
        backgroundColor = .clear
        hasShadow = true
    }
}

/// Manages showing/hiding a SwiftUI view in a floating panel.
@MainActor
final class FloatingPanelManager: ObservableObject {
    private var panel: FloatingPanel?
    @Published var alwaysOnTop: Bool = true

    func show<V: View>(size: CGSize = CGSize(width: 380, height: 520), @ViewBuilder content: () -> V) {
        if let panel, panel.isVisible {
            panel.orderOut(nil)
            return
        }

        let rect = NSRect(origin: .zero, size: size)
        let panel = FloatingPanel(contentRect: rect)
        panel.level = alwaysOnTop ? .floating : .normal
        let host = NSHostingView(rootView: AnyView(content()))
        panel.contentView = host
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        self.panel = panel
    }

    func setAlwaysOnTop(_ value: Bool) {
        alwaysOnTop = value
        panel?.level = value ? .floating : .normal
    }

    func close() {
        panel?.orderOut(nil)
        panel = nil
    }
}
