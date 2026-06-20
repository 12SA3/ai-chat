/**
 * Agent 长期记忆服务 — LanceDB 持久化 + 上下文管理
 *
 * 长期记忆:
 *   - LanceDB agent_memory 表存储用户偏好/事实/纠错
 *   - recall() 向量召回相关记忆
 *   - remember() 写入新记忆
 *
 * 上下文管理:
 *   - estimateTokens() 中英文字符数粗略估算 token 数
 *   - trimMessages() 滑动窗口截断
 */

import { connect, makeArrowTable } from "@lancedb/lancedb";
import path from "path";

// ─── 配置 ──────────────────────────────────────────────────

const DATA_DIR = "./data/knowledge-base"; // 与知识库共用 LanceDB 目录
const VECTOR_DIM = 256;

// ─── 哈希嵌入（与 knowledgeService 相同的实现）──────────────

function embed(text) {
  const vec = new Array(VECTOR_DIM).fill(0);
  const normalized = text.toLowerCase().replace(/[^\w一-鿿]/g, "");
  const ngrams = [];
  for (let i = 0; i < normalized.length; i++) ngrams.push(normalized[i]);
  for (let i = 0; i < normalized.length - 1; i++)
    ngrams.push(normalized[i] + normalized[i + 1]);
  for (const ng of ngrams) {
    let hash = 0;
    for (let i = 0; i < ng.length; i++)
      hash = ((hash << 5) - hash + ng.charCodeAt(i)) | 0;
    vec[Math.abs(hash) % VECTOR_DIM] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  return vec;
}

// ─── Token 估算（纯工具函数，前后端通用）────────────────────

/**
 * 粗略估算 messages 数组的 token 数
 * 中文约 1.5 字符/token，英文/代码约 4 字符/token
 */
function estimateTokens(messages) {
  let total = 0;
  for (const msg of messages) {
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = JSON.stringify(msg.content);
    } else if (msg.content) {
      text = String(msg.content);
    }

    const chineseChars = (text.match(/[一-鿿]/g) || []).length;
    const otherChars = text.length - chineseChars;
    total += Math.ceil(chineseChars / 1.5) + Math.ceil(otherChars / 4);
  }
  return total;
}

/**
 * 滑动窗口截断：保留 system prompt + 最近的 N 条消息
 * @param {Array} messages - API 格式的消息数组
 * @param {number} maxTokens - 对话历史可用 token 上限
 * @returns {Array} 截断后的消息数组
 */
function trimMessages(messages, maxTokens) {
  if (messages.length <= 2) return messages; // 太短不截

  const systemMsg = messages[0]; // system prompt 永远保留
  const history = messages.slice(1);
  const keep = [];
  let used = 0;

  // 从后往前保留（优先保留最近的消息）
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

// ─── 长期记忆服务 ──────────────────────────────────────────

class MemoryService {
  constructor() {
    this.db = null;
    this.table = null;
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return;

    const dbPath = path.resolve(DATA_DIR);
    this.db = await connect(dbPath);

    try {
      this.table = await this.db.openTable("agent_memory");
      const count = await this.table.countRows();
      console.log(`[Memory] 已有 ${count} 条长期记忆`);
    } catch {
      this.table = await this.db.createTable(
        "agent_memory",
        makeArrowTable([
          {
            id: "_init",
            type: "preference",
            key: "系统初始化",
            content: "记忆系统已启动",
            created_at: new Date().toISOString(),
            session_id: "_system",
            vector: embed("系统初始化"),
          },
        ])
      );
      // 删掉初始化占位行
      await this.table.delete('id = "_init"');
      console.log("[Memory] 记忆系统已初始化");
    }

    this.initialized = true;
  }

  /**
   * 召回与查询相关的记忆
   * @param {string} query - 用户当前输入
   * @param {number} limit - 召回数量
   * @returns {Promise<Array>}
   */
  async recall(query, limit = 5) {
    if (!this.table) return [];

    const queryVec = embed(query);

    try {
      const results = await this.table.search(queryVec).limit(limit).toArray();
      return results
        .filter((r) => r._distance < 1.5) // 过滤掉不相关的
        .map((r) => ({
          type: r.type,
          key: r.key,
          content: r.content,
          created_at: r.created_at,
        }));
    } catch (err) {
      console.error("[Memory] 召回失败:", err.message);
      return [];
    }
  }

  /**
   * 写入一条记忆
   */
  async remember(key, content, type = "preference", sessionId = "default") {
    if (!this.table) return false;

    const row = {
      id: `mem_${Date.now()}`,
      type,
      key,
      content,
      created_at: new Date().toISOString(),
      session_id: sessionId,
      vector: embed(`${key} ${content}`),
    };

    await this.table.add(makeArrowTable([row]));
    console.log(`[Memory] 已记住: [${type}] ${key}`);
    return true;
  }

  /**
   * 把召回的记忆格式化为 prompt 片段
   */
  buildMemoryPrompt(memories) {
    if (!memories || memories.length === 0) return "";

    const lines = ["", "## 关于用户的长期记忆", "以下是你之前记住的关于用户的信息，请在回答时参考："];
    for (const m of memories) {
      const typeTag = { preference: "偏好", fact: "事实", correction: "纠正" }[m.type] || m.type;
      lines.push(`- [${typeTag}] ${m.key}: ${m.content}`);
    }
    lines.push("", "请遵循以上用户偏好，并在合适时引用这些信息。");
    return lines.join("\n");
  }
}

const memoryService = new MemoryService();
export { memoryService, estimateTokens, trimMessages };
export default memoryService;
