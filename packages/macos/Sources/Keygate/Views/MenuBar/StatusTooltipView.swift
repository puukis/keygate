import SwiftUI

/// Custom styled tooltip that appears on hover over the tray icon.
/// Matches the dark rounded HUD aesthetic with status dot + activity info.
struct StatusTooltipView: View {
    let connectionState: ConnectionState
    let isStreaming: Bool
    let isThinking: Bool
    let activeToolName: String?
    let sessionTitle: String?
    let messageCount: Int

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Circle()
                        .fill(statusColor)
                        .frame(width: 8, height: 8)
                        .shadow(color: statusColor.opacity(0.5), radius: 3)

                    Text(statusLabel)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.white)
                }

                Text(activityLabel)
                    .font(.system(size: 11))
                    .foregroundStyle(.white.opacity(0.5))
            }

            Spacer()

            Image(systemName: statusIcon)
                .font(.system(size: 16))
                .foregroundStyle(.white.opacity(0.35))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .frame(minWidth: 200)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.black.opacity(0.85))
        )
    }

    // MARK: - Computed

    private var statusLabel: String {
        switch connectionState {
        case .connected:
            if activeToolName != nil { return "Working" }
            if isStreaming { return "Responding" }
            if isThinking { return "Thinking" }
            return "Idle"
        case .connecting:   return "Connecting"
        case .disconnected: return "Disconnected"
        case .error:        return "Error"
        }
    }

    private var statusColor: Color {
        switch connectionState {
        case .connected:
            if activeToolName != nil || isStreaming || isThinking {
                return .purple
            }
            return .green
        case .connecting:   return .orange
        case .disconnected: return .gray
        case .error:        return .red
        }
    }

    private var statusIcon: String {
        switch connectionState {
        case .connected:
            if activeToolName != nil { return "bolt.fill" }
            if isStreaming { return "text.bubble.fill" }
            if isThinking { return "brain" }
            return "moon.zzz.fill"
        case .connecting:   return "arrow.triangle.2.circlepath"
        case .disconnected: return "wifi.slash"
        case .error:        return "exclamationmark.triangle.fill"
        }
    }

    private var activityLabel: String {
        if let tool = activeToolName {
            return "Running \(tool)"
        }
        if isStreaming {
            return "Generating response…"
        }
        if isThinking {
            return "Processing request…"
        }

        if let title = sessionTitle, messageCount > 0 {
            return "\(title) · \(messageCount) msg\(messageCount == 1 ? "" : "s")"
        }

        return "No recent activity"
    }
}
