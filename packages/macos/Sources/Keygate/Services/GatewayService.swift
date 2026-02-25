import Foundation
import SwiftUI
import os
import UniformTypeIdentifiers

/// Connection state for the gateway.
enum ConnectionState: Equatable {
    case disconnected
    case connecting
    case connected
    case error(String)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }
}

/// Pending confirmation from the server.
struct PendingConfirmation: Identifiable {
    let id = UUID()
    let sessionId: String
    let prompt: String
    let details: ConfirmDetails?
}

/// Central service connecting the macOS app to the Keygate gateway over WebSocket.
@MainActor
final class GatewayService: ObservableObject {
    static let shared = GatewayService()

    private let logger = Logger(subsystem: "dev.keygate.app", category: "Gateway")
    private var client: WebSocketClient?

    // Connection
    @Published var connectionState: ConnectionState = .disconnected
    @Published var sessionId: String?

    // Server state
    @Published var mode: SecurityMode = .safe
    @Published var spicyEnabled = false
    @Published var spicyObedienceEnabled = false
    @Published var llmConfig: LLMConfig?
    @Published var availableModels: [ModelInfo] = []
    @Published var discordConfig: ChannelConfig?
    @Published var slackConfig: SlackConfig?
    @Published var browserConfig: BrowserConfig?
    @Published var skillsConfig: SkillsConfig?

    // Streaming state per session
    @Published var streamingSessionId: String?
    @Published var streamBuffer: String = ""
    @Published var uploadSessionId: String?

    // Tool activity
    @Published var activeTools: [String: String] = [:] // sessionId -> tool name

    // Confirmations
    @Published var pendingConfirmation: PendingConfirmation?

    // Pending message waiting for session creation
    @Published var pendingSendMessage: String?

    // Context usage
    @Published var contextUsage: ContextUsagePayload?

    let host: String
    let port: Int

    private init() {
        self.host = ProcessInfo.processInfo.environment["KEYGATE_HOST"] ?? "127.0.0.1"
        self.port = Int(ProcessInfo.processInfo.environment["KEYGATE_PORT"] ?? "18790") ?? 18790
    }

    var baseURL: URL {
        URL(string: "http://\(host):\(port)")!
    }

    var wsURL: URL {
        URL(string: "ws://\(host):\(port)/ws")!
    }

    // MARK: - Connection

    func connect() {
        connectionState = .connecting
        let ws = WebSocketClient(url: wsURL)

        ws.onConnect = { [weak self] in
            self?.connectionState = .connected
            self?.logger.info("Gateway connected")
        }

        ws.onDisconnect = { [weak self] in
            self?.connectionState = .disconnected
            self?.logger.info("Gateway disconnected — will retry")
        }

        ws.onMessage = { [weak self] message in
            self?.handleMessage(message)
        }

        client = ws
        ws.connect()
    }

    func disconnect() {
        client?.disconnect()
        client = nil
        connectionState = .disconnected
    }

    // MARK: - Send

    func send(_ message: ClientMessage) {
        client?.send(message)
    }

    func sendMessage(_ content: String, attachments: [Attachment]? = nil) {
        // Optimistically show the user's message immediately
        if let sid = sessionId {
            let msg = ChatMessage(role: "user", content: content, attachments: attachments)
            SessionStore.shared.appendMessage(sessionId: sid, message: msg)
        }
        send(.message(content: content, attachments: attachments))
    }

    func cancelSession(_ id: String) {
        send(.cancelSession(sessionId: normalizeSessionId(id)))
    }

    func cancelActiveSessionRun() {
        guard let activeId = SessionStore.shared.activeSessionId ?? sessionId else {
            return
        }
        cancelSession(activeId)
    }

    func uploadImageAttachment(fileURL: URL, sessionId: String) async throws -> Attachment {
        let payload = try Data(contentsOf: fileURL)
        if payload.isEmpty {
            throw NSError(domain: "GatewayService", code: 1, userInfo: [NSLocalizedDescriptionKey: "Attachment payload is empty."])
        }

        var components = URLComponents(url: baseURL.appendingPathComponent("api/uploads/image"), resolvingAgainstBaseURL: false)
        components?.queryItems = [URLQueryItem(name: "sessionId", value: sessionId)]
        guard let uploadURL = components?.url else {
            throw NSError(domain: "GatewayService", code: 2, userInfo: [NSLocalizedDescriptionKey: "Failed to build upload URL."])
        }

        var request = URLRequest(url: uploadURL)
        request.httpMethod = "POST"
        request.setValue(mimeType(for: fileURL), forHTTPHeaderField: "Content-Type")

        let (responseData, response) = try await URLSession.shared.upload(for: request, from: payload)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw NSError(domain: "GatewayService", code: 3, userInfo: [NSLocalizedDescriptionKey: "Upload response was invalid."])
        }

        guard (200..<300).contains(httpResponse.statusCode) else {
            let uploadError = decodeServerUploadError(responseData) ?? "Image upload failed (\(httpResponse.statusCode))."
            throw NSError(domain: "GatewayService", code: httpResponse.statusCode, userInfo: [NSLocalizedDescriptionKey: uploadError])
        }

        do {
            return try JSONDecoder().decode(Attachment.self, from: responseData)
        } catch {
            throw NSError(domain: "GatewayService", code: 4, userInfo: [NSLocalizedDescriptionKey: "Upload response was malformed."])
        }
    }

    func confirmAllow() {
        send(.confirmResponse(decision: .allowOnce))
        pendingConfirmation = nil
    }

    func confirmAllowAlways() {
        send(.confirmResponse(decision: .allowAlways))
        pendingConfirmation = nil
    }

    func confirmDeny() {
        send(.confirmResponse(decision: .cancel))
        pendingConfirmation = nil
    }

    func newSession() {
        send(.newSession)
    }

    func switchSession(_ id: String) {
        send(.switchSession(sessionId: normalizeSessionId(id)))
    }

    func deleteSession(_ id: String) {
        send(.deleteSession(sessionId: normalizeSessionId(id)))
    }

    func renameSession(_ id: String, title: String) {
        send(.renameSession(sessionId: normalizeSessionId(id), title: title))
    }

    func clearSession() {
        send(.clearSession)
    }

    func setMode(_ mode: SecurityMode) {
        send(.setMode(mode))
    }

    func setModel(provider: String?, model: String, reasoningEffort: String? = nil) {
        send(.setModel(provider: provider, model: model, reasoningEffort: reasoningEffort))
    }

    func requestModels(provider: String? = nil) {
        send(.getModels(provider: provider))
    }

    // MARK: - Message handling

    /// Canonicalize session IDs so web sessions always use the "web:" prefix.
    private func normalizeSessionId(_ id: String) -> String {
        let trimmed = id.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return id }
        return trimmed.contains(":") ? trimmed : "web:\(trimmed)"
    }

    private func handleMessage(_ message: ServerMessage) {
        switch message {
        case .connected(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            uploadSessionId = sid
            sessionId = sid
            SessionStore.shared.ensureSession(id: sid)
            SessionStore.shared.activeSessionId = sid
            mode = payload.mode
            spicyEnabled = payload.spicyEnabled ?? false
            spicyObedienceEnabled = payload.spicyObedienceEnabled ?? false
            llmConfig = payload.llm
            discordConfig = payload.discord
            slackConfig = payload.slack
            browserConfig = payload.browser
            skillsConfig = payload.skills
            requestModels(provider: payload.llm.provider)

        case .sessionSnapshot(let payload):
            SessionStore.shared.updateSessions(payload.sessions)
            // Ensure activeSessionId is set if the store doesn't have one yet
            if SessionStore.shared.activeSessionId == nil, let sid = sessionId {
                SessionStore.shared.activeSessionId = sid
            }

        case .sessionChunk(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            streamingSessionId = sid
            streamBuffer += payload.content
            SessionStore.shared.appendStreamChunk(
                sessionId: sid,
                chunk: payload.content
            )

        case .sessionMessageEnd(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            streamingSessionId = nil
            streamBuffer = ""
            SessionStore.shared.finalizeStream(
                sessionId: sid,
                content: payload.content
            )

        case .sessionCancelled(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            if streamingSessionId == sid {
                streamingSessionId = nil
            }
            streamBuffer = ""
            SessionStore.shared.cancelStream(sessionId: sid)

        case .sessionUserMessage(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            // Skip if we already optimistically inserted this message
            let isDuplicate = SessionStore.shared.lastMessage(sessionId: sid, role: "user")?.content == payload.content
            if !isDuplicate {
                let msg = ChatMessage(
                    role: "user",
                    content: payload.content,
                    attachments: payload.attachments
                )
                SessionStore.shared.appendMessage(sessionId: sid, message: msg)
            }

        case .messageReceived(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            SessionStore.shared.setThinking(sessionId: sid, true)

        case .confirmRequest(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            pendingConfirmation = PendingConfirmation(
                sessionId: sid,
                prompt: payload.prompt,
                details: payload.details
            )

        case .toolStart(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            activeTools[sid] = payload.tool
            SessionStore.shared.addToolEvent(
                sessionId: sid,
                tool: payload.tool,
                isStart: true
            )

        case .toolEnd(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            activeTools.removeValue(forKey: sid)
            SessionStore.shared.addToolEvent(
                sessionId: sid,
                tool: payload.tool,
                isStart: false,
                result: payload.result
            )

        case .modeChanged(let payload):
            mode = payload.mode

        case .modelChanged(let payload):
            llmConfig = payload.llm

        case .models(let payload):
            availableModels = payload.models

        case .sessionCreated(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            uploadSessionId = sid
            sessionId = sid
            SessionStore.shared.ensureSession(id: sid)
            SessionStore.shared.activeSessionId = sid
            // Send any message that was waiting for session creation
            if let pending = pendingSendMessage {
                pendingSendMessage = nil
                sendMessage(pending)
            }

        case .sessionSwitched(let payload):
            let sid = normalizeSessionId(payload.sessionId)
            uploadSessionId = sid
            sessionId = sid
            SessionStore.shared.activeSessionId = sid

        case .sessionDeleted(let payload):
            SessionStore.shared.removeSession(sessionId: normalizeSessionId(payload.sessionId))

        case .sessionRenamed(let payload):
            SessionStore.shared.renameSession(
                sessionId: normalizeSessionId(payload.sessionId),
                title: payload.title
            )

        case .sessionCleared(let payload):
            SessionStore.shared.clearMessages(sessionId: normalizeSessionId(payload.sessionId))

        case .contextUsage(let payload):
            // contextUsage sessionId also needs normalization for matching
            contextUsage = ContextUsagePayload(
                sessionId: normalizeSessionId(payload.sessionId),
                usedTokens: payload.usedTokens,
                limitTokens: payload.limitTokens,
                percent: payload.percent
            )

        case .mcpBrowserStatus(let payload):
            browserConfig = payload.browser

        case .error(let payload):
            logger.error("Server error: \(payload.error)")

        case .unknown(let type):
            logger.debug("Unknown message type: \(type)")
        }
    }

    private func decodeServerUploadError(_ data: Data) -> String? {
        guard
            let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let error = object["error"] as? String
        else {
            return nil
        }
        return error
    }

    private func mimeType(for fileURL: URL) -> String {
        let ext = fileURL.pathExtension.lowercased()
        if let type = UTType(filenameExtension: ext), let preferred = type.preferredMIMEType {
            return preferred
        }
        return "application/octet-stream"
    }
}
