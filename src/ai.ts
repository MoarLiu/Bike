import type { OutlineNode } from "./types";
import { createNode } from "./tree";

export type AiEndpoint = "chat_completions" | "responses";
export type AiNodeAction = "generate" | "polish";

export interface AiApiConfig {
  endpoint: AiEndpoint;
  baseUrl: string;
  apiKey: string;
  model: string;
}

export interface AiActionContext {
  documentTitle: string;
  topicText: string;
  note?: string;
  existingChildren?: string[];
}

export interface AiGeneratedNode {
  text: string;
  children?: AiGeneratedNode[];
}

export interface AiActionResult {
  text?: string;
  children?: AiGeneratedNode[];
}

type AiMessage = {
  role: "system" | "user";
  content: string;
};

const AI_CONFIG_KEY = "bike-ai-config";
const LEGACY_AI_CONFIG_KEY = "local-outline-ai-config";

export const defaultAiConfig: AiApiConfig = {
  endpoint: "responses",
  baseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-5.5",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

export const loadAiConfig = (): AiApiConfig => {
  try {
    const raw = localStorage.getItem(AI_CONFIG_KEY) ?? localStorage.getItem(LEGACY_AI_CONFIG_KEY);
    if (!raw) return defaultAiConfig;
    const parsed = JSON.parse(raw) as Partial<AiApiConfig>;
    return {
      endpoint: parsed.endpoint === "chat_completions" ? "chat_completions" : "responses",
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim()
        ? parsed.baseUrl.trim()
        : defaultAiConfig.baseUrl,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey : "",
      model: typeof parsed.model === "string" && parsed.model.trim()
        ? parsed.model.trim()
        : defaultAiConfig.model,
    };
  } catch {
    return defaultAiConfig;
  }
};

export const saveAiConfig = (config: AiApiConfig) => {
  const normalized = normalizeAiConfig(config);
  localStorage.setItem(AI_CONFIG_KEY, JSON.stringify(normalized));
  localStorage.removeItem(LEGACY_AI_CONFIG_KEY);
  return normalized;
};

export const normalizeAiConfig = (config: AiApiConfig): AiApiConfig => ({
  endpoint: config.endpoint === "chat_completions" ? "chat_completions" : "responses",
  baseUrl: config.baseUrl.trim().replace(/\/+$/, ""),
  apiKey: config.apiKey.trim(),
  model: config.model.trim(),
});

export const validateAiConfig = (config: AiApiConfig) => {
  const normalized = normalizeAiConfig(config);
  if (!normalized.baseUrl) return "请输入 API baseurl";
  if (!/^https?:\/\//i.test(normalized.baseUrl)) return "API baseurl 需要以 http:// 或 https:// 开头";
  if (!normalized.apiKey) return "请输入 API key";
  if (!normalized.model) return "请输入大模型名称";
  return null;
};

const endpointPath = (endpoint: AiEndpoint) =>
  endpoint === "chat_completions" ? "chat/completions" : "responses";

const endpointUrl = (config: AiApiConfig) => {
  const url = new URL(config.baseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(path) || /\/responses$/i.test(path)) {
    return url.toString();
  }
  url.pathname = `${path}/${endpointPath(config.endpoint)}`.replace(/\/{2,}/g, "/");
  return url.toString();
};

const systemPrompt = [
  "你是 Bike 的大纲写作助手。",
  "必须只输出 JSON，不要输出 Markdown 代码块、解释或多余文字。",
  "内容使用中文，短句优先，适合作为大纲主题。",
].join("\n");

const generationInstructions = [
  "任务：基于当前主题生成子主题。",
  "输出 JSON 结构：{\"children\":[{\"text\":\"子主题\",\"children\":[{\"text\":\"更细子主题\"}]}]}。",
  "最多生成 3 层子节点。每个节点 text 不超过 36 个中文字符。",
  "避免重复已有子主题，不要生成空节点。",
].join("\n");

const polishInstructions = [
  "任务：润色并重写当前主题文字。",
  "输出 JSON 结构：{\"text\":\"润色后的主题\"}。",
  "保留原意，让表达更清晰、准确、简洁。只返回一个主题文本。",
].join("\n");

const buildPrompt = (action: AiNodeAction, context: AiActionContext) => {
  const childList = context.existingChildren?.length
    ? context.existingChildren.map((child) => `- ${child}`).join("\n")
    : "无";
  return [
    action === "generate" ? generationInstructions : polishInstructions,
    "",
    `文档标题：${context.documentTitle || "未命名文档"}`,
    `当前主题：${context.topicText || "未命名主题"}`,
    context.note ? `主题备注：${context.note}` : "",
    `已有子主题：\n${childList}`,
  ].filter(Boolean).join("\n");
};

const requestBodyFor = (config: AiApiConfig, messages: AiMessage[]) => {
  if (config.endpoint === "chat_completions") {
    return {
      model: config.model,
      messages,
      temperature: 0.55,
    };
  }

  return {
    model: config.model,
    instructions: messages.find((message) => message.role === "system")?.content,
    input: messages
      .filter((message) => message.role !== "system")
      .map((message) => message.content)
      .join("\n\n"),
    temperature: 0.55,
  };
};

const extractTextFromResponse = (data: unknown): string => {
  if (typeof data === "string") return data;
  if (!isRecord(data)) return "";

  if (typeof data.output_text === "string") return data.output_text;
  if (typeof data.text === "string") return data.text;
  if (typeof data.content === "string") return data.content;

  const choices = Array.isArray(data.choices) ? data.choices : [];
  const firstChoice = choices.find(isRecord);
  const message = firstChoice && isRecord(firstChoice.message) ? firstChoice.message : null;
  if (message && typeof message.content === "string") return message.content;

  const output = Array.isArray(data.output) ? data.output : [];
  const outputText = output
    .flatMap((item) => isRecord(item) && Array.isArray(item.content) ? item.content : [])
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.output_text === "string") return item.output_text;
      return "";
    })
    .join("");
  if (outputText) return outputText;

  return "";
};

const parseJsonText = (value: string): unknown => {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    return JSON.parse(trimmed);
  } catch {
    const objectStart = trimmed.indexOf("{");
    const objectEnd = trimmed.lastIndexOf("}");
    if (objectStart >= 0 && objectEnd > objectStart) {
      return JSON.parse(trimmed.slice(objectStart, objectEnd + 1));
    }
    const arrayStart = trimmed.indexOf("[");
    const arrayEnd = trimmed.lastIndexOf("]");
    if (arrayStart >= 0 && arrayEnd > arrayStart) {
      return JSON.parse(trimmed.slice(arrayStart, arrayEnd + 1));
    }
    throw new Error("AI 返回内容不是有效 JSON");
  }
};

const sanitizeGeneratedNodes = (value: unknown, depth = 1): AiGeneratedNode[] => {
  if (depth > 3 || !Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!text) return [];
    return [{
      text: text.slice(0, 120),
      children: sanitizeGeneratedNodes(item.children, depth + 1),
    }];
  }).slice(0, 8);
};

const normalizeActionResult = (action: AiNodeAction, parsed: unknown): AiActionResult => {
  if (Array.isArray(parsed)) {
    return { children: sanitizeGeneratedNodes(parsed) };
  }
  if (!isRecord(parsed)) throw new Error("AI 返回 JSON 结构不正确");
  if (action === "polish") {
    const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
    if (!text) throw new Error("AI 没有返回润色文本");
    return { text };
  }
  return { children: sanitizeGeneratedNodes(parsed.children) };
};

export const generatedNodesToOutlineNodes = (
  nodes: AiGeneratedNode[] | undefined,
  depth = 1,
): OutlineNode[] => {
  if (!nodes?.length || depth > 3) return [];
  return nodes.map((item) => {
    const node = createNode(item.text.trim());
    node.children = generatedNodesToOutlineNodes(item.children, depth + 1);
    return node;
  });
};

export const runAiNodeAction = async (
  config: AiApiConfig,
  action: AiNodeAction,
  context: AiActionContext,
): Promise<AiActionResult> => {
  const error = validateAiConfig(config);
  if (error) throw new Error(error);

  const normalized = normalizeAiConfig(config);
  const messages: AiMessage[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: buildPrompt(action, context) },
  ];
  const body = requestBodyFor(normalized, messages);
  const invokePayload = {
    endpoint: normalized.endpoint,
    baseUrl: normalized.baseUrl,
    apiKey: normalized.apiKey,
    body,
  };

  let data: unknown;
  if (window.localOutline?.invokeAiProvider) {
    const result = await window.localOutline.invokeAiProvider(invokePayload);
    if (!result.ok) throw new Error(result.error ?? "AI 请求失败");
    data = result.data;
  } else {
    const response = await fetch(endpointUrl(normalized), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${normalized.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    data = await response.json().catch(() => null);
    if (!response.ok) {
      const message = isRecord(data) && typeof data.error === "string"
        ? data.error
        : `AI 请求失败：HTTP ${response.status}`;
      throw new Error(message);
    }
  }

  const text = extractTextFromResponse(data);
  if (!text.trim()) throw new Error("AI 返回内容为空");
  return normalizeActionResult(action, parseJsonText(text));
};
