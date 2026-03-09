import Foundation

func reasoningEffortDisplayLabel(_ effort: String) -> String {
    let normalized = effort
        .trimmingCharacters(in: .whitespacesAndNewlines)
        .lowercased()

    switch normalized {
    case "low":
        return "Low"
    case "medium":
        return "Medium"
    case "high":
        return "High"
    case "xhigh", "extra-high", "extra_high", "extra high":
        return "Extra High"
    default:
        let cleaned = normalized
            .replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")

        return cleaned.isEmpty ? effort : cleaned.capitalized
    }
}
