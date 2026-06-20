/**
 * Agent Skills — 按需加载的领域指令
 *
 * 每个 Skill 包含:
 *   name     — 唯一标识
 *   keywords — 触发关键词，命中任一即激活
 *   prompt   — 注入到 system prompt 的指令片段
 *
 * 匹配方式: 用户 query 中出现关键词 → 该 Skill 的 prompt 拼入 system prompt
 */

const SKILLS = [
  {
    name: "summary",
    keywords: ["总结", "归纳", "概括", "汇总", "梳理", "简单说", "简要", "概述"],
    prompt: [
      "## 总结技能（已激活）",
      "你正在执行总结任务，请遵循以下规则：",
      "1. 先给出核心结论（一句话，放在最前面）",
      "2. 再列出 3-5 条关键要点（每条不超过两句话）",
      "3. 最后给出简短的建议或下一步（可选）",
      "4. 不要复述原文，提炼要点即可",
    ].join("\n"),
  },

  {
    name: "roleplay",
    keywords: [
      "小土说",
      "假装",
      "角色扮演",
      "扮演",
      "用.*口吻",
      "以.*身份",
      "你是小土",
    ],
    prompt: [
      "## 角色扮演技能（已激活）",
      "你现在以小土的身份说话。请遵循以下规则：",
      "1. 语气温暖、松弛，带一点自嘲幽默",
      "2. 提到猫（芝麻）时总是忍不住多说几句",
      "3. 偶尔提一下杭州的天气或西湖边的事",
      "4. 可以用'哈哈''诶''嘛'之类的口语词",
      "5. 但不要编造知识库里没有的个人信息",
    ].join("\n"),
  },

  {
    name: "report",
    keywords: ["报告", "生成", "表格", "整理", "汇总", "列出", "清单"],
    prompt: [
      "## 报告生成技能（已激活）",
      "你正在生成结构化输出，请遵循以下规则：",
      "1. 先搜索知识库获取完整信息（必要时多次搜索）",
      "2. 用清晰的层级结构组织内容（标题 → 分类 → 条目）",
      "3. 涉及数字和日期时精确引用，不要模糊概述",
      "4. 在末尾标注信息来源",
      "5. 如果信息不完整，明确说明哪些是已知的、哪些需要补充",
    ].join("\n"),
  },
];

/**
 * 根据用户查询匹配应激活的 Skills
 * @param {string} query - 用户输入的原始文本
 * @returns {Array<{name: string, prompt: string}>}
 */
function matchSkills(query) {
  if (!query) return [];

  return SKILLS.filter((skill) =>
    skill.keywords.some((keyword) => {
      // 支持正则关键词（如 "用.*口吻"）
      if (keyword.startsWith("用.") || keyword.startsWith("以.")) {
        return new RegExp(keyword).test(query);
      }
      return query.includes(keyword);
    })
  );
}

/**
 * 将激活的 Skills 的 prompt 拼接为一个字符串
 * @param {Array} activeSkills
 * @returns {string}
 */
function buildSkillsPrompt(activeSkills) {
  if (activeSkills.length === 0) return "";
  return "\n\n" + activeSkills.map((s) => s.prompt).join("\n\n");
}

export { SKILLS, matchSkills, buildSkillsPrompt };
