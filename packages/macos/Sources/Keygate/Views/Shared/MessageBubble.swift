import SwiftUI

/// Shared message bubble used in both popover and full window chat.
struct MessageBubble: View {
    let message: ChatMessage
    var compact: Bool = false

    var body: some View {
        HStack {
            if message.isUser { Spacer(minLength: compact ? 40 : 80) }

            VStack(alignment: message.isUser ? .trailing : .leading, spacing: 4) {
                Text(LocalizedStringKey(message.content))
                    .font(.system(size: compact ? 13 : 14))
                    .lineSpacing(3)
                    .textSelection(.enabled)
                    .padding(.horizontal, compact ? 12 : 14)
                    .padding(.vertical, compact ? 8 : 10)
                    .background(bubbleBackground)
                    .clipShape(bubbleShape)
                    .foregroundStyle(message.isUser ? .white : .primary)
                    .overlay(
                        !message.isUser
                            ? bubbleShape.strokeBorder(.quaternary.opacity(0.5), lineWidth: 0.5)
                            : nil
                    )
            }

            if message.isAssistant { Spacer(minLength: compact ? 40 : 80) }
        }
    }

    @ViewBuilder
    private var bubbleBackground: some View {
        if message.isUser {
            LinearGradient(
                colors: [Color.purple.opacity(0.85), Color.indigo.opacity(0.9)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        } else {
            VisualEffectView(material: .contentBackground, blendingMode: .withinWindow)
        }
    }

    private var bubbleShape: UnevenRoundedRectangle {
        if message.isUser {
            UnevenRoundedRectangle(
                topLeadingRadius: compact ? 12 : 14,
                bottomLeadingRadius: compact ? 12 : 14,
                bottomTrailingRadius: 4,
                topTrailingRadius: compact ? 12 : 14
            )
        } else {
            UnevenRoundedRectangle(
                topLeadingRadius: compact ? 12 : 14,
                bottomLeadingRadius: 4,
                bottomTrailingRadius: compact ? 12 : 14,
                topTrailingRadius: compact ? 12 : 14
            )
        }
    }
}

/// Tool activity row shown between messages.
struct ToolActivityRow: View {
    let event: ToolEvent

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: event.isStart ? "bolt.fill" : "checkmark.circle.fill")
                .font(.system(size: 10))
                .foregroundStyle(event.isStart ? .orange : .green)

            Text(event.isStart ? "Running" : "Completed")
                .font(.system(size: 11, weight: .medium))
                .foregroundStyle(.secondary)

            Text(event.tool)
                .font(.system(size: 11, design: .monospaced))
                .foregroundStyle(.tertiary)

            if let result = event.result, let output = result.output, !output.isEmpty {
                Text("— \(output.prefix(50))")
                    .font(.system(size: 11))
                    .foregroundStyle(.quaternary)
                    .lineLimit(1)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 5)
        .background(.purple.opacity(0.06))
        .clipShape(RoundedRectangle(cornerRadius: 6))
        .overlay(
            HStack(spacing: 0) {
                Rectangle().fill(.purple.opacity(0.3)).frame(width: 2)
                Spacer()
            }
        )
    }
}
