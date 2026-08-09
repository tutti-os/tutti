import AVFoundation
import UIKit

enum QRCodeScannerError: Error {
  case cancelled
  case emptyCode
  case permissionDenied
  case unavailable
}

enum QRCodeScannerResult {
  case manual
  case scanned(String)
}

final class QRCodeScannerViewController: UIViewController,
  AVCaptureMetadataOutputObjectsDelegate
{
  var onCompletion: ((Result<QRCodeScannerResult, Error>) -> Void)?

  private let captureSession = AVCaptureSession()
  private let captureQueue = DispatchQueue(
    label: "sh.tutti.mobile.qr-capture",
    qos: .userInitiated
  )
  private let previewLayer = AVCaptureVideoPreviewLayer()
  private var completed = false

  override func viewDidLoad() {
    super.viewDidLoad()
    view.backgroundColor = .black
    previewLayer.session = captureSession
    previewLayer.videoGravity = .resizeAspectFill
    view.layer.addSublayer(previewLayer)

    let titleLabel = UILabel()
    titleLabel.translatesAutoresizingMaskIntoConstraints = false
    titleLabel.text = NSLocalizedString("scanner.title", comment: "")
    titleLabel.textColor = .white
    titleLabel.font = .preferredFont(forTextStyle: .headline)
    titleLabel.textAlignment = .center
    titleLabel.numberOfLines = 0
    view.addSubview(titleLabel)

    let cancelButton = UIButton(type: .system)
    cancelButton.translatesAutoresizingMaskIntoConstraints = false
    cancelButton.setTitle(
      NSLocalizedString("scanner.cancel", comment: ""),
      for: .normal
    )
    cancelButton.setTitleColor(.white, for: .normal)
    cancelButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    cancelButton.addTarget(self, action: #selector(cancel), for: .touchUpInside)
    view.addSubview(cancelButton)

    let manualButton = UIButton(type: .system)
    manualButton.translatesAutoresizingMaskIntoConstraints = false
    manualButton.setTitle(
      NSLocalizedString("scanner.manual", comment: ""),
      for: .normal
    )
    manualButton.setTitleColor(.white, for: .normal)
    manualButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
    manualButton.addTarget(self, action: #selector(manualEntry), for: .touchUpInside)
    view.addSubview(manualButton)

    NSLayoutConstraint.activate([
      titleLabel.topAnchor.constraint(
        equalTo: view.safeAreaLayoutGuide.topAnchor,
        constant: 24
      ),
      titleLabel.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 88),
      titleLabel.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -24),
      cancelButton.topAnchor.constraint(
        equalTo: view.safeAreaLayoutGuide.topAnchor,
        constant: 24
      ),
      cancelButton.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 24),
      manualButton.bottomAnchor.constraint(
        equalTo: view.safeAreaLayoutGuide.bottomAnchor,
        constant: -24
      ),
      manualButton.centerXAnchor.constraint(equalTo: view.centerXAnchor),
    ])

    configureCapture()
  }

  override func viewDidLayoutSubviews() {
    super.viewDidLayoutSubviews()
    previewLayer.frame = view.bounds
  }

  override func viewWillDisappear(_ animated: Bool) {
    super.viewWillDisappear(animated)
    stopCapture()
  }

  func metadataOutput(
    _ output: AVCaptureMetadataOutput,
    didOutput metadataObjects: [AVMetadataObject],
    from connection: AVCaptureConnection
  ) {
    guard
      let readable = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
      readable.type == .qr
    else {
      return
    }
    let value =
      readable.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines)
      ?? ""
    complete(
      value.isEmpty
        ? .failure(QRCodeScannerError.emptyCode)
        : .success(.scanned(value))
    )
  }

  private func configureCapture() {
    #if targetEnvironment(simulator)
      complete(.failure(QRCodeScannerError.unavailable), shouldDismiss: false)
      return
    #else
      switch AVCaptureDevice.authorizationStatus(for: .video) {
      case .authorized:
        startCapture()
      case .notDetermined:
        AVCaptureDevice.requestAccess(for: .video) { [weak self] granted in
          DispatchQueue.main.async {
            guard let self else { return }
            if granted {
              self.startCapture()
            } else {
              self.complete(.failure(QRCodeScannerError.permissionDenied))
            }
          }
        }
      case .denied, .restricted:
        complete(.failure(QRCodeScannerError.permissionDenied))
      @unknown default:
        complete(.failure(QRCodeScannerError.unavailable))
      }
    #endif
  }

  private func startCapture() {
    guard !completed else { return }
    guard
      let camera = AVCaptureDevice.default(for: .video),
      let input = try? AVCaptureDeviceInput(device: camera),
      captureSession.canAddInput(input)
    else {
      complete(.failure(QRCodeScannerError.unavailable))
      return
    }
    captureSession.addInput(input)

    let output = AVCaptureMetadataOutput()
    guard captureSession.canAddOutput(output) else {
      complete(.failure(QRCodeScannerError.unavailable))
      return
    }
    captureSession.addOutput(output)
    output.setMetadataObjectsDelegate(self, queue: .main)
    output.metadataObjectTypes = [.qr]
    captureQueue.async { [session = captureSession] in
      session.startRunning()
    }
  }

  @objc private func cancel() {
    complete(.failure(QRCodeScannerError.cancelled))
  }

  @objc private func manualEntry() {
    complete(.success(.manual))
  }

  func cancelScanning() {
    complete(.failure(QRCodeScannerError.cancelled))
  }

  private func complete(
    _ result: Result<QRCodeScannerResult, Error>,
    shouldDismiss: Bool = true
  ) {
    guard !completed else { return }
    completed = true
    let completion = onCompletion
    stopCapture { [weak self] in
      guard let self else {
        completion?(result)
        return
      }
      if shouldDismiss {
        self.dismiss(animated: true) {
          completion?(result)
        }
      } else {
        completion?(result)
      }
    }
  }

  private func stopCapture(completion: (() -> Void)? = nil) {
    captureQueue.async { [session = captureSession] in
      if session.isRunning {
        session.stopRunning()
      }
      if let completion {
        DispatchQueue.main.async(execute: completion)
      }
    }
  }
}
