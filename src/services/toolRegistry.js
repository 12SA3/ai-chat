/**
 * Agent 工具注册表
 * 定义模型可调用的工具及其执行函数
 */

/**
 * 工具定义数组 — OpenAI/讯飞兼容格式
 * 这些定义会在每次 API 请求时发送给模型
 */
const TOOLS = [
  {
    type: "function",
    function: {
      name: "get_current_time",
      description: "获取当前的日期和时间。当用户询问现在几点、今天几号、当前时间等问题时调用此工具。",
      parameters: {
        type: "object",
        properties: {
          timezone: {
            type: "string",
            description: "时区，如 'Asia/Shanghai'。默认为 'Asia/Shanghai'",
          },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calculator",
      description:
        "执行数学计算。支持加减乘除、括号、幂运算等。当用户需要计算时调用此工具，不要自己心算。",
      parameters: {
        type: "object",
        properties: {
          expression: {
            type: "string",
            description:
              "数学表达式字符串。支持的运算符：+ - * / ( ) ** 。例如: '2+3*4' '(100-20)/2' '2**10'",
          },
        },
        required: ["expression"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description:
        "在小土的知识库中搜索信息。当用户询问关于小土的任何问题（如她的个人信息、爱好、工作、经历等）时，必须先调用此工具搜索知识库，再根据搜索结果回答。不要凭记忆或猜测回答关于小土的问题。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "搜索关键词或自然语言问题，如 '小土的生日' '小土的工作' '小土的宠物'",
          },
        },
        required: ["query"],
      },
    },
  },
];

// ─── 工具执行函数 ────────────────────────────────────────

/**
 * 获取当前时间
 */
function getCurrentTime(args = {}) {
  const now = new Date();
  const options = {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "long",
    hour12: false,
  };
  return {
    datetime: now.toLocaleString("zh-CN", options),
    iso: now.toISOString(),
    timestamp: now.getTime(),
  };
}

/**
 * 安全计算数学表达式
 */
function calculate(args) {
  if (!args.expression) {
    return { error: "缺少表达式" };
  }

  const expr = args.expression;

  // 安全检查：只允许数字、运算符、括号、空格和小数点
  const sanitized = expr.replace(/\s+/g, "");
  if (!/^[0-9+\-*/().%^]+$/.test(sanitized)) {
    return { error: `表达式包含不允许的字符，仅支持数字和 + - * / ( ) ** %`, expression: expr };
  }

  try {
    // 将 ** (Python风格) 或 ^ 替换为 JS 的 **
    const jsExpr = sanitized.replace(/\^/g, "**");

    // eslint-disable-next-line no-eval
    const result = Function(`"use strict"; return (${jsExpr})`)();

    if (typeof result !== "number" || !isFinite(result)) {
      return { error: "计算结果不是有效数字", expression: expr };
    }

    return { expression: expr, result };
  } catch (e) {
    return { error: `计算错误: ${e.message}`, expression: expr };
  }
}

/**
 * 搜索知识库 — 通过调用后端 API
 */
async function searchKnowledgeBase(args = {}) {
  const query = args.query || "";
  if (!query.trim()) {
    return { error: "搜索关键词不能为空" };
  }

  try {
    const url = `http://localhost:3001/api/knowledge/search?q=${encodeURIComponent(query)}`;
    const response = await fetch(url);

    if (!response.ok) {
      return { error: `知识库搜索失败: HTTP ${response.status}` };
    }

    const data = await response.json();

    if (!data.results || data.results.length === 0) {
      return { message: "知识库中未找到相关信息", query };
    }

    return {
      query,
      totalResults: data.results.length,
      results: data.results.map((r) => ({
        title: r.title,
        chunkIndex: r.chunkIndex,
        score: r.score,
        content: r.content,
      })),
    };
  } catch (err) {
    return { error: `知识库连接失败: ${err.message}` };
  }
}

// ─── Agent System Prompt 生成 ────────────────────────────

/**
 * 构建 Agent 模式的 system prompt
 * 教模型用特定 JSON 格式输出函数调用，兼容不支持原生 tools 的 API
 */
function buildAgentSystemPrompt() {
  return [
    "你是一个具备工具调用能力的智能助手。",
    "",
    "## 可用工具",
    "当需要获取实时信息或进行计算时，你**必须**调用以下工具而不是猜测：",
    "",
    "1. **get_current_time** — 获取当前日期和时间",
    "   参数: {}",
    "",
    "2. **calculator** — 执行数学计算",
    "   参数: {\"expression\": \"数学表达式\"}",
    "   示例: {\"expression\": \"3600*24\"}",
    "",
    "3. **search_knowledge_base** — 搜索小土的知识库",
    "   参数: {\"query\": \"搜索关键词或问题\"}",
    "   关于小土的任何问题（个人信息、爱好、工作、经历等）**必须先调用此工具**",
    "",
    "## 调用格式",
    "当需要调用工具时，在回复中输出以下格式的 JSON（一行，单独成段）：",
    "",
    "{\"tool\": \"工具名\", \"args\": {参数对象}}",
    "",
    "例如：",
    "{\"tool\": \"get_current_time\", \"args\": {}}",
    "{\"tool\": \"calculator\", \"args\": {\"expression\": \"100*24\"}}",
    "{\"tool\": \"search_knowledge_base\", \"args\": {\"query\": \"小土的生日\"}}",
    "",
    "## 重要规则",
    "- 一次只能调用一个工具",
    "- 收到工具结果后，基于结果继续回答",
    "- 如果不需要调用工具就直接回答，不要输出 JSON",
    "- 不要编造或猜测工具才能提供的信息",
    "- 关于小土的问题，先搜索知识库再回答",
  ].join("\n");
}

// ─── 工具执行调度 ────────────────────────────────────────

/**
 * 根据工具名和参数执行工具，返回字符串结果
 * @param {string} name - 工具名称
 * @param {object} args - 工具参数
 * @returns {Promise<string>} JSON 字符串格式的结果
 */
async function executeTool(name, args = {}) {
  let parsedArgs = args;
  // 如果 args 是字符串，尝试解析
  if (typeof args === "string") {
    try {
      parsedArgs = JSON.parse(args);
    } catch {
      parsedArgs = {};
    }
  }

  let result;
  switch (name) {
    case "get_current_time":
      result = getCurrentTime(parsedArgs);
      break;
    case "calculator":
      result = calculate(parsedArgs);
      break;
    case "search_knowledge_base":
      result = await searchKnowledgeBase(parsedArgs);
      break;
    default:
      result = { error: `未知工具: ${name}` };
  }

  return typeof result === "string" ? result : JSON.stringify(result);
}

export { TOOLS, executeTool, buildAgentSystemPrompt };
