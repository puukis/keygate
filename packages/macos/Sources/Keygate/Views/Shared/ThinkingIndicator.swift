import SwiftUI

/// Animated thinking indicator shown while the bot is processing.
struct ThinkingIndicator: View {
    var compact: Bool = false

    @State private var phase: Int = 0
    private let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    HStack(spacing: 3) {
                        ForEach(0..<3) { index in
                            Circle()
                                .fill(Color.purple)
                                .frame(width: compact ? 5 : 6, height: compact ? 5 : 6)
                                .opacity(phase == index ? 1.0 : 0.3)
                                .animation(.easeInOut(duration: 0.3), value: phase)
                        }
                    }

                    Text("Thinking")
                        .font(.system(size: compact ? 11 : 12, weight: .medium))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, compact ? 12 : 14)
                .padding(.vertical, compact ? 8 : 10)
                .background(
                    VisualEffectView(material: .contentBackground, blendingMode: .withinWindow)
                )
                .clipShape(
                    UnevenRoundedRectangle(
                        topLeadingRadius: compact ? 12 : 14,
                        bottomLeadingRadius: 4,
                        bottomTrailingRadius: compact ? 12 : 14,
                        topTrailingRadius: compact ? 12 : 14
                    )
                )
                .overlay(
                    UnevenRoundedRectangle(
                        topLeadingRadius: compact ? 12 : 14,
                        bottomLeadingRadius: 4,
                        bottomTrailingRadius: compact ? 12 : 14,
                        topTrailingRadius: compact ? 12 : 14
                    )
                    .strokeBorder(.quaternary.opacity(0.5), lineWidth: 0.5)
                )
            }

            Spacer(minLength: compact ? 40 : 80)
        }
        .onReceive(timer) { _ in
            phase = (phase + 1) % 3
        }
    }
}
