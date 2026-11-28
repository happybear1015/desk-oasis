import LocalAuthentication
import Photos
import UIKit
import WebKit

@MainActor
private final class WeakMessageBridge: NSObject, WKScriptMessageHandlerWithReply {
    weak var target: OasisWebViewController?

    init(target: OasisWebViewController) {
        self.target = target
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void
    ) {
        guard let target = target else {
            replyHandler(nil, "disposed")
            return
        }
        target.handleScriptMessage(message, replyHandler: replyHandler)
    }
}

@MainActor
final class OasisWebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView!
    private let storeKit = StoreKitBridge()
    private let pipManager = OasisPipManager()

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var prefersHomeIndicatorAutoHidden: Bool { true }

    override func viewDidLoad() {
        super.viewDidLoad()
        let bg = UIColor(red: 9.0 / 255.0, green: 9.0 / 255.0, blue: 11.0 / 255.0, alpha: 1.0)
        view.backgroundColor = bg

        let userController = WKUserContentController()
        let bridgeScript = """
        window.OasisNative = {
          platform: 'ios',
          listProducts: (ids) => window.webkit.messageHandlers.oasis.postMessage({ action: 'listProducts', ids: Array.isArray(ids) ? ids : [] }),
          purchase: (productId) => window.webkit.messageHandlers.oasis.postMessage({ action: 'purchase', productId: String(productId || '') }),
          restore: () => window.webkit.messageHandlers.oasis.postMessage({ action: 'restore' }),
          haptic: (style) => window.webkit.messageHandlers.oasis.postMessage({ action: 'haptic', style: String(style || 'light') }),
          setKeepAwake: (on) => window.webkit.messageHandlers.oasis.postMessage({ action: 'setKeepAwake', on: Boolean(on) }),
          startPip: () => window.webkit.messageHandlers.oasis.postMessage({ action: 'startPip' }),
          stopPip: () => window.webkit.messageHandlers.oasis.postMessage({ action: 'stopPip' }),
          setAutoPip: (on) => window.webkit.messageHandlers.oasis.postMessage({ action: 'setAutoPip', on: Boolean(on) }),
          pushPipFrame: (base64) => window.webkit.messageHandlers.oasis.postMessage({ action: 'pushPipFrame', base64: String(base64 || '') }),
          canBiometricAuth: () => window.webkit.messageHandlers.oasis.postMessage({ action: 'canBiometricAuth' }),
          authenticate: (reason) => window.webkit.messageHandlers.oasis.postMessage({ action: 'authenticate', reason: String(reason || '验证以解锁锁屏屏保') }),
          saveWallpaperImage: (base64) => window.webkit.messageHandlers.oasis.postMessage({ action: 'saveWallpaperImage', base64: String(base64 || '') })
        };
        """
        userController.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        userController.addScriptMessageHandler(WeakMessageBridge(target: self), contentWorld: .page, name: "oasis")

        let config = WKWebViewConfiguration()
        config.userContentController = userController
        config.setURLSchemeHandler(OasisSchemeHandler(), forURLScheme: "oasis")
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        webView = WKWebView(frame: view.bounds, configuration: config)
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.isOpaque = true
        webView.backgroundColor = bg
        webView.scrollView.backgroundColor = bg
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        if #available(iOS 16.4, *) {
            #if DEBUG
            webView.isInspectable = true
            #endif
        }

        view.addSubview(webView)
        NSLayoutConstraint.activate([
            webView.topAnchor.constraint(equalTo: view.topAnchor),
            webView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            webView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: view.trailingAnchor)
        ])

        pipManager.attach(to: view)
        pipManager.onStateChanged = { [weak self] active in
            self?.webView.evaluateJavaScript(
                "window.dispatchEvent(new CustomEvent('oasis:pip-state', { detail: { active: \(active ? "true" : "false") } }));",
                completionHandler: nil
            )
        }

        storeKit.onTransactionJws = { [weak self] jws in
            guard let self = self,
                  let data = try? JSONSerialization.data(withJSONObject: ["jws": jws]),
                  let json = String(data: data, encoding: .utf8) else { return }
            self.webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('oasis:iap-transaction', { detail: \(json) }));", completionHandler: nil)
        }

        if let startUrl = URL(string: "oasis://app/ios.html") {
            webView.load(URLRequest(url: startUrl))
        }
    }

    func handleScriptMessage(_ message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        guard let body = message.body as? [String: Any],
              let action = body["action"] as? String else {
            replyHandler(["ok": false, "message": "无效的原生指令"], nil)
            return
        }

        switch action {
        case "listProducts":
            let ids = (body["ids"] as? [String]) ?? []
            Task { @MainActor in
                let items = await storeKit.listProducts(ids: ids)
                replyHandler(items, nil)
            }
        case "purchase":
            let productId = (body["productId"] as? String) ?? ""
            Task { @MainActor in
                let result = await storeKit.purchase(productId: productId)
                replyHandler(result, nil)
            }
        case "restore":
            Task { @MainActor in
                let result = await storeKit.restore()
                replyHandler(result, nil)
            }
        case "haptic":
            let style = (body["style"] as? String) ?? "light"
            triggerHaptic(style: style)
            replyHandler(["ok": true], nil)
        case "setKeepAwake":
            let on = (body["on"] as? Bool) ?? false
            UIApplication.shared.isIdleTimerDisabled = on
            replyHandler(["ok": true], nil)
        case "startPip":
            replyHandler(pipManager.start(), nil)
        case "stopPip":
            replyHandler(pipManager.stop(), nil)
        case "setAutoPip":
            let on = (body["on"] as? Bool) ?? false
            pipManager.setAutoPip(on)
            replyHandler(["ok": true, "supported": pipManager.isSupported], nil)
        case "pushPipFrame":
            if let base64 = body["base64"] as? String {
                pipManager.pushFrame(base64Jpeg: base64)
            }
            replyHandler(["ok": true], nil)
        case "canBiometricAuth":
            replyHandler(checkBiometricAuth(), nil)
        case "authenticate":
            let reason = (body["reason"] as? String) ?? "验证以解锁桌面生态锁屏"
            authenticateUser(reason: reason, completion: replyHandler)
        case "saveWallpaperImage":
            let base64 = (body["base64"] as? String) ?? ""
            saveWallpaperToPhotos(base64: base64, completion: replyHandler)
        default:
            replyHandler(["ok": false, "message": "未知指令: \(action)"], nil)
        }
    }

    private func checkBiometricAuth() -> [String: Any] {
        let context = LAContext()
        var error: NSError?
        let available = context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error)
        let kind: String
        switch context.biometryType {
        case .faceID: kind = "faceID"
        case .touchID: kind = "touchID"
        default: kind = available ? "passcode" : "none"
        }
        return ["available": available, "biometryType": kind]
    }

    private func authenticateUser(reason: String, completion: @escaping (Any?, String?) -> Void) {
        let context = LAContext()
        context.localizedCancelTitle = "取消"
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            completion(["ok": true, "bypassed": true], nil)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, evalError in
            DispatchQueue.main.async {
                if success {
                    completion(["ok": true], nil)
                } else {
                    completion(["ok": false, "message": evalError?.localizedDescription ?? "验证未通过"], nil)
                }
            }
        }
    }

    private func saveWallpaperToPhotos(base64: String, completion: @escaping (Any?, String?) -> Void) {
        let cleaned = base64.components(separatedBy: ",").last ?? base64
        guard let data = Data(base64Encoded: cleaned), let image = UIImage(data: data) else {
            completion(["ok": false, "message": "壁纸画面生成失败"], nil)
            return
        }
        PHPhotoLibrary.requestAuthorization(for: .addOnly) { status in
            guard status == .authorized || status == .limited else {
                DispatchQueue.main.async {
                    completion(["ok": false, "message": "请在系统设置中允许保存壁纸到相册"], nil)
                }
                return
            }
            PHPhotoLibrary.shared().performChanges({
                PHAssetChangeRequest.creationRequestForAsset(from: image)
            }) { success, error in
                DispatchQueue.main.async {
                    if success {
                        completion(["ok": true, "message": "已保存高清 3D 壁纸至相册，可前往「照片」设为锁屏或桌面壁纸"], nil)
                    } else {
                        completion(["ok": false, "message": error?.localizedDescription ?? "保存失败"], nil)
                    }
                }
            }
        }
    }

    private func triggerHaptic(style: String) {
        switch style {
        case "success":
            UINotificationFeedbackGenerator().notificationOccurred(.success)
        case "warning":
            UINotificationFeedbackGenerator().notificationOccurred(.warning)
        case "error":
            UINotificationFeedbackGenerator().notificationOccurred(.error)
        case "heavy":
            UIImpactFeedbackGenerator(style: .heavy).impactOccurred()
        case "medium":
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        case "soft":
            UIImpactFeedbackGenerator(style: .soft).impactOccurred()
        default:
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url,
              let scheme = url.scheme?.lowercased() else {
            decisionHandler(.allow)
            return
        }
        if scheme == "oasis" || scheme == "about" || scheme == "blob" || scheme == "data" {
            decisionHandler(.allow)
            return
        }
        if (scheme == "http" || scheme == "https"),
           (navigationAction.targetFrame == nil || navigationAction.navigationType == .linkActivated) {
            UIApplication.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            UIApplication.shared.open(url)
        }
        return nil
    }
}
