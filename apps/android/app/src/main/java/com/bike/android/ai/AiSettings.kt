package com.bike.android.ai

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

data class AiSettings(
    val endpoint: AiEndpoint = AiEndpoint.Responses,
    val baseUrl: String = DEFAULT_AI_BASE_URL,
    val apiKey: String = "",
    val model: String = "gpt-4.1-mini",
) {
    val isConfigured: Boolean
        get() = baseUrl.isNotBlank() && apiKey.isNotBlank() && model.isNotBlank()
}

enum class AiEndpoint(
    val storageValue: String,
    val path: String,
    val title: String,
) {
    Responses(
        storageValue = "responses",
        path = "responses",
        title = "Responses",
    ),
    ChatCompletions(
        storageValue = "chat_completions",
        path = "chat/completions",
        title = "Chat/completions",
    );

    companion object {
        fun fromStorage(value: String?): AiEndpoint =
            values().firstOrNull { it.storageValue == value } ?: Responses
    }
}

class AiSettingsRepository(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    init {
        migratePlainApiKeyIfNeeded()
    }

    fun load(): AiSettings =
        AiSettings(
            endpoint = AiEndpoint.fromStorage(preferences.getString(KEY_ENDPOINT, null)),
            baseUrl = preferences.getString(KEY_BASE_URL, DEFAULT_AI_BASE_URL).orEmpty()
                .ifBlank { DEFAULT_AI_BASE_URL },
            apiKey = preferences.getString(KEY_API_KEY_ENCRYPTED, null)
                ?.let { decryptString(it) }
                .orEmpty(),
            model = preferences.getString(KEY_MODEL, "gpt-4.1-mini").orEmpty()
                .ifBlank { "gpt-4.1-mini" },
        )

    fun save(settings: AiSettings) {
        preferences.edit()
            .putString(KEY_ENDPOINT, settings.endpoint.storageValue)
            .putString(KEY_BASE_URL, settings.baseUrl.trim())
            .putEncryptedString(KEY_API_KEY_ENCRYPTED, settings.apiKey.trim())
            .remove(KEY_API_KEY_PLAIN)
            .putString(KEY_MODEL, settings.model.trim())
            .apply()
    }

    private fun migratePlainApiKeyIfNeeded() {
        if (preferences.contains(KEY_API_KEY_ENCRYPTED)) return

        val plainApiKey = preferences.getString(KEY_API_KEY_PLAIN, null)
            ?.trim()
            .orEmpty()
        if (plainApiKey.isBlank()) {
            preferences.edit().remove(KEY_API_KEY_PLAIN).apply()
            return
        }

        preferences.edit()
            .putEncryptedString(KEY_API_KEY_ENCRYPTED, plainApiKey)
            .remove(KEY_API_KEY_PLAIN)
            .apply()
    }

    private fun SharedPreferences.Editor.putEncryptedString(
        key: String,
        value: String,
    ): SharedPreferences.Editor =
        if (value.isBlank()) {
            remove(key)
        } else {
            putString(key, encryptString(value))
        }

    private fun encryptString(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
        val encrypted = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
        return listOf(cipher.iv, encrypted)
            .joinToString(ENCRYPTED_VALUE_SEPARATOR) { bytes ->
                Base64.encodeToString(bytes, Base64.NO_WRAP)
            }
    }

    private fun decryptString(value: String): String =
        runCatching {
            val parts = value.split(ENCRYPTED_VALUE_SEPARATOR)
            if (parts.size != 2) return@runCatching ""

            val iv = Base64.decode(parts[0], Base64.NO_WRAP)
            val encrypted = Base64.decode(parts[1], Base64.NO_WRAP)
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(
                Cipher.DECRYPT_MODE,
                getOrCreateSecretKey(),
                GCMParameterSpec(GCM_TAG_LENGTH_BITS, iv),
            )
            cipher.doFinal(encrypted).toString(Charsets.UTF_8)
        }.onFailure { error ->
            Log.w(LOG_TAG, "Failed to decrypt AI API key", error)
        }.getOrDefault("")

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
        (keyStore.getEntry(KEYSTORE_ALIAS, null) as? KeyStore.SecretKeyEntry)
            ?.secretKey
            ?.let { return it }

        val keyGenerator = KeyGenerator.getInstance(
            KeyProperties.KEY_ALGORITHM_AES,
            ANDROID_KEY_STORE,
        )
        val spec = KeyGenParameterSpec.Builder(
            KEYSTORE_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        keyGenerator.init(spec)
        return keyGenerator.generateKey()
    }

    private companion object {
        const val PREFERENCES_NAME = "bike-ai-settings"
        const val KEY_ENDPOINT = "endpoint"
        const val KEY_BASE_URL = "baseUrl"
        const val KEY_API_KEY_PLAIN = "apiKey"
        const val KEY_API_KEY_ENCRYPTED = "apiKeyEncrypted"
        const val KEY_MODEL = "model"
        const val ANDROID_KEY_STORE = "AndroidKeyStore"
        const val KEYSTORE_ALIAS = "bike_android_ai_settings"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_LENGTH_BITS = 128
        const val ENCRYPTED_VALUE_SEPARATOR = ":"
        const val LOG_TAG = "AiSettingsRepository"
    }
}

const val DEFAULT_AI_BASE_URL = "https://api.openai.com/v1"
