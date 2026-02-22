import SwiftUI

/// Animated tray icon — shows connection state.
struct StatusItemLabel: View {
    let state: ConnectionState

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: iconName)
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(iconColor)

            if case .connecting = state {
                // Subtle pulse for connecting state
                Circle()
                    .fill(.orange)
                    .frame(width: 4, height: 4)
                    .opacity(0.8)
            }
        }
    }

    private var iconName: String {
        switch state {
        case .connected:    "diamond.fill"
        case .connecting:   "diamond"
        case .disconnected: "diamond"
        case .error:        "exclamationmark.diamond"
        }
    }

    private var iconColor: Color {
        switch state {
        case .connected:    .primary
        case .connecting:   .orange
        case .disconnected: .secondary
        case .error:        .red
        }
    }
}
