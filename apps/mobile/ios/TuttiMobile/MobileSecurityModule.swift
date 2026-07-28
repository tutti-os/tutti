import CryptoKit
import Foundation
import React
import Security
import UIKit

@objc(TuttiMobileSecurity)
final class MobileSecurityModule: NSObject {
  private let browserAuthBridge = MobileBrowserAuthBridge()
  private let store = MobileSecureStore()
  private var scannerActive = false
  private var scannerCancellationResolvers: [RCTPromiseResolveBlock] = []
  private weak var scannerViewController: QRCodeScannerViewController?

  @objc
  static func requiresMainQueueSetup() -> Bool {
    true
  }

  @objc
  func constantsToExport() -> [AnyHashable: Any] {
    [
      "clientVersion": Bundle.main.object(
        forInfoDictionaryKey: "CFBundleShortVersionString"
      ) as? String ?? "0.0.0",
      "localeIdentifier": Locale.current.identifier,
    ]
  }

  @objc(getOrCreateIdentity:rejecter:)
  func getOrCreateIdentity(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let identity = try store.getOrCreateIdentity()
      resolve([
        "deviceId": identity.deviceID,
        "publicKey": identity.publicKey,
        "arch": deviceArchitecture(),
        "deviceName": UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name,
      ])
    } catch {
      reject("IDENTITY_UNAVAILABLE", "Unable to load device identity", error)
    }
  }

  @objc(sign:resolver:rejecter:)
  func sign(
    _ message: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      resolve(try store.sign(Data(message.utf8)))
    } catch {
      reject("SIGN_FAILED", "Unable to sign device proof", error)
    }
  }

  @objc(loadSession:rejecter:)
  func loadSession(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      resolve(try store.loadSession())
    } catch {
      reject("SESSION_READ_FAILED", "Unable to read account session", error)
    }
  }

  @objc(saveSession:userId:email:name:resolver:rejecter:)
  func saveSession(
    _ sessionID: String,
    userId: String,
    email: String,
    name: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      try store.saveSession([
        "sessionId": sessionID.trimmingCharacters(in: .whitespacesAndNewlines),
        "userId": userId.trimmingCharacters(in: .whitespacesAndNewlines),
        "email": email.trimmingCharacters(in: .whitespacesAndNewlines),
        "name": name.trimmingCharacters(in: .whitespacesAndNewlines),
      ])
      resolve(nil)
    } catch {
      reject("SESSION_WRITE_FAILED", "Unable to save account session", error)
    }
  }

  @objc(clearSession:rejecter:)
  func clearSession(
    _ resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      try store.clearSession()
      resolve(nil)
    } catch {
      reject("SESSION_CLEAR_FAILED", "Unable to clear account session", error)
    }
  }

  @objc(clearLegacySessionCookie:resolver:rejecter:)
  func clearLegacySessionCookie(
    _ accountBaseURL: String,
    resolver resolve: RCTPromiseResolveBlock,
    rejecter reject: RCTPromiseRejectBlock
  ) {
    do {
      let url = try validatedCookieURL(accountBaseURL)
      for cookie in HTTPCookieStorage.shared.cookies(for: url) ?? []
      where cookie.name == "session_id" {
        HTTPCookieStorage.shared.deleteCookie(cookie)
      }
      resolve(nil)
    } catch {
      reject(
        "SESSION_COOKIE_CLEAR_FAILED",
        "Unable to clear legacy account session cookie",
        error
      )
    }
  }

  @objc(startBrowserLogin:authLoginURL:appCallbackURL:resolver:rejecter:)
  func startBrowserLogin(
    _ appID: String,
    authLoginURL: String,
    appCallbackURL: String,
    resolver resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    do {
      let identity = try store.getOrCreateIdentity()
      browserAuthBridge.start(
        appID: appID,
        authLoginURL: authLoginURL,
        appCallbackURL: appCallbackURL,
        deviceID: identity.deviceID,
        deviceName: UIDevice.current.name.isEmpty ? "iPhone" : UIDevice.current.name,
        clientVersion: constantsToExport()["clientVersion"] as? String ?? "0.0.0"
      ) { result in
        switch result {
        case .success(let completion):
          resolve(completion)
        case .failure(let error):
          let bridgeError = error as? MobileBrowserAuthError
          reject(
            bridgeError?.code ?? "BROWSER_LOGIN_FAILED",
            bridgeError?.message ?? "Unable to complete browser login",
            error
          )
        }
      }
    } catch {
      reject("BROWSER_LOGIN_FAILED", "Unable to start browser login", error)
    }
  }

  @objc(scanQRCode:rejecter:)
  func scanQRCode(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    #if targetEnvironment(simulator)
      reject("SCANNER_UNAVAILABLE", "QR scanner is unavailable in Simulator", nil)
    #else
      DispatchQueue.main.async { [weak self] in
        guard let self else {
          reject("SCANNER_UNAVAILABLE", "QR scanner is unavailable", nil)
          return
        }
        self.presentQRCodeScanner(resolve, rejecter: reject)
      }
    #endif
  }

  private func presentQRCodeScanner(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter reject: @escaping RCTPromiseRejectBlock
  ) {
    guard !scannerActive else {
      reject("SCANNER_BUSY", "A QR scan is already active", nil)
      return
    }
    guard let presenter = topViewController() else {
      reject("SCANNER_UNAVAILABLE", "No active iOS view controller", nil)
      return
    }

    scannerActive = true
    let scanner = QRCodeScannerViewController()
    scannerViewController = scanner
    scanner.modalPresentationStyle = .fullScreen
    scanner.onCompletion = { result in
      self.scannerActive = false
      self.scannerViewController = nil
      switch result {
      case .success(let value):
        resolve(value)
      case .failure(let error):
        switch error {
        case QRCodeScannerError.permissionDenied:
          reject("SCANNER_PERMISSION_DENIED", "Camera permission is required", error)
        case QRCodeScannerError.cancelled:
          reject("SCAN_CANCELLED", "QR scan cancelled", error)
        case QRCodeScannerError.emptyCode:
          reject("EMPTY_QR_CODE", "The scanned QR code is empty", error)
        default:
          reject("SCANNER_UNAVAILABLE", "QR scanner is unavailable", error)
        }
      }
      let cancellationResolvers = self.scannerCancellationResolvers
      self.scannerCancellationResolvers.removeAll()
      for resolveCancellation in cancellationResolvers {
        resolveCancellation(nil)
      }
    }
    presenter.present(scanner, animated: true)
  }

  @objc(cancelQRCodeScan:rejecter:)
  func cancelQRCodeScan(
    _ resolve: @escaping RCTPromiseResolveBlock,
    rejecter _: @escaping RCTPromiseRejectBlock
  ) {
    DispatchQueue.main.async { [weak self] in
      guard let self, let scanner = self.scannerViewController else {
        resolve(nil)
        return
      }
      self.scannerCancellationResolvers.append(resolve)
      scanner.cancelScanning()
    }
  }

  @objc
  func invalidate() {
    browserAuthBridge.close()
    DispatchQueue.main.async { [weak self] in
      self?.scannerViewController?.cancelScanning()
    }
  }

  private func topViewController() -> UIViewController? {
    let scenes = UIApplication.shared.connectedScenes.compactMap {
      $0 as? UIWindowScene
    }
    let root =
      scenes
      .flatMap(\.windows)
      .first(where: \.isKeyWindow)?
      .rootViewController
    var current = root
    while let presented = current?.presentedViewController {
      current = presented
    }
    return current
  }

  private func validatedCookieURL(_ rawURL: String) throws -> URL {
    guard
      let url = URL(string: rawURL.trimmingCharacters(in: .whitespacesAndNewlines)),
      url.scheme == "https",
      url.host != nil
    else {
      throw MobileSecurityError.invalidAccountURL
    }
    return url
  }
}

private struct MobileIdentity {
  let deviceID: String
  let publicKey: String
}

private enum MobileSecurityError: Error {
  case invalidAccountURL
  case invalidSession
  case invalidStoredIdentity
  case keychain(OSStatus)
}

private final class MobileSecureStore {
  private let keychain = MobileKeychain()

  func getOrCreateIdentity() throws -> MobileIdentity {
    let deviceID: String
    if let stored = try keychain.read(account: "device-id"),
      let value = String(data: stored, encoding: .utf8),
      !value.isEmpty
    {
      deviceID = value
    } else {
      deviceID = UUID().uuidString
      try keychain.write(Data(deviceID.utf8), account: "device-id")
    }

    let privateKey = try signingKey()
    return MobileIdentity(
      deviceID: deviceID,
      publicKey: privateKey.publicKey.rawRepresentation.base64URLEncodedString()
    )
  }

  func sign(_ message: Data) throws -> String {
    try signingKey().signature(for: message).base64EncodedString()
  }

  func loadSession() throws -> [String: String]? {
    guard let raw = try keychain.read(account: "account-session") else {
      return nil
    }
    guard
      let object = try JSONSerialization.jsonObject(with: raw) as? [String: String],
      object["sessionId"]?.isEmpty == false
    else {
      try? keychain.delete(account: "account-session")
      return nil
    }
    return object
  }

  func saveSession(_ session: [String: String]) throws {
    guard session["sessionId"]?.isEmpty == false else {
      throw MobileSecurityError.invalidSession
    }
    try keychain.write(
      JSONSerialization.data(withJSONObject: session),
      account: "account-session"
    )
  }

  func clearSession() throws {
    try keychain.delete(account: "account-session")
  }

  private func signingKey() throws -> Curve25519.Signing.PrivateKey {
    if let stored = try keychain.read(account: "signing-ed25519-v1") {
      guard
        let key = try? Curve25519.Signing.PrivateKey(rawRepresentation: stored)
      else {
        try keychain.delete(account: "signing-ed25519-v1")
        throw MobileSecurityError.invalidStoredIdentity
      }
      return key
    }
    let key = Curve25519.Signing.PrivateKey()
    try keychain.write(key.rawRepresentation, account: "signing-ed25519-v1")
    return key
  }
}

private final class MobileKeychain {
  private let service =
    (Bundle.main.bundleIdentifier ?? "dev.tutti.mobile") + ".secure-state"

  func read(account: String) throws -> Data? {
    var query = baseQuery(account: account)
    query[kSecReturnData as String] = true
    query[kSecMatchLimit as String] = kSecMatchLimitOne
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    if status == errSecItemNotFound {
      return nil
    }
    guard status == errSecSuccess else {
      throw MobileSecurityError.keychain(status)
    }
    return result as? Data
  }

  func write(_ data: Data, account: String) throws {
    let query = baseQuery(account: account)
    let attributes: [String: Any] = [
      kSecValueData as String: data,
      kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let updateStatus = SecItemUpdate(
      query as CFDictionary,
      attributes as CFDictionary
    )
    if updateStatus == errSecItemNotFound {
      var insertion = query
      for (key, value) in attributes {
        insertion[key] = value
      }
      let addStatus = SecItemAdd(insertion as CFDictionary, nil)
      guard addStatus == errSecSuccess else {
        throw MobileSecurityError.keychain(addStatus)
      }
    } else if updateStatus != errSecSuccess {
      throw MobileSecurityError.keychain(updateStatus)
    }
  }

  func delete(account: String) throws {
    let status = SecItemDelete(baseQuery(account: account) as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else {
      throw MobileSecurityError.keychain(status)
    }
  }

  private func baseQuery(account: String) -> [String: Any] {
    [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: service,
      kSecAttrAccount as String: account,
    ]
  }
}

private func deviceArchitecture() -> String {
  var systemInfo = utsname()
  uname(&systemInfo)
  return withUnsafePointer(to: &systemInfo.machine) { pointer in
    pointer.withMemoryRebound(to: CChar.self, capacity: 1) {
      String(cString: $0)
    }
  }
}

extension Data {
  fileprivate func base64URLEncodedString() -> String {
    base64EncodedString()
      .replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }
}
