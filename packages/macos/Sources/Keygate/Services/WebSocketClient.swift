import Foundation
import os

/// Raw WebSocket connection with auto-reconnect.
final class WebSocketClient: NSObject, @unchecked Sendable {
    private let logger = Logger(subsystem: "dev.keygate.app", category: "WebSocket")
    private var task: URLSessionWebSocketTask?
    private var session: URLSession?
    private var url: URL
    private var isConnected = false
    private var reconnectDelay: TimeInterval = 3

    var onMessage: ((ServerMessage) -> Void)?
    var onConnect: (() -> Void)?
    var onDisconnect: (() -> Void)?

    init(url: URL) {
        self.url = url
        super.init()
    }

    func connect() {
        guard !isConnected else { return }
        let config = URLSessionConfiguration.default
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
        task = session?.webSocketTask(with: url)
        task?.resume()
        listen()
    }

    func disconnect() {
        isConnected = false
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        session?.invalidateAndCancel()
        session = nil
    }

    func send(_ message: ClientMessage) {
        guard let data = message.data else { return }
        task?.send(.data(data)) { [weak self] error in
            if let error {
                self?.logger.error("Send error: \(error.localizedDescription)")
            }
        }
    }

    private func listen() {
        task?.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .success(let msg):
                self.handleRaw(msg)
                self.listen() // continue listening
            case .failure(let error):
                self.logger.error("Receive error: \(error.localizedDescription)")
                self.handleDisconnect()
            }
        }
    }

    private func handleRaw(_ message: URLSessionWebSocketTask.Message) {
        let data: Data
        switch message {
        case .data(let d): data = d
        case .string(let s): data = Data(s.utf8)
        @unknown default: return
        }

        do {
            let decoded = try JSONDecoder().decode(ServerMessage.self, from: data)
            DispatchQueue.main.async { [weak self] in
                self?.onMessage?(decoded)
            }
        } catch {
            logger.warning("Failed to decode message: \(error.localizedDescription)")
        }
    }

    private func handleDisconnect() {
        guard isConnected else { return }
        isConnected = false
        DispatchQueue.main.async { [weak self] in
            self?.onDisconnect?()
        }
        // Auto-reconnect
        DispatchQueue.global().asyncAfter(deadline: .now() + reconnectDelay) { [weak self] in
            self?.connect()
        }
    }
}

// MARK: - URLSessionWebSocketDelegate

extension WebSocketClient: URLSessionWebSocketDelegate {
    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didOpenWithProtocol protocol: String?
    ) {
        isConnected = true
        logger.info("Connected to \(self.url.absoluteString)")
        DispatchQueue.main.async { [weak self] in
            self?.onConnect?()
        }
    }

    func urlSession(
        _ session: URLSession,
        webSocketTask: URLSessionWebSocketTask,
        didCloseWith closeCode: URLSessionWebSocketTask.CloseCode,
        reason: Data?
    ) {
        logger.info("WebSocket closed: \(closeCode.rawValue)")
        handleDisconnect()
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        didCompleteWithError error: Error?
    ) {
        if let error {
            logger.error("Connection failed: \(error.localizedDescription)")
            handleDisconnect()
        }
    }
}
