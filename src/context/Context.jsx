import { createContext, useCallback, useEffect, useMemo, useRef, useState } from "react";
import streamParser from "../services/streamParser";
import { executeTool, buildAgentSystemPrompt } from "../services/toolRegistry";
import { matchSkills } from "../services/skills";
import { useSpeechRecognition } from "../hooks/useSpeechRecognition";

// ─── Token 估算 & 上下文截断（纯工具函数）────────────────────

const MAX_CONTEXT_TOKENS = 6000; // 留给输入的总 token 预算
const HISTORY_BUDGET = 4500;     // 对话历史可用 token（扣除 system prompt）

function estimateTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (msg.content) {
      text = JSON.stringify(msg.content);
    }
    const chineseChars = (text.match(/[一-鿿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    total += Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
  }
  return total;
}

function trimMessages(messages, maxTokens) {
  if (messages.length <= 2) return messages;
  const systemMsg = messages[0];
  const history = messages.slice(1);
  const keep = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const tokens = estimateTokens([history[i]]);
    if (used + tokens > maxTokens) break;
    keep.unshift(history[i]);
    used += tokens;
  }
  const dropped = history.length - keep.length;
  if (dropped > 0) {
    console.log(
      `[Context] 截断: ${history.length}条 → ${keep.length}条 (丢弃早期${dropped}条, 预估${used} tokens)`
    );
  }
  return [systemMsg, ...keep];
}

export const Context = createContext();

const ContextProvider = (props) => {
  const [input, setInput] = useState("");
  const [recentPrompt, setRecentPrompt] = useState("");
  const [sessions, setSessions] = useState([]);
  const [currentSessionId, setCurrentSessionId] = useState(null);
  const [showResult, setShowResult] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resultData, setResultData] = useState("");
  const [messages, setMessages] = useState([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAtBottom, setIsAtBottom] = useState(true);

  const virtuosoRef = useRef(null);

  const createNewSession = useCallback(() => {
    const newSession = {
      id: Date.now(),
      title: "New Chat",
      messages: [],
      createdAt: new Date().toISOString(),
      showResult: false,
      resultData: "",
      isGenerating: false,
      input: ""
    };

    setSessions((prev) => [newSession, ...prev]);
    setCurrentSessionId(newSession.id);
    setMessages([]);
    setShowResult(false);
    setResultData("");
    setInput("");
    setLoading(false);
    setIsGenerating(false);
    setIsAtBottom(true);
  }, []);

                                                                                                                                                    const loadSession = useCallback(
                                                                                                                                                      (sessionId) => {
                                                                                                                                                        const session = sessions.find((item) => item.id === sessionId);
                                                                                                                                                        if (!session) {
                                                                                                                                                          return;
                                                                                                                                                        }

                                                                                                                                                        setCurrentSessionId(sessionId);
                                                                                                                                                        setMessages(session.messages);
                                                                                                                                                        setShowResult(session.showResult !== undefined ? session.showResult : session.messages.length > 0);
                                                                                                                                                        setRecentPrompt(session.title);
                                                                                                                                                        setResultData(session.resultData || "");
                                                                                                                                                        setIsGenerating(session.isGenerating || false);
                                                                                                                                                        setInput(session.input || "");
                                                                                                                                                        setIsAtBottom(true);
                                                                                                                                                      },
                                                                                                                                                      [sessions]
                                                                                                                                                    );

  const deleteSession = useCallback(
    (sessionId) => {
      setSessions((prev) => {
        const updatedSessions = prev.filter((session) => session.id !== sessionId);

        if (currentSessionId === sessionId) {
          if (updatedSessions.length > 0) {
            setTimeout(() => loadSession(updatedSessions[0].id), 0);
          } else {
            setTimeout(() => createNewSession(), 0);
          }
        }

        return updatedSessions;
      });
    },
    [createNewSession, currentSessionId, loadSession]
  );

  const updateSessionMessages = useCallback(
    (newMessages, additionalState = {}) => {
      setSessions((prev) =>
        prev.map((session) =>
          session.id === currentSessionId
            ? {
                ...session,
                messages: newMessages,
                title:
                  newMessages.find((message) => message.role === "user")?.content?.slice(0, 20) ||
                  "New Chat",
                showResult:
                  additionalState.showResult !== undefined ? additionalState.showResult : session.showResult,
                resultData:
                  additionalState.resultData !== undefined ? additionalState.resultData : session.resultData,
                isGenerating:
                  additionalState.isGenerating !== undefined
                    ? additionalState.isGenerating
                    : session.isGenerating,
                input: additionalState.input !== undefined ? additionalState.input : session.input
              }
            : session
        )
      );
    },
    [currentSessionId]
  );

  useEffect(() => {
    if (sessions.length === 0) {
      createNewSession();
    }
  }, [createNewSession, sessions.length]);

  const scrollToBottom = useCallback(
    (behavior = "auto") => {
      if (!virtuosoRef.current) {
        return;
      }

      virtuosoRef.current.scrollToIndex({
        align: "end",
        behavior,
        index: Math.max(messages.length - 1, 0)
      });
    },
    [messages.length]
  );

  const onSent = useCallback(
    async (prompt) => {
      if (isGenerating) {
        return;
      }

      const messageText = prompt !== undefined ? prompt : input;
      if (!messageText.trim()) {
        return;
      }

      const normalizedText = messageText.trim();

      // ====== 1. 创建用户消息 ======
      const userMessage = {
        id: Date.now(),
        role: "user",
        content: normalizedText,
        timestamp: new Date().toLocaleString()
      };

      let uiMessages = [...messages, userMessage];
      setMessages(uiMessages);
      updateSessionMessages(uiMessages, { showResult: true, input: "", isGenerating: true });
      setInput("");
      setShowResult(true);
      setIsGenerating(true);
      setLoading(true);
      setRecentPrompt(normalizedText);
      setIsAtBottom(true);

      // ====== 2. 构建 API 消息（加入 Agent system prompt） ======
      const buildApiMessages = (uiMsgs) =>
        uiMsgs
          .filter((m) => m.role !== "system")
          .map((m) => {
            const apiMsg = { role: m.role, content: m.content };
            if (m.toolCalls) {
              apiMsg.tool_calls = m.toolCalls;
            }
            if (m.role === "tool") {
              apiMsg.tool_call_id = m.tool_call_id;
            }
            return apiMsg;
          });

      // 初始 API 消息：Agent system prompt + 历史消息
      const activeSkills = matchSkills(normalizedText);
      let apiMessages = [
        { role: "system", content: buildAgentSystemPrompt(activeSkills) },
        ...buildApiMessages(uiMessages),
      ];
      let accumulatedContent = "";

      // ====== 3. Agent 循环 ======
      const MAX_ITERATIONS = 5; // 安全上限
      let iteration = 0;

      while (iteration < MAX_ITERATIONS) {
        iteration++;

        // 为本轮创建 AI 消息 placeholder
        const aiMessageId = Date.now() + iteration;
        const aiMessage = {
          id: aiMessageId,
          role: "assistant",
          content: "",
          timestamp: new Date().toLocaleString(),
          status: "generating"
        };

        uiMessages = [...uiMessages, aiMessage];
        setMessages(uiMessages);

        // Token 估算 & 滑动窗口截断
        const estimated = estimateTokens(apiMessages);
        if (estimated > MAX_CONTEXT_TOKENS) {
          console.log(
            `[Context] Tokens: ${estimated} > ${MAX_CONTEXT_TOKENS}, 截断中...`
          );
          apiMessages = trimMessages(apiMessages, HISTORY_BUDGET);
        }

        // 流式文本收集（闭包内）
        let streamedText = "";
        let toolCalls = [];

        try {
          await streamParser.fetchStream(
            apiMessages,
            // onChunk
            (chunk) => {
              streamedText += chunk;
              const updated = uiMessages.map((m) =>
                m.id === aiMessageId
                  ? { ...m, content: m.content + chunk }
                  : m
              );
              uiMessages = updated;
              setMessages(updated);
              updateSessionMessages(updated, { resultData: streamedText });
            },
            // onError
            (error) => {
              console.error("Stream error:", error);
              const updated = uiMessages.map((m) =>
                m.id === aiMessageId
                  ? { ...m, status: "failed", content: m.content || "生成失败，请重试" }
                  : m
              );
              uiMessages = updated;
              setMessages(updated);
            },
            // onComplete — 解析 tool calls（优先原生，fallback 到 prompt-based）
            (completedToolCalls) => {
              // 先检查是否有原生 tool_calls（OpenAI 格式）
              if (completedToolCalls && completedToolCalls.length > 0) {
                toolCalls = completedToolCalls;
                return;
              }

              // Fallback: 从文本中解析 prompt-based 工具调用
              // 格式: {"tool": "工具名", "args": {...}}
              const toolCallRegex = /\{\s*"tool"\s*:\s*"([^"]+)"\s*,\s*"args"\s*:\s*(\{[^}]*\})\s*\}/g;
              let match;
              while ((match = toolCallRegex.exec(streamedText)) !== null) {
                try {
                  const toolName = match[1];
                  const args = JSON.parse(match[2]);
                  toolCalls.push({
                    id: `call_${Date.now()}_${toolCalls.length}`,
                    type: "function",
                    function: {
                      name: toolName,
                      arguments: JSON.stringify(args),
                    },
                  });
                } catch {
                  // 解析失败，跳过
                }
              }
            },
            true  // agentMode: server 不自动注入 RAG，Agent 自主调用工具
          );
        } catch (error) {
          console.error("Agent loop error:", error);
          const updated = uiMessages.map((m) =>
            m.id === aiMessageId
              ? { ...m, status: "failed", content: "生成失败，请重试" }
              : m
          );
          setMessages(updated);
          updateSessionMessages(updated, { isGenerating: false });
          setIsGenerating(false);
          setLoading(false);
          return;
        }

        // 检查是否有 tool_calls
        if (toolCalls.length > 0) {
          // 清理文本中的工具调用 JSON（不显示给用户）
          let cleanText = streamedText.replace(
            /\{\s*"tool"\s*:\s*"[^"]+"\s*,\s*"args"\s*:\s*\{[^}]+\}\s*\}/g,
            ""
          ).trim();

          const toolNames = toolCalls.map((tc) => tc.function.name).join(", ");
          uiMessages = uiMessages.map((m) =>
            m.id === aiMessageId
              ? {
                  ...m,
                  content: cleanText || `🔧 正在调用工具: ${toolNames}`,
                  status: "tool_use",
                  toolCalls: toolCalls
                }
              : m
          );
          setMessages(uiMessages);

          // 追加 assistant 回复到 API 消息（含工具调用 JSON）
          apiMessages.push({
            role: "assistant",
            content: streamedText,
          });

          // 执行工具，将结果以 user 消息形式追加（prompt-based 兼容）
          for (const tc of toolCalls) {
            let result;
            try {
              result = await executeTool(tc.function.name, tc.function.arguments);
            } catch (err) {
              result = JSON.stringify({ error: `工具执行失败: ${err.message}` });
            }

            // 以 user 消息形式发送工具结果
            apiMessages.push({
              role: "user",
              content: `[工具 ${tc.function.name} 的执行结果]\n${result}`,
            });

            // 在 UI 中显示工具调用结果（可选：折叠展示）
            let toolResultPreview = result;
            try {
              const parsed = JSON.parse(result);
              if (parsed.results) {
                toolResultPreview = `📚 找到 ${parsed.results.length} 条相关结果`;
              } else if (parsed.result !== undefined) {
                toolResultPreview = `🧮 ${tc.function.arguments.expression} = ${parsed.result}`;
              } else if (parsed.datetime) {
                toolResultPreview = `🕐 ${parsed.datetime}`;
              }
            } catch {
              toolResultPreview = result.substring(0, 100);
            }

            const toolMsg = {
              id: Date.now() + iteration + Math.random(),
              role: "tool",
              tool_call_id: tc.id,
              tool_name: tc.function.name,
              content: toolResultPreview,
              timestamp: new Date().toLocaleString()
            };
            uiMessages.push(toolMsg);
          }

          // 更新 UI
          setMessages([...uiMessages]);
          accumulatedContent = streamedText || accumulatedContent;

          // 继续循环 — 模型基于工具结果再次推理
          continue;
        }

        // 没有 tool_calls — 这是最终回答
        uiMessages = uiMessages.map((m) =>
          m.id === aiMessageId
            ? { ...m, status: "completed", content: streamedText }
            : m
        );
        setMessages(uiMessages);

        const finalContent = accumulatedContent + streamedText || streamedText;
        updateSessionMessages(uiMessages, {
          resultData: finalContent,
          isGenerating: false
        });
        setIsGenerating(false);
        setLoading(false);
        setResultData(finalContent);
        return;
      }

      // 超过最大迭代次数
      const lastMsg = uiMessages[uiMessages.length - 1];
      if (lastMsg && lastMsg.status === "generating") {
        uiMessages = uiMessages.map((m) =>
          m.id === lastMsg.id ? { ...m, status: "completed" } : m
        );
      }
      setMessages(uiMessages);
      updateSessionMessages(uiMessages, {
        isGenerating: false,
        resultData: accumulatedContent
      });
      setIsGenerating(false);
      setLoading(false);
    },
    [input, isGenerating, messages, updateSessionMessages]
  );

  const handleVoiceTranscript = useCallback(
    (transcript) => {
      setInput(transcript);
      onSent(transcript);
    },
    [onSent]
  );

  const {
    error: voiceError,
    isSupported: isVoiceSupported,
    status: voiceInputStatus,
    toggle: toggleVoiceInput,
    transcript: voiceTranscript
  } = useSpeechRecognition({ onTranscript: handleVoiceTranscript });

  const abortGeneration = useCallback(() => {
    streamParser.abort();
    setIsGenerating(false);
    setLoading(false);
    const updatedMessages = messages.map((message) =>
      message.status === "generating" ? { ...message, status: "aborted" } : message
    );
    setMessages(updatedMessages);
    updateSessionMessages(updatedMessages, { isGenerating: false });
  }, [messages, updateSessionMessages]);

  const handleKeyPress = useCallback(
    (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        onSent();
      }
    },
    [onSent]
  );

  const contextValue = useMemo(
    () => ({
      abortGeneration,
      createNewSession,
      currentSessionId,
      deleteSession,
      handleKeyPress,
      input,
      isAtBottom,
      isGenerating,
      isVoiceSupported,
      loadSession,
      loading,
      messages,
      onSent,
      recentPrompt,
      resultData,
      scrollToBottom,
      sessions,
      setInput,
      setIsAtBottom,
      setRecentPrompt,
      showResult,
      toggleVoiceInput,
      updateSessionMessages,
      virtuosoRef,
      voiceError,
      voiceInputStatus,
      voiceTranscript
    }),
    [
      abortGeneration,
      createNewSession,
      currentSessionId,
      deleteSession,
      handleKeyPress,
      input,
      isAtBottom,
      isGenerating,
      isVoiceSupported,
      loadSession,
      loading,
      messages,
      onSent,
      recentPrompt,
      resultData,
      scrollToBottom,
      sessions,
      showResult,
      toggleVoiceInput,
      updateSessionMessages,
      voiceError,
      voiceInputStatus,
      voiceTranscript
    ]
  );

  return <Context.Provider value={contextValue}>{props.children}</Context.Provider>;
};

export default ContextProvider;
