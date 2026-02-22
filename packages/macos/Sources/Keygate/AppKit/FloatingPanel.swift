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
final class FloatingPanelManager<Content: View>: ObservableObject {
    private var panel: FloatingPanel?

    func show(size: CGSize = CGSize(width: 380, height: 520), content: () -> Content) {
        if let panel, panel.isVisible {
            panel.orderOut(nil)
            return
        }

        let rect = NSRect(origin: .zero, size: size)
        let panel = FloatingPanel(contentRect: rect)
        let host = NSHostingView(rootView: content())
        panel.contentView = host
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        self.panel = panel
    }

    func close() {
        panel?.orderOut(nil)
        panel = nil
    }
}
