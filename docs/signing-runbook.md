# Bike 正式签名与公证 Runbook

记录日期为 2026-11-10。本文补齐发布链路上「ad-hoc → Developer ID 签名 → 公证 → 自动更新验收」这条缺失环节的操作步骤，不改变已有 ad-hoc 发布边界。执行完成后，再在对应版本的 `release-*.md` 与 `publish-verification-*.md` 中记录真实结果。

## 为什么必须补

macOS 的更新安装器在替换应用前会校验下载包的代码签名与当前运行的应用同源。ad-hoc 签名没有证书和 Team ID，这一步必然失败，所以应用内检查、下载、进度和安装前保存可以工作，但原生替换无法通过验收。这条限制与 Electron 版本无关，也无法用配置绕过；正式签名是前置条件。

自动更新的另一个硬性条件是**跨版本 Team ID 不变**。已安装的 ad-hoc 版本没有 Team ID，因此**不能**自动升级到第一个签名版本；该次迁移必须让用户手动下载 DMG。从第二个签名版本开始，应用内自动替换才具备可验收条件。

## 一次性准备

| 项目 | 说明 |
| --- | --- |
| Apple Developer Program | 个人 99 美元/年，公司需 D-U-N-S；没有账号无法获得 Developer ID 证书 |
| Developer ID Application 证书 | Xcode > Settings > Accounts > Manage Certificates 创建，或 CSR 上传后导出 `.p12`；有效期 5 年 |
| 公证凭据 | App 专用密码（Apple ID 方式）或 App Store Connect API Key（`.p8` + Key ID + Issuer） |
| 钥匙串 profile | `xcrun notarytool store-credentials` 保存，供 `signed-release-candidate.mjs` 与 electron-builder 共用 |

证书过期或更换不影响已发布版本，但新版本必须用当前有效证书签名，且 Team ID 保持不变。

## 本地流程

先修工具链，再确认身份可用：

```bash
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
security find-identity -v -p codesigning   # 应出现 Developer ID Application: 姓名 (TEAMID)
```

保存公证凭据（Apple ID 方式）：

```bash
xcrun notarytool store-credentials "bike-local-notary" \
  --apple-id "you@example.com" --team-id "TEAMID"
# 按交互提示输入 App 专用密码，不写入命令历史或进程参数
```

再执行前置检查与正式打包：

```bash
BIKE_EXPECTED_TEAM_ID="TEAMID" \
CSC_NAME="Developer ID Application: 姓名 (TEAMID)" \
APPLE_KEYCHAIN_PROFILE=bike-local-notary \
npm run release:preflight:signed

BIKE_EXPECTED_TEAM_ID="TEAMID" \
CSC_NAME="Developer ID Application: 姓名 (TEAMID)" \
APPLE_KEYCHAIN_PROFILE=bike-local-notary \
npm run electron:dist:signed

BIKE_EXPECTED_TEAM_ID="TEAMID" npm run release:verify:signed -- --json
```

`signed-release-candidate.mjs` 已完成的事情：强制签名、hardened runtime、`config/entitlements.mac.plist`、签名 DMG、公证并装订 DMG、重算 blockmap 与 `latest-mac.yml` 的 SHA-512、生成 `.sha256`。`release:verify:signed` 会只读挂载 DMG、解压 ZIP，逐项核对签名身份、TeamIdentifier、runtime 标志、公证票据装订、Gatekeeper 评估和清单一致性，失败即非零退出。

## CI 流程

`.github/workflows/macos-signed.yml` 为手动触发。需要在 `macos-release` environment 中配置以下 secrets：

| Secret | 内容 |
| --- | --- |
| `MAC_CERTIFICATE_P12` | Developer ID Application 证书的 `.p12`（base64 文本或路径，electron-builder 的 `CSC_LINK` 两种都接受） |
| `MAC_CERTIFICATE_PASSWORD` | `.p12` 导出密码 |
| `MAC_SIGNING_IDENTITY` | 完整身份名，必须与证书 CN 完全一致 |
| `NOTARY_KEY_P8` | API Key 的 `.p8` 明文内容；若存的是 base64，需在写入文件前解码 |
| `NOTARY_KEY_ID` | Key ID |
| `NOTARY_ISSUER` | Issuer UUID |

还需在同一 environment 配置变量 `MAC_TEAM_ID`，填写预期的 10 位 Team ID；不得从候选 App 自动推断可信身份。

工作流依次执行：安装依赖与普通检查（无签名密钥）→ 保存公证凭据 → 前置检查 → 签名构建 → 产物核对 → 包内附件与更新流程测试 → 上传 `bike-signed-<run>` 制品（DMG、ZIP、blockmap、sha256、`latest-mac.yml`、`signature-verification.json`）→ 清理临时密钥。没有通过核对的工作流不会产出可发布制品。

## 发布与自动更新

- GitHub Release 资产需包含 `Bike-<version>-arm64.dmg`、`Bike-<version>-arm64.zip`、两者的 `.blockmap`、`.sha256` 和 `latest-mac.yml`。Squirrel.Mac 依赖 ZIP 与 `latest-mac.yml`，只发 DMG 会导致应用内更新失败。
- `latest-mac.yml` 中的版本、`sha512`、`size` 必须与上传后的字节一致；已签名的 DMG 在装订票据后会改变字节，因此必须以 `release:verify:signed` 的输出为准，不能用打包前的摘要。
- 签名身份（Team ID）不得在版本之间变化；如需更换证书，保持 Team ID 不变，否则线上版本会断更，只能发过渡版本。

## 验收清单

签名链路完成后，按下列顺序留证，全部通过才把「正式签名、公证」从未完成项移出：

1. 干净用户目录安装签名版 DMG：不出现 Gatekeeper 拦截，`spctl` 显示 `source=Notarized Developer ID`。
2. 从签名版 A 自动更新到签名版 B：下载、替换、重启、版本号变化的完整链路，应用数据和设置保留。
3. 断网、篡改 ZIP、替换清单中的 SHA-512 三种失败路径：更新被拒绝，原应用不被破坏。
4. 降级与回退：确认 `allowDowngrade` 的既有行为，或明确不支持降级并写入发布说明。
5. 已安装 ad-hoc 存量版本的用户：发布说明明确指出需手动下载第一个签名版本，不承诺应用内迁移。
6. 产物证据归档：`signature-verification.json`、`notarytool log`（如有失败）、两份 `codesign -dv --verbose=4` 输出。

## 失败排查

| 现象 | 处理 |
| --- | --- |
| 前置检查报「钥匙串找不到身份」 | 证书未安装或 CN 不完整；在 Xcode 重新创建并确认 `security find-identity` 能看到 |
| `notarytool` 报 `No Keychain password item` | profile 名称拼写不一致，或凭据未保存 |
| 公证返回 Invalid | `xcrun notarytool log <submission-id> --keychain-profile <profile>` 查看具体条目；常见原因是缺少 hardened runtime、残留 `get-task-allow`、签名顺序错误 |
| 应用首次启动被系统拦截 | DMG 未公证或未装订；确认 `stapler validate` 通过且 DMG 本身被签名 |
| 应用内更新提示签名不匹配 | 新旧版本 Team ID 不同，或 ZIP 内的应用未使用 Developer ID 签名 |
## 2.0.1 候选门禁

GitHub Environment 需配置 `MAC_TEAM_ID` 变量；预检与验签都精确比较该身份。证书凭据仅注入预检和签名步骤。普通检查在凭据注入前执行；运行时测试不注入签名凭据环境变量。只有全部验证成功才上传正式候选；失败的构建不会作为 signed candidate 产出。
