# -*- coding: utf-8 -*-
"""
生成「蜜蜂信息采集」界面预览单文件。

做法：把真实的 public/style.css 和 public/app.js 内联进一个 HTML，
再用假数据顶替后端接口（mock fetch）。所以预览里跑的是真界面代码，
不是另画一张图——改了界面样式，重跑这个脚本预览就跟着变。

用法：python3 preview/make_preview.py
"""

import io
import os
import re
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'preview', '蜜蜂信息采集_界面预览.html')

NODE = r'C:\Users\Administrator\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'


def dump_ai_catalog():
    """直接问真代码要「7 个 AI + 6 个服务商」的目录，免得预览里的假数据和实际对不上"""
    js = "console.log(JSON.stringify(require('./src/ai').catalog()))"
    try:
        out = subprocess.run([NODE, '-e', js], cwd=ROOT, capture_output=True, timeout=30)
        return out.stdout.decode('utf-8').strip().splitlines()[-1]
    except Exception:
        return '{"tasks":[],"providers":[],"taskProviderChoices":[]}'


AI_CATALOG_JSON = dump_ai_catalog()

css = io.open(os.path.join(ROOT, 'public', 'style.css'), encoding='utf-8').read()
appjs = io.open(os.path.join(ROOT, 'public', 'app.js'), encoding='utf-8').read()
index = io.open(os.path.join(ROOT, 'public', 'index.html'), encoding='utf-8').read()

# 取 <body> 内容，去掉页面注入的 data-page-node-id 与外部脚本引用
body = re.search(r'<body[^>]*>(.*?)</body>', index, re.S).group(1)
body = re.sub(r'\s*data-page-node-id="[^"]*"', '', body)
body = re.sub(r'<script[^>]*src="/app\.js"[^>]*></script>', '', body)
body = re.sub(r'<!--pnid:[^>]*-->', '', body)
# 预览里默认展开「手动录入」面板，好把所有功能一次看全
body = body.replace('id="ingest" class="ingest hidden"', 'id="ingest" class="ingest"')

MOCK = r"""
/* ---------- 假后端：只是把接口换成写死的数据，界面逻辑一行没改 ---------- */

const CUSTOMERS = [
  {
    code: '1A00012', account_id: 1, wa_jid: '14155552671@c.us', phone: '14155552671',
    name: 'Daniel Brooks', region: '旧金山', timezone: 'America/Los_Angeles',
    stage_day: 4, pending: 1, channel: 'whatsapp',
    created_at: '2026-09-20T15:02:00Z', created_at_source: 'auto',
    last_body: 'She was 13. Best dog I ever had.',
    last_body_zh: '她 13 岁。我养过最好的狗。',
    last_msg_at: '2026-09-23T14:20:00Z',
    // 10 个附加字段（存 customers.profile_json）——预览里点「客户档案」能看到
    profile_json: JSON.stringify({
      '婚姻情况': '已婚，太太叫 Karen',
      '生活规律': '农场作息，天亮就起，晚上九点睡；下午常在谷仓忙',
      '别名': 'Dan',
      '老家家乡': '德州奥斯汀，十年前搬到加州',
      '爱好': '钓鱼、修旧皮卡、橄榄球',
      '职业': '农场主（种苹果 + 养鸡）',
      '家庭经济情况': '有稳定农场收入，对价格会算但舍得给狗花钱',
      '父母': '母亲住附近镇上，周末会来吃饭',
      '宠物': '一只 13 岁过世的拉布拉多，叫 Bella',
      '孩子': '两个孩子，大的上高中',
    }),
  },
  {
    code: '1A00013', account_id: 1, wa_jid: '14155553388@c.us', phone: '14155553388',
    name: 'Emily Chen', region: '西雅图', timezone: 'America/Los_Angeles',
    stage_day: 2, pending: 1, channel: 'whatsapp',
    created_at: '2026-09-22T18:00:00Z', created_at_source: 'auto',
    last_body: 'Do you ship to Seattle?',
    last_body_zh: '能寄到西雅图吗？',
    last_msg_at: '2026-09-23T11:05:00Z',
  },
  {
    code: '1A00007', account_id: 1, wa_jid: '14155559002@c.us', phone: '14155559002',
    name: 'Dio', region: '俄勒冈', timezone: 'America/Los_Angeles',
    stage_day: 2, pending: 0, channel: 'whatsapp',
    // 手动补的加入时间：他是三个月前就加了的，不是今天
    created_at: new Date(Date.now() - 88 * 86400000).toISOString(), created_at_source: 'manual',
    last_body: '我: 好，我醒了找你。晚安 Dio～',
    last_body_zh: '',
    last_msg_at: '2026-09-23T22:40:00Z',
  },
];

const MESSAGES = {
  '1A00012': [
    { id: 1, direction: 'in',  body: 'Hi, I saw your ad on Facebook', body_zh: '你好，我在 Facebook 上看到你的广告', msg_ts: '2026-09-20T15:02:00Z' },
    { id: 2, direction: 'out', body: 'hey! thanks for reaching out :)', body_zh: '', msg_ts: '2026-09-20T15:10:00Z' },
    { id: 3, direction: 'in',  body: 'I lost my golden retriever last month. Her name was Cooper.', body_zh: '我上个月失去了我的金毛。她叫 Cooper。', msg_ts: '2026-09-21T16:30:00Z' },
    { id: 4, direction: 'out', body: 'I am so sorry. I have a cat too — lost her two years ago.', body_zh: '', msg_ts: '2026-09-21T16:44:00Z' },
    { id: 5, direction: 'in',  body: 'She was 13. Best dog I ever had.', body_zh: '她 13 岁。我养过最好的狗。', msg_ts: '2026-09-23T14:20:00Z' },
  ],
  '1A00013': [
    { id: 1, direction: 'in',  body: 'How much for a 16x20?', body_zh: '16x20 多少钱？', msg_ts: '2026-09-22T18:00:00Z' },
    { id: 2, direction: 'out', body: '16x20 is $xxx, oil on canvas, about 3 weeks.', body_zh: '', msg_ts: '2026-09-22T18:20:00Z' },
    { id: 3, direction: 'in',  body: 'Do you ship to Seattle?', body_zh: '能寄到西雅图吗？', msg_ts: '2026-09-23T11:05:00Z' },
  ],
  '1A00007': [
    { id: 1, direction: 'in',  body: 'I live on a farm, I also have peaches, plums, and pears', body_zh: '我住在农场，还有桃子、李子和梨', msg_ts: '2026-09-22T21:30:00Z' },
    { id: 2, direction: 'out', body: 'Four kinds? that must be a lot of work in autumn', body_zh: '', msg_ts: '2026-09-22T21:35:00Z' },
    { id: 3, direction: 'in',  body: 'I really like orange cats. I have mice in my barn lol', body_zh: '我特别喜欢橘猫。我谷仓里有老鼠哈哈', msg_ts: '2026-09-22T22:10:00Z' },
    { id: 4, direction: 'out', body: 'Okay have a wonderful night. Text me when you wake up', body_zh: '', msg_ts: '2026-09-23T22:40:00Z' },
  ],
};

const ROUND_1 = {
  options: [
    { angle: 'empathy',  text: '13 岁，一整辈子都在你家。她叫什么名字？' },
    { angle: 'story',    text: '我懂这种感觉。我自己那只猫走的那年，我画了整整一个月才画完。' },
    { angle: 'curiosity',text: '她最喜欢的姿势是什么？我想先想想怎么构图。' },
  ],
  rationale: '他主动说了年龄和"最好的狗"——这是情绪出口，不是询价信号。现在接住情绪比谈画更重要。',
  riskFlags: ['不要在这句提价格', '不要说 I understand how you feel 这类套话'],
};

const ROUND_2 = {
  options: [
    { angle: 'share',   text: '我们家哆咪也是这样，走之前那几天一直趴在画室门口。' },
    { angle: 'curiosity', text: '你手机里有没有她趴在阳光里那种照片？那种最好画。' },
    { angle: 'reassure', text: '不着急。你想好了再给我照片，我可以先画个草图给你看。' },
  ],
  rationale: '上一轮偏共情，你说太早了。这次换成分享 + 具体动作，把话题从情绪引到照片上。',
  riskFlags: [],
};

let suggestionSeq = 100;

function route(path, body) {
  if (path === '/api/state') {
    return {
      accounts: [
        { id: 1, label: '1号 · 主号', enabled: true, status: 'online' },
        { id: 2, label: '2号', enabled: false, status: 'offline' },
      ],
      pending: CUSTOMERS.filter((c) => c.pending).length,
      driver: 'better-sqlite3',
      ai: {
        receive: { provider: '', model: '', ready: true, noAi: true },
        translate: { provider: 'hunyuan', model: 'hy3', ready: true },
        extract: { provider: 'hunyuan', model: 'hy3', ready: true },
        suggest: { provider: 'hunyuan', model: 'hy3', ready: true },
        vision: { provider: "vision", model: "hy-vision-2.0-instruct", ready: true },
        asr: { provider: "audio", model: "FunAudioLLM/SenseVoiceSmall", ready: false },
        video: { provider: "vision", model: "hy-vision-2.0-instruct", ready: true },
        translateReply: { provider: "gpt", model: "gpt-4o-mini", ready: true },
      },
    };
  }
  if (path === '/api/customers') return CUSTOMERS;
  if (path === '/api/stats/today') {
    // 左栏顶部「今日消息」提示窗的假数据
    return {
      date: new Date().toISOString().slice(0, 10),
      received: 7, handled: 4, todo: 3, sent: 2,
      byAccount: { 1: 4, 2: 2, 3: 1 },
    };
  }
  if (path === '/api/learned') {
    return {
      learned: [],
      rejected: [],
      stats: { learned: 12, rejected: 5 },
    };
  }
  if (path === '/api/suggestion/adopt') {
    return { ok: true, dedup: false, id: 1, stats: { learned: 13, rejected: 5 } };
  }
  if (path === '/api/suggestion/reject') {
    suggestionSeq += 1;
    return Object.assign({}, ROUND_2, {
      suggestionId: suggestionSeq,
      attempt: (body.attempt || 0) + 1,
      angles: ['share', 'curiosity', 'reassure'],
      day: { day: 4, source: 'auto', signals: [{ key: 'motive', label: '说出动机或场景' }] },
      knowledge: { always: ['persona.md'], matched: ['stories.md'] },
    });
  }
  if (path === '/api/manual') {
    return { ok: true, code: '1A00014', isNew: true, count: 3, customer: CUSTOMERS[0] };
  }

  let m = /^\/api\/customer\/([A-Z0-9]+)$/.exec(path);
  if (m) {
    const c = CUSTOMERS.find((x) => x.code === m[1]);
    if (!c) return { error: '客户不存在' };
    return {
      customer: c,
      messages: MESSAGES[m[1]] || [],
      duplicates: [],
      docFile: `data/customers/${c.name}_${c.region}_${c.code}.md`,
    };
  }

  m = /^\/api\/customer\/([A-Z0-9]+)\/extract$/.exec(path);
  if (m) {
    const c = CUSTOMERS.find((x) => x.code === m[1]);
    if (!c) return { error: '客户不存在' };
    // 假抽取：只补 6 字段（姓名/电话/地区/时区/阶段/加入时间），不碰任何附加资料
    return { ok: true, profile: {}, docFile: `data/customers/${c.name}_${c.region}_${c.code}.md` };
  }

  m = /^\/api\/customer\/([A-Z0-9]+)\/suggest$/.exec(path);
  if (m) {
    suggestionSeq += 1;
    return Object.assign({}, ROUND_1, {
      suggestionId: suggestionSeq,
      attempt: 0,
      angles: ['empathy', 'story', 'curiosity'],
      day: { day: 4, source: 'auto', signals: [{ key: 'motive', label: '说出动机或场景' }, { key: 'photo', label: '发来照片 / 聊作品' }] },
      knowledge: { always: ['persona.md', 'redlines.md', 'playbook7d.md'], matched: ['stories.md'] },
    });
  }

  m = /^\/api\/customer\/([A-Z0-9]+)\/(profile|replied)$/.exec(path);
  if (m) return { ok: true };

  if (path === '/api/translate') {
    const n = Number(body.count) || 2;
    const prov = body.provider === 'gpt' ? 'gpt' : 'hunyuan';
    const model = prov === 'gpt' ? 'gpt-4o-mini' : 'hy3';
    const versions = [
      { text: `Hey ${body.text} (EN v1 — casual, friend tone)`, note: '更口语，像朋友微信聊天' },
      { text: `So ${body.text} (EN v2 — shorter)`, note: '更短，留白让他接话' },
    ];
    if (n >= 3) versions.push({ text: `Hi! ${body.text} (EN v3 — warmer)`, note: '更暖，带点温度' });
    return {
      ok: true, provider: prov, model, versions,
      tip: '客户是 Daniel，金毛刚过世——这句别太轻快，先接住他的情绪再自然带出画。',
    };
  }

  // AI 设置弹窗（预览是静态的，给一份能看的示例数据；真机上读的是 config.yaml）
  if (path === '/api/ai/config' && !(o && o.body)) {
    const prov = (cn, baseUrl, model, hasKey) => ({ baseUrl, model, hasKey, keyHint: hasKey ? '•••• 1234' : '', type: 'openai_compatible' });
    return {
      file: 'config.yaml',
      providers: {
        hunyuan: prov('混元', 'https://tokenhub.tencentmaas.com/v1', 'hy3', true),
        gpt: prov('GPT', 'https://api.openai.com/v1', 'gpt-4o-mini', true),
        anthropic: prov('Claude', 'https://api.anthropic.com/v1', 'claude-sonnet-4-5', false),
        deepseek: prov('DeepSeek', 'https://api.deepseek.com/v1', 'deepseek-v4-flash', false),
        vision: prov('视觉', '', 'hy-vision-2.0-instruct', false),
        audio: prov('听觉', 'https://api.siliconflow.cn/v1', 'FunAudioLLM/SenseVoiceSmall', true),
      },
      tasks: {
        receive: { provider: '', model: '', ready: true, noAi: true },
        translate: { provider: 'hunyuan', model: 'hy3', ready: true },
        suggest: { provider: 'hunyuan', model: 'hy3', ready: true },
        translateReply: { provider: 'gpt', model: 'gpt-4o-mini', ready: true },
        vision: { provider: 'vision', model: 'hy-vision-2.0-instruct', ready: true },
        asr: { provider: 'audio', model: 'FunAudioLLM/SenseVoiceSmall', ready: true },
        video: { provider: 'vision', model: 'hy-vision-2.0-instruct', ready: false },
        extract: { provider: 'hunyuan', model: 'hy3', ready: true },
      },
      taskState: {
        receive: { provider: '', model: '', ready: true, noAi: true, reason: null, wired: true, fixed: '' },
        translate: { provider: 'hunyuan', model: 'hy3', ready: true, reason: null, wired: true, fixed: '' },
        suggest: { provider: 'hunyuan', model: 'hy3', ready: true, reason: null, wired: true, fixed: '' },
        translateReply: { provider: 'gpt', model: 'gpt-4o-mini', ready: true, reason: null, wired: true, fixed: 'gpt' },
        vision: { provider: 'vision', model: 'hy-vision-2.0-instruct', ready: true, reason: null, wired: true, fixed: '' },
        asr: { provider: 'audio', model: 'FunAudioLLM/SenseVoiceSmall', ready: true, reason: null, wired: true, fixed: '' },
        video: { provider: 'vision', model: 'hy-vision-2.0-instruct', ready: false, reason: null, wired: false, fixed: '' },
        extract: { provider: 'hunyuan', model: 'hy3', ready: true, reason: null, wired: true, fixed: '' },
      },
      catalog: __AI_CATALOG_JSON__,
    };
  }

  // 提示词弹窗：真机是后端从 src/ai.js 现取；预览是静态的，放两条示意
  if (path === '/api/ai/prompts') {
    return {
      file: 'config.yaml',
      sample: {},
      tasks: [
        {
          key: 'receive', cn: '接收信息', when: '客户每发来一条新消息时（账号连上 WhatsApp 之后）。',
          where: 'src/main.js · handleMessage() → src/db.js', fixed: '', wired: true, noAi: true,
          providerCn: '不需要 AI', model: '', ready: true,
          userLabel: '—（程序自己处理，不发给任何模型）',
          system: '（这一步没有提示词 —— 接收信息不调用 AI）',
          user: '（不调用 AI）进来的是两样东西：① 客户发来的消息本体（文字 / 图片 / 语音 / 视频）；② 发送方号码，用来绑客户编号。',
          output: '消息落进本地库（方向 / 时间 / 渠道 / 有没有媒体）→ 左栏立刻出现这条新消息、未读 +1',
          notes: ['（预览里只放了示意内容；真机上点开是全部 7 个 AI + 真提示词）',
                  '【不看语种】中文、英文、表情、图片、语音一视同仁地收进来。',
                  '【中文不翻】要不要翻译是 ② 那一步的判断，本来就是中文的直接跳过、不花钱。',
                  '所以这一项不用配 API Key，状态永远是「已就绪」。'],
        },
        {
          key: 'translate', cn: '翻译收到的消息', when: '客户发来外文消息时。',
          where: 'src/ai.js · translate() / promptTranslate()', fixed: '', wired: true,
          providerCn: '混元 Hy3（腾讯 TokenHub）', model: 'hy3', ready: true,
          userLabel: '客户消息原文',
          system: '你是翻译器。把客户的英文消息译成自然的中文口语。\\n要求：保留原意与语气……只输出译文一行。',
          user: 'hi, is this still available?',
          output: '中文译文一行',
          notes: ['（预览里只放了示意内容；真机上点开是全部 7 个 AI + 真提示词）',
                  '先判语种再翻：本来就是中文的直接跳过不翻，不花钱。'],
          partsTitle: "②' 语种兜底提示词（只有中英混着写、正则拿不准时才发这一段）",
          parts: [{ label: "②' 语种兜底", text: '你只做一件事：判断这条客户消息要不要译成中文。\\n回 yes = 主要是外文（英文等），需要翻；回 no = 主要是中文，中国人一眼看得懂，不用翻。\\n只回一个词：yes 或 no。不要解释。' }],
        },
        {
          key: 'suggest', cn: '回复建议', when: '点中栏底部「⚡ 生成建议」时。',
          where: 'src/ai.js · suggest() / promptSuggest()', fixed: '', wired: true,
          providerCn: '混元 Hy3（腾讯 TokenHub）', model: 'hy3', ready: true,
          userLabel: '客户信息 + 档案 + 最近 20 条对话',
          system: '<<persona.md>>\\n# 人设与说话习惯\\n（知识库正文整段拼进来）\\n\\n（教练块：第几天 / 今天做什么 / 三个角度）\\n\\n你要替这位卖家想「中文回复建议」……只输出 JSON。',
          user: '客户：Daniel（编号 1A00001）地区：纽约　阶段：Day 2……',
          output: 'JSON：三条中文建议 + rationale + riskFlags',
          notes: ['（预览里只放了示意内容；真机上会显示 persona / redlines / templates / playbook7d 的全文）'],
          parts: [{ label: '① 知识库（persona / redlines / templates / playbook7d）', text: '（真机这里显示四个文件的正文）' },
                  { label: '② 教练块（第几天 / 今天做什么 / 三个角度）', text: '（真机这里显示 coach.js 现算的那一段）' }],
        },
      ],
    };
  }

  return { error: '预览模式没有这个接口：' + path };
}

window.fetch = async (u, o) => {
  const path = String(u || '').replace(/^https?:\/\/[^/]+/, '');
  let body = {};
  try { body = o && o.body ? JSON.parse(o.body) : {}; } catch (e) { body = {}; }
  const data = route(path, body);
  return { status: data.error ? 503 : 200, json: async () => data, text: async () => JSON.stringify(data) };
};

/* SSE 在预览里不需要，给个空壳免得报错 */
window.EventSource = class {
  constructor() {}
  addEventListener() {}
  close() {}
};
"""

BANNER = """
<div class="demo-banner">
  <b>界面预览</b>　跑的是真实的界面代码（内联了 style.css 与 app.js），后端接口换成写死的数据。
  所以这里的每一个按钮、气泡、档案卡，和真跑起来一模一样——只是数据是假的。
  <div class="muted" style="margin-top:4px">
    本次改动两处：<b>① 左栏客户行</b>——行里不再有任何按钮，整行点哪儿都是"打开这个客户"；
    <b>② 中栏头部右端</b>——「客户档案」+「从对话里提取档案」两个按钮**上下叠放**在客户名那一行右边的空白处，
    档案条末尾原来那个重复的「客户档案 ↗」已经删掉。
  </div>
  <div class="muted" style="margin-top:4px">
    已自动打开 Daniel Brooks 并出好三条建议。点中栏头部右边的「客户档案」看档案弹窗，点「从对话里提取档案」看抽取效果，点「不要这条」看换思路，点「采纳」看记忆面板，点任意一条建议上的「翻译」看英文口语弹窗（按客户信息调口吻，可切 GPT）。
    左侧切到 <b>Dio</b>：他的加入时间是<b>手填</b>的（认识第 89 天），档案里能看到「要避开的雷」那条纪律。
    切到 <b>Emily Chen</b>：只有部分字段有值，没问出来的一律留空——不编。
  </div>
</div>
"""

# 演示模式：自动打开第一个客户并出建议，一眼看全；再自动点一条建议的「翻译」演示英文弹窗
AUTO = """
setTimeout(function () {
  if (typeof openCustomer === 'function') openCustomer('1A00012');
}, 500);
setTimeout(function () {
  var b = document.getElementById('btn-suggest');
  if (b && typeof generateSuggest === 'function') generateSuggest();
}, 1200);
setTimeout(function () {
  var t = document.querySelector('#suggest-out .tr');
  if (t) t.click();
  var go = document.getElementById('tr-count');
  if (go) { go.value = '3'; }
  var btn = document.getElementById('tr-go');
  if (btn) btn.click();
}, 2200);
"""

# 把 AI 目录塞进假后端
MOCK = MOCK.replace('__AI_CATALOG_JSON__', AI_CATALOG_JSON)

html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>蜜蜂信息采集 · 界面预览</title>
<style>
{css}

/* 预览页专属：顶部说明条 */
.demo-banner {{
  background: #fff8e6;
  border-bottom: 1px solid #f0dca8;
  color: #7a5a10;
  padding: 8px 16px;
  font-size: 12px;
  line-height: 1.7;
}}
.demo-banner .muted {{ color: #9a7b3a; }}
</style>
</head>
<body>
{BANNER}
{body}
<script>
{MOCK}
</script>
<script>
{appjs}
</script>
<script>
{AUTO}
</script>
</body>
</html>
"""

io.open(OUT, 'w', encoding='utf-8').write(html)
print('生成：', OUT, len(html), '字节')
