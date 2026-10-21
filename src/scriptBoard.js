/**
 * 每日话术编排台 · 数据层
 *
 * 每个客户一份看板（board），存在 <DATA_ROOT>/board/<客户编号>.json：
 *   {
 *     day: 1,
 *     fragments: [
 *       { id, name, morning:bool, evening:bool, dialogues: [ { id, en, zh, sent:bool } ] }
 *     ]
 *   }
 *
 * 时段三态（morning / evening 两个布尔，互斥）：
 *   - morning=true, evening=false → 早上的对话（只在上半天用；≥13:00 会被划掉）
 *   - morning=false, evening=true → 晚上的对话（只在下半天用；<13:00 会被划掉）
 *   - 两个都 false              → 通用对话（任何时段都能用，永不划掉）
 *
 * 第一次打开某客户时，用 buildSeed()（Day1 + Day2 +「后期维护」）初始化；
 * 已有看板只做格式归一，绝不追加碎片。之后用户在前端增删改都落盘。
 * 左栏碎片 = fragments；右栏 = 选中碎片的 dialogues。
 *
 * 红线条：本模块只负责“存取”，绝不包含任何“发给客户”的能力。发送预填由 server 的
 * prefillChat 完成（只把文字放进 WhatsApp 输入框，不自动按发送），与这里无关。
 */

const fs = require('fs');
const path = require('path');
const { DATA_ROOT } = require('./paths');
// 2026-10-06：V3.7.6 段（267 碎片）已导入云端 master_fragments，本地不再内置，
// 故此处不再 require('./seed_v376')（避免 562KB 种子进包/ 被误当本地数据源）。
// 文件本身保留在 src/ 供追溯，若云端数据丢失可重新生成。
const SEED_V376 = [];

const BOARD_DIR = path.join(DATA_ROOT, 'board');

/* ========================= 云端优先 · 本地兜底（v1.0.1） =========================
 *
 * 怎么工作：
 *   · 登录了云端 → 读写走云端「自己编号的仓库」（主数据来自后台，本地只读缓存）；
 *   · 没登录 / 断网 → 完全走本地 <数据目录>/board/<编号>.json（跟 v1.0.1 之前一模一样）。
 *
 * 为什么要本地兜底：云端是多人协作的前提，但不能变成单点。老板在外面没网、
 * 或者云端临时挂了，软件必须照常能用。
 *
 * ⚠️ 云端【主数据】只读：本文件对主数据只有 GET（cloud.getBoard / syncMaster），
 *    所有写操作都进「自己编号的仓库」，绝不碰后台数据。
 *
 * ⚠️ v1.0.8：「已发 / 恢复」不再参与上面这套 —— 它**只写本机**
 *    （<数据目录>/board/<编号>.sent.json），断网、没登录都一样能用，
 *    也不再往云端写任何东西。看板内容照旧云端优先。
 * ================================================================== */

let cloud = null;
function cloudMod() {
  if (cloud === null) {
    try { cloud = require('./cloud'); } catch (e) { cloud = false; }
  }
  return cloud || null;
}

/** 云端是否可用（登录了且最近心跳没挂）。 */
function cloudReady() {
  const c = cloudMod();
  if (!c) return false;
  try {
    const st = c.status();
    return !!(st.configured && st.loggedIn);
  } catch (e) { return false; }
}

// 2026-10-22：内容改为通用一份（board/_master.json），不再按客户号拉云端仓库，故 pullBoard 已无用。

function uid(prefix) {
  return (prefix || 'x') + Math.random().toString(36).slice(2, 8);
}

function clone(o) {
  return JSON.parse(JSON.stringify(o));
}

/* ---------------- 种子（可在界面里增删改；可读版见 knowledge/playbook/dayN.md） ----------------
   注1：英文里的 {name} 是占位符，前端渲染时替换成客户称呼。
   注2：对话 id 必须「全看板唯一」——后端按 id 定位对话（标记已发 / 改 / 删）。
        历史上各碎片都从 d1 开始编号，导致点某条「已发」实际改到了别的碎片那一条，
        所以这里改成带碎片前缀的 id（d_bf1 / d_title1 …），并留了 ensureUniqueIds 兜底迁移。
   注3（2026-09-30）：按用户要求，「每日话术编排台」第 8 页 = 「后期维护」（DAY_MAINTENANCE）。
       软件的页序是：Day 1 … Day 7（DAY_MAX）→ 后期维护（DAY_MAINTENANCE）。
       可读版：knowledge/playbook/day1.md … day7.md / 后期维护.md */
const DAY_MAINTENANCE = 8;   // 「后期维护」在数据里的 day 值（前端把它显示成文字而不是 "Day 8"）

/* ================= 种子区（2026-09-30 二轮重写：Day1/2/5/7/后期维护） =================
   生成来源：tools/gen_seed_days2.js → tmp/seed_days2.js
   可读版：knowledge/playbook/day1.md … day7.md / 后期维护.md
   ⚠️ 本区替换掉了旧的手写 SEED_DAY1 / SEED_DAY2 / SEED_DAY5 / SEED_MAINTENANCE，
      并新增 SEED_DAY7。改动务必与 knowledge/playbook/*.md 同步。
   备份：knowledge/playbook/归档_20260930_二轮/ 与 src/scriptBoard.js.bak_*
   ==================================================================================== */
/* ---------------- Day 1 种子（2026-09-30 重写：第一包改纯文字问候，15 碎片，埋"静不下来"伏笔） ---------------- */
const SEED_DAY1 = [
  {
    id: 'f1_1', name: '开场 · 纯文字轻问候 + 自介绍', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_1_1', en: 'Hi {name} — I\'m Wanqiu. I paint, mostly animals.',
        zh: '你好{称呼}——我是晚秋。我画画，主要是动物。', sent: false },
      { id: 'd1_1_2', en: 'I keep a small studio in Xiamen, which is a coastal city in the south of China.',
        zh: '我在厦门有个小画室，厦门是中国南方的一个沿海城市。', sent: false },
      { id: 'd1_1_3', en: 'I saw you\'re in the US. I\'ve been there a few times, but never long enough.',
        zh: '我看你在美国。我去过几次，但从来待得不够久。', sent: false },
    ],
  },
  {
    id: 'f1_2', name: '称呼对换', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_2_1', en: 'Can I ask what you\'d like me to call you?',
        zh: '我能问一下，你想让我怎么称呼你？', sent: false },
      { id: 'd1_2_2', en: 'I\'d rather use what you actually go by than guess.',
        zh: '我想用你真正的叫法，不想瞎猜。', sent: false },
      { id: 'd1_2_3', en: 'Good. {name} it is.',
        zh: '好。那就{称呼}。', sent: false },
    ],
  },
  {
    id: 'f1_3', name: '地区对换', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_3_1', en: 'Where in the US are you?',
        zh: '你在美国哪儿？', sent: false },
      { id: 'd1_3_2', en: 'I always picture the same three things about America and I\'m probably wrong about all of them.',
        zh: '我对美国的想象永远是那三样东西，估计一个都不对。', sent: false },
      { id: 'd1_3_3', en: 'Tell me one true thing about where you live.',
        zh: '跟我说一件关于你那边的事，得是真的。', sent: false },
      { id: 'd1_3_4', en: 'I\'m going to remember that.',
        zh: '我会记住的。', sent: false },
    ],
  },
  {
    id: 'f1_4', name: '美国经历', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_4_1', en: 'I\'ve been to the US a few times — the first time I was about twenty.',
        zh: '我去过几次美国——第一次大概二十岁。', sent: false },
      { id: 'd1_4_2', en: 'I went with my teacher and four other students. We went to look at paintings.',
        zh: '我是跟老师还有其他四个学生一起去的。我们去看画。', sent: false },
      { id: 'd1_4_3', en: 'He stopped taking students before that. He took me anyway.',
        zh: '他之前已经不收学生了。他还是收了我。', sent: false },
      { id: 'd1_4_4', en: 'I still think about that trip.',
        zh: '我到今天还会想起那次旅行。', sent: false },
    ],
  },
  {
    id: 'f1_5', name: '生活习惯', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_5_1', en: 'I paint late and sleep late.',
        zh: '我画得晚，睡得也晚。', sent: false },
      { id: 'd1_5_2', en: 'Not because I\'m busy — I just get interested in things at the wrong hours.',
        zh: '不是因为忙——我就是总在不对的时间对事情感兴趣。', sent: false },
      { id: 'd1_5_3', en: '{name}, are you a morning person, or a night owl?',
        zh: '{称呼}，你是早起型还是夜猫子型？', sent: false },
      { id: 'd1_5_4', en: 'Finally, someone on my schedule.',
        zh: '终于有个跟我一个作息的了。', sent: false },
    ],
  },
  {
    id: 'f1_6', name: '职业对换', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_6_1', en: 'What do you do for work?',
        zh: '你是做什么工作的？', sent: false },
      { id: 'd1_6_2', en: 'I\'m asking because I\'ve realised I know nothing about what a normal job looks like. I\'ve only ever painted.',
        zh: '我问是因为我发现我对"正常上班"是怎么样的完全没概念。我只会画画。', sent: false },
      { id: 'd1_6_3', en: 'How long have you been doing that?',
        zh: '你做这行多久了？', sent: false },
      { id: 'd1_6_4', en: 'That\'s longer than I\'ve been painting.',
        zh: '那比我画画的时间还长。', sent: false },
    ],
  },
  {
    id: 'f1_7', name: '环境对换', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_7_1', en: 'Xiamen is coastal, dense, and loud.',
        zh: '厦门靠海、人多、吵。', sent: false },
      { id: 'd1_7_2', en: 'But the sea keeps it calm somehow. I don\'t know how that works.',
        zh: '但海让它莫名安静下来。我不知道这是什么原理。', sent: false },
      { id: 'd1_7_3', en: '{name}, what\'s it like where you are — big and spread out, or tight?',
        zh: '{称呼}，你那边是什么样的——地方大、摊得开，还是挤？', sent: false },
      { id: 'd1_7_4', en: 'Okay, that sounds completely different from here. I\'m picturing it.',
        zh: '好，那听起来跟这里完全不一样。我正在想象。', sent: false },
    ],
  },
  {
    id: 'f1_8', name: '生活对换', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_8_1', en: 'Little things make a day for me — a good breakfast, a walk by the sea.',
        zh: '小事对我来说就是一天——一顿好早餐、海边走走。', sent: false },
      { id: 'd1_8_2', en: 'I know that\'s not a big answer.',
        zh: '我知道这不算什么了不起的答案。', sent: false },
      { id: 'd1_8_3', en: 'What\'s the small thing that makes your day, {name}?',
        zh: '{称呼}，什么是让你的日子变好的小事？', sent: false },
      { id: 'd1_8_4', en: 'I like that answer better than mine.',
        zh: '我喜欢你的答案，比我的好。', sent: false },
    ],
  },
  {
    id: 'f1_9', name: '轻口 · 这几天静不下来', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_9_1', en: 'Honestly, I\'ve been off this week.',
        zh: '说实话，我这周状态不太好。', sent: false },
      { id: 'd1_9_2', en: 'Not sick, nothing happened. I just sit down at the canvas and can\'t get into it.',
        zh: '不是病了，也没出什么事。就是坐到画布前，进不去。', sent: false },
      { id: 'd1_9_3', en: 'I have one piece that\'s been sitting half-done for days now.',
        zh: '有一张已经半途放下好几天了。', sent: false },
      { id: 'd1_9_4', en: 'Sorry — you don\'t need my week. How\'s yours going?',
        zh: '抱歉——你不用听我这一周。你这周怎么样？', sent: false },
    ],
  },
  {
    id: 'f1_10', name: '画室环境（只描述，不带图）', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_10_1', en: 'My studio is one small room.',
        zh: '我的画室就一个小房间。', sent: false },
      { id: 'd1_10_2', en: 'There\'s paint on the floor I\'ve given up on, and a chair that only the cat uses.',
        zh: '地上有我已经放弃清理的颜料，还有一把只有猫用的椅子。', sent: false },
      { id: 'd1_10_3', en: '{name}, where do you do your thing? Desk, garage, kitchen table?',
        zh: '{称呼}，你在哪儿干你的活？桌子、车库、还是厨房台面？', sent: false },
      { id: 'd1_10_4', en: 'That\'s what I pictured.',
        zh: '跟我猜的一样。', sent: false },
    ],
  },
  {
    id: 'f1_11', name: '请教他 · 他的城市', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_11_1', en: '{name}, can I ask you about where you live?',
        zh: '{称呼}，我能问问你那地方吗？', sent: false },
      { id: 'd1_11_2', en: 'I\'ve never been and I probably never will. So you\'re my only source.',
        zh: '我没去过，大概也不会去。所以你是我唯一的信息来源。', sent: false },
      { id: 'd1_11_3', en: 'What\'s the one place there I\'d never find as a tourist?',
        zh: '那儿有什么地方是游客绝对找不到的？', sent: false },
      { id: 'd1_11_4', en: 'See, that\'s exactly the kind of thing I wanted.',
        zh: '看，我就是想知道这种。', sent: false },
    ],
  },
  {
    id: 'f1_12', name: '请教他 · 他的行当', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_12_1', en: 'Can I ask something about your work?',
        zh: '我能问点关于你工作的事吗？', sent: false },
      { id: 'd1_12_2', en: 'I don\'t know anything about it and I\'m genuinely curious.',
        zh: '我完全不懂，但我是真的好奇。', sent: false },
      { id: 'd1_12_3', en: 'What\'s the part of your job that nobody outside it understands?',
        zh: '你工作里有什么部分是外行完全不懂的？', sent: false },
      { id: 'd1_12_4', en: 'I had no idea. That\'s actually a lot more complicated than it sounds.',
        zh: '我完全不知道。这其实比听起来复杂多了。', sent: false },
    ],
  },
  {
    id: 'f1_13', name: '橙猫日常（只描述，不带图）', morning: false, evening: false, day: 1,
    dialogues: [
      { id: 'd1_13_1', en: 'There\'s an orange cat here. He\'s not mine exactly — he just decided.',
        zh: '这儿有只橘猫。不完全是"我的"——是他自己决定的。', sent: false },
      { id: 'd1_13_2', en: 'He sleeps on a chair he\'s not allowed on. Every single day.',
        zh: '他每天睡在一把不准他上去的椅子上。每一天。', sent: false },
      { id: 'd1_13_3', en: '{name}, do you have any animals?',
        zh: '{称呼}，你养动物吗？', sent: false },
      { id: 'd1_13_4', en: 'What\'s their name?',
        zh: '它叫什么名字？', sent: false },
    ],
  },
  {
    id: 'f1_14', name: '白天经历（晚）', morning: false, evening: true, day: 1,
    dialogues: [
      { id: 'd1_14_1', en: 'Spent the afternoon trying to fix one thing on that half-done piece.',
        zh: '下午想修那张半途放下的画上的一个地方。', sent: false },
      { id: 'd1_14_2', en: 'Didn\'t really work.',
        zh: '没修好。', sent: false },
      { id: 'd1_14_3', en: '{name}, did you get anything done today, or was it one of those days?',
        zh: '{称呼}，你今天干成什么事了吗，还是属于那种什么都不成的日子？', sent: false },
      { id: 'd1_14_4', en: 'What was it? Tell me the boring version, I like those.',
        zh: '是什么事？跟我说那个无聊的版本，我喜欢听。', sent: false },
    ],
  },
  {
    id: 'f1_15', name: '经历照片（晚 · 只预告不发）', morning: false, evening: true, day: 1,
    dialogues: [
      { id: 'd1_15_1', en: 'I was going through old photos today.',
        zh: '我今天翻了翻旧照片。', sent: false },
      { id: 'd1_15_2', en: 'Found a few from the trip I told you about. I\'ll send one tomorrow when the light\'s better.',
        zh: '找到几张我说的那次旅行的。明天光线好我发一张。', sent: false },
      { id: 'd1_15_3', en: '{name}, do you have old photos you go back to?',
        zh: '{称呼}，你有会反复去看的旧照片吗？', sent: false },
      { id: 'd1_15_4', en: 'I\'d like to see one if you ever want to send it.',
        zh: '你要是想发，我想看看。', sent: false },
    ],
  },
];

/* ---------------- Day 2 种子（2026-09-30 重写：17 碎片，第一次发早餐照，伏笔二次回收） ---------------- */
const SEED_DAY2 = [
  {
    id: 'f2_1', name: '早晨的问候（食物）· 第一次发早餐照', morning: true, evening: false, day: 2,
    dialogues: [
      { id: 'd2_1_1', en: 'Morning {name}. First food photo, sorry in advance — I eat the same thing most days.',
        zh: '早上好{称呼}。第一次发食物照，先抱歉——我大部分日子吃的都一样。', sent: false },
      { id: 'd2_1_2', en: 'Congee, every morning. It\'s a southern Chinese thing.',
        zh: '粥，每天早上。这是中国南方的习惯。', sent: false },
      { id: 'd2_1_3', en: 'I know it looks boring. It isn\'t.',
        zh: '我知道它看着挺无聊的。其实不是。', sent: false },
      { id: 'd2_1_4', en: '{name} — are you a sit-down breakfast person, or coffee and straight out the door?',
        zh: '{称呼}——你是会坐下来吃早饭的人，还是咖啡一灌就出门？', sent: false },
      { id: 'd2_1_5', en: 'Coffee-only people always say it\'s efficiency. It\'s never efficiency.',
        zh: '只喝咖啡的人总说这是效率。从来不是效率。', sent: false },
    ],
  },
  {
    id: 'f2_2', name: '语音消息（录音）', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_2_1', en: 'Okay, I\'m doing this as a voice thing because typing it would take me twenty minutes and I\'d still get it wrong.',
        zh: '行吧，我用语音说，因为打字我得花二十分钟，而且还是会说错。', sent: false },
      { id: 'd2_2_2', en: 'My English isn\'t very good and I don\'t get to use it much.',
        zh: '我英文不太好，平时也没什么机会用。', sent: false },
      { id: 'd2_2_3', en: 'So — can you actually understand me, or are you just being polite?',
        zh: '所以——你是真听得懂我说话，还是只是在礼貌？', sent: false },
      { id: 'd2_2_4', en: 'If we keep talking it\'ll probably get better. That\'s part of why I like talking to people who aren\'t from here.',
        zh: '要是我们一直聊下去，大概会变好。这也是我喜欢跟不是本地人聊天的原因之一。', sent: false },
    ],
  },
  {
    id: 'f2_3', name: '去过美国 · 第一次去是二十岁（师父带我去的）', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_3_1', en: 'Here\'s the one I said I\'d send.',
        zh: '这就是我说要发的那张。', sent: false },
      { id: 'd2_3_2', en: 'The first time I went I was about twenty. It was also the first time I\'d been anywhere that far.',
        zh: '我第一次去大概二十岁。那也是我第一次去那么远的地方。', sent: false },
      { id: 'd2_3_3', en: 'Everything was so big. I remember being nervous the whole first day and not saying much.',
        zh: '什么都特别大。我记得第一天一直很紧张，话都不太敢说。', sent: false },
      { id: 'd2_3_4', en: 'I wasn\'t alone though — my teacher took four of us. His students. We were all useless in different ways.',
        zh: '不过我不是一个人——我老师带了四个人去，他的学生。我们几个各有各的没用。', sent: false },
      { id: 'd2_3_5', en: 'He\'d actually stopped taking new students. He took me anyway. I\'m still not sure I\'ve earned that.',
        zh: '其实他已经不收新学生了。他还是收了我。我到现在也不确定自己配不配。', sent: false },
    ],
  },
  {
    id: 'f2_4', name: '去过哪些地方（意大利/加拿大/新加坡/美国）', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_4_1', en: 'People are always surprised when I list them off — Italy, Canada, Singapore, the US.',
        zh: '每次我数出来，别人都挺惊讶的——意大利、加拿大、新加坡、美国。', sent: false },
      { id: 'd2_4_2', en: 'But I didn\'t go for the food or the shopping. I went to look at paintings.',
        zh: '但我不是为了吃和买东西去的。我是去看画的。', sent: false },
      { id: 'd2_4_3', en: 'Italy — a whole day in one building, and I still didn\'t see everything. I stood in front of one painting for about forty minutes and my neck hurt after.',
        zh: '意大利——在一栋楼里待了一整天，还是没看完。我在一幅画前面站了大概四十分钟，后来脖子疼。', sent: false },
      { id: 'd2_4_4', en: 'I don\'t remember what I ate that week. I remember one painting.',
        zh: '那一周吃了什么我全不记得了。我记得一幅画。', sent: false },
      { id: 'd2_4_5', en: '{name}, is there a museum near you that you keep meaning to go to and never do?',
        zh: '{称呼}，你那边有没有一个你一直想去、但总没去成的博物馆？', sent: false },
    ],
  },
  {
    id: 'f2_5', name: '去过哪些地方 · 分享照片', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_5_1', en: 'Found this one going through my phone.',
        zh: '翻手机翻到这张。', sent: false },
      { id: 'd2_5_2', en: 'I remember the light there being nothing like home — flatter, somehow. I still think about it when I\'m mixing colours.',
        zh: '我记得那边的光跟家里完全不一样——怎么说，更平一些。我现在调色的时候还会想到。', sent: false },
      { id: 'd2_5_3', en: '{name}, where are you in the States? I always picture the same three things and I\'m probably wrong about all of them.',
        zh: '{称呼}，你在美国哪儿？我脑子里总是那几个画面，估计一个都不对。', sent: false },
      { id: 'd2_5_4', en: 'I\'m going to remember that.',
        zh: '我会记住的。', sent: false },
    ],
  },
  {
    id: 'f2_6', name: '美食的料理', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_6_1', en: 'I cooked proper food today — braised pork. Two hours, and most of it is just waiting.',
        zh: '今天认真做了一顿——红烧肉。两个小时，其中大部分时间只是在等。', sent: false },
      { id: 'd2_6_2', en: 'The waiting part is the bit I\'m bad at. I keep lifting the lid.',
        zh: '"等"这部分我最不擅长。我老是掀锅盖。', sent: false },
      { id: 'd2_6_3', en: 'Funny — I was telling you I couldn\'t sit still with the painting, and here I am pacing around a pot.',
        zh: '有意思——我昨天跟你说画画静不下来，结果我在这儿围着锅转。', sent: false },
      { id: 'd2_6_4', en: '{name}, what\'s the one dish you\'d actually cook if you had the time?',
        zh: '{称呼}，你要是有时间，会认真做哪一道菜？', sent: false },
    ],
  },
  {
    id: 'f2_7', name: '有没有养宠物', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_7_1', en: '{name}, do you have any animals?',
        zh: '{称呼}，你养动物吗？', sent: false },
      { id: 'd2_7_2', en: 'I ask because the orange one is currently asleep on a chair he\'s not allowed on, and I need to know this is normal.',
        zh: '我问这个是因为橘猫现在正睡在一把不准他上去的椅子上，我需要确认这是不是正常的。', sent: false },
      { id: 'd2_7_3', en: 'That\'s him. He owns this place, I just pay for it.',
        zh: '就是他。这地方是他的，我只是付钱的。', sent: false },
      { id: 'd2_7_4', en: 'If you\'ve got one — what\'s their name?',
        zh: '你要是有——它叫什么名字？', sent: false },
    ],
  },
  {
    id: 'f2_8', name: '家庭的构成', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_8_1', en: 'Can I ask something — who\'s at home with you, {name}?',
        zh: '{称呼}，我能问个事吗——你家里都有谁一起住？', sent: false },
      { id: 'd2_8_2', en: 'I\'m an only child, so I grew up very quiet. I\'m always a little amazed by people who had siblings.',
        zh: '我是独生女，所以从小特别安静。我一直挺羡慕有兄弟姐妹的人。', sent: false },
      { id: 'd2_8_3', en: 'Did you grow up with brothers and sisters, or was it just you?',
        zh: '你小时候是有兄弟姐妹，还是就你自己？', sent: false },
      { id: 'd2_8_4', en: 'That\'s a good thing to have had.',
        zh: '有那个挺好的。', sent: false },
    ],
  },
  {
    id: 'f2_9', name: '我和师兄师姐', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_9_1', en: 'I was the last of his five students — the baby of the family, basically.',
        zh: '我是他五个学生里最小的——基本就是家里老幺那种。', sent: false },
      { id: 'd2_9_2', en: 'Which means I got nagged the most. My eldest classmate still checks up on me, and I\'m thirty-two.',
        zh: '意思是挨骂最多。我大师姐到现在还会来查岗，我都三十二了。', sent: false },
      { id: 'd2_9_3', en: 'Do you have people like that — who\'ve known you long enough to boss you around?',
        zh: '你有这种人吗——认识你够久、久到能管你两句的？', sent: false },
      { id: 'd2_9_4', en: 'Those are the good ones. Annoying, but the good ones.',
        zh: '那种人是好人。烦人，但是好人。', sent: false },
    ],
  },
  {
    id: 'f2_10', name: '对生活比较随意', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_10_1', en: '{name}, I\'m very casual about life and completely unreasonable about painting.',
        zh: '{称呼}，我生活上特别随便，画上一点不含糊。', sent: false },
      { id: 'd2_10_2', en: 'My studio\'s a mess. The painting itself — no. That part I don\'t compromise on.',
        zh: '画室乱七八糟。画本身——不行。那部分我不让步。', sent: false },
      { id: 'd2_10_3', en: 'Are you the same way, or is everything in your life in its place?',
        zh: '你也是这样的，还是你生活里什么都摆得整整齐齐？', sent: false },
      { id: 'd2_10_4', en: 'Good. I trust people with messy desks.',
        zh: '好。我信桌子乱的人。', sent: false },
    ],
  },
  {
    id: 'f2_11', name: '画室环境', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_11_1', en: 'This is where I work.',
        zh: '这是我干活的地方。', sent: false },
      { id: 'd2_11_2', en: 'Small room of my own. It\'s messy in a way I\'ve stopped apologising for.',
        zh: '我自己的小房间。乱得我已经懒得道歉了。', sent: false },
      { id: 'd2_11_3', en: 'Where do you do your thing, {name}? Desk, garage, kitchen table?',
        zh: '{称呼}，你在哪儿干你的活？桌子、车库、还是厨房台面？', sent: false },
      { id: 'd2_11_4', en: 'That\'s what I pictured.',
        zh: '跟我猜的一样。', sent: false },
    ],
  },
  {
    id: 'f2_12', name: '女人最难画（聊人物时才用）', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_12_1', en: 'Women are the hardest to paint, you know why?',
        zh: '女人是最难画的，你知道为什么吗？', sent: false },
      { id: 'd2_12_2', en: 'Because we look different every single day. Makeup, mood, sleep — all of it.',
        zh: '因为我们每天看起来都不一样。妆容、心情、睡没睡好，全都算。', sent: false },
      { id: 'd2_12_3', en: 'Men are easy. You\'ve looked the same since you were twenty-five.',
        zh: '男的就好画了。你从二十五岁到现在基本没变。', sent: false },
      { id: 'd2_12_4', en: '(That was a compliment. Mostly.)',
        zh: '（这是夸你。大部分是。）', sent: false },
    ],
  },
  {
    id: 'f2_13', name: '哆咪的故事（他提到老了/病了才接）', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_13_1', en: 'We had a cat in my teacher\'s studio. All of us raised her together.',
        zh: '以前在老师工作室里养过一只猫。我们大家一起把她带大的。', sent: false },
      { id: 'd2_13_2', en: 'She got sick and she\'s gone now.',
        zh: '后来她生病走了。', sent: false },
      { id: 'd2_13_3', en: 'That\'s actually how I ended up painting animals. Not a plan — just what I kept doing.',
        zh: '其实我就是从那时候开始画动物的。不是什么计划——就是一直在画。', sent: false },
    ],
  },
  {
    id: 'f2_14', name: '情感的问题（他先聊到才接）', morning: false, evening: false, day: 2,
    dialogues: [
      { id: 'd2_14_1', en: 'Honestly? I just haven\'t met the right one.',
        zh: '说实话？就是没遇到合适的。', sent: false },
      { id: 'd2_14_2', en: 'That\'s the whole story. There isn\'t a more interesting version.',
        zh: '就这么回事，没有更精彩的版本。', sent: false },
      { id: 'd2_14_3', en: 'People who know me say the same thing — that I\'m not built for a relationship, I\'m built for friendship. Because I disappear into the work and I\'m not around much.',
        zh: '认识我的人都这么说——我不适合爱情，适合友情。因为我一画起来就没了，陪不了人。', sent: false },
      { id: 'd2_14_4', en: 'Do you think that\'s fair? Or is it just something people like me tell themselves?',
        zh: '你觉得这话公平吗？还是像我这种人给自己找的台阶？', sent: false },
      { id: 'd2_14_5', en: 'Anyway — that\'s the boring part of my life. You were saying?',
        zh: '总之——这就是我生活里无聊的部分。你刚说到哪儿了？', sent: false },
    ],
  },
  {
    id: 'f2_15', name: '菜市场 / 街边日常（晚）', morning: false, evening: true, day: 2,
    dialogues: [
      { id: 'd2_15_1', en: 'Went down to the market this evening. It\'s my favourite part of the day.',
        zh: '傍晚去了一趟菜市场。这是一天里我最喜欢的时候。', sent: false },
      { id: 'd2_15_2', en: 'Everyone\'s loud, nobody\'s in a hurry, and the vegetables are better than anywhere else.',
        zh: '大家都很大声，没人着急，菜也比别处好。', sent: false },
      { id: 'd2_15_3', en: 'The woman who sells me fish has started adding extra without telling me. I think I\'ve been adopted.',
        zh: '卖鱼那位阿姨开始背着我多给我装一点了。我觉得我被收养了。', sent: false },
      { id: 'd2_15_4', en: 'What\'s your neighbourhood like, {name}? Walkable, or do you drive everywhere?',
        zh: '{称呼}，你那边街区是什么样的？走路能办事，还是去哪儿都得开车？', sent: false },
    ],
  },
  {
    id: 'f2_16', name: '我的生活照片 · 分享哪些（晚）', morning: false, evening: true, day: 2,
    dialogues: [
      { id: 'd2_16_1', en: 'Anyway — that\'s my day.',
        zh: '总之——这就是我的一天。', sent: false },
      { id: 'd2_16_2', en: 'Congee, four hours of painting, one market trip, and a cat who has never once respected a rule.',
        zh: '粥、画四小时、逛一趟菜场，还有一只从来没守过规矩的猫。', sent: false },
      { id: 'd2_16_3', en: '{name}, what does an ordinary day look like on your end? Not the interesting version — the actual one.',
        zh: '{称呼}，你那边普通的一天是什么样的？不用有趣的版本——就真实那个。', sent: false },
    ],
  },
  {
    id: 'f2_17', name: '白天经历（晚）', morning: false, evening: true, day: 2,
    dialogues: [
      { id: 'd2_17_1', en: 'Went back to that half-done piece tonight.',
        zh: '今晚回去看了那张半途放下的画。', sent: false },
      { id: 'd2_17_2', en: 'Sat with it for an hour. Didn\'t touch it. But sitting with it felt better than nothing.',
        zh: '坐着看了一个小时。没动笔。但坐着看也比不看好。', sent: false },
      { id: 'd2_17_3', en: '{name}, did you get anything done today, or was it one of those days?',
        zh: '{称呼}，你今天干成什么事了吗，还是属于那种什么都不成的日子？', sent: false },
      { id: 'd2_17_4', en: 'What was it? Tell me the boring version, I like those.',
        zh: '是什么事？跟我说那个无聊的版本，我喜欢听。', sent: false },
    ],
  },
];

/* ---------------- Day 5 种子（2026-09-30：16 碎片，新增第 8 包"沉浸式画画"作 Day 7 伏笔） ---------------- */
const SEED_DAY5 = [
  {
    id: 'f5_1', name: '早餐照片（食物）', morning: true, evening: false, day: 5,
    dialogues: [
      { id: 'd5_1_1', en: 'Morning {name}! It\'s actually cold this morning.',
        zh: '早啊{称呼}！今天早上真的冷。', sent: false },
      { id: 'd5_1_2', en: 'First time this year I\'ve wanted a jacket.',
        zh: '今年第一次想穿外套。', sent: false },
      { id: 'd5_1_3', en: 'How cold does it get where you are? I\'m genuinely asking, I have no idea.',
        zh: '你那边能冷到什么程度？我是真问，我完全没概念。', sent: false },
      { id: 'd5_1_4', en: 'Every time you tell me something about where you live I end up picturing it for the rest of the day.',
        zh: '每次你跟我说一点你那边的事，我一整天都会在脑子里想象。', sent: false },
    ],
  },
  {
    id: 'f5_2', name: '时间不长（核心信念）', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_2_1', en: 'Can I say something I\'ve been thinking about?',
        zh: '我能说点我一直在想的事吗？', sent: false },
      { id: 'd5_2_2', en: 'People keep asking me what a painting of a pet is worth. That\'s not the part that matters to me.',
        zh: '大家老问我一张宠物画值多少钱。但那不是我在意的部分。', sent: false },
      { id: 'd5_2_3', en: 'The thing is — they don\'t get that long with us. That\'s the whole reason I do this.',
        zh: '重点是——它们陪我们的时间不长。这就是我做这件事的全部理由。', sent: false },
      { id: 'd5_2_4', en: 'Anyway. How\'s {pet} today?',
        zh: '总之。{宠物}今天怎么样？', sent: false },
    ],
  },
  {
    id: 'f5_3', name: '定在那儿（信念第二句，连发）', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_3_1', en: 'I keep coming back to that thing I said this morning.',
        zh: '我一直在想我早上说的那件事。', sent: false },
      { id: 'd5_3_2', en: 'A photo keeps happening. It\'s always moving — the light changes, the phone changes, it\'s somewhere on a laptop now.',
        zh: '照片是不断发生的。光在变、手机在换，现在已经存在某个笔记本里了。', sent: false },
      { id: 'd5_3_3', en: 'A painting stops. That\'s the only thing it does, and it\'s the whole point.',
        zh: '画会停下来。这是它唯一做的事，也是全部意义。', sent: false },
      { id: 'd5_3_4', en: 'Sorry, that was very serious for a Tuesday. What are you doing this evening?',
        zh: '抱歉，周二说这么正经。你今晚干什么？', sent: false },
    ],
  },
  {
    id: 'f5_4', name: '把昨天那句还给他（本天最关键）', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_4_1', en: '{name}, you said something yesterday and I haven\'t been able to put it down.',
        zh: '{称呼}，你昨天说了一句话，我到现在都放不下。', sent: false },
      { id: 'd5_4_2', en: 'You said — "{他昨天那句原话，一字不改}".',
        zh: '你说——「{原话}」。', sent: false },
      { id: 'd5_4_3', en: 'That\'s it. That\'s the thing. It\'s not the painting. It\'s that.',
        zh: '就是这个。就是这个东西。不是画。是这个。', sent: false },
      { id: 'd5_4_4', en: 'I just wanted you to know it stayed with me.',
        zh: '我就是想让你知道，这句话留在我这儿了。', sent: false },
    ],
  },
  {
    id: 'f5_5', name: '橙猫日常（稀释情绪）', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_5_1', en: 'This one has discovered that the windowsill is warm in the afternoon.',
        zh: '这位发现下午窗台是暖的。', sent: false },
      { id: 'd5_5_2', en: 'He now spends four hours a day there. Doing nothing. Perfectly happy.',
        zh: '他现在每天在那儿待四小时。什么都不干。非常快乐。', sent: false },
      { id: 'd5_5_3', en: '{name}, is {pet} a windowsill type, or more of a following-you-around type?',
        zh: '{称呼}，{宠物}是窗台型的，还是走哪儿跟哪儿型的？', sent: false },
      { id: 'd5_5_4', en: 'Both is the correct answer. Both is always the answer.',
        zh: '"都是"才是正确答案。"都是"永远是答案。', sent: false },
    ],
  },
  {
    id: 'f5_6', name: '轻口 · 你们多久了', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_6_1', en: 'Can I ask — how long have you had {pet}?',
        zh: '我能问吗——{宠物}你养多久了？', sent: false },
      { id: 'd5_6_2', en: 'I like knowing the number. It makes the whole thing more real to me.',
        zh: '我喜欢知道这个数字。它让整件事对我来说更真实。', sent: false },
      { id: 'd5_6_3', en: 'That\'s a long time. That\'s most of what\'s happened to you since then.',
        zh: '那是很长一段时间。从那之后发生在你身上的事，基本都在这里面了。', sent: false },
    ],
  },
  {
    id: 'f5_7', name: '自嘲 · 我画得慢', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_7_1', en: 'Confession: I\'m a very slow painter.',
        zh: '坦白一下：我画得很慢。', sent: false },
      { id: 'd5_7_2', en: 'Not careful — slow. There\'s a difference.',
        zh: '不是细致——是慢。这俩不一样。', sent: false },
      { id: 'd5_7_3', en: '{name}, are you fast at what you do, or are you the slow type?',
        zh: '{称呼}，你做事快吗，还是慢的那种？', sent: false },
      { id: 'd5_7_4', en: 'Welcome. There are more of us than they admit.',
        zh: '欢迎。我们这类人比他们承认的多。', sent: false },
    ],
  },
  {
    id: 'f5_8', name: '沉浸式画画（Day 7 伏笔）', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_8_1', en: 'I got properly lost in it this afternoon.',
        zh: '今天下午我完全陷进去了。', sent: false },
      { id: 'd5_8_2', en: 'Four hours and I didn\'t look up once. Didn\'t eat, didn\'t notice the light change.',
        zh: '四个小时，一次都没抬头。没吃饭，连光变了都没发现。', sent: false },
      { id: 'd5_8_3', en: 'That\'s the best feeling I know. Nothing else is like it.',
        zh: '这是我知道的最好的感觉。没有别的能比。', sent: false },
      { id: 'd5_8_4', en: '{name}, do you have anything like that — something that swallows you whole?',
        zh: '{称呼}，你有这种事吗——能让你完全陷进去的？', sent: false },
      { id: 'd5_8_5', en: 'Then you know. You don\'t have to explain it to me.',
        zh: '那你就懂了。你不用跟我解释。', sent: false },
    ],
  },
  {
    id: 'f5_9', name: '生活对换', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_9_1', en: '{name}, what\'s the one thing you do every single day without fail?',
        zh: '{称呼}，有什么事是你每天一定会做的？', sent: false },
      { id: 'd5_9_2', en: 'I mean the boring one. Coffee, the news, walking the dog. Not the impressive one.',
        zh: '我说的是无聊那个。咖啡、看新闻、遛狗。不是那种了不起的。', sent: false },
      { id: 'd5_9_3', en: 'Mine is standing by the sink eating breakfast. Every day.',
        zh: '我的是站在水池边吃早饭。每天。', sent: false },
      { id: 'd5_9_4', en: 'I\'m going to think about that tomorrow morning when I\'m at the sink.',
        zh: '明天早上我在水池边的时候会想起这个。', sent: false },
    ],
  },
  {
    id: 'f5_10', name: '职业对换', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_10_1', en: 'If you could stop working tomorrow, what would you actually do with your time?',
        zh: '如果明天可以不上班，你会拿时间干嘛？', sent: false },
      { id: 'd5_10_2', en: 'I\'m not asking about retiring somewhere warm. I mean what would you do on a Tuesday.',
        zh: '我不是问去哪养老。我是说，一个普通的周二你会干什么。', sent: false },
      { id: 'd5_10_3', en: 'That\'s a real answer. Most people just say "travel".',
        zh: '这是真答案。大部分人只会说"旅行"。', sent: false },
    ],
  },
  {
    id: 'f5_11', name: '环境对换', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_11_1', en: 'What\'s the view out of your window right now?',
        zh: '你现在窗外是什么景色？', sent: false },
      { id: 'd5_11_2', en: 'Not the nice version. The actual one.',
        zh: '不要好看那个版本。就真实的。', sent: false },
      { id: 'd5_11_3', en: 'Okay, I can picture it now. That\'s a real place.',
        zh: '好，我现在能想象出来了。这是个真实的地方。', sent: false },
    ],
  },
  {
    id: 'f5_12', name: '请教他 · 一辈子里最值的一件事', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_12_1', en: '{name}, can I ask you a big question?',
        zh: '{称呼}，我能问你个大问题吗？', sent: false },
      { id: 'd5_12_2', en: 'You\'ve been around longer than me. I want to know what actually holds up.',
        zh: '你比我年长。我想知道什么东西才是真的靠得住的。', sent: false },
      { id: 'd5_12_3', en: 'Out of everything you\'ve spent money or time on in your life — what turned out to be worth it?',
        zh: '你这辈子花过钱、花过时间的事里——哪一件后来证明是值的？', sent: false },
      { id: 'd5_12_4', en: 'I\'m writing that down. That\'s a better answer than I expected.',
        zh: '我记下来了。这答案比我预想的好。', sent: false },
    ],
  },
  {
    id: 'f5_13', name: '请教他 · 有没有什么东西你一直留着', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_13_1', en: 'Random question — do you still have anything from when you were a kid?',
        zh: '随口问一句——你小时候的东西，还有留着的吗？', sent: false },
      { id: 'd5_13_2', en: 'I\'m asking because I threw almost everything away and I regret most of it.',
        zh: '我问是因为我几乎全扔了，我大部分都后悔。', sent: false },
      { id: 'd5_13_3', en: 'You kept it. That says something about you.',
        zh: '你留着了。这说明你是个什么人。', sent: false },
    ],
  },
  {
    id: 'f5_14', name: '褪色老照片 · 怀旧的意义（本天第二主线）', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_14_1', en: 'I keep a stack of old photos in the studio. Most of them are faded now — my dad when he was young, my teacher, a street that doesn\'t exist anymore.',
        zh: '我在画室存着一叠老照片。现在大多都褪色了——我爸年轻时候的、我师父的、一条现在不在了的街。', sent: false },
      { id: 'd5_14_2', en: 'I tried to paint one of them once. I spent three days just on the color of that faded yellow — never got it right.',
        zh: '我有一次试着画其中一张。光那个褪色的黄，我调了三天，一直没调对。', sent: false },
      { id: 'd5_14_3', en: 'Do you have any photos like that, or is everything on your phone now?',
        zh: '你也有这种照片吗？还是现在什么都在手机里了？', sent: false },
      { id: 'd5_14_4', en: 'Then you know exactly that yellow I\'m talking about.',
        zh: '那你一定懂我说的那个黄是什么样。', sent: false },
      { id: 'd5_14_5', en: 'That\'s the sad part about phones — nothing ever fades.',
        zh: '手机最可惜的就是这个——东西永远不会褪色。', sent: false },
      { id: 'd5_14_6', en: 'The ones in a box are the good ones.',
        zh: '放在盒子里的那些才是好的。', sent: false },
    ],
  },
  {
    id: 'f5_15', name: '他的名字其实是怎么来的', morning: false, evening: false, day: 5,
    dialogues: [
      { id: 'd5_15_1', en: 'I keep thinking about what you said about the name.',
        zh: '我一直在想你说的名字那件事。', sent: false },
      { id: 'd5_15_2', en: 'Most people name them something that sounds good. You didn\'t.',
        zh: '大部分人起名是起个好听的。你不是。', sent: false },
      { id: 'd5_15_3', en: 'Who picked it — you or somebody else?',
        zh: '谁起的——你还是别人？', sent: false },
      { id: 'd5_15_4', en: 'That\'s better than the name itself.',
        zh: '这比名字本身还好。', sent: false },
    ],
  },
  {
    id: 'f5_16', name: '白天经历（晚）', morning: false, evening: true, day: 5,
    dialogues: [
      { id: 'd5_16_1', en: 'Spent the whole afternoon on one patch of fur and it still isn\'t right.',
        zh: '一整个下午都在画一小块毛，还是不对。', sent: false },
      { id: 'd5_16_2', en: 'This is the part nobody photographs.',
        zh: '这是没人会拍下来的那部分。', sent: false },
      { id: 'd5_16_3', en: '{name}, how was your day? Anything worth reporting?',
        zh: '{称呼}，你今天怎么样？有什么值得汇报的吗？', sent: false },
      { id: 'd5_16_4', en: 'Good. I like your good days.',
        zh: '好。我喜欢你的好日子。', sent: false },
    ],
  },
  {
    id: 'f5_17', name: '画面延续（晚）', morning: false, evening: true, day: 5,
    dialogues: [
      { id: 'd5_17_1', en: 'Still thinking about him at the door.',
        zh: '还在想他在门口那个画面。', sent: false },
      { id: 'd5_17_2', en: 'I don\'t think I\'ll lose that image.',
        zh: '我觉得我不会忘掉这个画面了。', sent: false },
      { id: 'd5_17_3', en: 'Goodnight, {name}.',
        zh: '晚安，{称呼}。', sent: false },
    ],
  },
];

/* ---------------- Day 7 种子（2026-09-30 双分支：A线已成交 8 包 / B线未成交 7 包） ---------------- */
const SEED_DAY7 = [
  {
    id: 'f7_1', name: '【A线·已成交】早餐照片（食物）', morning: true, evening: false, day: 7,
    dialogues: [
      { id: 'd7_1_1', en: 'Morning {name}. Congee. Yes. Again.',
        zh: '早上好{称呼}。粥。对。又是。', sent: false },
      { id: 'd7_1_2', en: 'I\'ve got a proper day ahead of me today. First real day on it.',
        zh: '我今天有正经事要干。在那上头正经干活的第一天。', sent: false },
      { id: 'd7_1_3', en: 'I\'ll send you something later.',
        zh: '晚点我发你点东西。', sent: false },
    ],
  },
  {
    id: 'f7_2', name: '【A线】开工照（钱到账必发）', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_2_1', en: 'Canvas is up. Starting this morning.',
        zh: '画布架好了。今天早上开始。', sent: false },
      { id: 'd7_2_2', en: 'I always take a photo of the blank one. It\'s the only time it\'s perfect.',
        zh: '空白的那张我一定会拍一张。那是它唯一完美的时候。', sent: false },
      { id: 'd7_2_3', en: '{name}, I\'ll show you as it goes. Not every day — but when it changes.',
        zh: '{称呼}，我会一直给你看进展。不是每天——是有变化的时候。', sent: false },
      { id: 'd7_2_4', en: 'Good. Then we\'re doing this properly.',
        zh: '好。那我们就正经做这件事了。', sent: false },
    ],
  },
  {
    id: 'f7_3', name: '【A线】绷画布', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_3_1', en: 'Stretching it. This part is oddly satisfying — just fabric and wood and a stapler.',
        zh: '绷布。这一步莫名地爽——就是布、木头和一个订书机。', sent: false },
      { id: 'd7_3_2', en: 'I do this myself. I don\'t let anyone else touch it.',
        zh: '这个我自己做。我不让别人碰。', sent: false },
      { id: 'd7_3_3', en: 'Okay. Now it\'s real.',
        zh: '好。现在它是真的了。', sent: false },
    ],
  },
  {
    id: 'f7_4', name: '【A线】跟他确认细节', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_4_1', en: 'Before I go further — you said "{他之前描述过的画面}". Still that?',
        zh: '我往下画之前——你说过「{原话}」。还是那个吗？', sent: false },
      { id: 'd7_4_2', en: 'I don\'t want to get three days in and find out I had it wrong.',
        zh: '我不想画了三天才发现我理解错了。', sent: false },
      { id: 'd7_4_3', en: 'You can change it now. Later it gets hard.',
        zh: '你现在还能改。晚了就难了。', sent: false },
      { id: 'd7_4_4', en: 'Good. That\'s what I\'ve got.',
        zh: '好。就是我记的这个。', sent: false },
    ],
  },
  {
    id: 'f7_5', name: '【A线】说清接下来会发生什么', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_5_1', en: 'So here\'s how this goes.',
        zh: '那接下来说一下这事儿怎么走。', sent: false },
      { id: 'd7_5_2', en: 'Rough stage next — it\'ll look wrong for a while. That\'s normal, don\'t worry.',
        zh: '下一步是打底——有一阵子它会看起来不对。这很正常，别担心。', sent: false },
      { id: 'd7_5_3', en: 'Then it comes together at the end. It always comes together late.',
        zh: '然后到最后会合到一起。它总是很晚才合上。', sent: false },
      { id: 'd7_5_4', en: 'Any time you want to see it, just ask.',
        zh: '你什么时候想看，就说一声。', sent: false },
    ],
  },
  {
    id: 'f7_6', name: '【A线】生活对换', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_6_1', en: 'What\'s the one thing you do every single day without fail?',
        zh: '有什么事是你每天一定会做的？', sent: false },
      { id: 'd7_6_2', en: 'I mean the boring one. Coffee, the news, walking the dog.',
        zh: '我说的是无聊那个。咖啡、看新闻、遛狗。', sent: false },
      { id: 'd7_6_3', en: 'I\'m going to think about that tomorrow morning.',
        zh: '明天早上我会想起这个。', sent: false },
    ],
  },
  {
    id: 'f7_7', name: '【A线】环境对换', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_7_1', en: 'Has the weather turned where you are?',
        zh: '你那边天气变了吗？', sent: false },
      { id: 'd7_7_2', en: 'That sounds like proper weather. We don\'t get proper weather.',
        zh: '这听起来像正经的天气。我们这儿没有正经天气。', sent: false },
    ],
  },
  {
    id: 'f7_8', name: '【A线】进度照（晚）', morning: false, evening: true, day: 7,
    dialogues: [
      { id: 'd7_8_1', en: 'Underpainting\'s in.',
        zh: '底层上完了。', sent: false },
      { id: 'd7_8_2', en: 'Looks nothing like him yet — that\'s normal, that\'s how it\'s supposed to look at this stage.',
        zh: '现在还完全不像他——正常，这个阶段本来就该是这样。', sent: false },
      { id: 'd7_8_3', en: 'Don\'t feel obliged to reply to these, by the way.',
        zh: '顺便说一句，这些不用特意回。', sent: false },
    ],
  },
  {
    id: 'f7_9', name: '【B线·未成交】早餐照片（食物）', morning: true, evening: false, day: 7,
    dialogues: [
      { id: 'd7_9_1', en: 'Morning {name}. Congee. Yes. Again. We\'re a week in and you know exactly what I eat.',
        zh: '早上好{称呼}。粥。对。又是。一周了，你完全知道我吃什么。', sent: false },
      { id: 'd7_9_2', en: 'That\'s a strange thing to know about someone, honestly.',
        zh: '说实话，这算是对一个人挺奇怪的了解。', sent: false },
      { id: 'd7_9_3', en: 'Anyway. I\'ve got a good day ahead.',
        zh: '总之。我今天会过得不错。', sent: false },
    ],
  },
  {
    id: 'f7_10', name: '【B线】心情开朗了（伏笔回收）', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_10_1', en: '{name} — remember I told you I couldn\'t get into it this week?',
        zh: '{称呼}——记得我跟你说我这周画不进去吗？', sent: false },
      { id: 'd7_10_2', en: 'It came back last night. I don\'t know why. It just did.',
        zh: '昨晚回来了。我不知道为什么。就是回来了。', sent: false },
      { id: 'd7_10_3', en: 'I\'m in a much better mood today than I\'ve been all week.',
        zh: '我今天心情比这一整周都好。', sent: false },
      { id: 'd7_10_4', en: 'Anyway — that\'s my news. It\'s not big news, but it\'s mine.',
        zh: '总之——这就是我的消息。不是什么大事，但是我的事。', sent: false },
    ],
  },
  {
    id: 'f7_11', name: '【B线】回去接着画我那幅没画完的', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_11_1', en: 'I\'m going back to the one I put down.',
        zh: '我要回去画那张我放下的了。', sent: false },
      { id: 'd7_11_2', en: 'It\'s mine. Not a commission. I just want to finish it.',
        zh: '那是我自己的。不是委托。我就是想把它画完。', sent: false },
      { id: 'd7_11_3', en: 'I don\'t know what I\'ll do with it when it\'s done. Probably nothing.',
        zh: '画完了我也不知道拿它干嘛。大概什么也不干。', sent: false },
      { id: 'd7_11_4', en: 'Yeah. Some things you finish just to finish.',
        zh: '对。有些东西你画完，就是为了画完。', sent: false },
    ],
  },
  {
    id: 'f7_12', name: '【B线】沉浸式画画 · 一整天没出来（晚）', morning: false, evening: true, day: 7,
    dialogues: [
      { id: 'd7_12_1', en: 'Didn\'t come out of the studio today.',
        zh: '今天一天没出画室。', sent: false },
      { id: 'd7_12_2', en: 'Ate standing up, forgot two meals, and I\'m not even sorry.',
        zh: '站着吃的，忘了两顿，我一点也不觉得抱歉。', sent: false },
      { id: 'd7_12_3', en: 'That\'s the good kind of day. They\'ve been rare lately.',
        zh: '这是好日子。最近很少。', sent: false },
      { id: 'd7_12_4', en: '{name}, how was yours?',
        zh: '{称呼}，你怎么样？', sent: false },
    ],
  },
  {
    id: 'f7_13', name: '【B线】退回朋友线', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_13_1', en: 'Anyway — that\'s enough shop talk.',
        zh: '总之——不说这些了。', sent: false },
      { id: 'd7_13_2', en: 'How was your day?',
        zh: '你今天怎么样？', sent: false },
      { id: 'd7_13_3', en: 'Nothing to report on my end. Just a normal one.',
        zh: '我这边没什么可说的。就是个普通日子。', sent: false },
    ],
  },
  {
    id: 'f7_14', name: '【B线】长期维系', morning: false, evening: false, day: 7,
    dialogues: [
      { id: 'd7_14_1', en: 'I keep painting either way, so you\'ll keep getting photos. Fair warning.',
        zh: '反正我还是会画，所以你还是会收到照片。提前警告一下。', sent: false },
      { id: 'd7_14_2', en: 'Not because of anything. Just because that\'s what I do.',
        zh: '不是因为什么。就因为这是我干的事。', sent: false },
      { id: 'd7_14_3', en: 'Good. Glad that\'s settled.',
        zh: '好。这事说定了我就放心了。', sent: false },
    ],
  },
  {
    id: 'f7_15', name: '【B线】白天经历（晚）', morning: false, evening: true, day: 7,
    dialogues: [
      { id: 'd7_15_1', en: 'Long day. Painted, cleaned up, painted again.',
        zh: '长的一天。画画、收拾、再画。', sent: false },
      { id: 'd7_15_2', en: 'The studio smells like turpentine and I\'ve stopped noticing it.',
        zh: '画室一股松节油味，我已经闻不出来了。', sent: false },
      { id: 'd7_15_3', en: '{name}, how was your day? Anything worth reporting?',
        zh: '{称呼}，你今天怎么样？有什么值得汇报的吗？', sent: false },
      { id: 'd7_15_4', en: 'Good. I like your good days.',
        zh: '好。我喜欢你的好日子。', sent: false },
    ],
  },
];

/* ---------------- 「后期维护」种子（2026-09-30：12 碎片，新增 6 个"日常碎碎念" + A线专属 2 个） ---------------- */
const SEED_MAINTENANCE = [
  {
    id: 'f8_1', name: '日常回访 · 捡他提过的事', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_1_1', en: 'How did that thing go, by the way? The one you mentioned.',
        zh: '对了，那件事后来怎么样了？你之前提过的那个。', sent: false },
      { id: 'd8_1_2', en: 'I remembered the other day — {他的原话或细节}. It stuck with me.',
        zh: '我前两天想起来——{他的原话或细节}。我一直记着。', sent: false },
      { id: 'd8_1_3', en: 'No rush to reply. I just thought of it.',
        zh: '不用急着回。我就是想到了。', sent: false },
    ],
  },
  {
    id: 'f8_2', name: '继续分享生活（不聊画）', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_2_1', en: 'Still painting. Still being supervised by a cat who has no qualifications.',
        zh: '还在画。还在被一只毫无资质的猫监工。', sent: false },
      { id: 'd8_2_2', en: 'Found a new breakfast place near the studio. Dangerous discovery.',
        zh: '画室附近发现了一家新早餐店。发现它有点危险。', sent: false },
      { id: 'd8_2_3', en: 'How\'s your week going, {name}?',
        zh: '{称呼}，你这周怎么样？', sent: false },
    ],
  },
  {
    id: 'f8_3', name: '节日 / 节气问候（不群发模板）', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_3_1', en: 'Happy Thanksgiving, {name}. I know it\'s a whole thing over there — eat too much for me.',
        zh: '{称呼}，感恩节快乐。我知道你们那边挺隆重的——替我多吃点。', sent: false },
      { id: 'd8_3_2', en: 'Merry Christmas, {name}. I hope the day is warm where you are, in every sense.',
        zh: '{称呼}，圣诞快乐。希望你那儿这天是暖的——哪种意义上都是。', sent: false },
    ],
  },
  {
    id: 'f8_4', name: '碎碎念 · 天气', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_4_1', en: 'It rained all day here and I loved it.',
        zh: '这边下了一整天的雨，我很喜欢。', sent: false },
      { id: 'd8_4_2', en: 'I opened the window and just let it come in.',
        zh: '我把窗户打开，就让雨进来。', sent: false },
    ],
  },
  {
    id: 'f8_5', name: '碎碎念 · 刚看到的东西', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_5_1', en: 'Saw a dog on the street today that looked exactly like a {他提过的品种}.',
        zh: '今天在街上看到一只狗，长得特别像{他提过的品种}。', sent: false },
      { id: 'd8_5_2', en: 'I almost took a photo for you and then realised that would be a weird thing to do.',
        zh: '我差点拍下来发给你，然后意识到那样挺奇怪的。', sent: false },
    ],
  },
  {
    id: 'f8_6', name: '碎碎念 · 周末在干嘛', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_6_1', en: 'Quiet weekend here. Painted, ate, slept, repeat.',
        zh: '周末很安静。画画、吃饭、睡觉、循环。', sent: false },
      { id: 'd8_6_2', en: 'I\'m not complaining, by the way. That\'s genuinely what I want to do.',
        zh: '顺便说一句我不是在抱怨。我是真的想干这个。', sent: false },
      { id: 'd8_6_3', en: 'What about you — anything, or nothing?',
        zh: '你呢——有点事，还是什么都没有？', sent: false },
    ],
  },
  {
    id: 'f8_7', name: '碎碎念 · 猫又干了什么', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_7_1', en: 'The cat has started sitting on my palette.',
        zh: '猫开始坐在我的调色盘上了。', sent: false },
      { id: 'd8_7_2', en: 'Not next to it. On it. He\'s decided colours are furniture.',
        zh: '不是旁边。是上面。他决定颜料是家具。', sent: false },
      { id: 'd8_7_3', en: 'Yours does something like this, I know it.',
        zh: '你那只会干类似的事，我知道。', sent: false },
    ],
  },
  {
    id: 'f8_8', name: '碎碎念 · 今天累', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_8_1', en: 'Long one today. Nothing dramatic, just long.',
        zh: '今天很长。没什么戏剧性，就是长。', sent: false },
      { id: 'd8_8_2', en: 'Going to bed early for once.',
        zh: '今天难得早点睡。', sent: false },
    ],
  },
  {
    id: 'f8_9', name: '睡前一句（晚）', morning: false, evening: true, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_9_1', en: 'Goodnight, {name}.',
        zh: '晚安，{称呼}。', sent: false },
      { id: 'd8_9_2', en: 'It\'s raining again. I\'m not mad about it.',
        zh: '又下雨了。我不生气。', sent: false },
    ],
  },
  {
    id: 'f8_10', name: '生活照片（晚）', morning: false, evening: true, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_10_1', en: 'Today looked like this. That\'s it, that\'s the whole report.',
        zh: '今天长这样。就这样，汇报完毕。', sent: false },
    ],
  },
  {
    id: 'f8_11', name: '【仅A线】进度照', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_11_1', en: 'Small update — the background\'s finally behaving.',
        zh: '小更新——背景那块终于听话了。', sent: false },
      { id: 'd8_11_2', en: 'Thought you\'d want to see. Don\'t feel obliged to reply.',
        zh: '想着你可能想看。不用特意回。', sent: false },
    ],
  },
  {
    id: 'f8_12', name: '【仅A线】开工 / 完工节点', morning: false, evening: false, day: DAY_MAINTENANCE,
    dialogues: [
      { id: 'd8_12_1', en: 'Starting today. I\'ll keep you posted.',
        zh: '今天开始。我会一直跟你说进展。', sent: false },
      { id: 'd8_12_2', en: 'It\'s done. I need a day to look at it before I say anything about it.',
        zh: '画完了。我需要一天时间看着它，再说什么。', sent: false },
      { id: 'd8_12_3', en: 'Okay. Here it is.',
        zh: '好。就是这个。', sent: false },
    ],
  },
];

const SEED_DAY3 = [
  {
    id: 'f3_1', name: '早晨的问候（食物）', morning: true, evening: false, day: 3,
    dialogues: [
      { id: 'd3_1_1', en: 'Morning {name}. Two eggs and I burned the first one.',
        zh: '早上好{称呼}。两个蛋，第一个煎糊了。', sent: false },
      { id: 'd3_1_2', en: 'I ate it anyway. I\'m not proud of this.',
        zh: '我还是吃了。这我不太骄傲。', sent: false },
      { id: 'd3_1_3', en: '{name} — are you a proper breakfast person, or just coffee and out the door?',
        zh: '{称呼}——你是正经吃早饭的人，还是咖啡一灌就出门？', sent: false },
      { id: 'd3_1_4', en: 'Coffee-only people always say it\'s efficiency. It\'s never efficiency.',
        zh: '只喝咖啡的人总说这是效率。从来不是效率。', sent: false },
    ],
  },
  {
    id: 'f3_2', name: '居家环境', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_2_1', en: 'This is the part of my home I never show anyone.',
        zh: '这是我家从来不给人看的那部分。', sent: false },
      { id: 'd3_2_2', en: 'There\'s a stack of canvases by the wall that I\'ve been "about to deal with" since spring.',
        zh: '墙边堆着一摞画布，我从春天就"准备处理"到现在了。', sent: false },
      { id: 'd3_2_3', en: 'What\'s the one corner of your place that never gets dealt with, {name}?',
        zh: '{称呼}，你家里哪个角落是永远处理不完的？', sent: false },
      { id: 'd3_2_4', en: 'Okay, that makes me feel much better about the canvases.',
        zh: '行吧，这让我对那摞画布感觉好多了。', sent: false },
    ],
  },
  {
    id: 'f3_3', name: '为什么选择画宠物', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_3_1', en: 'People ask why I paint animals instead of people. It\'s a fair question.',
        zh: '有人问我为什么不画人，要画动物。这问题问得对。', sent: false },
      { id: 'd3_3_2', en: 'People sit for a portrait and they perform. They hold their face a certain way. Animals don\'t perform.',
        zh: '人坐着让人画的时候会演。他们会摆出某种表情。动物不演。', sent: false },
      { id: 'd3_3_3', en: '{name}, do you think that\'s true? Or am I just making excuses for only being good at one thing?',
        zh: '{称呼}，你觉得这是真的吗？还是我在给自己只会一样东西找借口？', sent: false },
      { id: 'd3_3_4', en: 'You know what — I hadn\'t thought about it that way. That\'s actually a better reason than mine.',
        zh: '你知道吗——我没想到这个角度。这理由比我的好。', sent: false },
    ],
  },
  {
    id: 'f3_4', name: '分享以前的油画', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_4_1', en: 'I found this while I was looking for something else. Painted it four years ago.',
        zh: '我找别的东西的时候翻出来的。四年前画的。', sent: false },
      { id: 'd3_4_2', en: 'I can still see everything I got wrong in it. That never goes away.',
        zh: '我现在还能看见里面所有画错的地方。这毛病好不了。', sent: false },
      { id: 'd3_4_3', en: '{name}, do you ever look at something you made years ago and just wince?',
        zh: '{称呼}，你会不会看自己很多年前做的东西，看得直皱眉？', sent: false },
      { id: 'd3_4_4', en: 'Good. So it\'s not just artists.',
        zh: '好，所以这不是画画的毛病。', sent: false },
    ],
  },
  {
    id: 'f3_5', name: '得奖的油画', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_5_1', en: 'Okay, one more and then I\'ll stop. This one won something a few years ago.',
        zh: '好，再来一张我就不发了。这张几年前得过个奖。', sent: false },
      { id: 'd3_5_2', en: 'I\'m telling you because I\'m embarrassed that I care about it.',
        zh: '我告诉你是因为我不好意思——我其实挺在意这个奖的。', sent: false },
      { id: 'd3_5_3', en: 'Did you ever get something you worked for and then feel weirdly flat about it?',
        zh: '你有没有过这种时候——努力拿到一个东西，然后莫名没什么感觉？', sent: false },
      { id: 'd3_5_4', en: 'Right? Exactly that.',
        zh: '对吧？就是这个。', sent: false },
    ],
  },
  {
    id: 'f3_6', name: '正在画的油画（画了 1 天，心情烦恼）', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_6_1', en: 'Day one of a new piece. It looks terrible. That\'s normal, I know that.',
        zh: '新画第一天。很难看。这正常，我知道。', sent: false },
      { id: 'd3_6_2', en: 'I still spend the whole of day one convinced I\'ve forgotten how to do this.',
        zh: '但第一天我永远整颗心都在想"我是不是已经不会画了"。', sent: false },
      { id: 'd3_6_3', en: '{name}, do you get that? Starting something and immediately thinking you\'ve lost it?',
        zh: '{称呼}，你有过吗？刚开始一件事，马上就觉得"我完了"？', sent: false },
      { id: 'd3_6_4', en: 'I\'m going to remember you said that tomorrow morning.',
        zh: '明天早上我会想起你这句话。', sent: false },
    ],
  },
  {
    id: 'f3_7', name: '画宠物有意义 · 有纪念价值（轻描淡写版）', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_7_1', en: 'Someone told me once that a painting of a pet is a strange thing to want.',
        zh: '有人跟我说过，想要一张宠物的画，这挺奇怪的。', sent: false },
      { id: 'd3_7_2', en: 'I don\'t think it is. When you paint an animal, you\'re painting the years, not the animal.',
        zh: '我觉得不奇怪。你画一只动物的时候，画的是那些年，不是那只动物。', sent: false },
      { id: 'd3_7_3', en: '{name}, have you had a pet you still think about?',
        zh: '{称呼}，你有没有一只到现在还会想起的宠物？', sent: false },
      { id: 'd3_7_4', en: 'Tell me about them.',
        zh: '跟我说说。', sent: false },
    ],
  },
  {
    id: 'f3_8', name: '分享视频（15–20 秒，实时拍）', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_8_1', en: 'I\'m sending this because a photo wouldn\'t show you how loud he is.',
        zh: '我发这个是因为照片看不出来他有多吵。', sent: false },
      { id: 'd3_8_2', en: 'That\'s the whole studio. It\'s not bigger than this.',
        zh: '整个画室就这些。就这么大。', sent: false },
      { id: 'd3_8_3', en: '{name}, do you have a spot like this — some corner that\'s just yours?',
        zh: '{称呼}，你有没有这么个地方——只属于你自己的一个角落？', sent: false },
      { id: 'd3_8_4', en: 'I want to see it if you ever feel like sending one.',
        zh: '你要是想发一张，我想看看。', sent: false },
    ],
  },
  {
    id: 'f3_9', name: '作品过程（讲过程，不讲成品）', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_9_1', en: 'This stage is the least impressive and the most honest.',
        zh: '这个阶段最不好看，但最诚实。', sent: false },
      { id: 'd3_9_2', en: 'I spend about four hours getting to a point that looks like nothing happened.',
        zh: '我花四个小时，做到一个看起来什么都没发生的程度。', sent: false },
      { id: 'd3_9_3', en: '{name}, how long does it take you to make something look easy?',
        zh: '{称呼}，你做一件事，要花多久才能做得看起来毫不费力？', sent: false },
      { id: 'd3_9_4', en: 'Okay, so it\'s not just me. That\'s a relief.',
        zh: '所以不只是我这样。那就好。', sent: false },
    ],
  },
  {
    id: 'f3_10', name: '第一次摸需求 · 它最好看的角度', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_10_1', en: 'Can I ask you something about {pet}?',
        zh: '我能问你点关于{宠物}的事吗？', sent: false },
      { id: 'd3_10_2', en: 'I\'m painting animals all week, so it\'s on my mind.',
        zh: '我这一整周都在画动物，所以一直在想这个。', sent: false },
      { id: 'd3_10_3', en: 'Do you know which is {pet}\'s best angle? Everyone\'s got one — even us.',
        zh: '你知道{宠物}最好看的角度是哪个吗？每个都有那么一个——连我们也是。', sent: false },
      { id: 'd3_10_4', en: 'Okay, that\'s the one. I can see it already.',
        zh: '好，就是这个角度。我已经能看见了。', sent: false },
    ],
  },
  {
    id: 'f3_11', name: '从眼睛开始（宠物单招牌细节）', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_11_1', en: 'I always start with the eyes.',
        zh: '我总是从眼睛开始。', sent: false },
      { id: 'd3_11_2', en: 'If that part is right, the rest pretty much paints itself.',
        zh: '那块对了，剩下基本自己就出来了。', sent: false },
      { id: 'd3_11_3', en: '{name}, do you know what I mean? Like — you can tell a person\'s drawing is wrong from the eyes.',
        zh: '{称呼}，你懂我意思吗？就是——一个人画得不对，你看眼睛就知道。', sent: false },
      { id: 'd3_11_4', en: 'Exactly. You see it. Most people don\'t.',
        zh: '就是这个。你看出来了。大部分人看不出来。', sent: false },
    ],
  },
  {
    id: 'f3_12', name: '视频通话（给选项，不追）', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_12_1', en: 'Can I be honest about something?',
        zh: '我能说句实话吗？', sent: false },
      { id: 'd3_12_2', en: 'I\'m always a little worried that people think I\'m not real. It\'s a lot of text and no face.',
        zh: '我一直有点担心别人觉得我不是真人。一堆文字，没有脸。', sent: false },
      { id: 'd3_12_3', en: 'If you ever want to just see me and hear the studio for a minute, I\'d be up for it. It doesn\'t have to be a thing.',
        zh: '你要是想看看我，听听画室的声音，一分钟就行，我随时可以。不用当成什么大事。', sent: false },
      { id: 'd3_12_4', en: 'Or we just keep doing this. Either\'s fine.',
        zh: '或者我们就这么聊。都行。', sent: false },
    ],
  },
  {
    id: 'f3_13', name: '为什么交朋友', morning: false, evening: false, day: 3,
    dialogues: [
      { id: 'd3_13_1', en: 'I have a strange reason for liking this job.',
        zh: '我喜欢这工作有个挺奇怪的原因。', sent: false },
      { id: 'd3_13_2', en: 'I paint alone all day. So the people I talk to here — I actually remember them.',
        zh: '我整天一个人画画。所以我在这儿聊过的人——我是真的记得。', sent: false },
      { id: 'd3_13_3', en: '{name}, do you have people you only know through work or online? Do you count them?',
        zh: '{称呼}，你有没有那种只在工作或者网上认识的朋友？你会把他们算成朋友吗？', sent: false },
      { id: 'd3_13_4', en: 'That\'s how I feel too. I wasn\'t sure if that was reasonable.',
        zh: '我也是这么觉得的。我一直不确定这算不算正常。', sent: false },
    ],
  },
  {
    id: 'f3_14', name: '城市夜景（晚）', morning: false, evening: true, day: 3,
    dialogues: [
      { id: 'd3_14_1', en: 'Went out for a walk just now.',
        zh: '刚出去走了走。', sent: false },
      { id: 'd3_14_2', en: 'Xiamen at night is a different city — everything quiets down and the lights on the water do all the work.',
        zh: '厦门的晚上是另一座城——什么都安静下来，水上的灯把活儿全干了。', sent: false },
      { id: 'd3_14_3', en: 'Is it dark where you are yet, {name}? I can never keep your time straight.',
        zh: '你那边天黑了吗{称呼}？我永远算不明白你的时间。', sent: false },
      { id: 'd3_14_4', en: 'This is going to sound ridiculous, but I keep a note of what time it is where you are.',
        zh: '说出来有点傻，但我一直记着你那边现在几点。', sent: false },
    ],
  },
  {
    id: 'f3_15', name: '白天经历（晚）', morning: false, evening: true, day: 3,
    dialogues: [
      { id: 'd3_15_1', en: 'Today\'s victory: I mixed a colour that actually matched what I saw.',
        zh: '今天的胜利：我调出了一个跟我看见的真的一样的颜色。', sent: false },
      { id: 'd3_15_2', en: 'This happens maybe twice a month.',
        zh: '这种事一个月大概发生两次。', sent: false },
      { id: 'd3_15_3', en: '{name}, did you get anything done today, or was it one of those days?',
        zh: '{称呼}，你今天干成什么事了吗，还是那种什么都没干成的日子？', sent: false },
      { id: 'd3_15_4', en: 'What was it? Tell me the boring version, I like those.',
        zh: '是什么事？跟我说那个无聊的版本，我喜欢听。', sent: false },
    ],
  },
];

/* ---------------- Day 4 种子（2026-09-30 老板要求：每天 15 个碎片 + 引导链） ----------------
   可读版见 knowledge/playbook/day4.md。t: 'm'=早 / 'e'=晚 / ''=通用。 */
const SEED_DAY4 = [
  {
    id: 'f4_1', name: '早餐照片（食物）', morning: true, evening: false, day: 4,
    dialogues: [
      { id: 'd4_1_1', en: 'Morning {name}. I made too much again. I always make too much.',
        zh: '早上好{称呼}。我又做多了。我永远做多。', sent: false },
      { id: 'd4_1_2', en: 'There\'s enough congee in this kitchen for a small village.',
        zh: '这厨房里的粥够一个小村子吃的。', sent: false },
      { id: 'd4_1_3', en: 'You\'re not a breakfast person, are you? I\'m guessing coffee and straight to work.',
        zh: '你不是会好好吃早饭那种人吧？我猜是咖啡一杯直接上班。', sent: false },
      { id: 'd4_1_4', en: 'I knew it. You\'ve got that look.',
        zh: '我就知道。你身上有那股劲儿。', sent: false },
    ],
  },
  {
    id: 'f4_2', name: '生活对换', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_2_1', en: '{name}, I\'m very casual about almost everything and completely unreasonable about painting.',
        zh: '{称呼}，我几乎什么都随便，就在画上一点不含糊。', sent: false },
      { id: 'd4_2_2', en: 'My studio\'s a mess. The painting itself — no. That part I don\'t compromise on.',
        zh: '画室乱七八糟。画本身——不行。那部分我不让步。', sent: false },
      { id: 'd4_2_3', en: 'I\'m guessing you\'re the opposite. Everything in its place.',
        zh: '我猜你是反过来的。什么都摆得整整齐齐。', sent: false },
      { id: 'd4_2_4', en: 'No? Okay, I\'m bad at this. What\'s the actual mess in your life?',
        zh: '不是？行吧，我不太会猜。那你生活里真正乱的是哪块？', sent: false },
    ],
  },
  {
    id: 'f4_3', name: '环境对换', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_3_1', en: 'Has the weather turned where you are?',
        zh: '你那边天气变了吗？', sent: false },
      { id: 'd4_3_2', en: 'It\'s finally cool here. The sea gets grey and everything smells like salt.',
        zh: '这边终于凉了。海变成灰的，到处都是咸味。', sent: false },
      { id: 'd4_3_3', en: 'I\'m guessing you\'re somewhere that gets proper seasons — not like here.',
        zh: '我猜你在的地方四季分明——不像这儿。', sent: false },
      { id: 'd4_3_4', en: 'So what\'s the worst month where you are? I want to know what I\'d be complaining about.',
        zh: '那你那边最难受的是哪个月？我想知道我要是住在那边会抱怨什么。', sent: false },
    ],
  },
  {
    id: 'f4_4', name: '挂在哪儿（猜）', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_4_1', en: 'Can I guess something about you?',
        zh: '我能猜你个事吗？', sent: false },
      { id: 'd4_4_2', en: 'When people think about a painting like this, they\'re not thinking about the painting. They\'re thinking about where it goes.',
        zh: '大家想这种画的时候，其实想的不是画。想的是它挂哪儿。', sent: false },
      { id: 'd4_4_3', en: 'I\'m guessing it\'s a living room. Somewhere everyone walks past. Not a bedroom — bedrooms are private.',
        zh: '我猜是客厅。大家都会路过的地方。不是卧室——卧室是私密的。', sent: false },
      { id: 'd4_4_4', en: 'No? Where then? I want the picture in my head to be right.',
        zh: '不是？那是哪儿？我想让我脑子里的画面是对的。', sent: false },
    ],
  },
  {
    id: 'f4_5', name: '送给谁（猜）', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_5_1', en: 'Another guess.',
        zh: '再猜一个。', sent: false },
      { id: 'd4_5_2', en: 'A lot of people who ask me about this aren\'t buying it for themselves.',
        zh: '很多人问我这个，其实不是给自己买的。', sent: false },
      { id: 'd4_5_3', en: 'I\'m guessing this one\'s for someone else. A partner, or someone who\'s not around anymore.',
        zh: '我猜这张是给别人买的。伴侣，或者一个已经不在了的人。', sent: false },
      { id: 'd4_5_4', en: 'I\'m sorry. But that\'s a good reason. It\'s the best one there is.',
        zh: '我很抱歉。但这是个好理由。这是最好的理由。', sent: false },
    ],
  },
  {
    id: 'f4_6', name: '画面猜测 · 门口等你', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_6_1', en: 'I have a picture in my head and I want to know if it\'s right.',
        zh: '我脑子里有个画面，我想知道对不对。', sent: false },
      { id: 'd4_6_2', en: 'It\'s him at the door. Not the whole room — just the door, and him looking up. Because that\'s the moment, isn\'t it?',
        zh: '是他在门口。不要整个房间——就门口，他抬头看。因为那个瞬间才是重点，对吧？', sent: false },
      { id: 'd4_6_3', en: 'The waiting. That\'s the part people actually remember.',
        zh: '等待。这才是人真正记得的部分。', sent: false },
      { id: 'd4_6_4', en: 'Yeah. That\'s the one. I could paint that.',
        zh: '对。就是这个。我能画这个。', sent: false },
    ],
  },
  {
    id: 'f4_7', name: '它几岁了（轻口）', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_7_1', en: 'How old is {pet} now?',
        zh: '{宠物}现在几岁了？', sent: false },
      { id: 'd4_7_2', en: 'I ask because the age changes the painting. Young ones — you paint the energy. Older ones — you paint the calm.',
        zh: '我问是因为年龄会改变画法。年轻的——画那股劲。年纪大的——画那份安静。', sent: false },
      { id: 'd4_7_3', en: 'Where is {pet} on that scale?',
        zh: '{宠物}算哪一头？', sent: false },
      { id: 'd4_7_4', en: 'That\'s a good age. That\'s the age where they\'re doing the most living.',
        zh: '好年纪。这是它们活得最像自己的年纪。', sent: false },
    ],
  },
  {
    id: 'f4_8', name: '最近的变化', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_8_1', en: 'Has anything changed with {pet} lately?',
        zh: '{宠物}最近有什么变化吗？', sent: false },
      { id: 'd4_8_2', en: 'People tell me these things out of nowhere — a new habit, a new favourite spot, sleeping more.',
        zh: '别人经常突然跟我说这些——新习惯、新喜欢的位置、睡得更多了。', sent: false },
      { id: 'd4_8_3', en: 'Anything like that?',
        zh: '有吗？', sent: false },
      { id: 'd4_8_4', en: 'That\'s the kind of thing worth keeping. Not the photo — the habit.',
        zh: '这种事值得留下来。不是照片——是这个习惯。', sent: false },
    ],
  },
  {
    id: 'f4_9', name: '追问深度 · 为什么是它', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_9_1', en: 'Can I ask you something that might sound like a strange question?',
        zh: '我能问个听着有点奇怪的问题吗？', sent: false },
      { id: 'd4_9_2', en: 'Of all the things in your life — why would it be him?',
        zh: '你生活里那么多东西——为什么要是他？', sent: false },
      { id: 'd4_9_3', en: 'I ask everyone this. Most people don\'t have an answer ready.',
        zh: '我每个人都问。大部分人都没有现成的答案。', sent: false },
      { id: 'd4_9_4', en: 'That\'s the answer. That\'s the whole painting right there.',
        zh: '这就是答案。整张画就在这句话里。', sent: false },
    ],
  },
  {
    id: 'f4_10', name: '画面感 · 你现在想到它是什么样子', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_10_1', en: 'Close your eyes for a second.',
        zh: '闭一下眼睛。', sent: false },
      { id: 'd4_10_2', en: 'Not the photo. The version in your head.',
        zh: '不是照片那个。是你脑子里那个版本。', sent: false },
      { id: 'd4_10_3', en: 'What is he doing?',
        zh: '他在干什么？', sent: false },
      { id: 'd4_10_4', en: 'That. That\'s the one I\'d paint. Not the photo. That.',
        zh: '就是这个。这才是我会画的那个。不是照片。是这个。', sent: false },
    ],
  },
  {
    id: 'f4_11', name: '请教他 · 他擅长的领域', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_11_1', en: '{name}, can I ask you something completely unrelated?',
        zh: '{称呼}，我能问你个完全不相关的事吗？', sent: false },
      { id: 'd4_11_2', en: 'I know nothing about what you do. Nothing. And I\'m curious.',
        zh: '我对你做的事一无所知。真的完全不懂。我很好奇。', sent: false },
      { id: 'd4_11_3', en: 'What\'s the thing in your job that looks easy to outsiders and is actually really hard?',
        zh: '你这一行里，有什么是外人看着简单、其实特别难的？', sent: false },
      { id: 'd4_11_4', en: 'I had no idea. That\'s actually the same as painting, just in a different language.',
        zh: '我完全不知道。这其实跟画画一样，就是换了个语言。', sent: false },
    ],
  },
  {
    id: 'f4_12', name: '他的名字 / 来历', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_12_1', en: 'Okay, I\'ve been meaning to ask.',
        zh: '好，我一直想问。', sent: false },
      { id: 'd4_12_2', en: 'Why that name?',
        zh: '为什么叫这个名字？', sent: false },
      { id: 'd4_12_3', en: 'I knew there\'d be a story. There\'s always a story.',
        zh: '我就知道有故事。一定都有故事。', sent: false },
      { id: 'd4_12_4', en: 'I\'m going to remember that.',
        zh: '我会记住的。', sent: false },
    ],
  },
  {
    id: 'f4_13', name: '你有多久没见它了（重，小心用）', morning: false, evening: false, day: 4,
    dialogues: [
      { id: 'd4_13_1', en: 'Can I ask how long it\'s been?',
        zh: '我能问一下，过去多久了吗？', sent: false },
      { id: 'd4_13_2', en: 'I\'m not asking to be morbid. I\'m asking because it changes how I\'d see it.',
        zh: '我问不是要揭伤口。我问是因为这会影响我怎么看它。', sent: false },
      { id: 'd4_13_3', en: 'If you\'d rather not, that\'s completely fine.',
        zh: '你要是不想说，完全没关系。', sent: false },
      { id: 'd4_13_4', en: 'Thank you for telling me.',
        zh: '谢谢你告诉我。', sent: false },
    ],
  },
  {
    id: 'f4_14', name: '白天经历（晚）', morning: false, evening: true, day: 4,
    dialogues: [
      { id: 'd4_14_1', en: 'Painted all afternoon and got one ear right. One.',
        zh: '画了一下午，画对了一只耳朵。一只。', sent: false },
      { id: 'd4_14_2', en: 'I\'m choosing to see this as progress.',
        zh: '我选择把这当成进步。', sent: false },
      { id: 'd4_14_3', en: '{name}, did today go the way you wanted, or did it get away from you?',
        zh: '{称呼}，今天是你想要的样子，还是被日子带跑了？', sent: false },
      { id: 'd4_14_4', en: 'Good. Tell me the part you\'re quietly pleased about.',
        zh: '好。跟我说说你偷偷得意的那部分。', sent: false },
    ],
  },
  {
    id: 'f4_15', name: '画面延续（晚）', morning: false, evening: true, day: 4,
    dialogues: [
      { id: 'd4_15_1', en: 'I\'m still thinking about what you said earlier.',
        zh: '我还在想你今天早些时候说的那些。', sent: false },
      { id: 'd4_15_2', en: 'About him at the door. That image stayed with me all afternoon.',
        zh: '关于他在门口那个画面。这画面在我脑子里待了一下午。', sent: false },
      { id: 'd4_15_3', en: 'Not everyone gives me an image that clear.',
        zh: '不是每个人都能给我这么清楚的画面。', sent: false },
      { id: 'd4_15_4', en: 'I\'m going to keep it, if that\'s alright.',
        zh: '我想留着，如果可以的话。', sent: false },
    ],
  },
];

/* ---------------- Day 6 种子（2026-09-30 老板要求：每天 15 个碎片 + 引导链） ----------------
   可读版见 knowledge/playbook/day6.md。t: 'm'=早 / 'e'=晚 / ''=通用。 */
const SEED_DAY6 = [
  {
    id: 'f6_1', name: '早餐照片（食物）', morning: true, evening: false, day: 6,
    dialogues: [
      { id: 'd6_1_1', en: 'Morning {name}. Congee. Again.',
        zh: '早上好{称呼}。粥。又是。', sent: false },
      { id: 'd6_1_2', en: 'Six days and you now know exactly what I eat.',
        zh: '六天了，你现在完全知道我吃什么。', sent: false },
      { id: 'd6_1_3', en: 'Does that feel like a long time or a short time to you?',
        zh: '对你来说这算长还是算短？', sent: false },
      { id: 'd6_1_4', en: 'Same. It went faster than I expected.',
        zh: '一样。比我预想的快。', sent: false },
    ],
  },
  {
    id: 'f6_2', name: '只给不取 · 勾一张小构图（今天第一步）', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_2_1', en: 'I sketched something this morning. Not for anything — I just wanted to see it.',
        zh: '我早上勾了个东西。不是为了什么——我就是想看看它长什么样。', sent: false },
      { id: 'd6_2_2', en: 'It\'s rough. The proportions are off. But the feeling is there.',
        zh: '很糙。比例也不对。但感觉对了。', sent: false },
      { id: 'd6_2_3', en: 'I don\'t know yet. I just wanted to see it on paper.',
        zh: '我还不知道。我就是想看看它在纸上是什么样。', sent: false },
    ],
  },
  {
    id: 'f6_3', name: '让他自己说 · 把画面推给他（本天主线）', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_3_1', en: 'Can I show you what I actually see when you describe him?',
        zh: '我能给你看看你描述他的时候，我脑子里是什么样吗？', sent: false },
      { id: 'd6_3_2', en: 'Just the eyes and the tilt of the head. Everything else is empty.',
        zh: '只有眼睛和头歪的角度。其他全是空的。', sent: false },
      { id: 'd6_3_3', en: 'That\'s a painting. I don\'t know how else to say it.',
        zh: '这就是一张画。我不知道还能怎么说。', sent: false },
    ],
  },
  {
    id: 'f6_4', name: '如果他要开口 · 怎么接（本天最关键）', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_4_1', en: 'Yeah?',
        zh: '真的？', sent: false },
      { id: 'd6_4_2', en: 'I\'d love that.',
        zh: '我很愿意。', sent: false },
      { id: 'd6_4_3', en: 'Let me write down what you said so I don\'t get it wrong.',
        zh: '让我把你说的话记下来，免得我记错了。', sent: false },
      { id: 'd6_4_4', en: 'Let\'s talk about that properly tomorrow — I want to get this one right, and I\'d rather not rush it.',
        zh: '这些我们明天好好说——这一张我想做对，不想赶。', sent: false },
    ],
  },
  {
    id: 'f6_5', name: '如果他没开口 · 退回轻松（不许硬推）', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_5_1', en: 'Anyway. That\'s my morning. How\'s yours going?',
        zh: '总之。这就是我的早上。你那边怎么样？', sent: false },
      { id: 'd6_5_2', en: 'I\'m going to go make a mess of some canvas.',
        zh: '我要去把画布搞乱了。', sent: false },
      { id: 'd6_5_3', en: 'No pressure on any of that, by the way.',
        zh: '顺便说一句，那些都别有压力。', sent: false },
    ],
  },
  {
    id: 'f6_6', name: '轻口 · 他宠物的一个小毛病', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_6_1', en: 'Tell me something annoying {pet} does.',
        zh: '跟我说一个{宠物}让人烦的小毛病。', sent: false },
      { id: 'd6_6_2', en: 'Every animal has one. The orange one knocks things off tables for entertainment.',
        zh: '每只动物都有。橘猫扒东西下桌当娱乐。', sent: false },
      { id: 'd6_6_3', en: 'That\'s worse than mine. I feel better about my cat now.',
        zh: '那比我这个严重。我现在对我家猫感觉好多了。', sent: false },
    ],
  },
  {
    id: 'f6_7', name: '自嘲 · 我今天什么也没画完', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_7_1', en: 'I have to admit something. I didn\'t finish anything today.',
        zh: '我得承认一件事。我今天什么都没画完。', sent: false },
      { id: 'd6_7_2', en: 'Some days the paint just doesn\'t behave.',
        zh: '有些日子颜料就是不听话。', sent: false },
      { id: 'd6_7_3', en: '{name}, do you have days where you just can\'t get anything done?',
        zh: '{称呼}，你有那种什么都干不成的日子吗？', sent: false },
      { id: 'd6_7_4', en: 'Okay good. So it\'s not a character flaw.',
        zh: '好。那就不是性格缺陷。', sent: false },
    ],
  },
  {
    id: 'f6_8', name: '请教他 · 你觉得我该注意什么', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_8_1', en: '{name}, can I ask your opinion on something?',
        zh: '{称呼}，我能问你个意见吗？', sent: false },
      { id: 'd6_8_2', en: 'I get too close to my own work. I can\'t see it anymore.',
        zh: '我对自己的东西离得太近了。我看不见它了。', sent: false },
      { id: 'd6_8_3', en: 'If you were me — working on that one — what would you pay attention to?',
        zh: '如果你是我——在弄那一张——你会注意什么？', sent: false },
      { id: 'd6_8_4', en: 'That\'s a good one. I hadn\'t thought about that.',
        zh: '这个好。我没想到这一点。', sent: false },
    ],
  },
  {
    id: 'f6_9', name: '你希望它挂在哪儿（画面收口）', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_9_1', en: 'One more question and then I\'ll leave you alone.',
        zh: '再问一个问题就不烦你了。', sent: false },
      { id: 'd6_9_2', en: 'If it existed — if it were sitting somewhere in your house right now — where would it be?',
        zh: '如果它存在——如果它现在就放在你家某个地方——它会在哪儿？', sent: false },
      { id: 'd6_9_3', en: 'I can picture that. That\'s a good spot.',
        zh: '我能想象出来。那个位置很好。', sent: false },
    ],
  },
  {
    id: 'f6_10', name: '生活对换', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_10_1', en: 'What\'s the thing you\'re looking forward to this week?',
        zh: '你这周有什么在盼着的事？', sent: false },
      { id: 'd6_10_2', en: 'Not a big thing. Something small.',
        zh: '不用大事。小事就行。', sent: false },
      { id: 'd6_10_3', en: 'That\'s a good one. I\'d look forward to that too.',
        zh: '这个好。我也会盼着这个。', sent: false },
    ],
  },
  {
    id: 'f6_11', name: '环境对换', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_11_1', en: 'Does it get dark early where you are now?',
        zh: '你那边现在天黑得早了吗？', sent: false },
      { id: 'd6_11_2', en: 'It\'s getting dark here at six and I hate it.',
        zh: '这边六点就黑了，我讨厌这样。', sent: false },
      { id: 'd6_11_3', en: 'Really? Okay, defend that. I want to hear it.',
        zh: '真的？行，说个理由。我想听。', sent: false },
    ],
  },
  {
    id: 'f6_12', name: '名字用回去', morning: false, evening: false, day: 6,
    dialogues: [
      { id: 'd6_12_1', en: '{pet} — I noticed I\'ve been calling him that all week now.',
        zh: '{宠物}——我发现我这周一直这么叫他了。', sent: false },
      { id: 'd6_12_2', en: 'It\'s a good name. It fits.',
        zh: '名字很好。很贴。', sent: false },
      { id: 'd6_12_3', en: 'Where\'s he right now, by the way?',
        zh: '对了，他现在在哪儿？', sent: false },
    ],
  },
  {
    id: 'f6_13', name: '白天经历（晚）', morning: false, evening: true, day: 6,
    dialogues: [
      { id: 'd6_13_1', en: 'Long day. Painted, cleaned up, painted again.',
        zh: '长的一天。画画、收拾、再画。', sent: false },
      { id: 'd6_13_2', en: 'The studio smells like turpentine and I\'ve stopped noticing it.',
        zh: '画室一股松节油味，我已经闻不出来了。', sent: false },
      { id: 'd6_13_3', en: '{name}, how was your day? Anything worth reporting?',
        zh: '{称呼}，你今天怎么样？有什么值得汇报的吗？', sent: false },
      { id: 'd6_13_4', en: 'Those. I had one of those yesterday.',
        zh: '那种日子。我昨天就过了一个。', sent: false },
    ],
  },
  {
    id: 'f6_14', name: '进度照（晚）', morning: false, evening: true, day: 6,
    dialogues: [
      { id: 'd6_14_1', en: 'This is what my table looks like at the end of the day.',
        zh: '这是我桌子一天结束时的样子。', sent: false },
      { id: 'd6_14_2', en: 'I\'ll deal with it tomorrow. I always say that.',
        zh: '我明天收拾。我每次都这么说。', sent: false },
      { id: 'd6_14_3', en: 'You have a table like this too. I know you do.',
        zh: '你也有这么一张桌子。我知道你有。', sent: false },
    ],
  },
  {
    id: 'f6_15', name: '不用回我（晚）', morning: false, evening: true, day: 6,
    dialogues: [
      { id: 'd6_15_1', en: '{name}, I know it\'s late there.',
        zh: '{称呼}，我知道你那边很晚了。', sent: false },
      { id: 'd6_15_2', en: 'I don\'t need an answer to any of this today.',
        zh: '这些我今天不需要任何答复。', sent: false },
      { id: 'd6_15_3', en: 'Just — goodnight.',
        zh: '就是——晚安。', sent: false },
    ],
  },
];

/** 编号安全化（编号可能含字母数字，做一层过滤避免路径穿越）。 */
function safeCode(code) {
  const safe = String(code || '').replace(/[^A-Za-z0-9]/g, '');
  if (!safe) throw new Error('invalid code');
  return safe;
}

function boardFile(code) {
  return path.join(BOARD_DIR, `${safeCode(code)}.json`);
}

/* ---------------- 本地「已发」状态（v1.0.8：彻底不连云端） ----------------
 * 「已发 / 恢复」只是老板自己的一张进度清单（哪条话术已经发过了），不需要多人共享，
 * 所以从 v1.0.8 起**只写本机**，一个网络请求都不发。
 *
 * 为什么单独放一个文件（board/<编号>.sent.json），而不是写进看板 json：
 *   登录云端时，看板内容会整份覆盖本地 board/<编号>.json（saveLocalSnapshot），
 *   已发状态混在里面一被覆盖就没了。单独一个文件跟内容解耦，谁也冲不掉谁。
 *
 * 存法：{ "<对话id>": true | false }
 *   · 只记「点过」的条目；没记过的 = 还没点（当作未发）
 *   · 首次读到云端老数据里的 sent=true 时自动采纳一次 —— 老进度不丢（迁移用）
 * ========================================================================= */
function sentFile(code) { return path.join(BOARD_DIR, `${safeCode(code)}.sent.json`); }

/* ---------------- 通用内容（一份，所有客户共享） ----------------
 * 2026-10-22 优化（老板要求）：话题碎片 + 对话信息 是「通用内容」，全账号只存一份，
 * 不再按客户号分叉（之前 board/<编号>.json 各自独立，导致 A 客户改了 B 客户看不到）。
 * 内容统一落在 board/_master.json；任务进度（用过哪些碎片/对话）仍按
 * board/<编号>.sent.json 各自保留（见 sentFile），本机先存、联网时同步后台。
 */
const MASTER_BOARD_KEY = '_master';
function masterBoardFile() { return path.join(BOARD_DIR, `${MASTER_BOARD_KEY}.json`); }

function loadMasterBoard() {
  const f = masterBoardFile();
  if (fs.existsSync(f)) {
    try {
      const b = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (b && Array.isArray(b.fragments)) {
        if (normalizeBoard(b)) saveMasterBoard(b);  // 老数据补字段 / 修 id 后落盘
        return b;
      }
    } catch (e) { /* 烂文件就重建 */ }
  }
  // 首次：优先用云端通用主数据缓存，否则本地内置种子；两者都是「通用内容」
  const seed = cloudMasterSeed() || buildSeed();
  normalizeBoard(seed);
  saveMasterBoard(seed);
  return seed;
}

function saveMasterBoard(board) {
  ensureDir();
  // 落盘前统一算一遍完成标记：任何一次增删改之后，返回给界面的 board 里
  // sentCount / total / doneAll 都是新的（不然新加的碎片 / 新加的对话会带着旧值）
  markDone(board);
  fs.writeFileSync(masterBoardFile(), JSON.stringify(board, null, 2), 'utf8');
}

function loadSentMap(code) {
  try {
    const f = sentFile(code);
    if (!fs.existsSync(f)) return {};
    const m = JSON.parse(fs.readFileSync(f, 'utf8'));
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  } catch (e) { return {}; }
}

function saveSentMap(code, map) {
  try {
    ensureDir();
    fs.writeFileSync(sentFile(code), JSON.stringify(map, null, 2), 'utf8');
  } catch (e) { /* 落不下就下次再来，界面上的样子不受影响 */ }
}

/** 每个碎片算一遍：已发几条 / 共几条 / 是不是全部发完（全部发完 = 这个话题完成了）。 */
function markDone(board) {
  if (!board || !Array.isArray(board.fragments)) return board;
  board.fragments.forEach((f) => {
    const ds = f.dialogues || [];
    f.sentCount = ds.filter((d) => d && d.sent).length;
    f.total = ds.length;
    f.doneAll = ds.length > 0 && f.sentCount === ds.length;
  });
  return board;
}

/** 这个碎片是不是「对话全部发完了」。空碎片不算完成 —— 还能往里加对话。 */
function fragmentDone(f) {
  const ds = (f && f.dialogues) || [];
  return ds.length > 0 && ds.every((d) => d && d.sent);
}

/** 迁移兜底：把「本地看板文件里还留着的 sent=true」也收进 sent.json。
 *  为什么需要这一步：v1.0.8 之前「已发」是存在云端的，本地看板文件里那份是抄下来的。
 *  万一云端那条记录已经没了（后台删碎片会连带删对话记录），本地就是唯一凭据 ——
 *  必须先收进 sent.json，才不会被「云端那份（全 false）」覆盖掉。
 *  ⚠️ 只补「本地还没记过」的 id，绝不覆盖已有记录（不然用户点过的「恢复」会被顶回来）。 */
function adoptLocalSent(code, map) {
  let changed = false;
  try {
    const f = boardFile(code);
    if (!fs.existsSync(f)) return false;
    const b = JSON.parse(fs.readFileSync(f, 'utf8'));
    ((b && b.fragments) || []).forEach((fr) => {
      ((fr && fr.dialogues) || []).forEach((d) => {
        if (!d || !d.id) return;
        if (d.sent && !Object.prototype.hasOwnProperty.call(map, d.id)) { map[d.id] = true; changed = true; }
      });
    });
  } catch (e) { /* 老文件读不动就算了，不影响新数据 */ }
  return changed;
}

/** 把本地已发状态叠加到看板上（看板内容可能来自云端），并算出完成标记。
 *  两个「迁移」入口：① 本地看板文件里遗留的 sent=true；② 看板自带 sent=true 但本地没记过的
 *  （= 云端老仓库里的已发）。都只补一次、只补缺的，之后一律以 sent.json 为准。 */
function applySentState(code, board) {
  if (!board || !Array.isArray(board.fragments)) return board;
  const map = loadSentMap(code);
  let changed = adoptLocalSent(code, map);
  board.fragments.forEach((f) => {
    (f.dialogues || []).forEach((d) => {
      if (!d || !d.id) return;
      if (Object.prototype.hasOwnProperty.call(map, d.id)) {
        d.sent = !!map[d.id];
      } else if (d.sent) {
        map[d.id] = true;
        changed = true;
      }
    });
  });
  if (changed) saveSentMap(code, map);
  return markDone(board);
}

/** 拿到云端那份看板之后固定要做的三件事（顺序不能换）：
 *  ① 用本地已发状态盖掉云端那份的 sent（顺带把本地文件里的旧已发收进 sent.json）；
 *  ② 再落成本地快照 —— 必须先「收」再「盖」，否则旧已发会被这份快照冲掉。 */
function mergeCloudBoard(code, b) {
  applySentState(code, b);
  saveLocalSnapshot(code, b);
  return b;
}

/* 老看板数据只有 evening 一个字段（没有 morning）。首次读到这种数据时按 id / 名称回填，
   让「早餐照片」变早上、「白天经历 / 经历照片」变晚上、其余都当通用。
   提示表只用于迁移，认不出的碎片一律当通用（两者皆 false，任何时段都可用）。 */
const SEED_TIME_BY_ID = {
  f_breakfast: { morning: true, evening: false },
  f_dayexp: { morning: false, evening: true },
  f_expphoto: { morning: false, evening: true },
};
const SEED_TIME_BY_NAME = {
  '早餐照片（食物）': { morning: true, evening: false },
  '白天经历': { morning: false, evening: true },
  '经历照片': { morning: false, evening: true },
};

/** 对话 id 必须全看板唯一（后端按 id 定位对话）。老数据里各碎片都叫 d1/d2…，
 *  这里把「重复的 / 缺失的」重新发一个 uid；返回是否改动过（改过就要落盘）。 */
function ensureUniqueIds(board) {
  let changed = false;
  if (!board || !Array.isArray(board.fragments)) return false;
  const seen = new Set();
  board.fragments.forEach((f) => {
    if (!f || typeof f !== 'object') return;
    if (!f.id || seen.has('f:' + f.id)) { f.id = uid('f'); changed = true; }
    seen.add('f:' + f.id);
    if (!Array.isArray(f.dialogues)) { f.dialogues = []; changed = true; }
    f.dialogues.forEach((d) => {
      if (!d || typeof d !== 'object') return;
      if (!d.id || seen.has('d:' + d.id)) { d.id = uid('d'); changed = true; }
      seen.add('d:' + d.id);
      if (typeof d.sent !== 'boolean') { d.sent = false; changed = true; }
    });
  });
  return changed;
}

/** 每个碎片都要有 day（第几天的话题碎片，默认 1）。老数据 / 种子缺省补 1。返回是否改动过。 */
function normalizeDays(board) {
  let changed = false;
  if (!board || !Array.isArray(board.fragments)) return false;
  board.fragments.forEach((f) => {
    if (!f || typeof f !== 'object') return;
    const d = Number(f.day);
    if (!Number.isFinite(d) || d < 1) { f.day = 1; changed = true; }
    else if (d !== Math.floor(d)) { f.day = Math.floor(d); changed = true; }
  });
  return changed;
}

/** 归一化：保证每个碎片都有 morning / evening 两个布尔、以及 day。返回是否改动过（改过就要落盘）。 */
function normalizeBoard(board) {
  let changed = false;
  if (!board || !Array.isArray(board.fragments)) return false;
  board.fragments.forEach((f) => {
    if (!f || typeof f !== 'object') return;
    if (typeof f.morning === 'boolean' && typeof f.evening === 'boolean') return;
    const hint = SEED_TIME_BY_ID[f.id] || SEED_TIME_BY_NAME[f.name];
    if (hint) {
      f.morning = !!hint.morning;
      f.evening = !!hint.evening;
    } else {
      f.morning = false;
      f.evening = typeof f.evening === 'boolean' ? !!f.evening : false;
    }
    changed = true;
  });
  if (normalizeDays(board)) changed = true;     // 碎片缺 day 就补 1（2026-09-30 起按 Day 分页）
  if (ensureUniqueIds(board)) changed = true;   // 顺手修掉重复的对话 id
  return changed;
}

function ensureDir() {
  if (!fs.existsSync(BOARD_DIR)) fs.mkdirSync(BOARD_DIR, { recursive: true });
}

/** 组装新客户的完整种子：Day1 15 + Day2 17 + Day3 15 + Day4 15 + Day5 16 + Day6 15 + Day7 15 + 后期维护 12。
 *  ⚠️ 只用于【新建】客户看板。已有看板一律不动 —— 老客户翻到空页由老板手动加碎片
 *  （2026-09-30 老板明确：存量客户的后几页碎片他自己给）。 */
function buildSeed() {
  const fragments = [].concat(SEED_DAY1).concat(SEED_DAY2).concat(SEED_DAY3).concat(SEED_DAY4)
    .concat(SEED_DAY5).concat(SEED_DAY6).concat(SEED_DAY7).concat(SEED_MAINTENANCE)
    .map(clone);
  // 2026-10-06 老板定：V3.7.6.1 那 267 个碎片只放云端主数据（master_fragments），
  // 由后台统一管理、桌面端不再本地内置（SEED_V376 已从buildSeed 断开）。
  return { day: 1, fragments };
}

/** 【异步版】读看板：登录云端时用云端的合并结果（主数据 + 自己编号的差异）；
 *  否则退回本地。界面走这个；测试和老调用点仍可用同步的 getBoard()。 */
/** 【异步版】读看板：内容 = 通用一份（board/_master.json），进度 = 按客户号叠加。
 *  这样在 A 客户档案的编排台里加的碎片，切到 B 客户也能立刻看到（老板 2026-10-22 要求）。 */
async function getBoardAsync(code) {
  const board = loadMasterBoard();
  return applySentState(code, clone(board));
}

/** 把云端合并结果落一份本地快照（只读用途，不要拿它当权威）。 */
function saveLocalSnapshot(code, board) {
  try {
    ensureDir();
    fs.writeFileSync(boardFile(code), JSON.stringify(board, null, 2), 'utf8');
  } catch (e) { /* 快照写不了无所谓 */ }
}

/** 读取某客户的看板；不存在则用完整种子（Day1+Day2+后期维护）初始化并落盘。
 *  ⚠️ 已存在的看板只做格式归一（补字段 / 修 id），**绝不追加任何碎片**。 */
/**
 * 云端同步下来的主数据当种子（「同步话题」按钮拉下来的那份）。
 * 没登录云端 / 没同步过 → 返回 null，退回内置种子。
 */
function cloudMasterSeed() {
  const c = cloudMod();
  if (!c) return null;
  try {
    const m = c.cachedMaster();
    const frags = (m && m.fragments) || [];
    if (!frags.length) return null;
    return { day: 1, fragments: clone(frags) };
  } catch (e) { return null; }
}

function getBoard(code) {
  // 内容 = 通用一份（board/_master.json）；进度 = 按客户号叠加（不写回主内容）
  const board = loadMasterBoard();
  return applySentState(code, clone(board));
}

function saveBoard(code, board) {
  // 通用内容统一落 _master.json（code 仅保留签名兼容，不再按客户号分叉）
  saveMasterBoard(board);
}

function findFragment(board, fid) {
  return board.fragments.find((f) => f.id === fid);
}
/** 按 id 找对话；给了 fid 就只在该碎片里找（双保险，防止历史数据 id 撞车时改错条）。 */
function findDialogue(board, did, fid) {
  const lone = fid ? board.fragments.find((f) => f.id === fid) : null;
  const list = lone ? [lone] : board.fragments;
  for (const f of list) {
    const d = (f.dialogues || []).find((x) => x.id === did);
    if (d) return { fragment: f, dialogue: d };
  }
  return null;
}

/* ---------------- 写操作（都返回更新后的 board） ----------------
 * ⚠️ v1.0.1 起，每个写操作都多了一个异步版（xxxAsync）：登录云端时写云端仓库，
 *    没登录时走原来的本地逻辑。本地版保持原样，测试与老调用点不受影响。
 *    云端只写「自己编号的仓库」，主数据一个字节都不动。
 * ⚠️ v1.0.8 例外：setSent / setFragmentSentAll（已发 / 恢复）**不论登没登录都只写本机**
 *    —— 它是老板自己的进度清单，不该受网络影响，也不该动云端数据。
 */

async function addFragmentAsync(code, name, patch) {
  // 内容通用一份：直接落到 board/_master.json（不再写 per-code 云端仓库 / 不再分叉）
  return addFragment(code, name, patch);
}

async function updateFragmentAsync(code, fid, patch) {
  return updateFragment(code, fid, patch);
}

async function deleteFragmentAsync(code, fid) {
  return deleteFragment(code, fid);
}

async function addDialogueAsync(code, fid, en, zh) {
  return addDialogue(code, fid, en, zh);
}

async function updateDialogueAsync(code, did, patch, fid) {
  return updateDialogue(code, did, patch, fid);
}

async function deleteDialogueAsync(code, did, fid) {
  return deleteDialogue(code, did, fid);
}

/** ⚠️ v1.0.8：「已发 / 恢复」**纯本地**，不再写云端（老板明确要求断掉这个依赖）。
 *  以前它会写云端自己编号的仓库，并顺手把当时的话术内容「冻结」在云端；
 *  现在只落本机 board/<编号>.sent.json。保留 async 签名，调用方不用改。 */
async function setSentAsync(code, did, sent, fid) {
  return setSent(code, did, sent, fid);
}

/** ⚠️ v1.0.8：同上，整个碎片的「全部已发 / 全部恢复」也只写本机。 */
async function setFragmentSentAllAsync(code, fid, sent, ids) {
  return setFragmentSentAll(code, fid, sent, ids);
}

function addFragment(code, name, patch) {
  const b = loadMasterBoard();
  // 兼容旧调用：第三参传布尔 = evening
  const p = (patch && typeof patch === 'object') ? patch : { evening: patch };
  const morning = !!p.morning;
  const evening = morning ? false : !!p.evening; // 互斥：早上优先
  const dn = Number(p.day);
  const day = (Number.isFinite(dn) && dn >= 1) ? Math.floor(dn) : 1;
  b.fragments.push({ id: uid('f'), name: String(name || '').trim() || '新碎片', morning, evening, day, dialogues: [] });
  saveMasterBoard(b);
  return applySentState(code, clone(b));
}

function updateFragment(code, fid, patch) {
  const b = loadMasterBoard();
  const f = findFragment(b, fid);
  if (!f) throw new Error('fragment not found');
  if (typeof patch.name === 'string') f.name = patch.name.trim() || f.name;
  // 三态互斥：勾了早上就取消晚上，勾了晚上就取消早上；都不勾 = 通用
  if (typeof patch.morning === 'boolean') { f.morning = patch.morning; if (patch.morning) f.evening = false; }
  if (typeof patch.evening === 'boolean') { f.evening = patch.evening; if (patch.evening) f.morning = false; }
  saveMasterBoard(b);
  return applySentState(code, clone(b));
}

function deleteFragment(code, fid) {
  const b = loadMasterBoard();
  b.fragments = b.fragments.filter((f) => f.id !== fid);
  saveMasterBoard(b);
  return applySentState(code, clone(b));
}

/* ================= V3.7.6.1 导入段 · 追加到已有看板（2026-10-06）=================
 *
 * 为什么需要这个函数：
 *   buildSeed() 只在【新建客户看板】时跑。老客户（以及登录云端、主数据在云端的）
 *   走的是 cloudMasterSeed() 或已有本地文件，永远拿不到这次导入的 267 个碎片。
 *   但铁律是「已有看板绝不自动追加碎片」，所以也不能在 getBoard 里偷偷合进去
 *   ——那会让老客户某天开机发现凭空多出几百个碎片。
 *
 * 所以做成**幂等的、需主动触发**的一次性追加：
 *   · 只补「本地还没有的碎片 id」，已存在的原样不动（不覆盖名字、不动对话、
 *     不碰老板改过的内容、不影响任何 sent 标记）；
 *   · 已经全部导入过 → 直接返回 skipped，不重复加；
 *   · 断网/没登录云端时也能用（纯本地写自己的编号仓库那套由 server 决定）。
 *
 * 返回 { added, skipped, total }：这次补了几个、跳过了几个、导入段一共多少。
 */
function importV376(code) {
  // 2026-10-06 起本地不再内置 V3.7.6 段（已进云端 master_fragments，由后台统一管理）。
  // 函数保留只为不破坏既有调用点/测试签名，直接返回「无需导入」。
  return { added: 0, skipped: 0, total: 0, cloudOnly: true };
}

/** 这个看板有没有导入过 V3.7.6 段。
 *  2026-10-06 起该段只存在于云端主数据，本地一律视为「不需要补」→ 恒 false，
 *  前端据此隐藏「补全新话术」按钮。 */
function hasV376(code) {
  return false;
}

function addDialogue(code, fid, en, zh) {
  const b = loadMasterBoard();
  const f = findFragment(b, fid);
  if (!f) throw new Error('fragment not found');
  f.dialogues = f.dialogues || [];
  f.dialogues.push({
    id: uid('d'),
    en: String(en || '').trim(),
    zh: String(zh || '').trim(),
    sent: false,
  });
  saveMasterBoard(b);
  return applySentState(code, clone(b));
}

function updateDialogue(code, did, patch, fid) {
  const b = loadMasterBoard();
  const hit = findDialogue(b, did, fid);
  if (!hit) throw new Error('dialogue not found');
  if (typeof patch.en === 'string') hit.dialogue.en = patch.en;
  if (typeof patch.zh === 'string') hit.dialogue.zh = patch.zh;
  saveMasterBoard(b);
  return applySentState(code, clone(b));
}

/** 只删「那一条」（按引用删，不会因为 id 撞车连带删掉别的碎片里的同名条） */
function deleteDialogue(code, did, fid) {
  const b = loadMasterBoard();
  const hit = findDialogue(b, did, fid);
  if (hit) hit.fragment.dialogues = hit.fragment.dialogues.filter((d) => d !== hit.dialogue);
  saveMasterBoard(b);
  return applySentState(code, clone(b));
}

/** 标已发 / 恢复（只写本机 sent.json；看完返回的看板已带 doneAll）。
 *  ⚠️ 通用内容模型下：对话 id 可能来自云端/历史进度，未必在本地通用 _master.json 里，
 *  因此即使通用看板找不到该对话也照常记录——sent.json 是纯进度 map，不依赖内容存在，
 *  绝不为一个不存在于本地的进度 id 抛错（否则迁移兜底场景会崩）。 */
function setSent(code, did, sent, fid) {
  const map = loadSentMap(code);
  map[did] = !!sent;   // 连「恢复」的 false 也明确记下，免得又被云端老值采纳回来
  saveSentMap(code, map);
  scheduleProgressFlush();   // 联网时把进度推回后台（防抖）
  const b = loadMasterBoard();
  return applySentState(code, clone(b));
}

/** 整个碎片「全部已发 / 全部恢复」。
 *  ids：界面传它手里当前看到的那几条（最准）；不传就按通用内容里该碎片的对话算。
 *  找不到碎片也照常跳过（进度纯 map，不为不存在的内容抛错）。 */
function setFragmentSentAll(code, fid, sent, ids) {
  const b = loadMasterBoard();
  const targets = (Array.isArray(ids) && ids.length)
    ? ids.map(String)
    : (() => { const f = findFragment(b, fid); return f ? (f.dialogues || []).map((d) => d.id) : []; })();
  const map = loadSentMap(code);
  targets.forEach((id) => { map[id] = !!sent; });
  saveSentMap(code, map);
  scheduleProgressFlush();   // 联网时把进度推回后台（防抖）
  return applySentState(code, clone(b));
}

/* ---------------- 进度同步后台（即时防抖） ----------------
 * 任务进度（用过哪些碎片/对话）按 board/<编号>.sent.json 本机先存（见上）；
 * 联网时把每个客户的进度推回后台数据库（cloud.setSent）。采用「即时防抖」：
 * 改动后 3 秒合并推一次，比「只在关闭时推」更稳（意外退出也不丢）。
 * 仍导出 syncAllProgressToCloud() 供需要时（如退出前）主动全量推一次。 */
let _progressFlushTimer = null;
function scheduleProgressFlush() {
  if (!cloudReady()) return;
  if (_progressFlushTimer) return;
  _progressFlushTimer = setTimeout(() => {
    _progressFlushTimer = null;
    syncAllProgressToCloud().catch(() => {});
  }, 3000);
}

async function syncAllProgressToCloud() {
  const c = cloudMod();
  if (!c || !cloudReady()) return { ok: false, reason: 'no-cloud' };
  if (!fs.existsSync(BOARD_DIR)) return { ok: true, pushed: 0 };
  let entries = [];
  try { entries = fs.readdirSync(BOARD_DIR).filter((f) => /^[A-Za-z0-9_]+\.sent\.json$/.test(f)); }
  catch (e) { return { ok: false, reason: 'read-fail' }; }
  let pushed = 0;
  for (const f of entries) {
    const code = f.replace(/\.sent\.json$/, '');
    let map = {};
    try { map = JSON.parse(fs.readFileSync(path.join(BOARD_DIR, f), 'utf8')) || {}; }
    catch (e) { continue; }
    for (const did of Object.keys(map)) {
      try { await c.setSent(code, did, !!map[did], ''); pushed++; }
      catch (e) { /* 单条失败不影响其它 */ }
    }
  }
  return { ok: true, pushed };
}

module.exports = {
  SEED_DAY1,
  // 同步（本地）
  getBoard, saveBoard, normalizeBoard, normalizeDays, ensureUniqueIds,
  addFragment, updateFragment, deleteFragment,
  addDialogue, updateDialogue, deleteDialogue,
  setSent, setFragmentSentAll,
  findFragment, findDialogue,
  // 本地「已发」状态（v1.0.8）
  applySentState, markDone, fragmentDone, loadSentMap, saveSentMap, sentFile,
  adoptLocalSent, mergeCloudBoard,
  // V3.7.6.1 导入段（幂等追加到已有看板）
  importV376, hasV376,
  // 异步（云端优先，没登录时退回本地）—— 界面走这套
  getBoardAsync,
  addFragmentAsync, updateFragmentAsync, deleteFragmentAsync,
  addDialogueAsync, updateDialogueAsync, deleteDialogueAsync,
  setSentAsync, setFragmentSentAllAsync,
  syncAllProgressToCloud,
  cloudReady,
};
