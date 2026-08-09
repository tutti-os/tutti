import Darwin
import Foundation

struct MobileBrowserAuthError: LocalizedError {
  let code: String
  let message: String

  var errorDescription: String? { message }
}

final class MobileBrowserAuthBridge {
  private let queue = DispatchQueue(
    label: "sh.tutti.mobile.browser-auth",
    qos: .userInitiated
  )
  private let lock = NSLock()
  private var active: BrowserLoginAttempt?
  private let webAuthenticationSession = MobileWebAuthenticationSession()
  private var closed = false
  private var starting = false

  func start(
    appID: String,
    authLoginURL: String,
    appCallbackURL: String,
    deviceID: String,
    deviceName: String,
    clientVersion: String,
    completion: @escaping (Result<[String: String], Error>) -> Void
  ) {
    lock.lock()
    guard !closed else {
      lock.unlock()
      completion(
        .failure(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_UNAVAILABLE",
            message: "Browser login is unavailable"
          )
        )
      )
      return
    }
    guard !starting, active == nil else {
      lock.unlock()
      completion(
        .failure(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_BUSY",
            message: "A browser login is already active"
          )
        )
      )
      return
    }
    starting = true
    lock.unlock()

    queue.async { [weak self] in
      guard let self else { return }
      do {
        let server = try Self.bindLoopbackServer()
        let attempt = try BrowserLoginAttempt.create(
          server: server,
          appID: appID,
          authLoginURL: authLoginURL,
          appCallbackURL: appCallbackURL,
          deviceID: deviceID,
          deviceName: deviceName,
          clientVersion: clientVersion,
          completion: completion
        )
        self.lock.lock()
        guard !self.closed else {
          self.starting = false
          self.lock.unlock()
          Self.closeSocket(server.fileDescriptor)
          throw MobileBrowserAuthError(
            code: "BROWSER_LOGIN_UNAVAILABLE",
            message: "Browser login is unavailable"
          )
        }
        self.starting = false
        self.active = attempt
        self.lock.unlock()

        DispatchQueue.main.async {
          self.openAuthenticationSession(attempt)
        }
        self.serve(attempt)
      } catch {
        self.lock.lock()
        self.starting = false
        self.lock.unlock()
        DispatchQueue.main.async {
          completion(.failure(error))
        }
      }
    }
  }

  func close() {
    lock.lock()
    guard !closed else {
      lock.unlock()
      return
    }
    closed = true
    starting = false
    let attempt = active
    active = nil
    lock.unlock()

    DispatchQueue.main.async {
      self.webAuthenticationSession.cancel()
    }
    guard let attempt else { return }
    Self.closeSocket(attempt.server.fileDescriptor)
    DispatchQueue.main.async {
      attempt.completion(
        .failure(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_UNAVAILABLE",
            message: "Browser login was closed"
          )
        )
      )
    }
  }

  private func serve(_ attempt: BrowserLoginAttempt) {
    while Date() < attempt.expiresAt, isActive(attempt) {
      var descriptor = pollfd(
        fd: attempt.server.fileDescriptor,
        events: Int16(POLLIN),
        revents: 0
      )
      let pollResult = Darwin.poll(&descriptor, 1, 1_000)
      if pollResult == 0 {
        continue
      }
      if pollResult < 0 {
        if errno == EINTR { continue }
        finish(
          attempt,
          result: .failure(
            MobileBrowserAuthError(
              code: "BROWSER_LOGIN_FAILED",
              message: "Browser login bridge stopped unexpectedly"
            )
          )
        )
        return
      }

      var address = sockaddr_storage()
      var addressLength = socklen_t(MemoryLayout<sockaddr_storage>.size)
      let client = withUnsafeMutablePointer(to: &address) { addressPointer in
        addressPointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.accept(
            attempt.server.fileDescriptor,
            $0,
            &addressLength
          )
        }
      }
      if client < 0 {
        if errno == EINTR { continue }
        continue
      }
      var noSignal: Int32 = 1
      setsockopt(
        client,
        SOL_SOCKET,
        SO_NOSIGPIPE,
        &noSignal,
        socklen_t(MemoryLayout<Int32>.size)
      )
      defer { Self.closeSocket(client) }

      do {
        switch try handleRequest(attempt, client: client) {
        case .pending:
          continue
        case .completed(let transferCode):
          finish(attempt, result: .success(transferCode))
          return
        case .failed(let error):
          finish(attempt, result: .failure(error))
          return
        }
      } catch {
        continue
      }
    }

    if isActive(attempt) {
      finish(
        attempt,
        result: .failure(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_TIMEOUT",
            message: "Browser login timed out"
          )
        )
      )
    }
  }

  private func handleRequest(
    _ attempt: BrowserLoginAttempt,
    client: Int32
  ) throws -> BrowserRequestOutcome {
    let request = try Self.readRequest(
      client,
      deadline: min(attempt.expiresAt, Date(timeIntervalSinceNow: 2))
    )
    guard request.parts.count >= 2 else {
      try Self.sendJSON(client, status: 400, body: #"{"ok":false}"#)
      return .pending
    }
    guard Self.allowedHost(request.headers["host"], port: attempt.server.port) else {
      try Self.sendEmpty(client, status: 403)
      return .pending
    }

    let method = request.parts[0].uppercased()
    let target = request.parts[1]
    guard
      let components = URLComponents(string: "http://localhost\(target)")
    else {
      try Self.sendJSON(client, status: 400, body: #"{"ok":false}"#)
      return .pending
    }
    guard let query = Self.queryValues(components.queryItems ?? []) else {
      try Self.sendJSON(client, status: 400, body: #"{"ok":false}"#)
      return .pending
    }
    let origin = request.headers["origin"]?
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let corsOrigin = origin == attempt.authOrigin ? attempt.authOrigin : nil

    if method == "OPTIONS" {
      if let corsOrigin {
        try Self.sendEmpty(client, status: 204, corsOrigin: corsOrigin)
      } else {
        try Self.sendEmpty(client, status: 403)
      }
      return .pending
    }

    if method == "GET", components.path == "/oauth/health" {
      if let origin, !origin.isEmpty, corsOrigin == nil {
        try Self.sendEmpty(client, status: 403)
        return .pending
      }
      let matched =
        query["attempt_id"] == attempt.attemptID
        && query["token"] == attempt.bridgeToken
        && isActive(attempt)
        && Date() < attempt.expiresAt
      if !matched {
        try Self.sendJSON(
          client,
          status: 401,
          body: #"{"ok":false,"error":{"code":"INVALID_BRIDGE_ATTEMPT"}}"#,
          corsOrigin: corsOrigin
        )
        return .pending
      }
      let expiresAt = Int64(attempt.expiresAt.timeIntervalSince1970 * 1_000)
      let payload: [String: Any] = [
        "ok": true,
        "data": [
          "attemptId": attempt.attemptID,
          "status": "ready",
          "expiresAt": expiresAt,
        ],
      ]
      let body =
        String(
          data: try JSONSerialization.data(withJSONObject: payload),
          encoding: .utf8
        ) ?? #"{"ok":true}"#
      try Self.sendJSON(client, status: 200, body: body, corsOrigin: corsOrigin)
      return .pending
    }

    if method == "GET", components.path == "/oauth/callback" {
      guard query["state"] == attempt.state else {
        try Self.sendRedirect(
          client,
          location: Self.bridgeResultURL(
            attempt,
            status: "error",
            safeErrorCode: "invalidState"
          )
        )
        return .failed(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_INVALID_STATE",
            message: "Browser login state is invalid"
          )
        )
      }

      let callbackError =
        query["error"]?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      if !callbackError.isEmpty {
        let cancelled = callbackError == "user_cancelled"
        try Self.sendRedirect(
          client,
          location: Self.bridgeResultURL(
            attempt,
            status: "error",
            safeErrorCode: cancelled ? "userCancelled" : "providerError"
          )
        )
        return .failed(
          MobileBrowserAuthError(
            code: cancelled ? "BROWSER_LOGIN_CANCELLED" : "BROWSER_LOGIN_FAILED",
            message: cancelled
              ? "Browser login was cancelled"
              : "Browser login provider returned an error"
          )
        )
      }

      let transferCode =
        query["transfer_code"]?
        .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard !transferCode.isEmpty else {
        try Self.sendRedirect(
          client,
          location: Self.bridgeResultURL(
            attempt,
            status: "error",
            safeErrorCode: "missingTransferCode"
          )
        )
        return .failed(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_FAILED",
            message: "Browser login transfer code is missing"
          )
        )
      }
      try Self.sendRedirect(
        client,
        location: Self.bridgeResultURL(attempt, status: "success")
      )
      return .completed(transferCode)
    }

    try Self.sendJSON(client, status: 404, body: #"{"ok":false}"#)
    return .pending
  }

  private func finish(
    _ attempt: BrowserLoginAttempt,
    result: Result<String, Error>
  ) {
    lock.lock()
    guard active === attempt else {
      lock.unlock()
      return
    }
    active = nil
    lock.unlock()

    Self.closeSocket(attempt.server.fileDescriptor)
    DispatchQueue.main.async {
      switch result {
      case .success(let transferCode):
        attempt.completion(
          .success([
            "attemptId": attempt.attemptID,
            "bridgeToken": attempt.bridgeToken,
            "deviceId": attempt.deviceID,
            "transferCode": transferCode,
          ])
        )
      case .failure(let error):
        self.webAuthenticationSession.cancel()
        attempt.completion(.failure(error))
      }
    }
  }

  private func openAuthenticationSession(_ attempt: BrowserLoginAttempt) {
    guard isActive(attempt) else { return }
    guard
      let callbackScheme = URL(string: attempt.appCallbackURL)?.scheme,
      !callbackScheme.isEmpty
    else {
      finish(
        attempt,
        result: .failure(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_FAILED",
            message: "Unable to present browser login"
          )
        )
      )
      return
    }

    let started = webAuthenticationSession.start(
      url: attempt.loginURL,
      callbackScheme: callbackScheme
    ) { [weak self, weak attempt] result in
      guard let self, let attempt else { return }
      guard result != .callback else { return }
      let cancelled = result == .cancelled
      self.finish(
        attempt,
        result: .failure(
          MobileBrowserAuthError(
            code: cancelled ? "BROWSER_LOGIN_CANCELLED" : "BROWSER_LOGIN_FAILED",
            message: cancelled
              ? "Browser login was cancelled"
              : "Browser authentication session failed"
          )
        )
      )
    }
    guard started else {
      finish(
        attempt,
        result: .failure(
          MobileBrowserAuthError(
            code: "BROWSER_LOGIN_FAILED",
            message: "Unable to start browser authentication session"
          )
        )
      )
      return
    }
  }

  private func isActive(_ attempt: BrowserLoginAttempt) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    return active === attempt && !closed
  }

  private static func bindLoopbackServer() throws -> LoopbackServer {
    for port in 38_473...38_492 {
      let descriptor = Darwin.socket(AF_INET, SOCK_STREAM, 0)
      guard descriptor >= 0 else { continue }
      var reuse: Int32 = 1
      setsockopt(
        descriptor,
        SOL_SOCKET,
        SO_REUSEADDR,
        &reuse,
        socklen_t(MemoryLayout<Int32>.size)
      )
      var address = sockaddr_in()
      address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
      address.sin_family = sa_family_t(AF_INET)
      address.sin_port = in_port_t(port).bigEndian
      guard
        "127.0.0.1".withCString({
          inet_pton(AF_INET, $0, &address.sin_addr)
        }) == 1
      else {
        closeSocket(descriptor)
        continue
      }
      let bound = withUnsafePointer(to: &address) { addressPointer in
        addressPointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
          Darwin.bind(
            descriptor,
            $0,
            socklen_t(MemoryLayout<sockaddr_in>.size)
          )
        }
      }
      guard bound == 0, Darwin.listen(descriptor, 8) == 0 else {
        closeSocket(descriptor)
        continue
      }
      return LoopbackServer(fileDescriptor: descriptor, port: port)
    }
    throw MobileBrowserAuthError(
      code: "BROWSER_LOGIN_FAILED",
      message: "Unable to allocate browser login port"
    )
  }

  private static func readRequest(
    _ client: Int32, deadline: Date
  ) throws -> BrowserHTTPRequest {
    var bytes = Data()
    var buffer = [UInt8](repeating: 0, count: 4_096)
    while bytes.count < 32_768 {
      let remaining = deadline.timeIntervalSinceNow
      guard remaining > 0 else { throw invalidRequestError() }
      var descriptor = pollfd(fd: client, events: Int16(POLLIN), revents: 0)
      let timeout = Int32(max(1, min(2_000, Int(remaining * 1_000))))
      let pollResult = Darwin.poll(&descriptor, 1, timeout)
      if pollResult == 0 { throw invalidRequestError() }
      if pollResult < 0 {
        if errno == EINTR { continue }
        throw invalidRequestError()
      }
      let count = Darwin.recv(client, &buffer, buffer.count, 0)
      guard count > 0 else { throw invalidRequestError() }
      bytes.append(contentsOf: buffer.prefix(count))
      if bytes.range(of: Data("\r\n\r\n".utf8)) != nil {
        break
      }
    }
    guard
      bytes.range(of: Data("\r\n\r\n".utf8)) != nil,
      let raw = String(data: bytes, encoding: .utf8)
    else { throw invalidRequestError() }
    let lines = raw.components(separatedBy: "\r\n")
    var headers: [String: String] = [:]
    for line in lines.dropFirst() {
      guard !line.isEmpty, let separator = line.firstIndex(of: ":") else {
        continue
      }
      let name = String(line[..<separator])
        .trimmingCharacters(in: .whitespaces)
        .lowercased()
      let value = String(line[line.index(after: separator)...])
        .trimmingCharacters(in: .whitespaces)
      headers[name] = value
    }
    return BrowserHTTPRequest(
      parts: lines.first?.split(separator: " ", maxSplits: 2).map(String.init) ?? [],
      headers: headers
    )
  }

  private static func sendEmpty(
    _ client: Int32,
    status: Int,
    corsOrigin: String? = nil
  ) throws {
    try writeResponse(
      client, status: status, headers: [:], body: "", corsOrigin: corsOrigin
    )
  }

  private static func sendJSON(
    _ client: Int32,
    status: Int,
    body: String,
    corsOrigin: String? = nil
  ) throws {
    try writeResponse(
      client,
      status: status,
      headers: ["Content-Type": "application/json; charset=utf-8"],
      body: body,
      corsOrigin: corsOrigin
    )
  }

  private static func sendRedirect(
    _ client: Int32,
    location: String
  ) throws {
    try writeResponse(
      client,
      status: 302,
      headers: ["Location": location],
      body: "",
      corsOrigin: nil
    )
  }

  private static func writeResponse(
    _ client: Int32,
    status: Int,
    headers: [String: String],
    body: String,
    corsOrigin: String?
  ) throws {
    let bodyData = Data(body.utf8)
    let reason: String
    switch status {
    case 200: reason = "OK"
    case 204: reason = "No Content"
    case 302: reason = "Found"
    case 400: reason = "Bad Request"
    case 401: reason = "Unauthorized"
    case 403: reason = "Forbidden"
    case 404: reason = "Not Found"
    default: reason = "Error"
    }
    var head = "HTTP/1.1 \(status) \(reason)\r\n"
    head += "Connection: close\r\n"
    head += "Content-Length: \(bodyData.count)\r\n"
    if let corsOrigin {
      head += "Access-Control-Allow-Origin: \(corsOrigin)\r\n"
      head += "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\n"
      head += "Access-Control-Allow-Headers: Content-Type\r\n"
      head += "Access-Control-Allow-Private-Network: true\r\n"
      head += "Vary: Origin\r\n"
    }
    for (name, value) in headers {
      head += "\(name): \(value)\r\n"
    }
    head += "\r\n"
    try sendAll(client, data: Data(head.utf8) + bodyData)
  }

  private static func sendAll(_ client: Int32, data: Data) throws {
    try data.withUnsafeBytes { rawBuffer in
      guard let base = rawBuffer.baseAddress else { return }
      var offset = 0
      while offset < rawBuffer.count {
        let written = Darwin.send(
          client,
          base.advanced(by: offset),
          rawBuffer.count - offset,
          0
        )
        guard written > 0 else {
          throw MobileBrowserAuthError(
            code: "BROWSER_LOGIN_FAILED",
            message: "Unable to reply to browser login"
          )
        }
        offset += written
      }
    }
  }

  private static func bridgeResultURL(
    _ attempt: BrowserLoginAttempt,
    status: String,
    safeErrorCode: String? = nil
  ) -> String {
    var query = ["desktopBridgeStatus=\(percentEncode(status))"]
    if let safeErrorCode, !safeErrorCode.isEmpty {
      query.append("desktopBridgeError=\(percentEncode(safeErrorCode))")
    }
    if safeErrorCode != "userCancelled" {
      var openAppParameters = ["desktopBridgeStatus=\(percentEncode(status))"]
      if let safeErrorCode, !safeErrorCode.isEmpty {
        openAppParameters.append(
          "desktopBridgeError=\(percentEncode(safeErrorCode))"
        )
      }
      let openAppURL =
        "\(attempt.appCallbackURL)?\(openAppParameters.joined(separator: "&"))"
      query.append("openAppUrl=\(percentEncode(openAppURL))")
    }
    return "\(attempt.authOrigin)/auth/login/callback?\(query.joined(separator: "&"))"
  }

  private static func percentEncode(_ value: String) -> String {
    value.addingPercentEncoding(
      withAllowedCharacters: .urlQueryAllowed.subtracting(
        CharacterSet(charactersIn: "&+=?")
      )
    ) ?? ""
  }

  private static func allowedHost(_ hostHeader: String?, port: Int) -> Bool {
    let host =
      hostHeader?
      .trimmingCharacters(in: .whitespacesAndNewlines)
      .lowercased() ?? ""
    return host == "127.0.0.1:\(port)" || host == "localhost:\(port)"
  }

  private static func queryValues(_ items: [URLQueryItem]) -> [String: String]? {
    var values: [String: String] = [:]
    for item in items {
      guard values[item.name] == nil else { return nil }
      values[item.name] = item.value ?? ""
    }
    return values
  }

  private static func invalidRequestError() -> MobileBrowserAuthError {
    MobileBrowserAuthError(
      code: "BROWSER_LOGIN_FAILED",
      message: "Browser login request is invalid"
    )
  }

  private static func closeSocket(_ descriptor: Int32) {
    guard descriptor >= 0 else { return }
    Darwin.shutdown(descriptor, SHUT_RDWR)
    Darwin.close(descriptor)
  }
}

private final class BrowserLoginAttempt {
  let appCallbackURL: String
  let attemptID: String
  let authOrigin: String
  let bridgeToken: String
  let completion: (Result<[String: String], Error>) -> Void
  let deviceID: String
  let expiresAt: Date
  let loginURL: URL
  let server: LoopbackServer
  let state: String

  private init(
    appCallbackURL: String,
    attemptID: String,
    authOrigin: String,
    bridgeToken: String,
    completion: @escaping (Result<[String: String], Error>) -> Void,
    deviceID: String,
    expiresAt: Date,
    loginURL: URL,
    server: LoopbackServer,
    state: String
  ) {
    self.appCallbackURL = appCallbackURL
    self.attemptID = attemptID
    self.authOrigin = authOrigin
    self.bridgeToken = bridgeToken
    self.completion = completion
    self.deviceID = deviceID
    self.expiresAt = expiresAt
    self.loginURL = loginURL
    self.server = server
    self.state = state
  }

  static func create(
    server: LoopbackServer,
    appID: String,
    authLoginURL: String,
    appCallbackURL: String,
    deviceID: String,
    deviceName: String,
    clientVersion: String,
    completion: @escaping (Result<[String: String], Error>) -> Void
  ) throws -> BrowserLoginAttempt {
    guard
      let authURL = URL(string: authLoginURL.trimmingCharacters(in: .whitespaces)),
      authURL.scheme == "https",
      let authHost = authURL.host
    else {
      throw MobileBrowserAuthError(
        code: "BROWSER_LOGIN_FAILED",
        message: "Browser login URL must use HTTPS"
      )
    }
    let normalizedAppID = appID.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalizedAppID.isEmpty else {
      throw MobileBrowserAuthError(
        code: "BROWSER_LOGIN_FAILED",
        message: "App id is required"
      )
    }
    let normalizedCallback = appCallbackURL.trimmingCharacters(
      in: .whitespacesAndNewlines
    )
    guard normalizedCallback == "tutti://auth/login" else {
      throw MobileBrowserAuthError(
        code: "BROWSER_LOGIN_FAILED",
        message: "App callback URL is not allowed"
      )
    }

    let attemptID = UUID().uuidString
    let bridgeToken = UUID().uuidString
    let authOrigin = "https://\(authHost)"
    let localOrigin = "http://127.0.0.1:\(server.port)"
    let stateObject: [String: Any] = [
      "v": 1,
      "flow": "desktop_bridge",
      "attemptId": attemptID,
      "localServerOrigin": localOrigin,
      "bridgeToken": bridgeToken,
      "appId": normalizedAppID,
      "appCallbackUrl": normalizedCallback,
      "deviceId": deviceID.trimmingCharacters(in: .whitespacesAndNewlines),
      "deviceName": deviceName.trimmingCharacters(in: .whitespacesAndNewlines),
      "clientVersion": clientVersion.trimmingCharacters(in: .whitespacesAndNewlines),
      "hostname": deviceName.trimmingCharacters(in: .whitespacesAndNewlines),
    ]
    let state = try JSONSerialization.data(withJSONObject: stateObject)
      .browserAuthBase64URLString()
    guard
      let encodedState = state.addingPercentEncoding(
        withAllowedCharacters: .urlQueryAllowed
      ),
      let loginURL = URL(string: "\(authOrigin)/auth/login?state=\(encodedState)")
    else {
      throw MobileBrowserAuthError(
        code: "BROWSER_LOGIN_FAILED",
        message: "Unable to create browser login URL"
      )
    }
    return BrowserLoginAttempt(
      appCallbackURL: normalizedCallback,
      attemptID: attemptID,
      authOrigin: authOrigin,
      bridgeToken: bridgeToken,
      completion: completion,
      deviceID: deviceID.trimmingCharacters(in: .whitespacesAndNewlines),
      expiresAt: Date(timeIntervalSinceNow: 5 * 60),
      loginURL: loginURL,
      server: server,
      state: state
    )
  }
}

private struct LoopbackServer {
  let fileDescriptor: Int32
  let port: Int
}

private struct BrowserHTTPRequest {
  let parts: [String]
  let headers: [String: String]
}

private enum BrowserRequestOutcome {
  case pending
  case completed(String)
  case failed(MobileBrowserAuthError)
}

extension Data {
  fileprivate func browserAuthBase64URLString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
