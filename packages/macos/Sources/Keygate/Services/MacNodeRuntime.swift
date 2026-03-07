import AppKit
import AVFoundation
import CoreGraphics
import CoreLocation
import Foundation
import ImageIO
import ObjectiveC
import UniformTypeIdentifiers
import UserNotifications

enum MacNodeRuntimeError: LocalizedError {
    case unsupported(String)
    case permissionDenied(String)
    case invalidRequest(String)
    case noCaptureDevice
    case captureFailed

    var errorDescription: String? {
        switch self {
        case .unsupported(let message),
             .permissionDenied(let message),
             .invalidRequest(let message):
            return message
        case .noCaptureDevice:
            return "No camera device is available."
        case .captureFailed:
            return "Capture failed."
        }
    }
}

@MainActor
final class MacNodeRuntime {
    func currentPermissions() async -> [String: String] {
        let notificationStatus = await currentNotificationPermission()
        return [
            NodeCapability.notify.rawValue: notificationStatus.rawValue,
            NodeCapability.location.rawValue: mapLocationPermission(CLLocationManager.authorizationStatus()).rawValue,
            NodeCapability.camera.rawValue: mapCameraPermission(AVCaptureDevice.authorizationStatus(for: .video)).rawValue,
            NodeCapability.screen.rawValue: CGPreflightScreenCaptureAccess() ? NodePermissionState.granted.rawValue : NodePermissionState.unknown.rawValue,
            NodeCapability.shell.rawValue: NodePermissionState.granted.rawValue,
            NodeCapability.invoke.rawValue: NodePermissionState.granted.rawValue,
        ]
    }

    func execute(
        capability: NodeCapability,
        params: [String: AnyCodable],
        uploadAttachment: @escaping (URL, String) async throws -> Attachment
    ) async throws -> (message: String, payload: [String: Any]) {
        switch capability {
        case .notify:
            return try await sendNotification(params: params)
        case .location:
            return try await fetchLocation()
        case .camera:
            return try await captureCamera(params: params, uploadAttachment: uploadAttachment)
        case .screen:
            return try await captureScreen(params: params, uploadAttachment: uploadAttachment)
        case .shell:
            return try await runShell(params: params)
        case .invoke:
            throw MacNodeRuntimeError.unsupported("The generic invoke capability is not implemented on macOS.")
        }
    }

    private func sendNotification(params: [String: AnyCodable]) async throws -> (message: String, payload: [String: Any]) {
        let center = UNUserNotificationCenter.current()
        let settings = await center.notificationSettings()
        if settings.authorizationStatus == .notDetermined {
            let granted = try await center.requestAuthorization(options: [.alert, .sound, .badge])
            if !granted {
                throw MacNodeRuntimeError.permissionDenied("Notification permission was denied.")
            }
        } else if settings.authorizationStatus == .denied {
            throw MacNodeRuntimeError.permissionDenied("Notification permission is denied.")
        }

        let title = params["title"]?.value as? String ?? "Keygate"
        let body = params["body"]?.value as? String ?? (params["message"]?.value as? String ?? "Node notification")

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        let request = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        try await center.add(request)

        return ("Notification delivered.", [
            "title": title,
            "body": body,
        ])
    }

    private func fetchLocation() async throws -> (message: String, payload: [String: Any]) {
        let manager = CLLocationManager()
        let authorization = CLLocationManager.authorizationStatus()
        if authorization == .denied || authorization == .restricted {
            throw MacNodeRuntimeError.permissionDenied("Location permission is denied.")
        }

        let location: CLLocation
        if authorization == .notDetermined {
            location = try await LocationRequester.requestLocation(manager: manager, requestAuthorization: true)
        } else {
            location = try await LocationRequester.requestLocation(manager: manager, requestAuthorization: false)
        }

        return ("Location captured.", [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracyMeters": location.horizontalAccuracy,
        ])
    }

    private func captureScreen(
        params: [String: AnyCodable],
        uploadAttachment: @escaping (URL, String) async throws -> Attachment
    ) async throws -> (message: String, payload: [String: Any]) {
        if !CGPreflightScreenCaptureAccess() && !CGRequestScreenCaptureAccess() {
            throw MacNodeRuntimeError.permissionDenied("Screen recording permission is required.")
        }

        guard let image = CGDisplayCreateImage(CGMainDisplayID()) else {
            throw MacNodeRuntimeError.captureFailed
        }

        let fileURL = try writeImageToTemporaryPNG(image, prefix: "keygate-screen")
        var payload: [String: Any] = [
            "path": fileURL.path,
        ]
        if let sessionId = params["sessionId"]?.value as? String, !sessionId.isEmpty {
            let attachment = try await uploadAttachment(fileURL, sessionId)
            payload["attachment"] = attachmentDictionary(attachment)
        }
        return ("Screen capture completed.", payload)
    }

    private func captureCamera(
        params: [String: AnyCodable],
        uploadAttachment: @escaping (URL, String) async throws -> Attachment
    ) async throws -> (message: String, payload: [String: Any]) {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        if status == .notDetermined {
            let granted = await AVCaptureDevice.requestAccess(for: .video)
            if !granted {
                throw MacNodeRuntimeError.permissionDenied("Camera permission was denied.")
            }
        } else if status == .denied || status == .restricted {
            throw MacNodeRuntimeError.permissionDenied("Camera permission is denied.")
        }

        let fileURL = try await CameraCaptureService.captureStillImage()
        var payload: [String: Any] = [
            "path": fileURL.path,
        ]
        if let sessionId = params["sessionId"]?.value as? String, !sessionId.isEmpty {
            let attachment = try await uploadAttachment(fileURL, sessionId)
            payload["attachment"] = attachmentDictionary(attachment)
        }
        return ("Camera capture completed.", payload)
    }

    private func runShell(params: [String: AnyCodable]) async throws -> (message: String, payload: [String: Any]) {
        guard let command = params["command"]?.value as? String, !command.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            throw MacNodeRuntimeError.invalidRequest("Shell capability requires a non-empty command.")
        }

        let cwd = params["cwd"]?.value as? String
        let result = try await ShellRunner.run(command: command, cwd: cwd)
        return (
            result.exitCode == 0 ? "Shell command completed." : "Shell command failed.",
            [
                "command": command,
                "cwd": cwd ?? FileManager.default.currentDirectoryPath,
                "stdout": result.stdout,
                "stderr": result.stderr,
                "exitCode": result.exitCode,
            ]
        )
    }

    private func currentNotificationPermission() async -> NodePermissionState {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .authorized, .provisional, .ephemeral:
            return .granted
        case .denied:
            return .denied
        case .notDetermined:
            return .unknown
        @unknown default:
            return .unknown
        }
    }
}

private func mapLocationPermission(_ status: CLAuthorizationStatus) -> NodePermissionState {
    switch status {
    case .authorizedAlways, .authorizedWhenInUse:
        return .granted
    case .denied, .restricted:
        return .denied
    case .notDetermined:
        return .unknown
    @unknown default:
        return .unknown
    }
}

private func mapCameraPermission(_ status: AVAuthorizationStatus) -> NodePermissionState {
    switch status {
    case .authorized:
        return .granted
    case .denied, .restricted:
        return .denied
    case .notDetermined:
        return .unknown
    @unknown default:
        return .unknown
    }
}

private func attachmentDictionary(_ attachment: Attachment) -> [String: Any] {
    [
        "id": attachment.id,
        "filename": attachment.filename,
        "contentType": attachment.contentType,
        "sizeBytes": attachment.sizeBytes,
        "url": attachment.url,
    ]
}

private func writeImageToTemporaryPNG(_ image: CGImage, prefix: String) throws -> URL {
    let directory = FileManager.default.temporaryDirectory
    let url = directory.appendingPathComponent("\(prefix)-\(UUID().uuidString).png")
    let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)
    guard let destination else {
        throw MacNodeRuntimeError.captureFailed
    }
    CGImageDestinationAddImage(destination, image, nil)
    if !CGImageDestinationFinalize(destination) {
        throw MacNodeRuntimeError.captureFailed
    }
    return url
}

private final class LocationRequester: NSObject, CLLocationManagerDelegate {
    private var continuation: CheckedContinuation<CLLocation, Error>?

    static func requestLocation(manager: CLLocationManager, requestAuthorization: Bool) async throws -> CLLocation {
        let requester = LocationRequester()
        return try await requester.request(manager: manager, requestAuthorization: requestAuthorization)
    }

    private func request(manager: CLLocationManager, requestAuthorization: Bool) async throws -> CLLocation {
        manager.delegate = self
        if requestAuthorization {
            manager.requestWhenInUseAuthorization()
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            manager.requestLocation()
        }
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let continuation else { return }
        self.continuation = nil
        if let location = locations.last {
            continuation.resume(returning: location)
        } else {
            continuation.resume(throwing: MacNodeRuntimeError.captureFailed)
        }
        manager.delegate = nil
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard let continuation else { return }
        self.continuation = nil
        continuation.resume(throwing: error)
        manager.delegate = nil
    }
}

private final class CameraCaptureService: NSObject, AVCapturePhotoCaptureDelegate {
    private static var retainedDelegates: [String: CameraCaptureService] = [:]
    private let identifier = UUID().uuidString
    private let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    private var continuation: CheckedContinuation<URL, Error>?

    static func captureStillImage() async throws -> URL {
        let service = CameraCaptureService()
        return try await service.capture()
    }

    private func capture() async throws -> URL {
        guard let device = AVCaptureDevice.default(for: .video) else {
            throw MacNodeRuntimeError.noCaptureDevice
        }

        let input = try AVCaptureDeviceInput(device: device)
        guard session.canAddInput(input), session.canAddOutput(output) else {
            throw MacNodeRuntimeError.captureFailed
        }

        session.beginConfiguration()
        session.addInput(input)
        session.addOutput(output)
        session.commitConfiguration()
        session.startRunning()

        CameraCaptureService.retainedDelegates[identifier] = self
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            output.capturePhoto(with: AVCapturePhotoSettings(), delegate: self)
        }
    }

    func photoOutput(
        _ output: AVCapturePhotoOutput,
        didFinishProcessingPhoto photo: AVCapturePhoto,
        error: Error?
    ) {
        defer {
            session.stopRunning()
            CameraCaptureService.retainedDelegates.removeValue(forKey: identifier)
        }

        guard let continuation else { return }
        self.continuation = nil

        if let error {
            continuation.resume(throwing: error)
            return
        }

        guard let data = photo.fileDataRepresentation() else {
            continuation.resume(throwing: MacNodeRuntimeError.captureFailed)
            return
        }

        let url = FileManager.default.temporaryDirectory.appendingPathComponent("keygate-camera-\(UUID().uuidString).jpg")
        do {
            try data.write(to: url)
            continuation.resume(returning: url)
        } catch {
            continuation.resume(throwing: error)
        }
    }
}

private enum ShellRunner {
    static func run(command: String, cwd: String?) async throws -> (stdout: String, stderr: String, exitCode: Int32) {
        try await withCheckedThrowingContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/zsh")
            process.arguments = ["-lc", command]
            if let cwd, !cwd.isEmpty {
                process.currentDirectoryURL = URL(fileURLWithPath: cwd)
            }

            let stdoutPipe = Pipe()
            let stderrPipe = Pipe()
            process.standardOutput = stdoutPipe
            process.standardError = stderrPipe

            process.terminationHandler = { process in
                let stdoutData = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
                let stderrData = stderrPipe.fileHandleForReading.readDataToEndOfFile()
                continuation.resume(returning: (
                    stdout: String(data: stdoutData, encoding: .utf8) ?? "",
                    stderr: String(data: stderrData, encoding: .utf8) ?? "",
                    exitCode: process.terminationStatus
                ))
            }

            do {
                try process.run()
            } catch {
                continuation.resume(throwing: error)
            }
        }
    }
}

private extension UNUserNotificationCenter {
    func add(_ request: UNNotificationRequest) async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            add(request) { error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume()
                }
            }
        }
    }

    func requestAuthorization(options: UNAuthorizationOptions) async throws -> Bool {
        try await withCheckedThrowingContinuation { continuation in
            requestAuthorization(options: options) { granted, error in
                if let error {
                    continuation.resume(throwing: error)
                } else {
                    continuation.resume(returning: granted)
                }
            }
        }
    }

    func notificationSettings() async -> UNNotificationSettings {
        await withCheckedContinuation { continuation in
            getNotificationSettings { settings in
                continuation.resume(returning: settings)
            }
        }
    }
}
