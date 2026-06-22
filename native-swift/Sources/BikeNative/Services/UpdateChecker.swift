import Foundation

struct UpdateCheckResult: Equatable {
    var ok: Bool
    var currentVersion: String
    var latestVersion: String
    var updateAvailable: Bool
    var releaseUrl: URL
    var releaseName: String
    var error: String?
}

enum UpdateChecker {
    static let releasesAPIURL = URL(string: "https://api.github.com/repos/MoarLiu/Bike/releases/latest")!
    static let releasesPageURL = URL(string: "https://github.com/MoarLiu/Bike/releases")!

    static func currentVersion() -> String {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "1.4.1"
    }

    static func compareVersions(_ lhs: String, _ rhs: String) -> Int {
        let left = normalizedParts(lhs)
        let right = normalizedParts(rhs)
        let count = max(left.count, right.count)
        for index in 0..<count {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a > b { return 1 }
            if a < b { return -1 }
        }
        return 0
    }

    static func resultFromRelease(currentVersion: String, release: [String: Any]) -> UpdateCheckResult {
        let tag = (release["tag_name"] as? String) ?? ""
        let latest = tag.replacingOccurrences(of: #"^[vV]"#, with: "", options: .regularExpression)
        let url = URL(string: release["html_url"] as? String ?? "") ?? releasesPageURL
        let name = (release["name"] as? String) ?? "Bike \(latest)"
        return UpdateCheckResult(
            ok: true,
            currentVersion: currentVersion,
            latestVersion: latest,
            updateAvailable: compareVersions(latest, currentVersion) > 0,
            releaseUrl: url,
            releaseName: name,
            error: nil
        )
    }

    static func fetchLatestRelease(currentVersion: String = currentVersion()) async -> UpdateCheckResult {
        do {
            var request = URLRequest(url: releasesAPIURL, timeoutInterval: 15)
            request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
            request.setValue("Bike/\(currentVersion)", forHTTPHeaderField: "User-Agent")

            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
                let status = (response as? HTTPURLResponse)?.statusCode ?? 0
                throw NSError(domain: "Bike.UpdateChecker", code: status, userInfo: [
                    NSLocalizedDescriptionKey: status > 0 ? "GitHub Releases 请求失败：HTTP \(status)" : "GitHub Releases 请求失败"
                ])
            }
            guard let release = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw NSError(domain: "Bike.UpdateChecker", code: -1, userInfo: [
                    NSLocalizedDescriptionKey: "GitHub Releases 返回内容无法解析"
                ])
            }
            return resultFromRelease(currentVersion: currentVersion, release: release)
        } catch {
            return UpdateCheckResult(
                ok: false,
                currentVersion: currentVersion,
                latestVersion: "",
                updateAvailable: false,
                releaseUrl: releasesPageURL,
                releaseName: "",
                error: error.localizedDescription
            )
        }
    }

    private static func normalizedParts(_ version: String) -> [Int] {
        version
            .replacingOccurrences(of: #"^[^\d]+"#, with: "", options: .regularExpression)
            .split(separator: ".")
            .map { part in
                let numeric = part.prefix { $0.isNumber }
                return Int(numeric) ?? 0
            }
    }
}
