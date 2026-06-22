package com.bike.android.sync

import android.content.Context
import com.bike.android.data.OutlineDocument
import com.bike.android.data.Workspace
import com.bike.android.data.WorkspaceJson
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest

data class SyncConfig(
    val serverUrl: String = "",
    val token: String = "",
    val autoSync: Boolean = false,
    val autoSyncIntervalSeconds: Int = DEFAULT_AUTO_SYNC_INTERVAL_SECONDS,
) {
    val normalized: SyncConfig
        get() = copy(
            serverUrl = normalizeServerUrl(serverUrl),
            token = token.trim(),
            autoSyncIntervalSeconds = normalizeAutoSyncInterval(autoSyncIntervalSeconds),
        )

    val isConfigured: Boolean
        get() = validationMessage(this) == null

    companion object {
        fun normalizeServerUrl(value: String): String =
            value.trim().replace(Regex("/+$"), "")

        fun normalizeAutoSyncInterval(value: Int): Int =
            value.coerceAtLeast(MIN_AUTO_SYNC_INTERVAL_SECONDS)

        fun validationMessage(config: SyncConfig): String? {
            val normalized = config.normalized
            if (normalized.serverUrl.isBlank()) return "请输入 Web 版地址"
            val url = runCatching { URL(normalized.serverUrl) }.getOrNull()
                ?: return "Web 版地址需要以 http:// 或 https:// 开头"
            if (url.protocol != "http" && url.protocol != "https") {
                return "Web 版地址需要以 http:// 或 https:// 开头"
            }
            if (normalized.token.isBlank()) return "请输入设备同步密钥"
            return null
        }
    }
}

data class SyncState(
    val serverUrl: String,
    val workspaceRevision: Int? = null,
    val documentRevisions: Map<String, Int> = emptyMap(),
    val documentFingerprints: Map<String, String> = emptyMap(),
    val deletedDocumentRevisions: Map<String, Int> = emptyMap(),
    val lastSyncedAt: String? = null,
) {
    companion object {
        fun empty(serverUrl: String): SyncState =
            SyncState(serverUrl = SyncConfig.normalizeServerUrl(serverUrl))
    }
}

data class SyncSummary(
    val uploaded: Int = 0,
    val downloaded: Int = 0,
    val deleted: Int = 0,
    val conflicts: List<String> = emptyList(),
) {
    val hasVisibleChange: Boolean
        get() = uploaded > 0 || downloaded > 0 || deleted > 0 || conflicts.isNotEmpty()

    val message: String
        get() {
            if (conflicts.isNotEmpty()) return "同步完成，但有 ${conflicts.size} 个冲突"
            val parts = listOfNotNull(
                uploaded.takeIf { it > 0 }?.let { "上传 $it" },
                downloaded.takeIf { it > 0 }?.let { "下载 $it" },
                deleted.takeIf { it > 0 }?.let { "删除 $it" },
            )
            return if (parts.isEmpty()) "已同步，无变化" else "已同步：${parts.joinToString("，")}"
        }
}

class SyncSettingsRepository(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun loadConfig(): SyncConfig =
        SyncConfig(
            serverUrl = preferences.getString(KEY_SERVER_URL, "").orEmpty(),
            token = preferences.getString(KEY_TOKEN, "").orEmpty(),
            autoSync = preferences.getBoolean(KEY_AUTO_SYNC, false),
            autoSyncIntervalSeconds = preferences.getInt(KEY_AUTO_SYNC_INTERVAL, DEFAULT_AUTO_SYNC_INTERVAL_SECONDS),
        ).normalized

    fun saveConfig(config: SyncConfig) {
        val normalized = config.normalized
        preferences.edit()
            .putString(KEY_SERVER_URL, normalized.serverUrl)
            .putString(KEY_TOKEN, normalized.token)
            .putBoolean(KEY_AUTO_SYNC, normalized.autoSync)
            .putInt(KEY_AUTO_SYNC_INTERVAL, normalized.autoSyncIntervalSeconds)
            .remove("tokenEncrypted")
            .apply()
    }

    fun loadState(serverUrl: String): SyncState {
        val normalizedServerUrl = SyncConfig.normalizeServerUrl(serverUrl)
        val raw = preferences.getString(KEY_STATE, null) ?: return SyncState.empty(normalizedServerUrl)
        return runCatching { json.decodeFromString<PersistedSyncState>(raw).toState() }
            .getOrNull()
            ?.takeIf { it.serverUrl == normalizedServerUrl }
            ?: SyncState.empty(normalizedServerUrl)
    }

    fun saveState(state: SyncState) {
        preferences.edit()
            .putString(KEY_STATE, json.encodeToString(PersistedSyncState.from(state)))
            .apply()
    }

    private companion object {
        const val PREFERENCES_NAME = "bike-sync-settings"
        const val KEY_SERVER_URL = "serverUrl"
        const val KEY_TOKEN = "token"
        const val KEY_AUTO_SYNC = "autoSync"
        const val KEY_AUTO_SYNC_INTERVAL = "autoSyncInterval"
        const val KEY_STATE = "state"
    }
}

class SyncService(
    private val config: SyncConfig,
    private val json: Json = WorkspaceJson.json,
) {
    suspend fun syncWorkspace(
        workspace: Workspace,
        previousState: SyncState,
    ): SyncResult =
        withContext(Dispatchers.IO) {
            var state = previousState.copy(serverUrl = config.normalized.serverUrl)
            var summary = SyncSummary()
            val manifest = fetchManifest()
            val remoteById = manifest.documents.associateBy { it.id }
            val remoteLiveIds = manifest.documents.filter { it.deletedAt == null }.map { it.id }.toSet()
            var documents = workspace.documents

            fun localById() = documents.associateBy { it.id }

            manifest.documents.forEach { remote ->
                val local = localById()[remote.id]
                val knownRevision = state.documentRevisions[remote.id]
                val knownFingerprint = state.documentFingerprints[remote.id]
                val localChanged = local?.let { documentFingerprint(it) != knownFingerprint } == true

                if (remote.deletedAt != null) {
                    state = state.recordDeleted(remote.id, remote.revision)
                    if (local != null) {
                        if (documents.size == 1) {
                            summary = summary.copy(conflicts = summary.conflicts + "${local.title}：远端已删除，但本机至少需要保留一个文档")
                        } else if (knownRevision != null && !localChanged) {
                            documents = documents.filterNot { it.id == remote.id }
                            summary = summary.copy(deleted = summary.deleted + 1)
                        } else {
                            summary = summary.copy(conflicts = summary.conflicts + "${local.title}：远端已删除，本机也有改动")
                        }
                    }
                    return@forEach
                }

                if (local == null) {
                    if (knownRevision != null) {
                        if (knownRevision == remote.revision) {
                            val deleted = deleteDocument(remote.id, remote.revision)
                            state = state.recordDeleted(remote.id, deleted.revision)
                            summary = summary.copy(deleted = summary.deleted + 1)
                        } else {
                            summary = summary.copy(conflicts = summary.conflicts + "${remote.title}：本机已删除，但远端有更新")
                        }
                    } else {
                        val downloaded = fetchDocument(remote.id)
                        documents = documents + downloaded.document
                        state = state.recordDocument(downloaded.document, downloaded.revision)
                        summary = summary.copy(downloaded = summary.downloaded + 1)
                    }
                    return@forEach
                }

                if (knownRevision == null) {
                    val downloaded = fetchDocument(remote.id)
                    if (documentFingerprint(downloaded.document) == documentFingerprint(local)) {
                        state = state.recordDocument(local, downloaded.revision)
                    } else {
                        summary = summary.copy(conflicts = summary.conflicts + "${local.title}：本机和远端都存在，尚未建立共同 revision")
                    }
                    return@forEach
                }

                if (knownRevision == remote.revision) {
                    if (localChanged) {
                        val uploaded = putDocument(local, knownRevision)
                        documents = documents.map { if (it.id == uploaded.document.id) uploaded.document else it }
                        state = state.recordDocument(uploaded.document, uploaded.revision)
                        summary = summary.copy(uploaded = summary.uploaded + 1)
                    } else {
                        state = state.recordDocument(local, remote.revision)
                    }
                    return@forEach
                }

                if (!localChanged) {
                    val downloaded = fetchDocument(remote.id)
                    documents = documents.map { if (it.id == downloaded.document.id) downloaded.document else it }
                    state = state.recordDocument(downloaded.document, downloaded.revision)
                    summary = summary.copy(downloaded = summary.downloaded + 1)
                } else {
                    summary = summary.copy(conflicts = summary.conflicts + "${local.title}：本机和远端都有新改动")
                }
            }

            documents.forEach { local ->
                if (remoteById[local.id] == null && local.id !in remoteLiveIds) {
                    val uploaded = putDocument(local, null)
                    documents = documents.map { if (it.id == uploaded.document.id) uploaded.document else it }
                    state = state.recordDocument(uploaded.document, uploaded.revision)
                    summary = summary.copy(uploaded = summary.uploaded + 1)
                }
            }

            val localOrder = workspace.documents.map { it.id }
            val preferredOrder = localOrder + manifest.documentOrder.filter { it !in localOrder }
            val ordered = orderedDocuments(documents, preferredOrder)
            val activeDocumentId = workspace.activeDocumentId.takeIf { id -> ordered.any { it.id == id } }
                ?: ordered.firstOrNull()?.id
                ?: workspace.activeDocumentId
            val nextWorkspace = workspace.copy(activeDocumentId = activeDocumentId, documents = ordered)
            state = if (summary.conflicts.isEmpty() && nextWorkspace.documents.isNotEmpty()) {
                val latest = fetchManifest()
                state.copy(
                    workspaceRevision = patchManifest(
                        expectedRevision = latest.workspaceRevision,
                        activeDocumentId = nextWorkspace.activeDocumentId,
                        documentOrder = nextWorkspace.documents.map { it.id },
                    ).workspaceRevision,
                    lastSyncedAt = isoNow(),
                )
            } else {
                state.copy(workspaceRevision = manifest.workspaceRevision, lastSyncedAt = isoNow())
            }
            SyncResult(nextWorkspace, state, summary)
        }

    suspend fun pullWorkspace(): PullResult =
        withContext(Dispatchers.IO) {
            var state = SyncState.empty(config.normalized.serverUrl)
            val manifest = fetchManifest()
            var documents = emptyList<OutlineDocument>()
            manifest.documents.forEach { summary ->
                if (summary.deletedAt != null) {
                    state = state.recordDeleted(summary.id, summary.revision)
                } else {
                    val remote = fetchDocument(summary.id)
                    documents = documents + remote.document
                    state = state.recordDocument(remote.document, remote.revision)
                }
            }
            state = state.copy(workspaceRevision = manifest.workspaceRevision, lastSyncedAt = isoNow())
            if (documents.isEmpty()) return@withContext PullResult(null, state)
            val ordered = orderedDocuments(documents, manifest.documentOrder)
            PullResult(
                Workspace(
                    activeDocumentId = manifest.activeDocumentId?.takeIf { id -> ordered.any { it.id == id } }
                        ?: ordered[0].id,
                    documents = ordered,
                ),
                state,
            )
        }

    suspend fun pushWorkspace(workspace: Workspace): PushResult =
        withContext(Dispatchers.IO) {
            var state = SyncState.empty(config.normalized.serverUrl)
            var summary = SyncSummary()
            var manifest = fetchManifest()
            val remoteById = manifest.documents.associateBy { it.id }
            workspace.documents.forEach { document ->
                val uploaded = putDocument(document, remoteById[document.id]?.revision)
                state = state.recordDocument(uploaded.document, uploaded.revision)
                summary = summary.copy(uploaded = summary.uploaded + 1)
            }
            manifest = fetchManifest()
            val patched = patchManifest(manifest.workspaceRevision, workspace.activeDocumentId, workspace.documents.map { it.id })
            state = state.copy(workspaceRevision = patched.workspaceRevision, lastSyncedAt = isoNow())
            PushResult(state, summary)
        }

    private fun fetchManifest(): SyncManifest =
        request("/api/sync/manifest")

    private fun fetchDocument(id: String): RemoteDocumentResponse =
        request("/api/documents/${pathComponent(id)}")

    private fun putDocument(document: OutlineDocument, expectedRevision: Int?): RemoteDocumentResponse =
        request(
            pathname = "/api/documents/${pathComponent(document.id)}",
            method = "PUT",
            body = json.encodeToString(PutDocumentBody(expectedRevision, document)),
        )

    private fun deleteDocument(id: String, expectedRevision: Int): DeletedDocumentResponse =
        request(
            pathname = "/api/documents/${pathComponent(id)}",
            method = "DELETE",
            body = json.encodeToString(DeleteDocumentBody(expectedRevision)),
        )

    private fun patchManifest(expectedRevision: Int, activeDocumentId: String?, documentOrder: List<String>): SyncManifest =
        request(
            pathname = "/api/sync/manifest",
            method = "PATCH",
            body = json.encodeToString(PatchManifestBody(expectedRevision, activeDocumentId, documentOrder)),
        )

    private inline fun <reified T> request(pathname: String, method: String = "GET", body: String? = null): T {
        var connection: HttpURLConnection? = null
        try {
            connection = (URL("${config.normalized.serverUrl}$pathname").openConnection() as HttpURLConnection)
            connection.requestMethod = method
            connection.connectTimeout = SYNC_CONNECT_TIMEOUT_MS
            connection.readTimeout = SYNC_READ_TIMEOUT_MS
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty("Authorization", "Bearer ${config.normalized.token}")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val text = if (status in 200..299) {
                connection.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            } else {
                connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }.orEmpty()
            }
            if (status !in 200..299) {
                val error = runCatching { json.decodeFromString<SyncErrorBody>(text) }.getOrNull()
                throw SyncHttpException(status, error?.message ?: text.take(500).ifBlank { "同步请求失败" })
            }
            return json.decodeFromString(text)
        } finally {
            connection?.disconnect()
        }
    }

    private fun orderedDocuments(documents: List<OutlineDocument>, documentOrder: List<String>): List<OutlineDocument> {
        val byId = documents.associateBy { it.id }.toMutableMap()
        val ordered = documentOrder.mapNotNull { byId.remove(it) }
        return ordered + byId.values
    }

    private fun SyncState.recordDocument(document: OutlineDocument, revision: Int): SyncState =
        copy(
            documentRevisions = documentRevisions + (document.id to revision),
            documentFingerprints = documentFingerprints + (document.id to documentFingerprint(document)),
            deletedDocumentRevisions = deletedDocumentRevisions - document.id,
        )

    private fun SyncState.recordDeleted(id: String, revision: Int): SyncState =
        copy(
            documentRevisions = documentRevisions + (id to revision),
            deletedDocumentRevisions = deletedDocumentRevisions + (id to revision),
            documentFingerprints = documentFingerprints - id,
        )

    private fun documentFingerprint(document: OutlineDocument): String {
        val bytes = json.encodeToString(document).toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256")
            .digest(bytes)
            .joinToString("") { "%02x".format(it) }
    }

    private fun pathComponent(value: String): String =
        URLEncoder.encode(value, Charsets.UTF_8.name()).replace("+", "%20")

    private fun isoNow(): String =
        java.time.Instant.now().toString()

    private companion object {
        const val SYNC_CONNECT_TIMEOUT_MS = 30_000
        const val SYNC_READ_TIMEOUT_MS = 60_000
    }
}

data class SyncResult(val workspace: Workspace, val state: SyncState, val summary: SyncSummary)
data class PullResult(val workspace: Workspace?, val state: SyncState)
data class PushResult(val state: SyncState, val summary: SyncSummary)

class SyncHttpException(val statusCode: Int, message: String) : Exception(message)

private const val DEFAULT_AUTO_SYNC_INTERVAL_SECONDS = 60
private const val MIN_AUTO_SYNC_INTERVAL_SECONDS = 15

@Serializable
private data class PersistedSyncState(
    val serverUrl: String,
    val workspaceRevision: Int? = null,
    val documentRevisions: Map<String, Int> = emptyMap(),
    val documentFingerprints: Map<String, String> = emptyMap(),
    val deletedDocumentRevisions: Map<String, Int> = emptyMap(),
    val lastSyncedAt: String? = null,
) {
    fun toState(): SyncState =
        SyncState(
            serverUrl = serverUrl,
            workspaceRevision = workspaceRevision,
            documentRevisions = documentRevisions,
            documentFingerprints = documentFingerprints,
            deletedDocumentRevisions = deletedDocumentRevisions,
            lastSyncedAt = lastSyncedAt,
        )

    companion object {
        fun from(state: SyncState): PersistedSyncState =
            PersistedSyncState(
                serverUrl = state.serverUrl,
                workspaceRevision = state.workspaceRevision,
                documentRevisions = state.documentRevisions,
                documentFingerprints = state.documentFingerprints,
                deletedDocumentRevisions = state.deletedDocumentRevisions,
                lastSyncedAt = state.lastSyncedAt,
            )
    }
}

@Serializable
private data class SyncManifest(
    val workspaceRevision: Int,
    val activeDocumentId: String? = null,
    val documentOrder: List<String> = emptyList(),
    val documents: List<SyncDocumentSummary> = emptyList(),
)

@Serializable
private data class SyncDocumentSummary(
    val id: String,
    val title: String,
    val revision: Int,
    val updatedAt: String,
    val deletedAt: String? = null,
)

@Serializable
private data class RemoteDocumentResponse(
    val revision: Int,
    val document: OutlineDocument,
)

@Serializable
private data class DeletedDocumentResponse(
    val id: String,
    val revision: Int,
    val deletedAt: String,
)

@Serializable
private data class PutDocumentBody(
    val expectedRevision: Int?,
    val document: OutlineDocument,
)

@Serializable
private data class DeleteDocumentBody(val expectedRevision: Int)

@Serializable
private data class PatchManifestBody(
    val expectedRevision: Int,
    val activeDocumentId: String?,
    val documentOrder: List<String>,
)

@Serializable
private data class SyncErrorBody(val message: String? = null)

private val json = WorkspaceJson.json
