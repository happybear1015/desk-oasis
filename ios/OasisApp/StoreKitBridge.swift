import Foundation
import StoreKit

@MainActor
final class StoreKitBridge {
    var onTransactionJws: ((String) -> Void)?
    private var updatesTask: Task<Void, Never>?

    init() {
        updatesTask = Task { [weak self] in
            for await verification in Transaction.updates {
                let jws = verification.jwsRepresentation
                if case .verified(let tx) = verification {
                    await tx.finish()
                }
                await MainActor.run {
                    self?.onTransactionJws?(jws)
                }
            }
        }
    }

    deinit {
        updatesTask?.cancel()
    }

    func listProducts(ids: [String]) async -> [[String: Any]] {
        let unique = Array(Set(ids.filter { !$0.isEmpty }))
        guard !unique.isEmpty else { return [] }
        do {
            let products = try await Product.products(for: unique)
            return products.map { p in
                [
                    "id": p.id,
                    "displayPrice": p.displayPrice,
                    "title": p.displayName,
                    "description": p.description
                ]
            }
        } catch {
            return []
        }
    }

    func purchase(productId: String) async -> [String: Any] {
        guard !productId.isEmpty else {
            return ["ok": false, "message": "商品编号为空"]
        }
        do {
            let products = try await Product.products(for: [productId])
            guard let product = products.first else {
                return ["ok": false, "message": "内购商品正在同步，请稍后再试"]
            }
            let result = try await product.purchase()
            switch result {
            case .success(let verification):
                let jws = verification.jwsRepresentation
                if case .verified(let tx) = verification {
                    await tx.finish()
                }
                return ["ok": true, "jws": jws]
            case .userCancelled:
                return ["ok": false, "cancelled": true, "message": "已取消支付"]
            case .pending:
                return ["ok": false, "pending": true, "message": "交易等待系统确认"]
            @unknown default:
                return ["ok": false, "message": "未知支付状态"]
            }
        } catch {
            return ["ok": false, "message": error.localizedDescription]
        }
    }

    func restore() async -> [String: Any] {
        do {
            try await AppStore.sync()
            var jwsList: [String] = []
            for await verification in Transaction.currentEntitlements {
                jwsList.append(verification.jwsRepresentation)
            }
            return ["ok": true, "jwsList": jwsList]
        } catch {
            return ["ok": false, "message": error.localizedDescription]
        }
    }
}
