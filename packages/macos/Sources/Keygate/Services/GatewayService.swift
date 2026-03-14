import AppKit
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
    @Published var runtimeStatus: RuntimeStatusPayload?
    @Published var canvasSurfaces: [CanvasStatePayload] = []
    @Published var recentChannelActions: [ChannelActionPayload] = []
    @Published var channelPolls: [ChannelPollPayload] = []
    @Published var activeVoiceSessions: [VoiceSessionPayload] = []

    // Confirmations
    @Published var pendingConfirmation: PendingConfirmation?

    // Pending message waiting for session creation
    @Published var pendingSendMessage: String?

    // Context usage
    @Published var contextUsage: ContextUsagePayload?
    @Published var nodePairRequest: NodePairRequest?
    @Published var nodeRecord: NodeRecord?
    @Published var nodeCapabilitySelection: Set<NodeCapability> = Set(NodeCapability.allCases.filter { $0 != .invoke })
    @Published var nodePermissions: [String: String] = [:]
    @Published var nodeLastInvocationStatus: String = ""
    @Published var sessionDebugEvents: [DebugEvent] = []

    let host: String
    let port: Int
    private let nodeRuntime = MacNodeRuntime()
    private var nodeHeartbeatTask: Task<Void, Never>?
    private var statusRefreshTask: Task<Void, Never>?

    private init() {
        self.host = ProcessInfo.processInfo.environment["KEYGATE_HOST"] ?? "127.0.0.1"
        self.port = Int(ProcessInfo.processInfo.environment["KEYGATE_PORT"] ?? "18790") ?? 18790
        if let saved = LocalNodeStore.loadCapabilitySelection() {
            self.nodeCapabilitySelection = saved
        }
        if let credentials = LocalNodeStore.loadCredentials() {
            self.nodeRecord = NodeRecord(
                id: credentials.nodeId,
                name: credentials.name,
                capabilities: credentials.capabilities,
                trusted: true,
                authToken: credentials.authToken,
                platform: credentials.platform,
                version: credentials.version,
                online: false,
                permissions: nil,
                createdAt: "",
                updatedAt: "",
                lastSeenAt: "",
                lastInvocationAt: nil
            )
        }
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
            Task {
                await self?.refreshNodeRegistration(forceHeartbeat: false)
                await self?.refreshRuntimeStatus()
                self?.startStatusRefreshLoop()
            }
        }

        ws.onDisconnect = { [weak self] in
            self?.connectionState = .disconnected
            self?.logger.info("Gateway disconnected — will retry")
            self?.nodeHeartbeatTask?.cancel()
            self?.statusRefreshTask?.cancel()
            if let current = self?.nodeRecord {
                self?.nodeRecord = NodeRecord(
                    id: current.id,
                    name: current.name,
                    capabilities: current.capabilities,
                    trusted: current.trusted,
                    authToken: current.authToken,
                    platform: current.platform,
                    version: current.version,
                    online: false,
                    permissions: current.permissions,
                    createdAt: current.createdAt,
                    updatedAt: current.updatedAt,
                    lastSeenAt: current.lastSeenAt,
                    lastInvocationAt: current.lastInvocationAt
                )
            }
        }

        ws.onMessage = { [weak self] message in
            self?.handleMessage(message)
        }

        client = ws
        ws.connect()
    }

    func disconnect() {
        nodeHeartbeatTask?.cancel()
        statusRefreshTask?.cancel()
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

    func uploadAttachment(fileURL: URL, sessionId: String) async throws -> Attachment {
        let payload = try Data(contentsOf: fileURL)
        if payload.isEmpty {
            throw NSError(domain: "GatewayService", code: 1, userInfo: [NSLocalizedDescriptionKey: "Attachment payload is empty."])
        }

        var components = URLComponents(url: baseURL.appendingPathComponent("api/uploads/attachment"), resolvingAgainstBaseURL: false)
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
            let uploadError = decodeServerUploadError(responseData) ?? "Attachment upload failed (\(httpResponse.statusCode))."
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

    func requestNodePairing() {
        let name = Host.current().localizedName ?? "Keygate Mac"
        let capabilities = Array(nodeCapabilitySelection).sorted { $0.rawValue < $1.rawValue }
        send(.nodePairRequest(nodeName: name, capabilities: capabilities))
    }

    func approveNodePairing() {
        guard let request = nodePairRequest else { return }
        send(.nodePairApprove(requestId: request.requestId, pairingCode: request.pairingCode))
    }

    func forgetPairedNode() {
        LocalNodeStore.clearCredentials()
        nodeRecord = nil
        nodePermissions = [:]
        nodePairRequest = nil
        nodeHeartbeatTask?.cancel()
    }

    func setNodeCapabilityEnabled(_ capability: NodeCapability, enabled: Bool) {
        if enabled {
            nodeCapabilitySelection.insert(capability)
        } else {
            nodeCapabilitySelection.remove(capability)
        }
        LocalNodeStore.saveCapabilitySelection(nodeCapabilitySelection)
    }

    func refreshDebugEvents() {
        guard let activeSession = SessionStore.shared.activeSessionId ?? sessionId else { return }
        send(.debugEvents(sessionId: normalizeSessionId(activeSession)))
    }

    func refreshRuntimeStatusNow() {
        Task { await refreshRuntimeStatus() }
    }

    func activeCanvasSurfaces(for sessionId: String?) -> [CanvasStatePayload] {
        guard let sessionId else { return canvasSurfaces }
        let normalized = normalizeSessionId(sessionId)
        return canvasSurfaces.filter { normalizeSessionId($0.sessionId) == normalized }
    }

    func openCanvasSurface(_ surface: CanvasStatePayload) {
        CanvasWindowManager.shared.present(surface: surface, baseURL: baseURL, reveal: true)
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
            Task { await refreshNodeRegistration(forceHeartbeat: false) }

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

        case .nodePairRequestResult(let payload):
            nodePairRequest = payload.request
            nodeLastInvocationStatus = "Pairing code ready."

        case .nodePairApproveResult(let payload):
            nodePairRequest = nil
            nodeRecord = payload.node
            if let authToken = payload.node.authToken {
                LocalNodeStore.saveCredentials(.init(
                    nodeId: payload.node.id,
                    authToken: authToken,
                    name: payload.node.name,
                    capabilities: payload.node.capabilities,
                    platform: "macOS",
                    version: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
                ))
            }
            Task { await refreshNodeRegistration(forceHeartbeat: false) }

        case .nodeRegisterResult(let payload):
            nodeRecord = payload.node
            if let permissions = payload.node.permissions {
                nodePermissions = permissions.mapValues(\.rawValue)
            }
            startNodeHeartbeat()

        case .nodeInvokeRequest(let payload):
            Task { await handleNodeInvokeRequest(payload) }

        case .nodeStatusChanged(let payload):
            guard payload.nodeId == nodeRecord?.id else { break }
            if let current = nodeRecord {
                nodeRecord = NodeRecord(
                    id: current.id,
                    name: current.name,
                    capabilities: current.capabilities,
                    trusted: current.trusted,
                    authToken: current.authToken,
                    platform: current.platform,
                    version: current.version,
                    online: payload.online,
                    permissions: current.permissions,
                    createdAt: current.createdAt,
                    updatedAt: current.updatedAt,
                    lastSeenAt: payload.lastSeenAt,
                    lastInvocationAt: current.lastInvocationAt
                )
            }

        case .canvasState(let payload):
            let normalized = CanvasStatePayload(
                sessionId: normalizeSessionId(payload.sessionId),
                surfaceId: payload.surfaceId,
                path: payload.path,
                mode: payload.mode,
                state: payload.state,
                statusText: payload.statusText
            )
            let isNewSurface = !canvasSurfaces.contains(where: { $0.id == normalized.id })
            upsertCanvasSurface(normalized)
            CanvasWindowManager.shared.present(surface: normalized, baseURL: baseURL, reveal: isNewSurface)

        case .canvasClose(let payload):
            let sessionId = normalizeSessionId(payload.sessionId)
            removeCanvasSurface(sessionId: sessionId, surfaceId: payload.surfaceId)
            CanvasWindowManager.shared.close(sessionId: sessionId, surfaceId: payload.surfaceId)

        case .channelAction(let payload):
            recordChannelAction(ChannelActionPayload(
                sessionId: normalizeSessionId(payload.sessionId),
                channel: payload.channel,
                action: payload.action,
                ok: payload.ok,
                actionId: payload.actionId,
                accountId: payload.accountId,
                externalMessageId: payload.externalMessageId,
                threadId: payload.threadId,
                pollId: payload.pollId,
                error: payload.error,
                payload: payload.payload
            ))

        case .channelPoll(let payload):
            upsertChannelPoll(ChannelPollPayload(
                id: payload.id,
                sessionId: normalizeSessionId(payload.sessionId),
                channel: payload.channel,
                externalMessageId: payload.externalMessageId,
                question: payload.question,
                options: payload.options,
                multiple: payload.multiple,
                status: payload.status,
                metadata: payload.metadata,
                votes: payload.votes,
                createdAt: payload.createdAt,
                updatedAt: payload.updatedAt
            ))

        case .channelPollVote(let payload):
            applyChannelPollVote(ChannelPollVotePayload(
                sessionId: normalizeSessionId(payload.sessionId),
                pollId: payload.pollId,
                voterId: payload.voterId,
                optionIds: payload.optionIds
            ))

        case .voiceSession(let payload):
            upsertVoiceSession(VoiceSessionPayload(
                sessionId: normalizeSessionId(payload.sessionId),
                guildId: payload.guildId,
                channelId: payload.channelId,
                status: payload.status,
                error: payload.error
            ))

        case .debugEvents(let payload):
            let normalized = normalizeSessionId(payload.sessionId)
            if normalized == SessionStore.shared.activeSessionId || normalized == sessionId {
                sessionDebugEvents = payload.events
            }

        case .debugEvent(let payload):
            let normalized = normalizeSessionId(payload.sessionId)
            guard normalized == SessionStore.shared.activeSessionId || normalized == sessionId else { break }
            sessionDebugEvents.append(payload.event)
            if sessionDebugEvents.count > 200 {
                sessionDebugEvents.removeFirst(sessionDebugEvents.count - 200)
            }

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

    private func startStatusRefreshLoop() {
        statusRefreshTask?.cancel()
        statusRefreshTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled else { return }
                await self.refreshRuntimeStatus()
            }
        }
    }

    private func refreshRuntimeStatus() async {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/status"))
        request.httpMethod = "GET"
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let httpResponse = response as? HTTPURLResponse, (200..<300).contains(httpResponse.statusCode) else {
                return
            }

            let payload = try JSONDecoder().decode(RuntimeStatusPayload.self, from: data)
            runtimeStatus = payload
            if let sessions = payload.voice?.sessions {
                activeVoiceSessions = sessions.map {
                    VoiceSessionPayload(
                        sessionId: normalizeSessionId($0.sessionId),
                        guildId: $0.guildId,
                        channelId: $0.channelId,
                        status: $0.status,
                        error: $0.error
                    )
                }
            }
        } catch {
            logger.debug("Failed to refresh runtime status: \(error.localizedDescription)")
        }
    }

    private func upsertCanvasSurface(_ payload: CanvasStatePayload) {
        if let index = canvasSurfaces.firstIndex(where: { $0.id == payload.id }) {
            canvasSurfaces[index] = payload
        } else {
            canvasSurfaces.append(payload)
        }
        canvasSurfaces.sort { $0.id < $1.id }
    }

    private func removeCanvasSurface(sessionId: String, surfaceId: String) {
        canvasSurfaces.removeAll { normalizeSessionId($0.sessionId) == sessionId && $0.surfaceId == surfaceId }
    }

    private func recordChannelAction(_ payload: ChannelActionPayload) {
        recentChannelActions.insert(payload, at: 0)
        if recentChannelActions.count > 40 {
            recentChannelActions.removeLast(recentChannelActions.count - 40)
        }
    }

    private func upsertChannelPoll(_ payload: ChannelPollPayload) {
        if let index = channelPolls.firstIndex(where: { $0.id == payload.id }) {
            channelPolls[index] = payload
        } else {
            channelPolls.append(payload)
        }
        channelPolls.sort { $0.updatedAt > $1.updatedAt }
    }

    private func applyChannelPollVote(_ payload: ChannelPollVotePayload) {
        guard let index = channelPolls.firstIndex(where: { $0.id == payload.pollId }) else { return }

        var votes = channelPolls[index].votes.filter { $0.voterId != payload.voterId }
        votes.append(ChannelPollVoteEntry(voterId: payload.voterId, optionIds: payload.optionIds))
        let current = channelPolls[index]
        channelPolls[index] = ChannelPollPayload(
            id: current.id,
            sessionId: current.sessionId,
            channel: current.channel,
            externalMessageId: current.externalMessageId,
            question: current.question,
            options: current.options,
            multiple: current.multiple,
            status: current.status,
            metadata: current.metadata,
            votes: votes,
            createdAt: current.createdAt,
            updatedAt: ISO8601DateFormatter().string(from: Date())
        )
    }

    private func upsertVoiceSession(_ payload: VoiceSessionPayload) {
        if payload.status == "left" {
            activeVoiceSessions.removeAll { $0.guildId == payload.guildId && $0.channelId == payload.channelId }
            return
        }

        if let index = activeVoiceSessions.firstIndex(where: { $0.guildId == payload.guildId && $0.channelId == payload.channelId }) {
            activeVoiceSessions[index] = payload
        } else {
            activeVoiceSessions.append(payload)
        }
        activeVoiceSessions.sort { $0.id < $1.id }
    }

    private func refreshNodeRegistration(forceHeartbeat: Bool) async {
        guard connectionState.isConnected, let credentials = LocalNodeStore.loadCredentials() else {
            return
        }

        let permissions = await nodeRuntime.currentPermissions()
        nodePermissions = permissions
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? credentials.version

        if forceHeartbeat {
            send(.nodeHeartbeat(
                nodeId: credentials.nodeId,
                authToken: credentials.authToken,
                platform: "macOS",
                version: version,
                permissions: permissions
            ))
        } else {
            send(.nodeRegister(
                nodeId: credentials.nodeId,
                authToken: credentials.authToken,
                platform: "macOS",
                version: version,
                permissions: permissions
            ))
        }
    }

    private func startNodeHeartbeat() {
        nodeHeartbeatTask?.cancel()
        nodeHeartbeatTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                guard let self, !Task.isCancelled else { return }
                await self.refreshNodeRegistration(forceHeartbeat: true)
            }
        }
    }

    private func handleNodeInvokeRequest(_ payload: NodeInvokeRequestPayload) async {
        guard payload.nodeId == nodeRecord?.id || payload.nodeId == LocalNodeStore.loadCredentials()?.nodeId else {
            return
        }

        let params = payload.params ?? [:]
        if ["camera", "screen", "shell"].contains(payload.capability.rawValue) {
            let approved = requestHighRiskNodeApproval(for: payload)
            if !approved {
                send(.nodeInvokeResponse(
                    requestId: payload.requestId,
                    nodeId: payload.nodeId,
                    capability: payload.capability,
                    ok: false,
                    message: "User denied high-risk node action."
                ))
                nodeLastInvocationStatus = "Denied \(payload.capability.rawValue) request."
                return
            }
        }

        do {
            let result = try await nodeRuntime.execute(
                capability: payload.capability,
                params: params
            ) { [weak self] fileURL, sessionId in
                guard let self else {
                    throw NSError(domain: "GatewayService", code: 99, userInfo: [NSLocalizedDescriptionKey: "Gateway service unavailable during upload."])
                }
                return try await self.uploadAttachment(fileURL: fileURL, sessionId: self.normalizeSessionId(sessionId))
            }
            send(.nodeInvokeResponse(
                requestId: payload.requestId,
                nodeId: payload.nodeId,
                capability: payload.capability,
                ok: true,
                message: result.message,
                payload: result.payload
            ))
            nodeLastInvocationStatus = "\(payload.capability.rawValue) succeeded at \(Date().formatted(date: .omitted, time: .standard))"
            await refreshNodeRegistration(forceHeartbeat: true)
        } catch {
            let message = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            send(.nodeInvokeResponse(
                requestId: payload.requestId,
                nodeId: payload.nodeId,
                capability: payload.capability,
                ok: false,
                message: message
            ))
            nodeLastInvocationStatus = "\(payload.capability.rawValue) failed: \(message)"
        }
    }

    private func requestHighRiskNodeApproval(for payload: NodeInvokeRequestPayload) -> Bool {
        let alert = NSAlert()
        alert.messageText = "Allow Keygate node action?"
        alert.informativeText = highRiskNodeSummary(for: payload)
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Allow")
        alert.addButton(withTitle: "Deny")
        return alert.runModal() == .alertFirstButtonReturn
    }

    private func highRiskNodeSummary(for payload: NodeInvokeRequestPayload) -> String {
        switch payload.capability {
        case .shell:
            if let command = payload.params?["command"]?.value as? String {
                return "Shell command:\n\(command)"
            }
        case .camera:
            return "Capture a still image from the Mac camera."
        case .screen:
            return "Capture the current screen contents."
        default:
            break
        }
        return "Capability: \(payload.capability.rawValue)"
    }
}

private struct LocalNodeCredentials: Codable {
    let nodeId: String
    let authToken: String
    let name: String
    let capabilities: [NodeCapability]
    let platform: String
    let version: String
}

private enum LocalNodeStore {
    private static let credentialsKey = "keygate.localNodeCredentials"
    private static let capabilitySelectionKey = "keygate.localNodeCapabilitySelection"

    static func loadCredentials() -> LocalNodeCredentials? {
        guard let data = UserDefaults.standard.data(forKey: credentialsKey) else { return nil }
        return try? JSONDecoder().decode(LocalNodeCredentials.self, from: data)
    }

    static func saveCredentials(_ credentials: LocalNodeCredentials) {
        if let data = try? JSONEncoder().encode(credentials) {
            UserDefaults.standard.set(data, forKey: credentialsKey)
        }
    }

    static func clearCredentials() {
        UserDefaults.standard.removeObject(forKey: credentialsKey)
    }

    static func loadCapabilitySelection() -> Set<NodeCapability>? {
        guard let raw = UserDefaults.standard.array(forKey: capabilitySelectionKey) as? [String] else { return nil }
        let values = raw.compactMap(NodeCapability.init(rawValue:))
        return Set(values)
    }

    static func saveCapabilitySelection(_ selection: Set<NodeCapability>) {
        UserDefaults.standard.set(selection.map(\.rawValue).sorted(), forKey: capabilitySelectionKey)
    }
}
