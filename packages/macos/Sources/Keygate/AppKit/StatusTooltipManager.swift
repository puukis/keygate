import AppKit
import SwiftUI

/// Manages a custom tooltip window that appears near the status item on hover.
/// Uses `NSTrackingArea` on the status item window for reliable hover detection.
@MainActor
final class StatusTooltipManager {
    private var tooltipWindow: NSWindow?
    private var trackerView: HoverTrackerView?
    private var statusItemWindow: NSWindow?
    private var hideTask: Task<Void, Never>?
    private var isVisible = false
    private var retryCount = 0

    /// Attach hover tracking to the status item's window.
    /// Call once after the MenuBarExtra has been created.
    func attachTracking() {
        findAndAttachTracker()
    }

    func teardown() {
        trackerView?.removeFromSuperview()
        trackerView = nil
        tooltipWindow?.orderOut(nil)
        tooltipWindow = nil
        hideTask?.cancel()
    }

    // MARK: - Find status item

    private func findAndAttachTracker() {
        // The MenuBarExtra creates an NSStatusBarWindow — find it by class name
        for window in NSApp.windows {
            let className = String(describing: type(of: window))

            // SwiftUI's MenuBarExtra uses _NSStatusBarWindow or similar
            if className.contains("StatusBar") {
                attachTracker(to: window)
                return
            }
        }

        // Fallback: look for tiny windows at the very top of the screen (menu bar area)
        if let screen = NSScreen.main {
            let menuBarTop = screen.frame.maxY
            for window in NSApp.windows {
                let frame = window.frame
                // Status item windows are small and at the top
                guard frame.height <= 30, frame.width < 100 else { continue }
                guard frame.maxY >= menuBarTop - 2 else { continue }
                // Skip our own tooltip window
                guard window !== tooltipWindow else { continue }

                attachTracker(to: window)
                return
            }
        }

        // Retry a few times — MenuBarExtra might not have created the window yet
        retryCount += 1
        if retryCount < 10 {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.findAndAttachTracker()
            }
        }
    }

    private func attachTracker(to window: NSWindow) {
        guard let contentView = window.contentView else { return }
        statusItemWindow = window

        let tracker = HoverTrackerView(frame: contentView.bounds, manager: self)
        tracker.autoresizingMask = [.width, .height]
        contentView.addSubview(tracker, positioned: .above, relativeTo: nil)
        trackerView = tracker
    }

    // MARK: - Show / Hide

    func handleMouseEntered() {
        hideTask?.cancel()
        hideTask = nil

        guard let statusFrame = statusItemWindow?.frame else { return }

        if isVisible {
            // Just update content + position
            updateContent()
            updatePosition(near: statusFrame)
            return
        }

        let view = makeTooltipView()
        let hostingView = NSHostingView(rootView: view)
        hostingView.frame.size = hostingView.fittingSize

        let window = NSWindow(
            contentRect: NSRect(origin: .zero, size: hostingView.fittingSize),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        window.contentView = hostingView
        window.backgroundColor = .clear
        window.isOpaque = false
        window.hasShadow = true
        window.level = .floating
        window.collectionBehavior = [.canJoinAllSpaces, .stationary]
        window.isReleasedWhenClosed = false
        window.ignoresMouseEvents = true

        // Position just below the status item, centered
        let tooltipSize = hostingView.fittingSize
        let x = statusFrame.midX - tooltipSize.width / 2
        let y = statusFrame.minY - tooltipSize.height - 4
        window.setFrameOrigin(NSPoint(x: x, y: y))

        window.alphaValue = 0
        window.orderFront(nil)

        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 1
        }

        tooltipWindow = window
        isVisible = true
    }

    func handleMouseExited() {
        guard isVisible, let window = tooltipWindow else { return }

        hideTask?.cancel()
        hideTask = Task { @MainActor in
            // Brief delay to prevent flicker
            try? await Task.sleep(nanoseconds: 150_000_000)
            guard !Task.isCancelled else { return }

            NSAnimationContext.runAnimationGroup({ ctx in
                ctx.duration = 0.12
                ctx.timingFunction = CAMediaTimingFunction(name: .easeIn)
                window.animator().alphaValue = 0
            }, completionHandler: {
                MainActor.assumeIsolated { [weak self] in
                    window.orderOut(nil)
                    self?.isVisible = false
                }
            })
        }
    }

    /// Update tooltip content when state changes.
    func updateContent() {
        guard let window = tooltipWindow, isVisible else { return }

        let view = makeTooltipView()
        let hostingView = NSHostingView(rootView: view)
        hostingView.frame.size = hostingView.fittingSize

        let oldFrame = window.frame
        window.contentView = hostingView
        let newSize = hostingView.fittingSize
        let x = oldFrame.midX - newSize.width / 2
        let y = oldFrame.maxY - newSize.height
        window.setFrame(NSRect(origin: NSPoint(x: x, y: y), size: newSize), display: true)
    }

    // MARK: - Private

    private func updatePosition(near statusFrame: NSRect) {
        guard let window = tooltipWindow else { return }
        let size = window.frame.size
        let x = statusFrame.midX - size.width / 2
        let y = statusFrame.minY - size.height - 4
        window.setFrameOrigin(NSPoint(x: x, y: y))
    }

    private func makeTooltipView() -> StatusTooltipView {
        let gateway = GatewayService.shared
        let store = SessionStore.shared

        let activeToolName = gateway.activeTools.values.first
        var sessionTitle: String?
        var messageCount = 0

        if let sid = store.activeSessionId,
           let session = store.sessions.first(where: { $0.sessionId == sid }) {
            sessionTitle = session.displayTitle
            messageCount = session.messages.count
        }

        return StatusTooltipView(
            connectionState: gateway.connectionState,
            isStreaming: store.activeIsStreaming,
            isThinking: store.activeIsThinking,
            activeToolName: activeToolName,
            sessionTitle: sessionTitle,
            messageCount: messageCount
        )
    }
}

// MARK: - Hover Tracker NSView

/// Transparent NSView overlay that detects mouse enter/exit via NSTrackingArea.
private class HoverTrackerView: NSView {
    private weak var manager: StatusTooltipManager?

    init(frame: NSRect, manager: StatusTooltipManager) {
        self.manager = manager
        super.init(frame: frame)

        let area = NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        )
        addTrackingArea(area)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError() }

    override func mouseEntered(with event: NSEvent) {
        Task { @MainActor in
            manager?.handleMouseEntered()
        }
    }

    override func mouseExited(with event: NSEvent) {
        Task { @MainActor in
            manager?.handleMouseExited()
        }
    }

    // Stay transparent / non-interactive for clicks
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}
