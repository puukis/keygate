import SwiftUI

/// Confirmation dialog overlay for tool approvals.
struct ConfirmationOverlay: View {
    let confirmation: PendingConfirmation
    let onAllow: () -> Void
    let onAllowAlways: () -> Void
    let onDeny: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            HStack {
                Image(systemName: "exclamationmark.shield.fill")
                    .font(.system(size: 18))
                    .foregroundStyle(.orange)
                Text("Approval Required")
                    .font(.system(size: 15, weight: .semibold))
                Spacer()
            }

            Text(confirmation.prompt)
                .font(.system(size: 13))
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)

            if let details = confirmation.details {
                VStack(alignment: .leading, spacing: 6) {
                    if let tool = details.tool {
                        DetailRow(label: "Tool", value: tool)
                    }
                    if let command = details.command {
                        DetailRow(label: "Command", value: command, mono: true)
                    }
                    if let cwd = details.cwd {
                        DetailRow(label: "Working Dir", value: cwd, mono: true)
                    }
                    if let path = details.path {
                        DetailRow(label: "Path", value: path, mono: true)
                    }
                    if let summary = details.summary {
                        DetailRow(label: "Summary", value: summary)
                    }
                }
                .padding(12)
                .background(.ultraThinMaterial)
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(
                    RoundedRectangle(cornerRadius: 8)
                        .strokeBorder(.quaternary, lineWidth: 0.5)
                )
            }

            HStack(spacing: 8) {
                Button("Deny") { onDeny() }
                    .buttonStyle(KGButtonStyle(role: .destructive))

                Spacer()

                Button("Allow Always") { onAllowAlways() }
                    .buttonStyle(KGButtonStyle(role: .secondary))

                Button("Allow Once") { onAllow() }
                    .buttonStyle(KGButtonStyle(role: .primary))
            }
        }
        .padding(20)
        .frame(maxWidth: 420)
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.3), radius: 30, y: 10)
        .overlay(
            RoundedRectangle(cornerRadius: 14)
                .strokeBorder(.quaternary.opacity(0.5), lineWidth: 0.5)
        )
    }
}

private struct DetailRow: View {
    let label: String
    let value: String
    var mono: Bool = false

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(label)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.tertiary)
                .frame(width: 70, alignment: .trailing)

            Text(value)
                .font(.system(size: 12, design: mono ? .monospaced : .default))
                .foregroundStyle(.primary)
                .textSelection(.enabled)
        }
    }
}

// MARK: - Button Style

enum KGButtonRole {
    case primary, secondary, destructive
}

struct KGButtonStyle: ButtonStyle {
    let role: KGButtonRole

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: .medium))
            .padding(.horizontal, 14)
            .padding(.vertical, 6)
            .background(background(pressed: configuration.isPressed))
            .foregroundStyle(foreground)
            .clipShape(RoundedRectangle(cornerRadius: 7))
            .overlay(
                role == .secondary
                    ? RoundedRectangle(cornerRadius: 7).strokeBorder(.quaternary, lineWidth: 0.5)
                    : nil
            )
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.spring(duration: 0.15), value: configuration.isPressed)
    }

    @ViewBuilder
    private func background(pressed: Bool) -> some View {
        switch role {
        case .primary:
            LinearGradient(
                colors: [.purple, .indigo],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            ).opacity(pressed ? 0.8 : 1)
        case .secondary:
            Color.primary.opacity(pressed ? 0.08 : 0.04)
        case .destructive:
            Color.red.opacity(pressed ? 0.25 : 0.15)
        }
    }

    private var foreground: Color {
        switch role {
        case .primary: .white
        case .secondary: .secondary
        case .destructive: .red
        }
    }
}
