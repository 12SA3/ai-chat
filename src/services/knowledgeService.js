/**
 * Phase 1 知识库服务
 * 基于关键词匹配的文档检索 + prompt 注入
 * 零外部依赖，纯内存存储
 */

class KnowledgeService {
  constructor() {
    /**
     * 文档存储: 每个文档 { id, title, content, chunks }
     * chunks: 按段落分块后的文本数组
     */
    this.documents = [];
  }

  /**
   * 加载文档并分块
   * @param {string} title - 文档标题
   * @param {string} rawText - 文档原始文本
   * @param {number} chunkSize - 每块最大字符数，默认 500
   * @returns {{ id: string, chunksCount: number }}
   */
  loadDocument(title, rawText, chunkSize = 500) {
    const paragraphs = rawText.split(/\n\n+/).filter((p) => p.trim());
    const chunks = [];

    for (const para of paragraphs) {
      const trimmed = para.trim();
      if (trimmed.length <= chunkSize) {
        chunks.push(trimmed);
      } else {
        // 按句子切分长段落
        const sentences =
          trimmed.match(/[^。！？.!?\n]+[。！？.!?\n]?/g) || [];
        let current = "";
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

    const id = Date.now().toString();
    this.documents.push({
      id,
      title,
      content: rawText,
      chunks,
    });

    console.log(
      `[KnowledgeBase] 已加载文档: "${title}" (${chunks.length} 个分块)`
    );
    return { id, chunksCount: chunks.length };
  }

  /**
   * 将查询字符串拆分为可匹配的词元
   * 支持中文（bigram + 单字）和英文（按空格分词）
   * @param {string} text
   * @returns {string[]}
   */
  _tokenize(text) {
    const tokens = [];

    // 按空格和标点分割，处理中英混合
    const segments = text.split(/[\s,，。！？、；：""''（）\(\)\[\]{}…—\-/]+/).filter(s => s.length > 0);

    for (const seg of segments) {
      // 判断是否为纯中文（含中文标点）
      const hasChinese = /[一-鿿]/.test(seg);

      if (hasChinese) {
        // 中文: 先做 bigram (两字词)，再补单字
        const chars = seg.split('');
        for (let i = 0; i < chars.length - 1; i++) {
          tokens.push(chars[i] + chars[i + 1]);
        }
        // 单字也加入（提高覆盖率）
        for (const ch of chars) {
          tokens.push(ch);
        }
      } else {
        // 英文/数字: 直接作为词元
        if (seg.length >= 2) {
          tokens.push(seg);
        }
      }
    }

    // 去重
    return [...new Set(tokens)];
  }

  /**
   * 关键词匹配检索
   * @param {string} query - 用户查询
   * @param {number} topK - 返回最相关的前 K 个结果
   * @returns {Array<{ docId, title, chunkIndex, content, score }>}
   */
  search(query, topK = 3) {
    if (this.documents.length === 0) return [];

    const queryLower = query.toLowerCase();
    const tokens = this._tokenize(queryLower);

    // 额外保留完整查询短语用于精确匹配
    const queryPhrases = queryLower
      .split(/[，。！？、；：\n]+/)
      .filter((p) => p.trim().length >= 3)
      .map((p) => p.trim());

    const scored = [];

    for (const doc of this.documents) {
      for (let i = 0; i < doc.chunks.length; i++) {
        const chunk = doc.chunks[i];
        const chunkLower = chunk.toLowerCase();

        let score = 0;

        // 1. 精确短语匹配 — 权重最高
        for (const phrase of queryPhrases) {
          if (chunkLower.includes(phrase)) {
            score += 5;
          }
        }
        // 完整查询匹配也给高分
        if (queryLower.length >= 3 && chunkLower.includes(queryLower)) {
          score += 5;
        }

        // 2. 词元匹配 — 每个匹配到的词元加 1 分
        for (const token of tokens) {
          if (chunkLower.includes(token)) {
            score += 1;
          }
        }

        // 3. 标题匹配加权
        if (doc.title.toLowerCase().includes(queryLower)) {
          score += 2;
        }

        if (score > 0) {
          scored.push({
            docId: doc.id,
            title: doc.title,
            chunkIndex: i,
            content: chunk,
            score,
          });
        }
      }
    }

    return scored.sort((a, b) => b.score - a.score).slice(0, topK);
  }

  /**
   * 根据查询构建上下文文本
   * @param {string} query - 用户查询
   * @param {number} topK - 检索数量
   * @returns {string|null} 拼接好的上下文字符串，无结果时返回 null
   */
  buildContext(query, topK = 3) {
    const results = this.search(query, topK);
    if (results.length === 0) return null;

    return results
      .map(
        (r, i) =>
          `[参考资料${i + 1} — 来自《${r.title}》，相关度: ${Math.round(r.score)}分]\n${r.content}`
      )
      .join("\n\n---\n\n");
  }

  /**
   * 构建包含检索结果的完整 system prompt
   * @param {string} query - 用户原始问题
   * @param {number} topK - 检索数量
   * @returns {string|null} system prompt 文本
   */
  buildSystemPrompt(query, topK = 3) {
    const context = this.buildContext(query, topK);

    const basePrompt = [
      '你是小土的私人助手，你非常了解小土的一切。',
      '请根据下面的参考资料回答用户关于小土的问题。',
      '如果参考资料中确实完全没有相关信息，才可以说你不知道——但大多数情况下资料里都有线索。'
    ].join(' ');

    if (context) {
      return `${basePrompt}\n\n## 参考资料\n${context}`;
    }

    return `${basePrompt}\n\n（今天知识库好像出了点问题，没有找到相关记录。可能是文件还没加载。）`;
  }

  /**
   * 移除指定文档
   * @param {string} id - 文档 ID
   */
  removeDocument(id) {
    const index = this.documents.findIndex((d) => d.id === id);
    if (index !== -1) {
      const title = this.documents[index].title;
      this.documents.splice(index, 1);
      console.log(`[KnowledgeBase] 已移除文档: "${title}"`);
      return true;
    }
    return false;
  }

  /**
   * 获取知识库摘要信息
   */
  getStats() {
    const totalChunks = this.documents.reduce(
      (sum, doc) => sum + doc.chunks.length,
      0
    );
    return {
      documentCount: this.documents.length,
      totalChunks,
      documents: this.documents.map((d) => ({
        id: d.id,
        title: d.title,
        chunksCount: d.chunks.length,
      })),
    };
  }

  /**
   * 列出所有文档标题，用于验证
   */
  listDocuments() {
    return this.documents.map((d) => ({
      id: d.id,
      title: d.title,
      chunksCount: d.chunks.length,
    }));
  }
}

// 单例导出
const knowledgeService = new KnowledgeService();
export default knowledgeService;
