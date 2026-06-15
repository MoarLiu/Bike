package com.bike.android.ui

import android.content.Intent
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items as gridItems
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.input.key.Key
import androidx.compose.ui.input.key.KeyEventType
import androidx.compose.ui.input.key.key
import androidx.compose.ui.input.key.onPreviewKeyEvent
import androidx.compose.ui.input.key.type
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.bike.android.ai.AiHttpException
import com.bike.android.ai.AiEndpoint
import com.bike.android.ai.AiResponseFormatException
import com.bike.android.ai.AiService
import com.bike.android.ai.AiSettings
import com.bike.android.ai.AiSettingsRepository
import com.bike.android.ai.generatedNodesToOutlineNodes
import com.bike.android.data.OutlineDocument
import com.bike.android.data.OutlineNode
import com.bike.android.data.WorkspacePayload
import com.bike.android.data.WorkspaceRepository
import com.bike.android.data.activeDocument
import com.bike.android.data.createStarterWorkspace
import com.bike.android.data.nodeCount
import com.bike.android.data.outlineNode
import com.bike.android.data.withActiveDocument
import com.bike.android.data.withChildNode
import com.bike.android.data.withDocumentTitle
import com.bike.android.data.withDocumentDeleted
import com.bike.android.data.withDocumentDuplicated
import com.bike.android.data.withDocumentMovedToFront
import com.bike.android.data.withDocumentShortcut
import com.bike.android.data.withDocumentsDeleted
import com.bike.android.data.withDocumentsDuplicated
import com.bike.android.data.withGeneratedOutlineChildren
import com.bike.android.data.withInboxEntry
import com.bike.android.data.withNewDocument
import com.bike.android.data.withNodeChecked
import com.bike.android.data.withNodeCollapsed
import com.bike.android.data.withNodeDeleted
import com.bike.android.data.withNodeMovedToParentLevel
import com.bike.android.data.withNodeText
import com.bike.android.data.withNodeTextAndNote
import com.bike.android.data.withRootNode
import com.bike.android.data.withSiblingAfter
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import java.net.SocketTimeoutException
import java.net.UnknownHostException

private const val SAVE_DEBOUNCE_MS = 300L

private val BikeBackground = Color(0xFF0E0F11)
private val BikeSurface = Color(0xFF1A1B1E)
private val BikePanel = Color(0xFF202125)
private val BikePanelHigh = Color(0xFF262830)
private val BikeInk = Color(0xFFF2F3F5)
private val BikeMuted = Color(0xFF8C9099)
private val BikeFaint = Color(0xFF5B606B)
private val BikeLine = Color.White.copy(alpha = 0.08f)
private val BikeGuide = Color.White.copy(alpha = 0.16f)
private val BikeAccent = Color(0xFF75B8ED)
private val BikeAccentHot = Color(0xFFFF4E3E)
private val BikeDanger = Color(0xFFFF6A6A)
private val BikeGreen = Color(0xFF52C78C)
private val BikeGold = Color(0xFFF5C252)

@Composable
fun BikeAndroidApp(
    repository: WorkspaceRepository,
    aiSettingsRepository: AiSettingsRepository,
    aiService: AiService,
    sharedText: String? = null,
    onSharedTextConsumed: () -> Unit = {},
) {
    BikeAndroidTheme {
        var payload by remember { mutableStateOf<WorkspacePayload?>(null) }
        var status by remember { mutableStateOf("正在载入工作区...") }
        var saveJob by remember { mutableStateOf<Job?>(null) }
        var saveRequestId by remember { mutableStateOf(0) }
        var aiSettings by remember { mutableStateOf(aiSettingsRepository.load()) }
        var showAiSettings by remember { mutableStateOf(false) }
        var aiBusyNodeId by remember { mutableStateOf<String?>(null) }
        var aiJob by remember { mutableStateOf<Job?>(null) }
        var aiRequestId by remember { mutableStateOf(0) }
        val scope = rememberCoroutineScope()

        fun cancelPendingSave() {
            saveJob?.cancel()
            saveJob = null
        }

        fun invalidatePendingSave() {
            saveRequestId += 1
            cancelPendingSave()
        }

        fun replacePayload(next: WorkspacePayload, persist: Boolean = true) {
            payload = next
            if (persist) {
                saveRequestId += 1
                val requestId = saveRequestId
                cancelPendingSave()
                status = "正在保存..."
                saveJob = scope.launch {
                    delay(SAVE_DEBOUNCE_MS)
                    if (requestId != saveRequestId) return@launch
                    runCatching { repository.save(next) }
                        .onSuccess {
                            if (requestId == saveRequestId) status = "已保存到本机"
                        }
                        .onFailure {
                            if (requestId == saveRequestId) status = it.message ?: "保存失败"
                        }
                }
            }
        }

        fun updatePayload(transform: (WorkspacePayload) -> WorkspacePayload) {
            val current = payload ?: return
            replacePayload(transform(current))
        }

        fun cancelAiTask(message: String? = null) {
            if (aiJob?.isActive == true || aiBusyNodeId != null) {
                aiRequestId += 1
                aiJob?.cancel()
                aiJob = null
                aiBusyNodeId = null
                if (message != null) status = message
            }
        }

        fun runAiGenerate(documentId: String, node: OutlineNode) {
            if (aiJob?.isActive == true || aiBusyNodeId != null) {
                status = "AI 正在处理，请稍后"
                return
            }
            if (!aiSettings.isConfigured) {
                showAiSettings = true
                status = "请先配置 AI Base URL、API key 和模型"
                return
            }
            aiBusyNodeId = node.id
            status = "AI 正在生成子主题..."
            aiRequestId += 1
            val requestId = aiRequestId
            aiJob = scope.launch {
                val result = runCatching {
                    aiService.generateChildren(
                        settings = aiSettings,
                        node = node,
                        documentTitle = payload?.workspace?.documents
                            ?.firstOrNull { it.id == documentId }
                            ?.title
                            .orEmpty(),
                    )
                }
                if (requestId != aiRequestId) return@launch

                result.onSuccess { generatedChildren ->
                    val outlineChildren = generatedNodesToOutlineNodes(generatedChildren)
                    if (outlineChildren.isEmpty()) {
                        status = "AI 没有生成可用子主题"
                    } else {
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withGeneratedOutlineChildren(
                                    documentId = documentId,
                                    nodeId = node.id,
                                    children = outlineChildren,
                                ),
                            )
                        }
                        status = "AI 已生成子主题"
                    }
                }.onFailure {
                    if (it !is CancellationException) {
                        status = aiErrorMessage("AI 生成失败", it)
                    }
                }
                if (requestId == aiRequestId) {
                    aiBusyNodeId = null
                    aiJob = null
                }
            }
        }

        fun runAiPolish(documentId: String, node: OutlineNode) {
            if (aiJob?.isActive == true || aiBusyNodeId != null) {
                status = "AI 正在处理，请稍后"
                return
            }
            if (!aiSettings.isConfigured) {
                showAiSettings = true
                status = "请先配置 AI Base URL、API key 和模型"
                return
            }
            aiBusyNodeId = node.id
            status = "AI 正在润色主题..."
            aiRequestId += 1
            val requestId = aiRequestId
            aiJob = scope.launch {
                val result = runCatching {
                    aiService.polishNodeText(
                        settings = aiSettings,
                        node = node,
                        documentTitle = payload?.workspace?.documents
                            ?.firstOrNull { it.id == documentId }
                            ?.title
                            .orEmpty(),
                    )
                }
                if (requestId != aiRequestId) return@launch

                result.onSuccess { text ->
                    if (text.isBlank()) {
                        status = "AI 没有返回润色文本"
                    } else {
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNodeText(
                                    documentId = documentId,
                                    nodeId = node.id,
                                    text = text,
                                ),
                            )
                        }
                        status = "AI 已润色主题"
                    }
                }.onFailure {
                    if (it !is CancellationException) {
                        status = aiErrorMessage("AI 润色失败", it)
                    }
                }
                if (requestId == aiRequestId) {
                    aiBusyNodeId = null
                    aiJob = null
                }
            }
        }

        DisposableEffect(Unit) {
            onDispose {
                cancelAiTask()
            }
        }

        val importLauncher = rememberLauncherForActivityResult(
            contract = ActivityResultContracts.OpenDocument(),
        ) { uri ->
            if (uri == null) return@rememberLauncherForActivityResult
            scope.launch {
                cancelAiTask("已取消未完成的 AI 请求")
                invalidatePendingSave()
                status = "正在导入工作区..."
                runCatching {
                    val source = repository.readTextFromUri(uri)
                    repository.replaceFromJson(source)
                }.onSuccess {
                    payload = it
                    status = "已导入工作区"
                }.onFailure {
                    status = it.message ?: "导入失败"
                }
            }
        }

        val exportLauncher = rememberLauncherForActivityResult(
            contract = ActivityResultContracts.CreateDocument("application/json"),
        ) { uri ->
            val currentPayload = payload
            if (uri == null || currentPayload == null) return@rememberLauncherForActivityResult
            scope.launch {
                status = "正在导出工作区..."
                runCatching {
                    repository.writeTextToUri(uri, repository.exportText(currentPayload))
                }.onSuccess {
                    status = "已导出 bike-workspace.json"
                }.onFailure {
                    status = it.message ?: "导出失败"
                }
            }
        }

        LaunchedEffect(repository) {
            runCatching { repository.loadOrCreate() }
                .onSuccess {
                    payload = it
                    status = it.recovery?.let { recovery ->
                        "工作区文件损坏，已备份为 ${recovery.backupFileName}，并创建新工作区"
                    } ?: "已载入本地工作区"
                }
                .onFailure { status = it.message ?: "载入失败" }
        }

        LaunchedEffect(sharedText, payload) {
            val currentPayload = payload
            val content = sharedText?.trim()
            if (currentPayload != null && !content.isNullOrBlank()) {
                replacePayload(
                    currentPayload.copy(
                        workspace = currentPayload.workspace.withInboxEntry(content),
                    ),
                )
                status = "已添加到收件箱"
                onSharedTextConsumed()
            }
        }

        Surface(
            modifier = Modifier.fillMaxSize(),
            color = BikeBackground,
        ) {
            val currentPayload = payload
            if (currentPayload == null) {
                LoadingState(status = status)
            } else {
                WorkspaceScreen(
                    payload = currentPayload,
                    status = status,
                    aiSettings = aiSettings,
                    showAiSettings = showAiSettings,
                    aiBusyNodeId = aiBusyNodeId,
                    onImport = { importLauncher.launch(arrayOf("application/json", "text/*", "*/*")) },
                    onExport = { exportLauncher.launch("bike-workspace.json") },
                    onToggleAiSettings = { showAiSettings = !showAiSettings },
                    onSaveAiSettings = { settings ->
                        runCatching {
                            aiSettingsRepository.save(settings)
                        }.onSuccess {
                            aiSettings = settings
                            showAiSettings = false
                            status = "AI 配置已保存"
                        }.onFailure {
                            status = it.message?.take(80)?.let { message ->
                                "AI 配置保存失败：$message"
                            } ?: "AI 配置保存失败"
                        }
                    },
                    onNewDocument = {
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNewDocument(),
                            )
                        }
                    },
                    onSelectDocument = { documentId ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withActiveDocument(documentId),
                            )
                        }
                    },
                    onUpdateDocumentTitle = { documentId, title ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentTitle(
                                    documentId = documentId,
                                    title = title,
                                ),
                            )
                        }
                    },
                    onMoveDocumentToFront = { documentId ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentMovedToFront(documentId),
                            )
                        }
                        status = "已移动到列表顶部"
                    },
                    onDuplicateDocument = { documentId ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentDuplicated(documentId),
                            )
                        }
                        status = "已复制文档"
                    },
                    onDuplicateDocuments = { documentIds ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentsDuplicated(documentIds),
                            )
                        }
                        status = "已复制 ${documentIds.size} 篇文档"
                    },
                    onToggleDocumentShortcut = { documentId, isShortcut ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentShortcut(
                                    documentId = documentId,
                                    isShortcut = isShortcut,
                                ),
                            )
                        }
                        status = if (isShortcut) "已添加到捷径" else "已从捷径移除"
                    },
                    onDeleteDocument = { documentId ->
                        cancelAiTask("已取消未完成的 AI 请求")
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentDeleted(documentId),
                            )
                        }
                        status = "已删除文档"
                    },
                    onDeleteDocuments = { documentIds ->
                        cancelAiTask("已取消未完成的 AI 请求")
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withDocumentsDeleted(documentIds),
                            )
                        }
                        status = "已删除 ${documentIds.size} 篇文档"
                    },
                    onToggleNode = { documentId, nodeId, checked ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNodeChecked(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                    checked = checked,
                                ),
                            )
                        }
                    },
                    onUpdateNodeTextAndNote = { documentId, nodeId, text, note ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNodeTextAndNote(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                    text = text,
                                    note = note,
                                ),
                            )
                        }
                    },
                    onToggleCollapsed = { documentId, nodeId, collapsed ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNodeCollapsed(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                    collapsed = collapsed,
                                ),
                            )
                        }
                    },
                    onMoveNodeToParentLevel = { documentId, nodeId ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNodeMovedToParentLevel(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                ),
                            )
                        }
                    },
                    onAddRootNode = { documentId, node ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withRootNode(
                                    documentId = documentId,
                                    newNode = node,
                                ),
                            )
                        }
                    },
                    onAddSibling = { documentId, nodeId, node ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withSiblingAfter(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                    newNode = node,
                                ),
                            )
                        }
                    },
                    onAddChild = { documentId, nodeId, node ->
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withChildNode(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                    childNode = node,
                                ),
                            )
                        }
                    },
                    onDeleteNode = { documentId, nodeId ->
                        cancelAiTask("已取消未完成的 AI 请求")
                        updatePayload { latestPayload ->
                            latestPayload.copy(
                                workspace = latestPayload.workspace.withNodeDeleted(
                                    documentId = documentId,
                                    nodeId = nodeId,
                                ),
                            )
                        }
                    },
                    onAiGenerate = { documentId, node ->
                        runAiGenerate(documentId, node)
                    },
                    onAiPolish = { documentId, node ->
                        runAiPolish(documentId, node)
                    },
                )
            }
        }
    }
}

@Composable
private fun WorkspaceScreen(
    payload: WorkspacePayload,
    status: String,
    aiSettings: AiSettings,
    showAiSettings: Boolean,
    aiBusyNodeId: String?,
    onImport: () -> Unit,
    onExport: () -> Unit,
    onToggleAiSettings: () -> Unit,
    onSaveAiSettings: (AiSettings) -> Unit,
    onNewDocument: () -> Unit,
    onSelectDocument: (String) -> Unit,
    onUpdateDocumentTitle: (String, String) -> Unit,
    onMoveDocumentToFront: (String) -> Unit,
    onDuplicateDocument: (String) -> Unit,
    onDuplicateDocuments: (Set<String>) -> Unit,
    onToggleDocumentShortcut: (String, Boolean) -> Unit,
    onDeleteDocument: (String) -> Unit,
    onDeleteDocuments: (Set<String>) -> Unit,
    onToggleNode: (String, String, Boolean) -> Unit,
    onUpdateNodeTextAndNote: (String, String, String, String) -> Unit,
    onToggleCollapsed: (String, String, Boolean) -> Unit,
    onMoveNodeToParentLevel: (String, String) -> Unit,
    onAddRootNode: (String, OutlineNode) -> Unit,
    onAddSibling: (String, String, OutlineNode) -> Unit,
    onAddChild: (String, String, OutlineNode) -> Unit,
    onDeleteNode: (String, String) -> Unit,
    onAiGenerate: (String, OutlineNode) -> Unit,
    onAiPolish: (String, OutlineNode) -> Unit,
) {
    val workspace = payload.workspace
    val activeDocument = workspace.activeDocument()
    var mode by remember { mutableStateOf(WorkspaceMode.Library) }

    fun returnToLibrary() {
        mode = WorkspaceMode.Library
    }

    BackHandler(enabled = mode == WorkspaceMode.Editor) {
        returnToLibrary()
    }

    when (mode) {
        WorkspaceMode.Library -> LibraryScreen(
            documents = workspace.documents,
            activeDocumentId = activeDocument.id,
            status = status,
            aiConfigured = aiSettings.isConfigured,
            showAiSettings = showAiSettings,
            aiSettings = aiSettings,
            onSaveAiSettings = onSaveAiSettings,
            onOpenDocument = { documentId ->
                onSelectDocument(documentId)
                mode = WorkspaceMode.Editor
            },
            onNewDocument = {
                onNewDocument()
                mode = WorkspaceMode.Editor
            },
            onRenameDocument = onUpdateDocumentTitle,
            onMoveDocumentToFront = onMoveDocumentToFront,
            onDuplicateDocument = onDuplicateDocument,
            onDuplicateDocuments = onDuplicateDocuments,
            onToggleDocumentShortcut = onToggleDocumentShortcut,
            onDeleteDocument = onDeleteDocument,
            onDeleteDocuments = onDeleteDocuments,
            onImport = onImport,
            onExport = onExport,
            onToggleAiSettings = onToggleAiSettings,
        )

        WorkspaceMode.Editor -> EditorScreen(
            document = activeDocument,
            status = status,
            aiSettings = aiSettings,
            showAiSettings = showAiSettings,
            aiBusyNodeId = aiBusyNodeId,
            onBack = { returnToLibrary() },
            onUpdateTitle = { title -> onUpdateDocumentTitle(activeDocument.id, title) },
            onToggleNode = { nodeId, checked ->
                onToggleNode(activeDocument.id, nodeId, checked)
            },
            onUpdateNodeTextAndNote = { nodeId, text, note ->
                onUpdateNodeTextAndNote(activeDocument.id, nodeId, text, note)
            },
            onToggleCollapsed = { node ->
                onToggleCollapsed(activeDocument.id, node.id, !node.collapsed)
            },
            onMoveNodeToParentLevel = { nodeId -> onMoveNodeToParentLevel(activeDocument.id, nodeId) },
            onAddRootNode = { node -> onAddRootNode(activeDocument.id, node) },
            onAddSibling = { nodeId, node -> onAddSibling(activeDocument.id, nodeId, node) },
            onAddChild = { nodeId, node -> onAddChild(activeDocument.id, nodeId, node) },
            onDeleteNode = { nodeId -> onDeleteNode(activeDocument.id, nodeId) },
            onAiGenerate = { node -> onAiGenerate(activeDocument.id, node) },
            onAiPolish = { node -> onAiPolish(activeDocument.id, node) },
            onImport = onImport,
            onExport = onExport,
            onToggleAiSettings = onToggleAiSettings,
            onSaveAiSettings = onSaveAiSettings,
        )
    }
}

private enum class WorkspaceMode {
    Library,
    Editor,
}

private enum class LibraryFilter {
    All,
    Shortcuts,
}

@Composable
private fun LibraryScreen(
    documents: List<OutlineDocument>,
    activeDocumentId: String,
    status: String,
    aiConfigured: Boolean,
    showAiSettings: Boolean,
    aiSettings: AiSettings,
    onSaveAiSettings: (AiSettings) -> Unit,
    onOpenDocument: (String) -> Unit,
    onNewDocument: () -> Unit,
    onRenameDocument: (String, String) -> Unit,
    onMoveDocumentToFront: (String) -> Unit,
    onDuplicateDocument: (String) -> Unit,
    onDuplicateDocuments: (Set<String>) -> Unit,
    onToggleDocumentShortcut: (String, Boolean) -> Unit,
    onDeleteDocument: (String) -> Unit,
    onDeleteDocuments: (Set<String>) -> Unit,
    onImport: () -> Unit,
    onExport: () -> Unit,
    onToggleAiSettings: () -> Unit,
) {
    val context = LocalContext.current
    var filter by remember { mutableStateOf(LibraryFilter.All) }
    var searchQuery by remember { mutableStateOf("") }
    var menuExpanded by remember { mutableStateOf(false) }
    var actionDocument by remember { mutableStateOf<OutlineDocument?>(null) }
    var renameDocument by remember { mutableStateOf<OutlineDocument?>(null) }
    var deleteDocumentIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    var selectionMode by remember { mutableStateOf(false) }
    var selectedDocumentIds by remember { mutableStateOf<Set<String>>(emptySet()) }
    val visibleDocuments = documents.filter { document ->
        val matchesFilter = filter == LibraryFilter.All || document.isShortcut
        val matchesSearch = searchQuery.isBlank() ||
            document.title.contains(searchQuery, ignoreCase = true) ||
            flattenSearchNodes(document.nodes, searchQuery).isNotEmpty()
        matchesFilter && matchesSearch
    }

    LaunchedEffect(documents) {
        val documentIds = documents.map { it.id }.toSet()
        selectedDocumentIds = selectedDocumentIds.filter { it in documentIds }.toSet()
        if (selectedDocumentIds.isEmpty()) selectionMode = false

        val actionDocumentId = actionDocument?.id
        if (actionDocumentId != null && actionDocumentId !in documentIds) actionDocument = null

        val renameDocumentId = renameDocument?.id
        if (renameDocumentId != null && renameDocumentId !in documentIds) renameDocument = null
    }

    fun toggleSelected(documentId: String) {
        selectedDocumentIds = if (documentId in selectedDocumentIds) {
            selectedDocumentIds - documentId
        } else {
            selectedDocumentIds + documentId
        }
    }

    fun shareDocument(document: OutlineDocument) {
        val title = document.title.ifBlank { "无标题" }
        val intent = Intent(Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(Intent.EXTRA_SUBJECT, title)
            putExtra(Intent.EXTRA_TEXT, document.asShareText())
        }
        context.startActivity(Intent.createChooser(intent, title))
    }

    Box(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .background(BikeBackground),
    ) {
        LazyVerticalGrid(
            columns = GridCells.Fixed(2),
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(start = 16.dp, top = 10.dp, end = 16.dp, bottom = 28.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item(span = { GridItemSpan(maxLineSpan) }) {
                if (selectionMode) {
                    SelectionTopBar(
                        count = selectedDocumentIds.size,
                        onCancel = {
                            selectionMode = false
                            selectedDocumentIds = emptySet()
                        },
                        onDuplicate = {
                            if (selectedDocumentIds.isNotEmpty()) {
                                onDuplicateDocuments(selectedDocumentIds)
                                selectionMode = false
                                selectedDocumentIds = emptySet()
                            }
                        },
                        onDelete = {
                            if (selectedDocumentIds.isNotEmpty()) {
                                deleteDocumentIds = selectedDocumentIds
                            }
                        },
                    )
                } else {
                    LibraryTopBar(
                        aiConfigured = aiConfigured,
                        onToggleAiSettings = onToggleAiSettings,
                        onNewDocument = onNewDocument,
                        onMenuClick = { menuExpanded = true },
                    )
                }
            }

            if (!selectionMode) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    LibraryHeader(
                        documentCount = documents.size,
                        status = status,
                    )
                }

                item(span = { GridItemSpan(maxLineSpan) }) {
                    SearchField(
                        value = searchQuery,
                        onValueChange = { searchQuery = it },
                        placeholder = "搜索文档和主题",
                    )
                }

                item(span = { GridItemSpan(maxLineSpan) }) {
                    LibrarySegmentedFilter(
                        selected = filter,
                        onSelect = { filter = it },
                    )
                }

                if (showAiSettings) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        AiSettingsPanel(
                            settings = aiSettings,
                            onSave = onSaveAiSettings,
                        )
                    }
                }
            } else {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Text(
                        text = "点选文档进行批量操作",
                        style = MaterialTheme.typography.bodySmall,
                        color = BikeFaint,
                    )
                }
            }

            if (visibleDocuments.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    EmptyLibraryState(
                        onNewDocument = onNewDocument,
                        message = if (filter == LibraryFilter.Shortcuts) {
                            "还没有捷径"
                        } else {
                            "还没有文档"
                        },
                    )
                }
            }

            gridItems(visibleDocuments, key = { it.id }) { document ->
                val selected = if (selectionMode) {
                    document.id in selectedDocumentIds
                } else {
                    document.id == activeDocumentId
                }
                LibraryDocumentCard(
                    document = document,
                    selected = selected,
                    selectionMode = selectionMode,
                    onClick = {
                        if (selectionMode) {
                            toggleSelected(document.id)
                        } else {
                            onOpenDocument(document.id)
                        }
                    },
                    onLongPress = {
                        if (selectionMode) {
                            toggleSelected(document.id)
                        } else {
                            actionDocument = document
                        }
                    },
                )
            }
        }

        Box(
            modifier = Modifier
                .align(Alignment.TopEnd)
                .padding(top = 10.dp, end = 16.dp),
        ) {
            DropdownMenu(
                expanded = menuExpanded,
                onDismissRequest = { menuExpanded = false },
            ) {
                DropdownMenuItem(
                    text = { Text("导入 Workspace") },
                    onClick = {
                        menuExpanded = false
                        onImport()
                    },
                )
                DropdownMenuItem(
                    text = { Text("导出 Workspace") },
                    onClick = {
                        menuExpanded = false
                        onExport()
                    },
                )
                DropdownMenuItem(
                    text = { Text("AI 设置") },
                    onClick = {
                        menuExpanded = false
                        onToggleAiSettings()
                    },
                )
            }
        }

        actionDocument?.let { document ->
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.38f))
                    .clickable { actionDocument = null },
            )
            DocumentActionSheet(
                document = document,
                modifier = Modifier.align(Alignment.BottomCenter),
                onDismiss = { actionDocument = null },
                onRename = {
                    actionDocument = null
                    renameDocument = document
                },
                onMove = {
                    actionDocument = null
                    onMoveDocumentToFront(document.id)
                },
                onDuplicate = {
                    actionDocument = null
                    onDuplicateDocument(document.id)
                },
                onShare = {
                    actionDocument = null
                    shareDocument(document)
                },
                onToggleShortcut = {
                    actionDocument = null
                    onToggleDocumentShortcut(document.id, !document.isShortcut)
                },
                onMultiSelect = {
                    actionDocument = null
                    selectionMode = true
                    selectedDocumentIds = setOf(document.id)
                },
                onDelete = {
                    actionDocument = null
                    deleteDocumentIds = setOf(document.id)
                },
            )
        }

        renameDocument?.let { document ->
            RenameDocumentDialog(
                document = document,
                onDismiss = { renameDocument = null },
                onConfirm = { title ->
                    onRenameDocument(document.id, title)
                    renameDocument = null
                },
            )
        }

        if (deleteDocumentIds.isNotEmpty()) {
            DeleteDocumentsDialog(
                count = deleteDocumentIds.size,
                onDismiss = { deleteDocumentIds = emptySet() },
                onConfirm = {
                    onDeleteDocuments(deleteDocumentIds)
                    selectedDocumentIds = emptySet()
                    selectionMode = false
                    deleteDocumentIds = emptySet()
                },
            )
        }
    }
}

@Composable
private fun EditorScreen(
    document: OutlineDocument,
    status: String,
    aiSettings: AiSettings,
    showAiSettings: Boolean,
    aiBusyNodeId: String?,
    onBack: () -> Unit,
    onUpdateTitle: (String) -> Unit,
    onToggleNode: (String, Boolean) -> Unit,
    onUpdateNodeTextAndNote: (String, String, String) -> Unit,
    onToggleCollapsed: (OutlineNode) -> Unit,
    onMoveNodeToParentLevel: (String) -> Unit,
    onAddRootNode: (OutlineNode) -> Unit,
    onAddSibling: (String, OutlineNode) -> Unit,
    onAddChild: (String, OutlineNode) -> Unit,
    onDeleteNode: (String) -> Unit,
    onAiGenerate: (OutlineNode) -> Unit,
    onAiPolish: (OutlineNode) -> Unit,
    onImport: () -> Unit,
    onExport: () -> Unit,
    onToggleAiSettings: () -> Unit,
    onSaveAiSettings: (AiSettings) -> Unit,
) {
    var selectedNodeId by remember(document.id) { mutableStateOf<String?>(null) }
    var searchVisible by remember(document.id) { mutableStateOf(false) }
    var searchQuery by remember(document.id) { mutableStateOf("") }
    val outlineRows = if (searchQuery.isBlank()) {
        flattenVisibleNodes(document.nodes)
    } else {
        flattenSearchNodes(document.nodes, searchQuery)
    }
    val selectedRow = outlineRows.firstOrNull { it.node.id == selectedNodeId }

    fun clearSearchForStructureEdit() {
        if (searchQuery.isNotBlank()) searchQuery = ""
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .statusBarsPadding()
            .background(BikeBackground),
    ) {
        EditorTopBar(
            title = document.title,
            onBack = onBack,
        )

        if (showAiSettings) {
            Box(modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp)) {
                AiSettingsPanel(
                    settings = aiSettings,
                    onSave = onSaveAiSettings,
                )
            }
        }

        if (searchVisible) {
            Box(modifier = Modifier.padding(horizontal = 18.dp, vertical = 8.dp)) {
                SearchField(
                    value = searchQuery,
                    onValueChange = { searchQuery = it },
                    placeholder = "搜索主题和备注",
                )
            }
        }

        LazyColumn(
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(start = 14.dp, top = 10.dp, end = 14.dp, bottom = 28.dp),
            verticalArrangement = Arrangement.spacedBy(0.dp),
        ) {
            item {
                DocumentTitleField(
                    documentId = document.id,
                    title = document.title,
                    onTitleChange = onUpdateTitle,
                )
            }

            if (outlineRows.isEmpty()) {
                item {
                    Text(
                        text = if (searchQuery.isBlank()) "点击底部 + 新增主题" else "没有匹配主题",
                        modifier = Modifier.padding(top = 26.dp),
                        style = MaterialTheme.typography.titleMedium,
                        color = BikeMuted,
                    )
                }
            }

            items(outlineRows, key = { it.node.id }) { row ->
                OutlineNodeRowDark(
                    row = row,
                    selected = row.node.id == selectedNodeId,
                    aiBusy = aiBusyNodeId != null,
                    aiBusyOnThisNode = aiBusyNodeId == row.node.id,
                    onSelect = {
                        selectedNodeId = if (selectedNodeId == row.node.id) null else row.node.id
                    },
                    onToggle = { checked -> onToggleNode(row.node.id, checked) },
                    onSaveTextAndNote = { text, note ->
                        clearSearchForStructureEdit()
                        onUpdateNodeTextAndNote(row.node.id, text, note)
                    },
                    onToggleCollapsed = { onToggleCollapsed(row.node) },
                    onMoveToParentLevel = {
                        onMoveNodeToParentLevel(row.node.id)
                    },
                    onAddSibling = {
                        clearSearchForStructureEdit()
                        val sibling = outlineNode("")
                        onAddSibling(row.node.id, sibling)
                        selectedNodeId = sibling.id
                    },
                    onAddChild = {
                        clearSearchForStructureEdit()
                        val child = outlineNode("")
                        onAddChild(row.node.id, child)
                        selectedNodeId = child.id
                    },
                    onDelete = {
                        onDeleteNode(row.node.id)
                        selectedNodeId = null
                    },
                    onAiGenerate = { onAiGenerate(row.node) },
                    onAiPolish = { onAiPolish(row.node) },
                    onCommitNewChild = {
                        clearSearchForStructureEdit()
                        val child = outlineNode("")
                        onAddChild(row.node.id, child)
                        selectedNodeId = child.id
                    },
                )
            }
        }

        if (selectedRow != null) {
            if (status.shouldShowInEditorStatusStrip()) {
                EditorStatusStrip(status = status)
            }
            NodeInputAccessoryBar(
                modifier = Modifier.imePadding(),
                canMoveToParentLevel = selectedRow.depth > 0,
                aiBusy = aiBusyNodeId != null,
                aiBusyOnThisNode = aiBusyNodeId == selectedRow.node.id,
                onMoveToParentLevel = {
                    if (selectedRow.depth > 0) {
                        onMoveNodeToParentLevel(selectedRow.node.id)
                    }
                },
                onAddSibling = {
                    clearSearchForStructureEdit()
                    val sibling = outlineNode("")
                    onAddSibling(selectedRow.node.id, sibling)
                    selectedNodeId = sibling.id
                },
                onAddChild = {
                    clearSearchForStructureEdit()
                    val child = outlineNode("")
                    onAddChild(selectedRow.node.id, child)
                    selectedNodeId = child.id
                },
                onAiGenerate = { onAiGenerate(selectedRow.node) },
                onAiPolish = { onAiPolish(selectedRow.node) },
                onDelete = {
                    onDeleteNode(selectedRow.node.id)
                    selectedNodeId = null
                },
            )
        } else {
            EditorBottomBar(
                aiConfigured = aiSettings.isConfigured,
                searchVisible = searchVisible,
                onAddRootNode = {
                    clearSearchForStructureEdit()
                    val root = outlineNode("")
                    onAddRootNode(root)
                    selectedNodeId = root.id
                },
                onToggleAiSettings = onToggleAiSettings,
                onToggleSearch = { searchVisible = !searchVisible },
            )
        }
    }
}

@Composable
private fun SelectionTopBar(
    count: Int,
    onCancel: () -> Unit,
    onDuplicate: () -> Unit,
    onDelete: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PlainIconButton(symbol = "×", onClick = onCancel, tint = BikeInk)
        Text(
            text = "已选择 $count",
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleLarge,
            color = BikeInk,
            fontWeight = FontWeight.SemiBold,
        )
        PlainIconButton(
            symbol = "⧉",
            onClick = onDuplicate,
            tint = if (count > 0) BikeInk else BikeFaint,
        )
        PlainIconButton(
            symbol = "⌫",
            onClick = onDelete,
            tint = if (count > 0) BikeDanger else BikeFaint,
        )
    }
}

@Composable
private fun LibraryTopBar(
    aiConfigured: Boolean,
    onToggleAiSettings: () -> Unit,
    onNewDocument: () -> Unit,
    onMenuClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(54.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = "Bike",
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.headlineMedium,
            color = BikeInk,
            fontWeight = FontWeight.SemiBold,
        )
        Box {
            PlainIconButton(
                symbol = "✦",
                onClick = onToggleAiSettings,
                tint = if (aiConfigured) BikeInk else BikeMuted,
            )
            if (!aiConfigured) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 9.dp, end = 8.dp)
                        .size(7.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(BikeAccentHot),
                )
            }
        }
        PlainIconButton(symbol = "✎", onClick = onNewDocument, tint = BikeInk)
        PlainIconButton(symbol = "⋯", onClick = onMenuClick, tint = BikeInk)
    }
}

@Composable
private fun LibraryHeader(
    documentCount: Int,
    status: String,
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 2.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        Text(
            text = "本机工作区",
            style = MaterialTheme.typography.labelLarge,
            color = BikeMuted,
            fontWeight = FontWeight.SemiBold,
        )
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = documentCount.toString(),
                style = MaterialTheme.typography.displaySmall,
                color = BikeInk,
                fontWeight = FontWeight.Bold,
            )
            Spacer(modifier = Modifier.width(6.dp))
            Text(
                text = "篇文档",
                style = MaterialTheme.typography.titleMedium,
                color = BikeMuted,
                fontWeight = FontWeight.SemiBold,
            )
            Spacer(modifier = Modifier.weight(1f))
            CompactStatusBadge(status)
        }
    }
}

@Composable
private fun LibrarySegmentedFilter(
    selected: LibraryFilter,
    onSelect: (LibraryFilter) -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(42.dp)
            .clip(RoundedCornerShape(8.dp))
            .background(BikePanel),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        LibraryFilter.values().forEach { filter ->
            val isSelected = filter == selected
            Box(
                modifier = Modifier
                    .weight(1f)
                    .padding(3.dp)
                    .clip(RoundedCornerShape(6.dp))
                    .background(if (isSelected) BikePanelHigh else Color.Transparent)
                    .clickable { onSelect(filter) }
                    .padding(vertical = 8.dp),
                contentAlignment = Alignment.Center,
            ) {
                Text(
                    text = when (filter) {
                        LibraryFilter.All -> "全部"
                        LibraryFilter.Shortcuts -> "快捷"
                    },
                    style = MaterialTheme.typography.labelLarge,
                    color = if (isSelected) BikeInk else BikeMuted,
                    fontWeight = if (isSelected) FontWeight.SemiBold else FontWeight.Medium,
                )
            }
        }
    }
}

@Composable
private fun CompactStatusBadge(status: String) {
    Text(
        text = status,
        modifier = Modifier
            .clip(RoundedCornerShape(16.dp))
            .background(BikePanel)
            .padding(horizontal = 9.dp, vertical = 6.dp),
        style = MaterialTheme.typography.labelSmall,
        color = BikeMuted,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
    )
}

@Composable
private fun PlainIconButton(
    symbol: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    tint: Color = BikeInk,
) {
    Box(
        modifier = modifier
            .size(46.dp)
            .clip(RoundedCornerShape(23.dp))
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = symbol,
            style = MaterialTheme.typography.headlineSmall,
            color = tint,
            fontWeight = FontWeight.Medium,
        )
    }
}

@Composable
private fun SearchField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
) {
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = true,
        textStyle = MaterialTheme.typography.bodyLarge.copy(color = BikeInk),
        cursorBrush = SolidColor(BikeAccent),
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(BikePanel)
            .padding(horizontal = 12.dp, vertical = 11.dp),
        decorationBox = { innerTextField ->
            Box {
                if (value.isBlank()) {
                    Text(
                        text = placeholder,
                        style = MaterialTheme.typography.bodyLarge,
                        color = BikeFaint,
                    )
                }
                innerTextField()
            }
        },
    )
}

@Composable
private fun LibraryDocumentCard(
    document: OutlineDocument,
    selected: Boolean,
    selectionMode: Boolean,
    onClick: () -> Unit,
    onLongPress: () -> Unit,
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .aspectRatio(1.16f)
            .pointerInput(document.id, selectionMode) {
                detectTapGestures(
                    onTap = { onClick() },
                    onLongPress = { onLongPress() },
                )
            },
        colors = CardDefaults.cardColors(
            containerColor = BikePanel,
            contentColor = BikeInk,
        ),
        border = BorderStroke(
            width = 1.dp,
            color = if (selected) BikeAccent.copy(alpha = 0.38f) else BikeLine,
        ),
        elevation = CardDefaults.cardElevation(defaultElevation = 0.dp),
    ) {
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(14.dp),
            verticalArrangement = Arrangement.SpaceBetween,
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    text = if (document.isShortcut) "★" else "▤",
                    style = MaterialTheme.typography.titleMedium,
                    color = if (document.isShortcut) BikeGold else BikeAccent,
                    fontWeight = FontWeight.SemiBold,
                )
                Spacer(modifier = Modifier.weight(1f))
                if (selectionMode) {
                    Text(
                        text = if (selected) "✓" else "○",
                        color = if (selected) BikeAccent else BikeMuted,
                        style = MaterialTheme.typography.labelLarge,
                        fontWeight = FontWeight.SemiBold,
                    )
                } else {
                    Text(
                        text = document.nodeCount().toString(),
                        color = BikeMuted,
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
            Column(verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Text(
                    text = document.title.ifBlank { "无标题" },
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = document.updatedAt.asCompactDate(),
                    style = MaterialTheme.typography.labelSmall,
                    color = BikeFaint,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

@Composable
private fun DocumentActionSheet(
    document: OutlineDocument,
    modifier: Modifier = Modifier,
    onDismiss: () -> Unit,
    onRename: () -> Unit,
    onMove: () -> Unit,
    onDuplicate: () -> Unit,
    onShare: () -> Unit,
    onToggleShortcut: () -> Unit,
    onMultiSelect: () -> Unit,
    onDelete: () -> Unit,
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(topStart = 18.dp, topEnd = 18.dp))
            .background(BikeSurface)
            .padding(start = 24.dp, top = 22.dp, end = 24.dp, bottom = 28.dp),
        verticalArrangement = Arrangement.spacedBy(18.dp),
    ) {
        Row(
            modifier = Modifier.fillMaxWidth(),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = document.title.ifBlank { "无标题" },
                modifier = Modifier.weight(1f),
                style = MaterialTheme.typography.titleLarge,
                color = BikeInk,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            PlainIconButton(symbol = "×", onClick = onDismiss, tint = BikeMuted)
        }

        Row(horizontalArrangement = Arrangement.spacedBy(18.dp)) {
            DocumentActionTile(
                symbol = "✎",
                label = "重命名",
                modifier = Modifier.weight(1f),
                onClick = onRename,
            )
            DocumentActionTile(
                symbol = "⇄",
                label = "移动",
                modifier = Modifier.weight(1f),
                onClick = onMove,
            )
            DocumentActionTile(
                symbol = "▣",
                label = "复制",
                modifier = Modifier.weight(1f),
                onClick = onDuplicate,
            )
            DocumentActionTile(
                symbol = "⇧",
                label = "分享",
                modifier = Modifier.weight(1f),
                onClick = onShare,
            )
        }

        Column(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(12.dp))
                .background(BikePanel),
        ) {
            DocumentActionRow(
                label = if (document.isShortcut) "取消快速访问" else "快速访问",
                symbol = "ϟ",
                onClick = onToggleShortcut,
            )
            DocumentActionRow(
                label = "多选",
                symbol = "✓",
                onClick = onMultiSelect,
            )
            DocumentActionRow(
                label = "删除",
                symbol = "⌫",
                tint = BikeDanger,
                onClick = onDelete,
            )
        }
    }
}

@Composable
private fun DocumentActionTile(
    symbol: String,
    label: String,
    modifier: Modifier = Modifier,
    onClick: () -> Unit,
) {
    Column(
        modifier = modifier
            .height(126.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(BikePanelHigh)
            .clickable(onClick = onClick)
            .padding(horizontal = 8.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        Text(
            text = symbol,
            style = MaterialTheme.typography.headlineMedium,
            color = BikeInk,
            fontWeight = FontWeight.Medium,
        )
        Spacer(modifier = Modifier.height(12.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = BikeInk,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DocumentActionRow(
    label: String,
    symbol: String,
    tint: Color = BikeInk,
    onClick: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(66.dp)
            .clickable(onClick = onClick)
            .padding(horizontal = 26.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(
            text = label,
            modifier = Modifier.weight(1f),
            style = MaterialTheme.typography.titleMedium,
            color = tint,
        )
        Text(
            text = symbol,
            style = MaterialTheme.typography.titleLarge,
            color = tint,
        )
    }
}

@Composable
private fun RenameDocumentDialog(
    document: OutlineDocument,
    onDismiss: () -> Unit,
    onConfirm: (String) -> Unit,
) {
    var title by remember(document.id) { mutableStateOf(document.title) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("重命名") },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it },
                singleLine = true,
                label = { Text("文档标题") },
            )
        },
        confirmButton = {
            TextButton(
                onClick = {
                    onConfirm(title.ifBlank { "无标题" })
                },
            ) {
                Text("保存")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

@Composable
private fun DeleteDocumentsDialog(
    count: Int,
    onDismiss: () -> Unit,
    onConfirm: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("删除文档") },
        text = {
            Text(
                text = if (count == 1) {
                    "确认删除这篇文档？"
                } else {
                    "确认删除选中的 $count 篇文档？"
                },
            )
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text("删除", color = BikeDanger)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("取消")
            }
        },
    )
}

@Composable
private fun EmptyLibraryState(
    onNewDocument: () -> Unit,
    message: String = "还没有文档",
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(top = 52.dp),
        horizontalAlignment = Alignment.Start,
        verticalArrangement = Arrangement.spacedBy(12.dp),
    ) {
        Text(
            text = message,
            style = MaterialTheme.typography.headlineSmall,
            color = BikeInk,
            fontWeight = FontWeight.SemiBold,
        )
        Text(
            text = "点击右上角新建第一篇大纲",
            style = MaterialTheme.typography.bodyLarge,
            color = BikeMuted,
        )
        OutlinedButton(onClick = onNewDocument) {
            Text("新建文档")
        }
    }
}

@Composable
private fun EditorStatusStrip(status: String) {
    Text(
        text = status,
        modifier = Modifier
            .fillMaxWidth()
            .background(BikeSurface)
            .padding(horizontal = 16.dp, vertical = 8.dp),
        style = MaterialTheme.typography.bodySmall,
        color = if (status.contains("失败") || status.contains("无效")) BikeDanger else BikeMuted,
        maxLines = 2,
        overflow = TextOverflow.Ellipsis,
    )
}

private fun String.shouldShowInEditorStatusStrip(): Boolean =
    startsWith("AI") ||
        startsWith("API") ||
        startsWith("请先配置")

@Composable
private fun EditorTopBar(
    title: String,
    onBack: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(56.dp)
            .background(BikeBackground)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        PlainIconButton(symbol = "←", onClick = onBack, tint = BikeInk)
        Text(
            text = title.ifBlank { "无标题" },
            modifier = Modifier
                .weight(1f)
                .padding(end = 46.dp),
            style = MaterialTheme.typography.titleMedium,
            color = BikeInk,
            fontWeight = FontWeight.SemiBold,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

@Composable
private fun DocumentTitleField(
    documentId: String,
    title: String,
    onTitleChange: (String) -> Unit,
) {
    var draftTitle by remember(documentId) { mutableStateOf(title) }

    LaunchedEffect(documentId, title) {
        if (draftTitle != title) draftTitle = title
    }

    BasicTextField(
        value = draftTitle,
        onValueChange = {
            draftTitle = it
            onTitleChange(it)
        },
        textStyle = MaterialTheme.typography.headlineMedium.copy(
            color = BikeInk,
            fontWeight = FontWeight.Bold,
        ),
        cursorBrush = SolidColor(BikeAccent),
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = 12.dp),
        decorationBox = { innerTextField ->
            Box {
                if (draftTitle.isBlank()) {
                    Text(
                        text = "无标题",
                        style = MaterialTheme.typography.headlineMedium,
                        color = BikeMuted,
                        fontWeight = FontWeight.Bold,
                    )
                }
                innerTextField()
            }
        },
    )
}

@Composable
@OptIn(ExperimentalComposeUiApi::class)
private fun OutlineNodeRowDark(
    row: FlatNodeRow,
    selected: Boolean,
    aiBusy: Boolean,
    aiBusyOnThisNode: Boolean,
    onSelect: () -> Unit,
    onToggle: (Boolean) -> Unit,
    onSaveTextAndNote: (String, String) -> Unit,
    onToggleCollapsed: () -> Unit,
    onMoveToParentLevel: () -> Unit,
    onAddSibling: () -> Unit,
    onAddChild: () -> Unit,
    onDelete: () -> Unit,
    onAiGenerate: () -> Unit,
    onAiPolish: () -> Unit,
    onCommitNewChild: () -> Unit,
) {
    var draftText by remember(row.node.id) { mutableStateOf(row.node.text) }
    var draftNote by remember(row.node.id) { mutableStateOf(row.node.note) }
    val focusRequester = remember { FocusRequester() }
    val keyboardController = LocalSoftwareKeyboardController.current
    val effectiveChecked = row.node.checked || row.inheritedChecked
    val textDecoration = if (effectiveChecked) TextDecoration.LineThrough else TextDecoration.None

    LaunchedEffect(row.node.id, row.node.text) {
        if (row.node.text != draftText) draftText = row.node.text
    }

    LaunchedEffect(row.node.id, row.node.note) {
        if (row.node.note != draftNote) draftNote = row.node.note
    }

    LaunchedEffect(selected) {
        if (selected) {
            focusRequester.requestFocus()
            keyboardController?.show()
        }
    }

    Box(modifier = Modifier.fillMaxWidth()) {
        OutlineGuides(
            depth = row.depth,
            modifier = Modifier.matchParentSize(),
        )
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(7.dp))
                .background(Color.Transparent)
                .clickable(onClick = onSelect)
                .padding(vertical = 0.dp),
            verticalAlignment = Alignment.Top,
        ) {
            Spacer(modifier = Modifier.width((row.depth * 20).dp))
            OutlineBullet(
                checked = row.node.checked,
                inheritedChecked = row.inheritedChecked,
                hasChildren = row.node.children.isNotEmpty(),
                collapsed = row.node.collapsed,
            )
            Column(
                modifier = Modifier
                    .weight(1f)
                    .padding(top = 4.dp, end = 8.dp),
                verticalArrangement = Arrangement.spacedBy(1.dp),
            ) {
                if (selected) {
                    BasicTextField(
                        value = draftText,
                        onValueChange = {
                            if (it.contains('\n')) {
                                val nextText = it.substringBefore('\n')
                                draftText = nextText
                                onSaveTextAndNote(nextText, draftNote)
                                onCommitNewChild()
                            } else {
                                draftText = it
                                onSaveTextAndNote(it, draftNote)
                            }
                        },
                        singleLine = true,
                        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                        keyboardActions = KeyboardActions(
                            onDone = { onCommitNewChild() },
                        ),
                        textStyle = MaterialTheme.typography.titleMedium.copy(
                            color = if (effectiveChecked) BikeMuted else BikeInk,
                            fontWeight = if (row.depth == 0) FontWeight.SemiBold else FontWeight.Normal,
                            textDecoration = textDecoration,
                        ),
                        cursorBrush = SolidColor(BikeAccent),
                        modifier = Modifier
                            .fillMaxWidth()
                            .focusRequester(focusRequester)
                            .onPreviewKeyEvent { event ->
                                if (
                                    event.type == KeyEventType.KeyUp &&
                                    (event.key == Key.Enter || event.key == Key.NumPadEnter)
                                ) {
                                    onCommitNewChild()
                                    true
                                } else {
                                    false
                                }
                            },
                        decorationBox = { innerTextField ->
                            Box {
                                if (draftText.isBlank()) {
                                    Text(
                                        text = "点击新增主题",
                                        style = MaterialTheme.typography.titleMedium,
                                        color = BikeMuted,
                                    )
                                }
                                innerTextField()
                            }
                        },
                    )
                } else {
                    Text(
                        text = row.node.text.ifBlank { "点击新增主题" },
                        style = MaterialTheme.typography.titleMedium,
                        color = if (effectiveChecked) BikeMuted else BikeInk,
                        fontWeight = if (row.depth == 0) FontWeight.SemiBold else FontWeight.Normal,
                        textDecoration = textDecoration,
                        maxLines = 3,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (row.node.note.isNotBlank()) {
                    Text(
                        text = row.node.note,
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (effectiveChecked) BikeFaint else BikeMuted,
                        textDecoration = textDecoration,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (row.node.children.isNotEmpty()) {
                PlainIconButton(
                    symbol = if (row.node.collapsed) "›" else "⌄",
                    onClick = onToggleCollapsed,
                    tint = BikeFaint,
                    modifier = Modifier.size(34.dp),
                )
            }
        }
    }
}

@Composable
private fun NodeInputAccessoryBar(
    modifier: Modifier = Modifier,
    canMoveToParentLevel: Boolean,
    aiBusy: Boolean,
    aiBusyOnThisNode: Boolean,
    onMoveToParentLevel: () -> Unit,
    onAddSibling: () -> Unit,
    onAddChild: () -> Unit,
    onAiGenerate: () -> Unit,
    onAiPolish: () -> Unit,
    onDelete: () -> Unit,
) {
    LazyRow(
        modifier = modifier
            .fillMaxWidth()
            .background(BikeSurface)
            .padding(horizontal = 12.dp, vertical = 7.dp),
        contentPadding = PaddingValues(horizontal = 4.dp),
        horizontalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        item {
            AccessoryIconButton(
                symbol = "⇤",
                description = "移动到上级",
                enabled = canMoveToParentLevel,
                onClick = onMoveToParentLevel,
            )
        }
        item {
            AccessoryIconButton(
                symbol = "↔",
                description = "新增同级",
                onClick = onAddSibling,
            )
        }
        item {
            AccessoryIconButton(
                symbol = "↳",
                description = "新增子级",
                onClick = onAddChild,
            )
        }
        item {
            AccessoryIconButton(
                symbol = if (aiBusyOnThisNode) "…" else "✦",
                description = if (aiBusyOnThisNode) "AI生成中" else "AI生成",
                enabled = !aiBusy,
                onClick = onAiGenerate,
            )
        }
        item {
            AccessoryIconButton(
                symbol = "✎",
                description = "AI润色",
                enabled = !aiBusy,
                onClick = onAiPolish,
            )
        }
        item {
            AccessoryIconButton(
                symbol = "⌫",
                description = "删除",
                tint = BikeDanger,
                onClick = onDelete,
            )
        }
    }
}

@Composable
private fun OutlineGuides(
    depth: Int,
    modifier: Modifier = Modifier,
) {
    if (depth <= 0) return

    Canvas(modifier = modifier) {
        val stroke = 1.dp.toPx()
        repeat(depth) { level ->
            val x = (level * 20).dp.toPx() + 14.dp.toPx()
            drawLine(
                color = BikeGuide,
                start = Offset(x, 0f),
                end = Offset(x, size.height),
                strokeWidth = stroke,
            )
        }
    }
}

@Composable
private fun OutlineBullet(
    checked: Boolean,
    inheritedChecked: Boolean,
    hasChildren: Boolean,
    collapsed: Boolean,
) {
    Canvas(
        modifier = Modifier.size(width = 28.dp, height = 28.dp),
    ) {
        val centerX = size.width / 2f
        val centerY = 13.dp.toPx()
        drawCircle(
            color = when {
                checked -> BikeGreen
                inheritedChecked -> BikeMuted
                else -> BikeFaint
            },
            radius = if (hasChildren && !collapsed) 4.6.dp.toPx() else 4.dp.toPx(),
            center = Offset(centerX, centerY),
        )
    }
}

@Composable
private fun AccessoryIconButton(
    symbol: String,
    description: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    tint: Color = BikeInk,
    onClick: () -> Unit,
) {
    val contentColor = if (enabled) tint else BikeFaint.copy(alpha = 0.52f)
    val backgroundColor = if (enabled) BikePanel else BikePanel.copy(alpha = 0.42f)

    Box(
        modifier = modifier
            .size(42.dp)
            .clip(RoundedCornerShape(10.dp))
            .background(backgroundColor)
            .semantics { contentDescription = description }
            .clickable(enabled = enabled, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = symbol,
            style = MaterialTheme.typography.titleLarge,
            color = contentColor,
            fontWeight = FontWeight.SemiBold,
        )
    }
}

@Composable
private fun EditorBottomBar(
    aiConfigured: Boolean,
    searchVisible: Boolean,
    onAddRootNode: () -> Unit,
    onToggleAiSettings: () -> Unit,
    onToggleSearch: () -> Unit,
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .height(72.dp)
            .background(BikeSurface)
            .padding(horizontal = 28.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        PlainIconButton(symbol = "+", onClick = onAddRootNode, tint = BikeMuted)
        Box {
            PlainIconButton(
                symbol = "AI",
                onClick = onToggleAiSettings,
                tint = if (aiConfigured) BikeMuted else BikeFaint,
            )
            if (!aiConfigured) {
                Box(
                    modifier = Modifier
                        .align(Alignment.TopEnd)
                        .padding(top = 7.dp, end = 4.dp)
                        .size(7.dp)
                        .clip(RoundedCornerShape(4.dp))
                        .background(BikeAccentHot),
                )
            }
        }
        PlainIconButton(symbol = "≡", onClick = {}, tint = BikeMuted)
        PlainIconButton(
            symbol = "⌕",
            onClick = onToggleSearch,
            tint = if (searchVisible) BikeInk else BikeMuted,
        )
    }
}

private fun String.asCompactDate(): String =
    take(16).replace('T', ' ')

private fun OutlineDocument.asShareText(): String =
    buildString {
        appendLine(title.ifBlank { "无标题" })
        nodes.forEach { node ->
            appendNode(node, depth = 0)
        }
    }.trim()

private fun StringBuilder.appendNode(
    node: OutlineNode,
    depth: Int,
) {
    val indent = "  ".repeat(depth)
    appendLine("$indent- ${node.text.ifBlank { "无标题" }}")
    if (node.note.isNotBlank()) {
        node.note.lines()
            .filter { it.isNotBlank() }
            .forEach { appendLine("$indent  $it") }
    }
    node.children.forEach { child ->
        appendNode(child, depth + 1)
    }
}

@Composable
private fun AiSettingsPanel(
    settings: AiSettings,
    onSave: (AiSettings) -> Unit,
) {
    var endpoint by remember(settings.endpoint) { mutableStateOf(settings.endpoint) }
    var baseUrl by remember(settings.baseUrl) { mutableStateOf(settings.baseUrl) }
    var apiKey by remember(settings.apiKey) { mutableStateOf(settings.apiKey) }
    var model by remember(settings.model) { mutableStateOf(settings.model) }

    Card(
        modifier = Modifier.fillMaxWidth(),
        colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
    ) {
        Column(
            modifier = Modifier.padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text(
                text = "AI 设置",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
            )
            Text(
                text = "端点",
                style = MaterialTheme.typography.labelMedium,
                color = BikeMuted,
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                AiEndpoint.values().forEach { option ->
                    if (endpoint == option) {
                        Button(onClick = { endpoint = option }) {
                            Text(option.title)
                        }
                    } else {
                        OutlinedButton(onClick = { endpoint = option }) {
                            Text(option.title)
                        }
                    }
                }
            }
            OutlinedTextField(
                value = baseUrl,
                onValueChange = { baseUrl = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("Base URL") },
            )
            OutlinedTextField(
                value = apiKey,
                onValueChange = { apiKey = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                label = { Text("API key") },
            )
            OutlinedTextField(
                value = model,
                onValueChange = { model = it },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                label = { Text("模型") },
            )
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(
                    onClick = {
                        onSave(
                            settings.copy(
                                endpoint = endpoint,
                                baseUrl = baseUrl,
                                apiKey = apiKey,
                                model = model,
                            ),
                        )
                    },
                ) {
                    Text("保存 AI 配置")
                }
            }
        }
    }
}

@Composable
private fun LoadingState(status: String) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center,
    ) {
        CircularProgressIndicator()
        Spacer(modifier = Modifier.height(16.dp))
        Text(text = status)
    }
}

@Composable
private fun BikeAndroidTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = darkColorScheme(
            primary = BikeAccent,
            background = BikeBackground,
            surface = BikeBackground,
            surfaceVariant = BikePanel,
            onPrimary = Color.White,
            onBackground = BikeInk,
            onSurface = BikeInk,
            onSurfaceVariant = BikeMuted,
        ),
        content = content,
    )
}

internal data class FlatNodeRow(
    val node: OutlineNode,
    val depth: Int,
    val inheritedChecked: Boolean = false,
)

internal fun flattenVisibleNodes(
    nodes: List<OutlineNode>,
    depth: Int = 0,
    inheritedChecked: Boolean = false,
): List<FlatNodeRow> =
    nodes.flatMap { node ->
        val current = listOf(FlatNodeRow(node, depth, inheritedChecked))
        if (node.collapsed) {
            current
        } else {
            current + flattenVisibleNodes(
                nodes = node.children,
                depth = depth + 1,
                inheritedChecked = inheritedChecked || node.checked,
            )
        }
    }

internal fun flattenSearchNodes(
    nodes: List<OutlineNode>,
    query: String,
    depth: Int = 0,
    inheritedChecked: Boolean = false,
): List<FlatNodeRow> {
    val normalizedQuery = query.trim()
    if (normalizedQuery.isBlank()) {
        return flattenVisibleNodes(nodes, depth, inheritedChecked)
    }

    return nodes.flatMap { node ->
        val current = if (node.matchesQuery(normalizedQuery)) {
            listOf(FlatNodeRow(node, depth, inheritedChecked))
        } else {
            emptyList()
        }
        current + flattenSearchNodes(
            nodes = node.children,
            query = normalizedQuery,
            depth = depth + 1,
            inheritedChecked = inheritedChecked || node.checked,
        )
    }
}

private fun OutlineNode.matchesQuery(query: String): Boolean =
    text.contains(query, ignoreCase = true) || note.contains(query, ignoreCase = true)

internal fun aiErrorMessage(
    fallback: String,
    error: Throwable,
): String =
    when (error) {
        is UnknownHostException -> "AI 连接失败，请检查网络或 Base URL"
        is SocketTimeoutException -> "AI 请求超时，请稍后重试"
        is AiHttpException -> when (error.statusCode) {
            401, 403 -> "API Key 无效或没有权限，请检查 AI 设置"
            404 -> "AI 接口或模型不存在，请检查 Base URL 和模型名称"
            408 -> "AI 请求超时，请稍后重试"
            429 -> "AI 请求过于频繁，请稍后重试"
            in 500..599 -> "AI 服务暂时不可用，请稍后重试"
            else -> listOfNotNull(
                "$fallback：HTTP ${error.statusCode}",
                error.providerMessage?.take(80),
            ).joinToString("，")
        }
        is AiResponseFormatException -> error.message ?: "AI 返回格式不正确，请检查 Base URL"
        else -> error.message?.take(80)?.let { "$fallback：$it" } ?: fallback
    }

@Preview(showBackground = true)
@Composable
private fun BikeAndroidAppPreview() {
    val workspace = createStarterWorkspace()
    BikeAndroidTheme {
        WorkspaceScreen(
            payload = WorkspacePayload(
                workspace = workspace,
                raw = com.bike.android.data.WorkspaceJson.json.encodeToJsonElement(workspace)
                    .jsonObject,
            ),
            status = "预览",
            aiSettings = AiSettings(),
            showAiSettings = true,
            aiBusyNodeId = null,
            onImport = {},
            onExport = {},
            onToggleAiSettings = {},
            onSaveAiSettings = {},
            onNewDocument = {},
            onSelectDocument = {},
            onUpdateDocumentTitle = { _, _ -> },
            onMoveDocumentToFront = {},
            onDuplicateDocument = {},
            onDuplicateDocuments = {},
            onToggleDocumentShortcut = { _, _ -> },
            onDeleteDocument = {},
            onDeleteDocuments = {},
            onToggleNode = { _, _, _ -> },
            onUpdateNodeTextAndNote = { _, _, _, _ -> },
            onToggleCollapsed = { _, _, _ -> },
            onMoveNodeToParentLevel = { _, _ -> },
            onAddRootNode = { _, _ -> },
            onAddSibling = { _, _, _ -> },
            onAddChild = { _, _, _ -> },
            onDeleteNode = { _, _ -> },
            onAiGenerate = { _, _ -> },
            onAiPolish = { _, _ -> },
        )
    }
}
