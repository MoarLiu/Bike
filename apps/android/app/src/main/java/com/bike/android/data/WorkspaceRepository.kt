package com.bike.android.data

import android.content.Context
import android.net.Uri
import android.util.AtomicFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.io.File
import java.io.FileOutputStream

class WorkspaceRepository(
    context: Context,
    private val workspaceFileName: String = DEFAULT_WORKSPACE_FILE_NAME,
) {
    private val appContext = context.applicationContext
    private val workspaceWriteMutex = Mutex()
    private val workspaceFile: File
        get() = File(appContext.filesDir, workspaceFileName)

    suspend fun loadOrCreate(): WorkspacePayload =
        withContext(Dispatchers.IO) {
            val file = workspaceFile
            if (!file.exists()) {
                return@withContext workspaceWriteMutex.withLock {
                    if (file.exists()) {
                        WorkspaceJson.decode(file.readText(Charsets.UTF_8))
                    } else {
                        createAndPersistStarterWorkspace()
                    }
                }
            }

            runCatching {
                WorkspaceJson.decode(file.readText(Charsets.UTF_8))
            }.getOrElse {
                workspaceWriteMutex.withLock {
                    if (!file.exists()) {
                        return@withLock createAndPersistStarterWorkspace()
                    }
                    val recovery = runCatching {
                        WorkspaceRecovery(backupCorruptedWorkspaceFile(file).absolutePath)
                    }.getOrNull()
                    createAndPersistStarterWorkspace(
                        recovery = recovery,
                    )
                }
            }
        }

    suspend fun save(payload: WorkspacePayload): WorkspacePayload =
        withContext(Dispatchers.IO) {
            workspaceWriteMutex.withLock {
                writeTextAtomically(WorkspaceJson.encode(payload))
            }
            payload
        }

    suspend fun replaceFromJson(source: String): WorkspacePayload =
        withContext(Dispatchers.IO) {
            val payload = WorkspaceJson.decode(source)
            workspaceWriteMutex.withLock {
                writeTextAtomically(WorkspaceJson.encode(payload))
            }
            payload
        }

    suspend fun readTextFromUri(uri: Uri): String =
        withContext(Dispatchers.IO) {
            appContext.contentResolver.openInputStream(uri)?.use { input ->
                input.bufferedReader(Charsets.UTF_8).readText()
            } ?: error("无法读取所选文件")
        }

    suspend fun writeTextToUri(uri: Uri, text: String) {
        withContext(Dispatchers.IO) {
            appContext.contentResolver.openOutputStream(uri, "wt")?.use { output ->
                output.write(text.toByteArray(Charsets.UTF_8))
            } ?: error("无法写入所选文件")
        }
    }

    fun exportText(payload: WorkspacePayload): String =
        WorkspaceJson.encode(payload)

    private fun createAndPersistStarterWorkspace(
        recovery: WorkspaceRecovery? = null,
    ): WorkspacePayload {
        val workspace = createStarterWorkspace()
        val raw = WorkspaceJson.json.encodeToJsonElement(workspace).jsonObject
        val payload = WorkspacePayload(workspace = workspace, raw = raw, recovery = recovery)
        writeTextAtomically(WorkspaceJson.encode(payload))
        return payload
    }

    private fun writeTextAtomically(text: String) {
        workspaceFile.parentFile?.mkdirs()
        val atomicFile = AtomicFile(workspaceFile)
        var stream: FileOutputStream? = null
        try {
            stream = atomicFile.startWrite()
            stream.write(text.toByteArray(Charsets.UTF_8))
            atomicFile.finishWrite(stream)
        } catch (error: Exception) {
            atomicFile.failWrite(stream)
            throw error
        }
    }

    private companion object {
        const val DEFAULT_WORKSPACE_FILE_NAME = "bike-workspace.json"
    }
}
