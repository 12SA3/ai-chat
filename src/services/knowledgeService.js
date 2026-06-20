/**
 * Phase 2 知识库服务 — LanceDB 向量存储 + 哈希嵌入
 *
 * 相比 Phase 1 的改进：
 *   1. 向量语义搜索替代纯关键字匹配
 *   2. LanceDB 持久化存储，重启数据不丢失
 *   3. 对外 API 保持不变，内部实现可替换
 *
 * 嵌入策略：哈希 n-gram 投影到固定维度稠密向量
 *   类似 Random Indexing / SimHash，用字面重叠近似语义相似度。
 *   当讯飞 Embedding API 可用时，只需替换 embed() 函数即可升级为真实语义检索。
 */

import { connect, makeArrowTable } from '@lancedb/lancedb';
import https from 'https';
import path from 'path';

// ─── 配置 ──────────────────────────────────────────────────

const VECTOR_DIM = 256;         // 向量维度
const DATA_DIR = './data/knowledge-base';  // LanceDB 数据目录
const ROUGH_RECALL = 12;        // 粗排召回数量（后续精排筛选）
const RERANK_MODEL = 'xop35qwen2b'; // 精排用模型（与对话相同）

// ─── 哈希嵌入函数 ──────────────────────────────────────────

/**
 * 将文本转为固定维度稠密向量
 * 核心思路：对文本中每个 2-gram 做哈希映射到向量中的某个位置并累加，最后归一化。
 * 这样相似文本会产生余弦距离相近的向量。
 *
 * 当接入真实 Embedding API 时，只需替换此函数。
 */
function embed(text) {
  const vec = new Array(VECTOR_DIM).fill(0);

  // 提取 1-gram 和 2-gram（兼容中英文）
  const normalized = text.toLowerCase().replace(/[^\w一-鿿]/g, '');
  const ngrams = [];

  // 单字
  for (let i = 0; i < normalized.length; i++) {
    ngrams.push(normalized[i]);
  }
  // bigram
  for (let i = 0; i < normalized.length - 1; i++) {
    ngrams.push(normalized[i] + normalized[i + 1]);
  }

  if (ngrams.length === 0) return vec;

  // 哈希映射到向量维度
  for (const ng of ngrams) {
    let hash = 0;
    for (let i = 0; i < ng.length; i++) {
      hash = ((hash << 5) - hash + ng.charCodeAt(i)) | 0;
    }
    const idx = Math.abs(hash) % VECTOR_DIM;
    vec[idx] += 1;
  }

  // L2 归一化
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  if (norm > 0) {
    for (let i = 0; i < VECTOR_DIM; i++) vec[i] /= norm;
  }

  return vec;
}

// ─── 知识库服务类 ──────────────────────────────────────────

class KnowledgeService {
  constructor() {
    this.db = null;
    this.table = null;
    this.initialized = false;
  }

  /**
   * 初始化 LanceDB 连接和表
   * 在服务器启动时调用一次
   */
  async init() {
    if (this.initialized) return;

    const dbPath = path.resolve(DATA_DIR);
    this.db = await connect(dbPath);
    console.log(`[KnowledgeBase] LanceDB 已连接: ${dbPath}`);

    // 尝试打开已存在的表
    try {
      this.table = await this.db.openTable('chunks');
      const count = await this.table.countRows();
      console.log(`[KnowledgeBase] 已有 ${count} 个分块`);
      this.initialized = true;
    } catch {
      // 表不存在，等 loadDocument 时创建
      console.log('[KnowledgeBase] 新知识库，等待文档加载');
      this.initialized = true;
    }
  }

  /**
   * 设置精排器：传入 API Key 启用 LLM Re-rank
   * @param {string} apiKey - 讯飞 MaaS API Key
   */
  setReranker(apiKey) {
    this.apiKey = apiKey;
    console.log('[KnowledgeBase] LLM Re-rank 已启用');
  }

  /**
   * LLM Cross-encoder 精排
   * 将所有候选分块打包成一个请求，让模型给每条打分（0-10）
   * @param {string} query - 用户问题
   * @param {Array} candidates - 粗排召回的分块
   * @returns {Promise<Array>} 重新排序后的分块（附带 llmScore）
   */
  async _rerankWithLLM(query, candidates) {
    if (!this.apiKey || candidates.length === 0) return candidates;

    // 构建评分 prompt
    const itemsText = candidates
      .map((c, i) => `[${i}] ${c.content.substring(0, 300)}`)
      .join('\n\n');

    const prompt = [
      '你的任务是评估每段参考资料与用户问题的相关性。',
      '给每段资料打分（0-10分）：',
      '  10 = 直接回答了问题，包含关键信息',
      '  5  = 部分相关，涉及同一主题但未直接回答',
      '  0  = 完全不相关',
      '',
      `用户问题：${query}`,
      '',
      '参考资料：',
      itemsText,
      '',
      '请按以下格式输出（每行一个，只输出分数不要解释）：',
      '[0] 分数',
      '[1] 分数',
      '...',
    ].join('\n');

    try {
      const response = await this._callChatAPI(prompt);

      // 解析模型返回的分数
      const scores = [];
      const lines = response.split('\n');
      for (const line of lines) {
        const match = line.match(/\[(\d+)\]\s*(\d+(?:\.\d+)?)/);
        if (match) {
          scores[parseInt(match[1])] = parseFloat(match[2]);
        }
      }

      // 将 LLM 分数合并到候选结果
      const reranked = candidates.map((c, i) => ({
        ...c,
        vectorScore: c.score,
        llmScore: scores[i] !== undefined ? scores[i] : 0,
        score: scores[i] !== undefined ? scores[i] / 10 : c.score,
      }));

      // 按 LLM 分数降序排列
      reranked.sort((a, b) => b.llmScore - a.llmScore);

      console.log(
        `[Re-rank] ${candidates.length} 条 → LLM 精排，Top-3 分数: ${reranked.slice(0, 3).map(r => r.llmScore).join(', ')}`
      );

      return reranked;
    } catch (err) {
      console.error('[Re-rank] LLM 调用失败，降级为粗排结果:', err.message);
      return candidates;
    }
  }

  /**
   * 调用讯飞 Chat API（用于 Re-rank 评分）
   */
  _callChatAPI(userContent) {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({
        model: RERANK_MODEL,
        messages: [{ role: 'user', content: userContent }],
        max_tokens: 200,
        temperature: 0,
        stream: false,
      });

      const options = {
        hostname: 'maas-api.cn-huabei-1.xf-yun.com',
        port: 443,
        path: '/v2/chat/completions',
        method: 'POST',
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const content = json.choices?.[0]?.message?.content || '';
            resolve(content);
          } catch (e) {
            reject(new Error('Re-rank API 响应解析失败'));
          }
        });
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Re-rank API 超时'));
      });

      req.write(body);
      req.end();
    });
  }

  /**
   * 向量粗排（原 search 逻辑）
   */
  async _vectorSearch(queryVec, limit = ROUGH_RECALL) {
    if (!this.table) return [];

    const results = await this.table.search(queryVec).limit(limit).toArray();

    return results.map((r) => ({
      docId: r.doc_id,
      title: r.title,
      chunkIndex: r.chunk_index,
      content: r.content,
      score: Math.max(0, 1 - (r._distance || 0) / 2),
    }));
  }

  /**
   * 分块：按段落 + 句子分割
   */
  _chunkText(text, chunkSize = 500) {
    const paragraphs = text.split(/\n\n+/).filter((p) => p.trim());
    const chunks = [];

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length <= chunkSize) {
        chunks.push(trimmed);
      } else {
        const sentences =
          trimmed.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || [];
        let current = '';
        for (const s of sentences) {
          if ((current + s).length > chunkSize && current) {
            chunks.push(current.trim());
            current = s;
          } else {
            current += s;
          }
        }
        if (current.trim()) chunks.push(current.trim());
      }
    }

    return chunks;
  }

  /**
   * 加载文档：分块 → 向量化 → 写入 LanceDB
   * @returns {{ id: string, chunksCount: number }}
   */
  async loadDocument(title, rawText) {
    const chunks = this._chunkText(rawText);
    const id = Date.now().toString();

    // 为每个分块生成向量
    const rows = chunks.map((content, i) => ({
      doc_id: id,
      title,
      chunk_index: i,
      content,
      vector: embed(content),
    }));

    // 创建或追加到表
    if (!this.table) {
      this.table = await this.db.createTable('chunks', makeArrowTable(rows));
    } else {
      await this.table.add(makeArrowTable(rows));
    }

    console.log(
      `[KnowledgeBase] 已加载: "${title}" → ${chunks.length} 个分块`
    );
    return { id, chunksCount: chunks.length };
  }

  /**
   * 两阶段检索：粗排（向量）→ 精排（LLM Cross-encoder）→ Top-K
   * @param {string} query - 查询文本
   * @param {number} topK - 最终返回数量
   * @returns {Promise<Array>}
   */
  async search(query, topK = 3) {
    if (!this.table) return [];

    const queryVec = embed(query);

    try {
      // ── Stage 1: 粗排 — 向量召回 ──
      const candidates = await this._vectorSearch(queryVec, ROUGH_RECALL);
      if (candidates.length === 0) return [];

      // ── Stage 2: 精排 — LLM Cross-encoder 打分 ──
      const reranked = this.apiKey
        ? await this._rerankWithLLM(query, candidates)
        : candidates;

      if (this.apiKey) {
        console.log(
          `[RAG] 两阶段检索: 粗排${candidates.length}条 → 精排 → 返回Top-${topK}`
        );
      }

      return reranked.slice(0, topK);
    } catch (err) {
      console.error('[KnowledgeBase] 搜索出错:', err.message);
      return [];
    }
  }

  /**
   * 构建上下文字符串
   */
  async buildContext(query, topK = 3) {
    const results = await this.search(query, topK);
    if (results.length === 0) return null;

    return results
      .map(
        (r, i) =>
          `[参考资料${i + 1} — 来自《${r.title}》，相关度: ${(r.score * 100).toFixed(0)}%]\n${r.content}`
      )
      .join('\n\n---\n\n');
  }

  /**
   * 构建 system prompt
   */
  async buildSystemPrompt(query, topK = 3) {
    const context = await this.buildContext(query, topK);

    const basePrompt = [
      '你是小土的私人助手，你非常了解小土的一切。',
      '请根据下面的参考资料回答用户关于小土的问题。',
      '如果参考资料中确实完全没有相关信息，才可以说你不知道——但大多数情况下资料里都有线索。',
    ].join(' ');

    if (context) {
      return `${basePrompt}\n\n## 参考资料\n${context}`;
    }

    return `${basePrompt}\n\n（今天知识库好像出了点问题，没有找到相关记录。可能是文件还没加载。）`;
  }

  /**
   * 移除文档的所有分块
   */
  async removeDocument(docId) {
    if (!this.table) return false;
    await this.table.delete(`doc_id = "${docId}"`);
    console.log(`[KnowledgeBase] 已移除文档: ${docId}`);
    return true;
  }

  /**
   * 获取统计信息
   */
  async getStats() {
    if (!this.table) {
      return { documentCount: 0, totalChunks: 0, documents: [] };
    }

    const count = await this.table.countRows();
    // 统计不重复文档
    const results = await this.table
      .search(Array(VECTOR_DIM).fill(0))
      .limit(Math.min(count, 1000))
      .toArray();

    const docIds = new Set(results.map((r) => r.doc_id));
    const titleMap = {};
    for (const r of results) {
      if (!titleMap[r.doc_id]) {
        titleMap[r.doc_id] = { id: r.doc_id, title: r.title, chunksCount: 0 };
      }
      titleMap[r.doc_id].chunksCount++;
    }

    return {
      documentCount: docIds.size,
      totalChunks: count,
      documents: Object.values(titleMap),
    };
  }

  /**
   * 列出文档摘要
   */
  async listDocuments() {
    const stats = await this.getStats();
    return stats.documents;
  }
}

// 单例
const knowledgeService = new KnowledgeService();
export default knowledgeService;
