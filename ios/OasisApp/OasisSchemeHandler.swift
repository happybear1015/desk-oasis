import Foundation
import WebKit

final class OasisSchemeHandler: NSObject, WKURLSchemeHandler {
    private var stoppedTasks = Set<ObjectIdentifier>()

    private static let mimeMap: [String: String] = [
        "html": "text/html; charset=utf-8",
        "js": "application/javascript; charset=utf-8",
        "mjs": "application/javascript; charset=utf-8",
        "css": "text/css; charset=utf-8",
        "json": "application/json; charset=utf-8",
        "svg": "image/svg+xml",
        "png": "image/png",
        "jpg": "image/jpeg",
        "jpeg": "image/jpeg",
        "webp": "image/webp",
        "ico": "image/x-icon",
        "woff2": "font/woff2",
        "mp3": "audio/mpeg",
        "wav": "audio/wav"
    ]

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        let taskId = ObjectIdentifier(urlSchemeTask)
        guard let reqUrl = urlSchemeTask.request.url else {
            urlSchemeTask.didFailWithError(URLError(.badURL))
            return
        }

        var rawPath = reqUrl.path
        if rawPath.isEmpty || rawPath == "/" {
            rawPath = "/ios.html"
        }
        let safeParts = rawPath
            .split(separator: "/")
            .map(String.init)
            .filter { !$0.isEmpty && $0 != "." && $0 != ".." }

        guard let bundleRoot = Bundle.main.resourceURL?.appendingPathComponent("WebBundle", isDirectory: true) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }

        var fileUrl = bundleRoot
        for part in safeParts {
            fileUrl.appendPathComponent(part)
        }

        guard FileManager.default.fileExists(atPath: fileUrl.path),
              let data = try? Data(contentsOf: fileUrl) else {
            if !stoppedTasks.contains(taskId) {
                if let resp = HTTPURLResponse(
                    url: reqUrl,
                    statusCode: 404,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*"]
                ) {
                    urlSchemeTask.didReceive(resp)
                    urlSchemeTask.didReceive(Data("Not Found".utf8))
                    urlSchemeTask.didFinish()
                } else {
                    urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
                }
            } else {
                stoppedTasks.remove(taskId)
            }
            return
        }

        guard !stoppedTasks.contains(taskId) else {
            stoppedTasks.remove(taskId)
            return
        }

        let ext = fileUrl.pathExtension.lowercased()
        let mime = Self.mimeMap[ext] ?? "application/octet-stream"
        let headers: [String: String] = [
            "Content-Type": mime,
            "Content-Length": "\(data.count)",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": ext == "html" ? "no-cache" : "public, max-age=31536000"
        ]
        if let response = HTTPURLResponse(url: reqUrl, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: headers) {
            urlSchemeTask.didReceive(response)
            urlSchemeTask.didReceive(data)
            urlSchemeTask.didFinish()
        } else {
            urlSchemeTask.didFailWithError(URLError(.cannotParseResponse))
        }
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {
        stoppedTasks.insert(ObjectIdentifier(urlSchemeTask))
    }
}
