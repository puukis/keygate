import Foundation
import os

/// Manages the local gateway process lifecycle — starting, stopping, health checks.
@MainActor
final class GatewayLifecycle: ObservableObject {
    static let shared = GatewayLifecycle()

    private let logger = Logger(subsystem: "dev.keygate.app", category: "Lifecycle")

    @Published var gatewayRunning = false

    private let host: String
    private let port: Int

    private init() {
        self.host = ProcessInfo.processInfo.environment["KEYGATE_HOST"] ?? "127.0.0.1"
        self.port = Int(ProcessInfo.processInfo.environment["KEYGATE_PORT"] ?? "18790") ?? 18790
    }

    var statusURL: URL {
        URL(string: "http://\(host):\(port)/api/status")!
    }

    /// Check whether the gateway HTTP server is reachable.
    func checkHealth() async -> Bool {
        var request = URLRequest(url: statusURL)
        request.timeoutInterval = 3
        do {
            let (_, response) = try await URLSession.shared.data(for: request)
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            gatewayRunning = ok
            return ok
        } catch {
            gatewayRunning = false
            return false
        }
    }

    /// Attempt to start the gateway using the launchd-managed plist (keygate gateway open).
    /// Falls back to running `keygate serve` directly if the CLI is on PATH.
    func startGateway() async throws {
        // First check if it's already up
        if await checkHealth() {
            logger.info("Gateway already running")
            return
        }

        // Try the CLI command — `keygate gateway open` handles launchd management
        let cliPath = findKeygateCliPath()
        guard let cliPath else {
            throw GatewayError.cliNotFound
        }

        logger.info("Starting gateway via: \(cliPath) gateway open")

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cliPath)
        process.arguments = ["gateway", "open"]
        process.environment = ProcessInfo.processInfo.environment
        // Suppress opening the browser
        process.environment?["KEYGATE_OPEN_CHAT_ON_START"] = "false"

        try process.run()
        process.waitUntilExit()

        // Wait briefly then confirm health
        try await Task.sleep(for: .seconds(2))

        let healthy = await checkHealth()
        if !healthy {
            throw GatewayError.startFailed
        }
    }

    /// Stop the running gateway via `keygate gateway close`.
    func stopGateway() async throws {
        guard let cliPath = findKeygateCliPath() else {
            throw GatewayError.cliNotFound
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: cliPath)
        process.arguments = ["gateway", "close"]
        process.environment = ProcessInfo.processInfo.environment

        try process.run()
        process.waitUntilExit()
        gatewayRunning = false
    }

    // MARK: - Helpers

    /// Look for `keygate` in PATH, common homebrew locations, or the local monorepo.
    private func findKeygateCliPath() -> String? {
        // Check PATH
        if let pathResult = shell("which keygate"), !pathResult.isEmpty {
            return pathResult.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Common locations
        let candidates = [
            "/usr/local/bin/keygate",
            "\(NSHomeDirectory())/.local/bin/keygate",
            "/opt/homebrew/bin/keygate",
        ]

        for candidate in candidates {
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }

        return nil
    }

    private func shell(_ command: String) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/zsh")
        process.arguments = ["-l", "-c", command]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice

        do {
            try process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            return String(data: data, encoding: .utf8)
        } catch {
            return nil
        }
    }
}

enum GatewayError: LocalizedError {
    case cliNotFound
    case startFailed

    var errorDescription: String? {
        switch self {
        case .cliNotFound:
            return "Could not find the keygate CLI. Install it with: curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash"
        case .startFailed:
            return "Gateway started but failed health check. Check logs."
        }
    }
}
