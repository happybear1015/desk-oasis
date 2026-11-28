import SwiftUI

@main
struct OasisApp: App {
    var body: some Scene {
        WindowGroup {
            OasisRootView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

struct OasisRootView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> OasisWebViewController {
        OasisWebViewController()
    }

    func updateUIViewController(_ uiViewController: OasisWebViewController, context: Context) {}
}
