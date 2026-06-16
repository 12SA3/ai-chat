class StreamParser {
  constructor() {
    this.sseBuffer = "";
    this.renderBuffer = "";
    this.textDecoder = new TextDecoder("utf-8", { stream: true });
    this.abortController = null;
    this.flushInterval = null;
    this.isFlushing = false;
    this.currentOnChunk = null;
    // tool_calls 累积缓冲区: Map<index, { id, type, function: { name, arguments } }>
    this.toolCallsMap = new Map();
  }

  getErrorMessage(errorValue) {
    if (!errorValue) {
      return "Unknown stream error";
    }

    if (typeof errorValue === "string") {
      return errorValue;
    }

    if (errorValue instanceof Error) {
      return errorValue.message || "Stream error";
    }

    const message = errorValue.message || errorValue.msg || errorValue.code;
    if (message) {
      return String(message);
    }

    try {
      return JSON.stringify(errorValue);
    } catch (jsonError) {
      return "Stream error";
    }
  }

  /**
   * 发起流式请求
   * @param {Array} messages - API 格式的消息数组
   * @param {Function} onChunk - 文本增量回调 (chunk: string)
   * @param {Function} onError - 错误回调 (error: Error)
   * @param {Function} onComplete - 完成回调 (toolCalls: Array|null)
   * @param {Array|null} tools - 工具定义数组 (OpenAI 格式)
   */
  async fetchStream(messages, onChunk, onError, onComplete, agentMode = false) {
    this.abortController = new AbortController();
    this.sseBuffer = "";
    this.renderBuffer = "";
    this.isFlushing = false;
    this.currentOnChunk = onChunk;
    this.toolCallsMap = new Map();

    // 构建请求体
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user");
    const body = {
      messages,
      query: lastUserMsg?.content || "",
      agentMode, // Agent 模式时 server 不自动注入 RAG
    };

    try {
      const response = await fetch("http://localhost:3001/api/chat", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          this._finishStream(onComplete);
          break;
        }

        const chunk = this.textDecoder.decode(value, { stream: true });
        this.sseBuffer += chunk;

        const lines = this.sseBuffer.split("\n");
        this.sseBuffer = lines.pop() || "";

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6).trim();

            if (data === "[DONE]") {
              this._finishStream(onComplete);
              return;
            }

            try {
              const json = JSON.parse(data);

              if (json.error) {
                this.stopFlush();
                onError(new Error(this.getErrorMessage(json.error)));
                return;
              }

              if (json.choices && json.choices.length > 0) {
                const delta = json.choices[0].delta;

                // 1. 文本增量
                const content = delta?.content || "";
                if (content) {
                  this.addToRenderBuffer(content);
                }

                // 2. tool_calls 增量 (Agent/Function Calling)
                if (delta?.tool_calls) {
                  this._accumulateToolCalls(delta.tool_calls);
                }
              }
            } catch (jsonError) {
              console.error("JSON parse error:", jsonError);
            }
          }
        }
      }
    } catch (error) {
      if (error.name === "AbortError") {
        console.log("Stream aborted");
        this.flushAll();
      } else {
        this.stopFlush();
        onError(error);
      }
    }
  }

  /**
   * 累积 tool_calls 分片
   * SSE 流中 tool_calls 的 arguments 是分片传输的，需要按 index 拼接
   */
  _accumulateToolCalls(toolCalls) {
    for (const tc of toolCalls) {
      const index = tc.index ?? 0;

      if (!this.toolCallsMap.has(index)) {
        this.toolCallsMap.set(index, {
          id: "",
          type: "function",
          function: { name: "", arguments: "" },
        });
      }

      const entry = this.toolCallsMap.get(index);

      if (tc.id) entry.id = tc.id;
      if (tc.type) entry.type = tc.type;
      if (tc.function?.name) entry.function.name = tc.function.name;
      if (tc.function?.arguments) entry.function.arguments += tc.function.arguments;
    }
  }

  /**
   * 流结束处理：flush 剩余文本、解析 tool_calls 并回调
   */
  _finishStream(onComplete) {
    this.flushAll();
    this.stopFlush();

    // 构建 tool_calls 数组
    // arguments 保持为字符串（符合 OpenAI API 格式），executeTool 中会解析
    const toolCalls = [];
    if (this.toolCallsMap.size > 0) {
      for (const [, tc] of this.toolCallsMap) {
        toolCalls.push({
          id: tc.id,
          type: tc.type,
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments || "{}",
          },
        });
      }
    }

    onComplete(toolCalls.length > 0 ? toolCalls : []);
  }

  addToRenderBuffer(content) {
    this.renderBuffer += content;

    if (!this.isFlushing) {
      this.startFlush();
    }
  }

  startFlush() {
    this.isFlushing = true;
    this.flushInterval = setInterval(() => {
      this.flushChunk();
    }, 50);
  }

  stopFlush() {
    this.isFlushing = false;
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  flushChunk() {
    if (this.renderBuffer.length === 0) {
      return;
    }

    const chunkSize = Math.min(8, this.renderBuffer.length);
    const chunk = this.renderBuffer.substring(0, chunkSize);
    this.renderBuffer = this.renderBuffer.substring(chunkSize);

    if (this.currentOnChunk) {
      this.currentOnChunk(chunk);
    }
  }

  flushAll() {
    while (this.renderBuffer.length > 0) {
      this.flushChunk();
    }
  }

  abort() {
    this.stopFlush();
    if (this.abortController) {
      this.abortController.abort();
    }
  }

  reset() {
    this.stopFlush();
    this.sseBuffer = "";
    this.renderBuffer = "";
    this.textDecoder = new TextDecoder("utf-8", { stream: true });
    this.abortController = null;
    this.isFlushing = false;
    this.currentOnChunk = null;
    this.toolCallsMap = new Map();
  }
}

export default new StreamParser();
