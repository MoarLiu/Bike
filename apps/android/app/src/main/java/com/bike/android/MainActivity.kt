package com.bike.android

import android.content.Intent
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.bike.android.ai.AiService
import com.bike.android.ai.AiSettingsRepository
import com.bike.android.data.WorkspaceRepository
import com.bike.android.ui.BikeAndroidApp

class MainActivity : ComponentActivity() {
    private var sharedText by mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        sharedText = extractSharedText(intent)
        val repository = WorkspaceRepository(this)
        val aiSettingsRepository = AiSettingsRepository(this)
        val aiService = AiService()
        setContent {
            BikeAndroidApp(
                repository = repository,
                aiSettingsRepository = aiSettingsRepository,
                aiService = aiService,
                sharedText = sharedText,
                onSharedTextConsumed = { markSharedTextConsumed() },
            )
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        sharedText = extractSharedText(intent)
    }

    private fun extractSharedText(intent: Intent?): String? {
        if (intent?.action != Intent.ACTION_SEND || intent.type?.startsWith("text/") != true) return null
        val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT).orEmpty().trim()
        val text = intent.getStringExtra(Intent.EXTRA_TEXT).orEmpty().trim()
        return listOf(subject, text)
            .filter { it.isNotBlank() }
            .distinct()
            .joinToString("\n")
            .takeIf { it.isNotBlank() }
    }

    private fun markSharedTextConsumed() {
        sharedText = null
        if (intent?.action == Intent.ACTION_SEND) {
            setIntent(Intent(this, MainActivity::class.java).apply {
                action = Intent.ACTION_MAIN
            })
        }
    }
}
