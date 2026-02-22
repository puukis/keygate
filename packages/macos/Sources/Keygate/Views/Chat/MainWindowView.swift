import SwiftUI

/// The main full-window layout — sidebar + chat.
struct MainWindowView: View {
    @EnvironmentObject var gateway: GatewayService
    @EnvironmentObject var store: SessionStore
    @AppStorage("backgroundMaterial") private var backgroundMaterial: Int = AppearanceMaterial.headerView.rawValue
    @AppStorage("vibrancyEnabled") private var vibrancyEnabled: Bool = true
    @AppStorage("windowOpacity") private var windowOpacity: Double = 1.0
    @AppStorage("backgroundBlur") private var backgroundBlur: Double = 0.0

    private var resolvedMaterial: NSVisualEffectView.Material {
        (AppearanceMaterial(rawValue: backgroundMaterial) ?? .headerView).nsMaterial
    }

    var body: some View {
        NavigationSplitView {
            SessionSidebar()
        } detail: {
            if let session = store.activeSession {
                ChatView(session: session)
            } else {
                emptyState
            }
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 680, minHeight: 500)
        .background {
            if vibrancyEnabled {
                VisualEffectView(
                    material: resolvedMaterial,
                    blendingMode: .behindWindow
                )
                .opacity(windowOpacity)
            } else {
                Color(nsColor: .windowBackgroundColor)
                    .opacity(windowOpacity)
            }
        }
        .onAppear {
            configureWindowTransparency(blurRadius: Int(backgroundBlur))
        }
        .onChange(of: windowOpacity) {
            configureWindowTransparency(blurRadius: Int(backgroundBlur))
        }
        .onChange(of: vibrancyEnabled) {
            configureWindowTransparency(blurRadius: Int(backgroundBlur))
        }
        .onChange(of: backgroundBlur) {
            configureWindowTransparency(blurRadius: Int(backgroundBlur))
        }
    }

    private var emptyState: some View {
        VStack(spacing: 16) {
            Image(systemName: "diamond.fill")
                .font(.system(size: 40))
                .foregroundStyle(
                    .linearGradient(
                        colors: [.purple, .indigo],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )

            Text("Select a session or create a new one")
                .font(.system(size: 14, weight: .medium))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Makes the main window non-opaque so the background opacity slider
/// only affects the background layer — text and controls stay fully visible.
/// Also applies the behind-window Gaussian blur via CGS private API.
private func configureWindowTransparency(blurRadius: Int = 0) {
    for window in NSApp.windows where window.identifier?.rawValue == "main" || window.title == "Keygate" {
        window.isOpaque = false
        window.backgroundColor = .clear
        applyBackgroundBlur(radius: blurRadius, to: window)
    }
}
