package com.bike.android.ui

import com.bike.android.ai.AiHttpException
import org.junit.Assert.assertEquals
import org.junit.Test
import java.net.SocketTimeoutException
import java.net.UnknownHostException

class AiErrorMessageTest {
    @Test
    fun mapsNetworkErrorsToFriendlyMessages() {
        assertEquals(
            "AI 连接失败，请检查网络或 Base URL",
            aiErrorMessage("AI 生成失败", UnknownHostException()),
        )
        assertEquals(
            "AI 请求超时，请稍后重试",
            aiErrorMessage("AI 生成失败", SocketTimeoutException()),
        )
    }

    @Test
    fun mapsHttpStatusErrorsToFriendlyMessages() {
        assertEquals(
            "API Key 无效或没有权限，请检查 AI 设置",
            aiErrorMessage("AI 润色失败", AiHttpException(401, "bad key")),
        )
        assertEquals(
            "AI 请求过于频繁，请稍后重试",
            aiErrorMessage("AI 润色失败", AiHttpException(429, "rate limit")),
        )
        assertEquals(
            "AI 服务暂时不可用，请稍后重试",
            aiErrorMessage("AI 润色失败", AiHttpException(503, "temporarily unavailable")),
        )
    }

    @Test
    fun includesUnknownHttpStatusAndProviderMessage() {
        assertEquals(
            "AI 生成失败：HTTP 418，short and stout",
            aiErrorMessage("AI 生成失败", AiHttpException(418, "short and stout")),
        )
    }
}
