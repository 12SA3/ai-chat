import http from 'http';
import https from 'https';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import knowledgeService from './src/services/knowledgeService.js';

dotenv.config();

const API_KEY = process.env.XUNFEI_API_KEY;
const PORT = process.env.PORT || 3001;

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.statusCode = 200;
    res.end();
    return;
  }
  
  if (req.method === 'POST' && req.url === '/api/chat') {
    let body = '';
    
    req.on('data', (chunk) => {
      body += chunk;
    });
    
    req.on('end', async () => {
      try {
        const requestData = JSON.parse(body);
        const { messages, query, agentMode } = requestData;

        console.log(
          '收到请求:', query || '(无查询)',
          '| 消息数:', messages.length,
          agentMode ? '| [Agent]' : ''
        );

        // RAG 策略：
        // - Agent 模式：让 Agent 自主决定是否搜索知识库，不自动注入
        // - 普通模式：自动注入知识库上下文
        const systemPrompt = (!agentMode && query)
          ? knowledgeService.buildSystemPrompt(query)
          : null;
        if (systemPrompt) {
          console.log('[RAG] 已注入知识库上下文');
        } else if (agentMode) {
          console.log('[Agent] 工具由 Agent 自主调用');
        }

        handleStreamRequest(messages, res, systemPrompt);
      } catch (error) {
        console.error('解析请求体错误:', error);
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: '请求格式错误' }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/health') {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', message: 'AI Chat API is running' }));
  } else if (req.method === 'POST' && req.url === '/api/knowledge/load') {
    // 加载文档到知识库
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { title, content } = JSON.parse(body);
        const result = knowledgeService.loadDocument(title, content);
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, ...result }));
      } catch (error) {
        res.statusCode = 400;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: error.message }));
      }
    });
  } else if (req.method === 'GET' && req.url === '/api/knowledge/documents') {
    // 列出已加载的文档
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ documents: knowledgeService.listDocuments() }));
  } else if (req.method === 'GET' && req.url.startsWith('/api/knowledge/search')) {
    // 测试用: 直接搜索知识库 (GET /api/knowledge/search?q=关键词)
    const url = new URL(req.url, 'http://localhost');
    const q = url.searchParams.get('q') || '';
    const results = knowledgeService.search(q, 5);
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ query: q, results }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});

function handleStreamRequest(messages, res, systemPrompt = null) {
  // RAG/Agent: system prompt 由前端注入，这里只做兜底自动注入
  const apiMessages = systemPrompt
    ? [{ role: 'system', content: systemPrompt }, ...messages]
    : messages;

  const requestBody = {
    model: 'xop35qwen2b',
    messages: apiMessages,
    max_tokens: 4000,
    temperature: 0.7,
    stream: true
  };
  
  const options = {
    hostname: 'maas-api.cn-huabei-1.xf-yun.com',
    port: 443,
    path: '/v2/chat/completions',
    method: 'POST',
    timeout: 30000,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
      'User-Agent': 'Node.js-Client',
      'Accept': '*/*'
    }
  };
  
  console.log('发送到MaaS:', '模型:', requestBody.model, '| 消息数:', requestBody.messages.length, '| RAG:', !!systemPrompt);
  
  const maasReq = https.request(options, (maasRes) => {
    console.log('MaaS API 响应状态码:', maasRes.statusCode);
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    
    maasRes.pipe(res);
    
    maasRes.on('end', () => {
      console.log('响应结束');
    });
  });
  
  maasReq.on('error', (error) => {
    console.error('请求错误:', error);
    
    res.write(`data: {"error": "流式请求失败：${error.message}"} \n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  
  maasReq.on('timeout', () => {
    console.error('请求超时');
    maasReq.destroy();
    
    res.write(`data: {"error": "请求超时"} \n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  });
  
  maasReq.write(JSON.stringify(requestBody));
  maasReq.end();
  
  console.log('请求已发送');
}

server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);

  // 启动时自动加载知识库文档
  const knowledgeDir = path.join(process.cwd(), 'knowledge-base');
  if (fs.existsSync(knowledgeDir)) {
    const files = fs.readdirSync(knowledgeDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(knowledgeDir, file), 'utf-8');
        const title = file.replace('.md', '');
        knowledgeService.loadDocument(title, content);
        console.log(`[知识库] 已自动加载: ${file}`);
      } catch (err) {
        console.error(`[知识库] 加载失败: ${file}`, err.message);
      }
    }
  }
});
