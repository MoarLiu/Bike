import Foundation
import Security

public final class AiSettingsStore: @unchecked Sendable {
    private let defaults: UserDefaults
    private let service = "com.bike.ios.ai"
    private let account = "api-key"

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    public func load() -> AiSettings {
        AiSettings(
            endpoint: AiEndpoint(rawValue: defaults.string(forKey: Keys.endpoint) ?? "") ?? .responses,
            baseUrl: defaults.string(forKey: Keys.baseUrl) ?? "https://api.openai.com/v1",
            apiKey: loadAPIKey(),
            model: defaults.string(forKey: Keys.model) ?? "gpt-4.1-mini"
        )
    }

    @discardableResult
    public func save(_ settings: AiSettings) throws -> AiSettingsStorageMode {
        let normalized = settings.normalized()
        defaults.set(normalized.endpoint.rawValue, forKey: Keys.endpoint)
        defaults.set(normalized.baseUrl, forKey: Keys.baseUrl)
        defaults.set(normalized.model, forKey: Keys.model)
        do {
            try saveAPIKeyToKeychain(normalized.apiKey)
            defaults.removeObject(forKey: Keys.apiKeyFallback)
            return .keychain
        } catch {
#if DEBUG
            defaults.set(normalized.apiKey, forKey: Keys.apiKeyFallback)
            return .debugFallback
#else
            throw error
#endif
        }
    }

    private func loadAPIKey() -> String {
        let keychainValue = loadAPIKeyFromKeychain()
        if !keychainValue.isEmpty {
            return keychainValue
        }
#if DEBUG
        return defaults.string(forKey: Keys.apiKeyFallback) ?? ""
#else
        return ""
#endif
    }

    private func loadAPIKeyFromKeychain() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data else {
            return ""
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func saveAPIKeyToKeychain(_ value: String) throws {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account
        ]
        SecItemDelete(query as CFDictionary)
        guard !value.isEmpty else { return }

        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            kSecValueData as String: Data(value.utf8)
        ]
        let status = SecItemAdd(item as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.unhandledStatus(status)
        }
    }

    private enum Keys {
        static let endpoint = "bike-ai-endpoint"
        static let baseUrl = "bike-ai-base-url"
        static let model = "bike-ai-model"
        static let apiKeyFallback = "bike-ai-api-key-debug-fallback"
    }
}

public enum AiSettingsStorageMode: Equatable, Sendable {
    case keychain
    case debugFallback
}

public enum KeychainError: LocalizedError, Equatable {
    case unhandledStatus(OSStatus)

    public var errorDescription: String? {
        switch self {
        case .unhandledStatus(let status):
            "Keychain 保存失败：\(status)"
        }
    }
}
