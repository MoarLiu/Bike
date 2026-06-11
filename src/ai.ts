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

type ResponsesInputItem = {
  role: "user";
  content: Array<{
    type: "input_text";
    text: string;
  }>;
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

const responsesInputFor = (messages: AiMessage[]): ResponsesInputItem[] => {
  const userPrompt = messages
    .filter((message) => message.role !== "system")
    .map((message) => message.content)
    .join("\n\n");
  return [{
    role: "user",
    content: [{ type: "input_text", text: userPrompt }],
  }];
};

const providerErrorMessage = (data: unknown): string | undefined => {
  if (!isRecord(data)) return undefined;
  if (isRecord(data.error) && typeof data.error.message === "string") return data.error.message;
  if (typeof data.error === "string") return data.error;
  if (typeof data.detail === "string") return data.detail;
  if (Array.isArray(data.detail)) {
    const details = data.detail
      .map((item) => {
        if (typeof item === "string") return item;
        if (isRecord(item) && typeof item.msg === "string") return item.msg;
        if (isRecord(item) && typeof item.message === "string") return item.message;
        return "";
      })
      .filter(Boolean);
    if (details.length) return details.join("; ");
  }
  if (typeof data.message === "string") return data.message;
  return undefined;
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
    input: responsesInputFor(messages),
  };
};

const extractTextFromOutputContent = (content: unknown) => {
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (!isRecord(item)) return "";
      if (typeof item.text === "string") return item.text;
      if (typeof item.output_text === "string") return item.output_text;
      return "";
    })
    .join("");
};

const extractTextFromEventStream = (value: string) => {
  if (!/^\s*(event|data):/m.test(value)) return "";

  const deltas: string[] = [];
  const completedTexts: string[] = [];

  value.split(/\r?\n/).forEach((line) => {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return;

    let eventData: unknown;
    try {
      eventData = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(eventData)) return;

    if (eventData.type === "response.output_text.delta" && typeof eventData.delta === "string") {
      deltas.push(eventData.delta);
      return;
    }

    if (eventData.type === "response.output_text.done" && typeof eventData.text === "string") {
      completedTexts.push(eventData.text);
      return;
    }

    const part = isRecord(eventData.part) ? eventData.part : null;
    if (part && part.type === "output_text" && typeof part.text === "string" && part.text) {
      completedTexts.push(part.text);
      return;
    }

    const item = isRecord(eventData.item) ? eventData.item : null;
    const itemText = item ? extractTextFromOutputContent(item.content) : "";
    if (itemText) {
      completedTexts.push(itemText);
      return;
    }

    const response = isRecord(eventData.response) ? eventData.response : null;
    const responseOutput = response && Array.isArray(response.output) ? response.output : [];
    const responseText = responseOutput
      .map((outputItem) => isRecord(outputItem) ? extractTextFromOutputContent(outputItem.content) : "")
      .join("");
    if (responseText) completedTexts.push(responseText);
  });

  return deltas.join("") || completedTexts.join("");
};

const parseProviderPayload = (value: string): unknown => {
  if (!value.trim()) return null;
  try {
    return JSON.parse(value);
  } catch {
    return { text: value };
  }
};

const extractTextFromResponse = (data: unknown): string => {
  if (typeof data === "string") return extractTextFromEventStream(data) || data;
  if (!isRecord(data)) return "";

  if (typeof data.output_text === "string") return extractTextFromEventStream(data.output_text) || data.output_text;
  if (typeof data.text === "string") return extractTextFromEventStream(data.text) || data.text;
  if (typeof data.content === "string") return extractTextFromEventStream(data.content) || data.content;

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
    const jsonSlice = firstBalancedJsonSlice(trimmed);
    if (jsonSlice) return JSON.parse(jsonSlice);
    throw new Error("AI 返回内容不是有效 JSON");
  }
};

const firstBalancedJsonSlice = (value: string) => {
  for (let start = 0; start < value.length; start += 1) {
    const firstChar = value[start];
    if (firstChar !== "{" && firstChar !== "[") continue;

    const stack = [firstChar === "{" ? "}" : "]"];
    let inString = false;
    let escaped = false;

    for (let index = start + 1; index < value.length; index += 1) {
      const char = value[index];

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (char === "\\") {
          escaped = true;
        } else if (char === "\"") {
          inString = false;
        }
        continue;
      }

      if (char === "\"") {
        inString = true;
        continue;
      }

      if (char === "{") {
        stack.push("}");
      } else if (char === "[") {
        stack.push("]");
      } else if (char === "}" || char === "]") {
        if (stack[stack.length - 1] !== char) break;
        stack.pop();
        if (!stack.length) return value.slice(start, index + 1);
      }
    }
  }

  return null;
};

const generatedTextKeys = ["text", "title", "name", "label", "content", "heading", "topic"] as const;
const generatedChildrenKeys = [
  "children",
  "childNodes",
  "subtopics",
  "subTopics",
  "topics",
  "nodes",
  "items",
  "outline",
  "subnodes",
  "subNodes",
] as const;

const generatedNodeText = (value: unknown) => {
  if (typeof value === "string") return value.trim();
  if (!isRecord(value)) return "";
  for (const key of generatedTextKeys) {
    const text = value[key];
    if (typeof text === "string" && text.trim()) return text.trim();
  }
  return "";
};

const generatedNodeChildren = (value: unknown): unknown => {
  if (!isRecord(value)) return undefined;
  for (const key of generatedChildrenKeys) {
    const children = value[key];
    if (Array.isArray(children)) return children;
  }
  return undefined;
};

const sanitizeGeneratedNodes = (value: unknown, depth = 1): AiGeneratedNode[] => {
  if (depth > 3) return [];
  const items = Array.isArray(value) ? value : generatedNodeChildren(value);
  if (!Array.isArray(items)) return [];

  return items.flatMap((item) => {
    const text = generatedNodeText(item);
    if (!text) {
      return sanitizeGeneratedNodes(generatedNodeChildren(item), depth);
    }
    return [{
      text: text.slice(0, 120),
      children: sanitizeGeneratedNodes(generatedNodeChildren(item), depth + 1),
    }];
  }).slice(0, 8);
};

const normalizeActionResult = (action: AiNodeAction, parsed: unknown): AiActionResult => {
  if (Array.isArray(parsed)) {
    return { children: sanitizeGeneratedNodes(parsed) };
  }
  if (!isRecord(parsed)) throw new Error("AI 返回 JSON 结构不正确");
  if (action === "polish") {
    const text = generatedNodeText(parsed);
    if (!text) throw new Error("AI 没有返回润色文本");
    return { text };
  }
  return { children: sanitizeGeneratedNodes(parsed) };
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
  const bikeBridge = window.bike ?? window.localOutline;
  if (bikeBridge?.invokeAiProvider) {
    const result = await bikeBridge.invokeAiProvider(invokePayload);
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
    const contentType = response.headers.get("content-type") || "";
    data = parseProviderPayload(await response.text());
    if (response.ok && /^text\/html\b/i.test(contentType)) {
      throw new Error("AI 端点返回了 HTML 页面，请检查 API baseurl 和协议端点是否匹配");
    }
    if (!response.ok) {
      const message = providerErrorMessage(data) ?? `AI 请求失败：HTTP ${response.status}`;
      throw new Error(message);
    }
  }

  const text = extractTextFromResponse(data);
  if (!text.trim()) throw new Error("AI 返回内容为空");
  return normalizeActionResult(action, parseJsonText(text));
};
