// 一次性生成器：把 day3–day6 的碎片定义产出成可直接粘进 scriptBoard.js 的 JS 代码
// 用法：node tools/gen_seed_days.js
const fs = require('fs');
const path = require('path');

const DAY = { 3: 3, 4: 4, 5: 5, 6: 6 };

// 每项：{ name, t: 'm'|'e'|'', d: [[en, zh], ...] }
const DATA = {
  3: [
    { name: '早晨的问候（食物）', t: 'm', d: [
      ["Morning {name}. Two eggs and I burned the first one.", '早上好{称呼}。两个蛋，第一个煎糊了。'],
      ["I ate it anyway. I'm not proud of this.", '我还是吃了。这我不太骄傲。'],
      ["{name} — are you a proper breakfast person, or just coffee and out the door?", '{称呼}——你是正经吃早饭的人，还是咖啡一灌就出门？'],
      ["Coffee-only people always say it's efficiency. It's never efficiency.", '只喝咖啡的人总说这是效率。从来不是效率。'],
    ]},
    { name: '居家环境', t: '', d: [
      ['This is the part of my home I never show anyone.', '这是我家从来不给人看的那部分。'],
      ['There\'s a stack of canvases by the wall that I\'ve been "about to deal with" since spring.', '墙边堆着一摞画布，我从春天就"准备处理"到现在了。'],
      ["What's the one corner of your place that never gets dealt with, {name}?", '{称呼}，你家里哪个角落是永远处理不完的？'],
      ['Okay, that makes me feel much better about the canvases.', '行吧，这让我对那摞画布感觉好多了。'],
    ]},
    { name: '为什么选择画宠物', t: '', d: [
      ["People ask why I paint animals instead of people. It's a fair question.", '有人问我为什么不画人，要画动物。这问题问得对。'],
      ['People sit for a portrait and they perform. They hold their face a certain way. Animals don\'t perform.', '人坐着让人画的时候会演。他们会摆出某种表情。动物不演。'],
      ["{name}, do you think that's true? Or am I just making excuses for only being good at one thing?", '{称呼}，你觉得这是真的吗？还是我在给自己只会一样东西找借口？'],
      ["You know what — I hadn't thought about it that way. That's actually a better reason than mine.", '你知道吗——我没想到这个角度。这理由比我的好。'],
    ]},
    { name: '分享以前的油画', t: '', d: [
      ['I found this while I was looking for something else. Painted it four years ago.', '我找别的东西的时候翻出来的。四年前画的。'],
      ['I can still see everything I got wrong in it. That never goes away.', '我现在还能看见里面所有画错的地方。这毛病好不了。'],
      ['{name}, do you ever look at something you made years ago and just wince?', '{称呼}，你会不会看自己很多年前做的东西，看得直皱眉？'],
      ["Good. So it's not just artists.", '好，所以这不是画画的毛病。'],
    ]},
    { name: '得奖的油画', t: '', d: [
      ["Okay, one more and then I'll stop. This one won something a few years ago.", '好，再来一张我就不发了。这张几年前得过个奖。'],
      ["I'm telling you because I'm embarrassed that I care about it.", '我告诉你是因为我不好意思——我其实挺在意这个奖的。'],
      ['Did you ever get something you worked for and then feel weirdly flat about it?', '你有没有过这种时候——努力拿到一个东西，然后莫名没什么感觉？'],
      ['Right? Exactly that.', '对吧？就是这个。'],
    ]},
    { name: '正在画的油画（画了 1 天，心情烦恼）', t: '', d: [
      ["Day one of a new piece. It looks terrible. That's normal, I know that.", '新画第一天。很难看。这正常，我知道。'],
      ["I still spend the whole of day one convinced I've forgotten how to do this.", '但第一天我永远整颗心都在想"我是不是已经不会画了"。'],
      ["{name}, do you get that? Starting something and immediately thinking you've lost it?", '{称呼}，你有过吗？刚开始一件事，马上就觉得"我完了"？'],
      ["I'm going to remember you said that tomorrow morning.", '明天早上我会想起你这句话。'],
    ]},
    { name: '画宠物有意义 · 有纪念价值（轻描淡写版）', t: '', d: [
      ['Someone told me once that a painting of a pet is a strange thing to want.', '有人跟我说过，想要一张宠物的画，这挺奇怪的。'],
      ["I don't think it is. When you paint an animal, you're painting the years, not the animal.", '我觉得不奇怪。你画一只动物的时候，画的是那些年，不是那只动物。'],
      ['{name}, have you had a pet you still think about?', '{称呼}，你有没有一只到现在还会想起的宠物？'],
      ['Tell me about them.', '跟我说说。'],
    ]},
    { name: '分享视频（15–20 秒，实时拍）', t: '', d: [
      ["I'm sending this because a photo wouldn't show you how loud he is.", '我发这个是因为照片看不出来他有多吵。'],
      ["That's the whole studio. It's not bigger than this.", '整个画室就这些。就这么大。'],
      ['{name}, do you have a spot like this — some corner that\'s just yours?', '{称呼}，你有没有这么个地方——只属于你自己的一个角落？'],
      ['I want to see it if you ever feel like sending one.', '你要是想发一张，我想看看。'],
    ]},
    { name: '作品过程（讲过程，不讲成品）', t: '', d: [
      ['This stage is the least impressive and the most honest.', '这个阶段最不好看，但最诚实。'],
      ['I spend about four hours getting to a point that looks like nothing happened.', '我花四个小时，做到一个看起来什么都没发生的程度。'],
      ['{name}, how long does it take you to make something look easy?', '{称呼}，你做一件事，要花多久才能做得看起来毫不费力？'],
      ["Okay, so it's not just me. That's a relief.", '所以不只是我这样。那就好。'],
    ]},
    { name: '第一次摸需求 · 它最好看的角度', t: '', d: [
      ['Can I ask you something about {pet}?', '我能问你点关于{宠物}的事吗？'],
      ["I'm painting animals all week, so it's on my mind.", '我这一整周都在画动物，所以一直在想这个。'],
      ["Do you know which is {pet}'s best angle? Everyone's got one — even us.", '你知道{宠物}最好看的角度是哪个吗？每个都有那么一个——连我们也是。'],
      ["Okay, that's the one. I can see it already.", '好，就是这个角度。我已经能看见了。'],
    ]},
    { name: '从眼睛开始（宠物单招牌细节）', t: '', d: [
      ['I always start with the eyes.', '我总是从眼睛开始。'],
      ['If that part is right, the rest pretty much paints itself.', '那块对了，剩下基本自己就出来了。'],
      ["{name}, do you know what I mean? Like — you can tell a person's drawing is wrong from the eyes.", '{称呼}，你懂我意思吗？就是——一个人画得不对，你看眼睛就知道。'],
      ['Exactly. You see it. Most people don\'t.', '就是这个。你看出来了。大部分人看不出来。'],
    ]},
    { name: '视频通话（给选项，不追）', t: '', d: [
      ['Can I be honest about something?', '我能说句实话吗？'],
      ["I'm always a little worried that people think I'm not real. It's a lot of text and no face.", '我一直有点担心别人觉得我不是真人。一堆文字，没有脸。'],
      ["If you ever want to just see me and hear the studio for a minute, I'd be up for it. It doesn't have to be a thing.", '你要是想看看我，听听画室的声音，一分钟就行，我随时可以。不用当成什么大事。'],
      ["Or we just keep doing this. Either's fine.", '或者我们就这么聊。都行。'],
    ]},
    { name: '为什么交朋友', t: '', d: [
      ['I have a strange reason for liking this job.', '我喜欢这工作有个挺奇怪的原因。'],
      ['I paint alone all day. So the people I talk to here — I actually remember them.', '我整天一个人画画。所以我在这儿聊过的人——我是真的记得。'],
      ['{name}, do you have people you only know through work or online? Do you count them?', '{称呼}，你有没有那种只在工作或者网上认识的朋友？你会把他们算成朋友吗？'],
      ["That's how I feel too. I wasn't sure if that was reasonable.", '我也是这么觉得的。我一直不确定这算不算正常。'],
    ]},
    { name: '城市夜景（晚）', t: 'e', d: [
      ['Went out for a walk just now.', '刚出去走了走。'],
      ['Xiamen at night is a different city — everything quiets down and the lights on the water do all the work.', '厦门的晚上是另一座城——什么都安静下来，水上的灯把活儿全干了。'],
      ['Is it dark where you are yet, {name}? I can never keep your time straight.', '你那边天黑了吗{称呼}？我永远算不明白你的时间。'],
      ['This is going to sound ridiculous, but I keep a note of what time it is where you are.', '说出来有点傻，但我一直记着你那边现在几点。'],
    ]},
    { name: '白天经历（晚）', t: 'e', d: [
      ["Today's victory: I mixed a colour that actually matched what I saw.", '今天的胜利：我调出了一个跟我看见的真的一样的颜色。'],
      ['This happens maybe twice a month.', '这种事一个月大概发生两次。'],
      ['{name}, did you get anything done today, or was it one of those days?', '{称呼}，你今天干成什么事了吗，还是那种什么都没干成的日子？'],
      ['What was it? Tell me the boring version, I like those.', '是什么事？跟我说那个无聊的版本，我喜欢听。'],
    ]},
  ],
  4: [
    { name: '早餐照片（食物）', t: 'm', d: [
      ['Morning {name}. I made too much again. I always make too much.', '早上好{称呼}。我又做多了。我永远做多。'],
      ["There's enough congee in this kitchen for a small village.", '这厨房里的粥够一个小村子吃的。'],
      ["You're not a breakfast person, are you? I'm guessing coffee and straight to work.", '你不是会好好吃早饭那种人吧？我猜是咖啡一杯直接上班。'],
      ["I knew it. You've got that look.", '我就知道。你身上有那股劲儿。'],
    ]},
    { name: '生活对换', t: '', d: [
      ["{name}, I'm very casual about almost everything and completely unreasonable about painting.", '{称呼}，我几乎什么都随便，就在画上一点不含糊。'],
      ["My studio's a mess. The painting itself — no. That part I don't compromise on.", '画室乱七八糟。画本身——不行。那部分我不让步。'],
      ["I'm guessing you're the opposite. Everything in its place.", '我猜你是反过来的。什么都摆得整整齐齐。'],
      ["No? Okay, I'm bad at this. What's the actual mess in your life?", '不是？行吧，我不太会猜。那你生活里真正乱的是哪块？'],
    ]},
    { name: '环境对换', t: '', d: [
      ['Has the weather turned where you are?', '你那边天气变了吗？'],
      ["It's finally cool here. The sea gets grey and everything smells like salt.", '这边终于凉了。海变成灰的，到处都是咸味。'],
      ["I'm guessing you're somewhere that gets proper seasons — not like here.", '我猜你在的地方四季分明——不像这儿。'],
      ["So what's the worst month where you are? I want to know what I'd be complaining about.", '那你那边最难受的是哪个月？我想知道我要是住在那边会抱怨什么。'],
    ]},
    { name: '挂在哪儿（猜）', t: '', d: [
      ['Can I guess something about you?', '我能猜你个事吗？'],
      ["When people think about a painting like this, they're not thinking about the painting. They're thinking about where it goes.", '大家想这种画的时候，其实想的不是画。想的是它挂哪儿。'],
      ["I'm guessing it's a living room. Somewhere everyone walks past. Not a bedroom — bedrooms are private.", '我猜是客厅。大家都会路过的地方。不是卧室——卧室是私密的。'],
      ["No? Where then? I want the picture in my head to be right.", '不是？那是哪儿？我想让我脑子里的画面是对的。'],
    ]},
    { name: '送给谁（猜）', t: '', d: [
      ['Another guess.', '再猜一个。'],
      ["A lot of people who ask me about this aren't buying it for themselves.", '很多人问我这个，其实不是给自己买的。'],
      ["I'm guessing this one's for someone else. A partner, or someone who's not around anymore.", '我猜这张是给别人买的。伴侣，或者一个已经不在了的人。'],
      ["I'm sorry. But that's a good reason. It's the best one there is.", '我很抱歉。但这是个好理由。这是最好的理由。'],
    ]},
    { name: '画面猜测 · 门口等你', t: '', d: [
      ["I have a picture in my head and I want to know if it's right.", '我脑子里有个画面，我想知道对不对。'],
      ["It's him at the door. Not the whole room — just the door, and him looking up. Because that's the moment, isn't it?", '是他在门口。不要整个房间——就门口，他抬头看。因为那个瞬间才是重点，对吧？'],
      ["The waiting. That's the part people actually remember.", '等待。这才是人真正记得的部分。'],
      ["Yeah. That's the one. I could paint that.", '对。就是这个。我能画这个。'],
    ]},
    { name: '它几岁了（轻口）', t: '', d: [
      ['How old is {pet} now?', '{宠物}现在几岁了？'],
      ['I ask because the age changes the painting. Young ones — you paint the energy. Older ones — you paint the calm.', '我问是因为年龄会改变画法。年轻的——画那股劲。年纪大的——画那份安静。'],
      ['Where is {pet} on that scale?', '{宠物}算哪一头？'],
      ["That's a good age. That's the age where they're doing the most living.", '好年纪。这是它们活得最像自己的年纪。'],
    ]},
    { name: '最近的变化', t: '', d: [
      ['Has anything changed with {pet} lately?', '{宠物}最近有什么变化吗？'],
      ['People tell me these things out of nowhere — a new habit, a new favourite spot, sleeping more.', '别人经常突然跟我说这些——新习惯、新喜欢的位置、睡得更多了。'],
      ['Anything like that?', '有吗？'],
      ["That's the kind of thing worth keeping. Not the photo — the habit.", '这种事值得留下来。不是照片——是这个习惯。'],
    ]},
    { name: '追问深度 · 为什么是它', t: '', d: [
      ['Can I ask you something that might sound like a strange question?', '我能问个听着有点奇怪的问题吗？'],
      ['Of all the things in your life — why would it be him?', '你生活里那么多东西——为什么要是他？'],
      ["I ask everyone this. Most people don't have an answer ready.", '我每个人都问。大部分人都没有现成的答案。'],
      ["That's the answer. That's the whole painting right there.", '这就是答案。整张画就在这句话里。'],
    ]},
    { name: '画面感 · 你现在想到它是什么样子', t: '', d: [
      ['Close your eyes for a second.', '闭一下眼睛。'],
      ['Not the photo. The version in your head.', '不是照片那个。是你脑子里那个版本。'],
      ['What is he doing?', '他在干什么？'],
      ["That. That's the one I'd paint. Not the photo. That.", '就是这个。这才是我会画的那个。不是照片。是这个。'],
    ]},
    { name: '请教他 · 他擅长的领域', t: '', d: [
      ['{name}, can I ask you something completely unrelated?', '{称呼}，我能问你个完全不相关的事吗？'],
      ["I know nothing about what you do. Nothing. And I'm curious.", '我对你做的事一无所知。真的完全不懂。我很好奇。'],
      ["What's the thing in your job that looks easy to outsiders and is actually really hard?", '你这一行里，有什么是外人看着简单、其实特别难的？'],
      ["I had no idea. That's actually the same as painting, just in a different language.", '我完全不知道。这其实跟画画一样，就是换了个语言。'],
    ]},
    { name: '他的名字 / 来历', t: '', d: [
      ["Okay, I've been meaning to ask.", '好，我一直想问。'],
      ['Why that name?', '为什么叫这个名字？'],
      ["I knew there'd be a story. There's always a story.", '我就知道有故事。一定都有故事。'],
      ["I'm going to remember that.", '我会记住的。'],
    ]},
    { name: '你有多久没见它了（重，小心用）', t: '', d: [
      ["Can I ask how long it's been?", '我能问一下，过去多久了吗？'],
      ["I'm not asking to be morbid. I'm asking because it changes how I'd see it.", '我问不是要揭伤口。我问是因为这会影响我怎么看它。'],
      ["If you'd rather not, that's completely fine.", '你要是不想说，完全没关系。'],
      ['Thank you for telling me.', '谢谢你告诉我。'],
    ]},
    { name: '白天经历（晚）', t: 'e', d: [
      ['Painted all afternoon and got one ear right. One.', '画了一下午，画对了一只耳朵。一只。'],
      ["I'm choosing to see this as progress.", '我选择把这当成进步。'],
      ['{name}, did today go the way you wanted, or did it get away from you?', '{称呼}，今天是你想要的样子，还是被日子带跑了？'],
      ["Good. Tell me the part you're quietly pleased about.", '好。跟我说说你偷偷得意的那部分。'],
    ]},
    { name: '画面延续（晚）', t: 'e', d: [
      ["I'm still thinking about what you said earlier.", '我还在想你今天早些时候说的那些。'],
      ['About him at the door. That image stayed with me all afternoon.', '关于他在门口那个画面。这画面在我脑子里待了一下午。'],
      ['Not everyone gives me an image that clear.', '不是每个人都能给我这么清楚的画面。'],
      ["I'm going to keep it, if that's alright.", '我想留着，如果可以的话。'],
    ]},
  ],
  5: [
    { name: '早餐照片（食物）', t: 'm', d: [
      ["Morning {name}! It's actually cold this morning.", '早啊{称呼}！今天早上真的冷。'],
      ["First time this year I've wanted a jacket.", '今年第一次想穿外套。'],
      ["How cold does it get where you are? I'm genuinely asking, I have no idea.", '你那边能冷到什么程度？我是真问，我完全没概念。'],
      ['Every time you tell me something about where you live I end up picturing it for the rest of the day.', '每次你跟我说一点你那边的事，我一整天都会在脑子里想象。'],
    ]},
    { name: '时间不长（核心信念）', t: '', d: [
      ["Can I say something I've been thinking about?", '我能说点我一直在想的事吗？'],
      ["People keep asking me what a painting of a pet is worth. That's not the part that matters to me.", '大家老问我一张宠物画值多少钱。但那不是我在意的部分。'],
      ["The thing is — they don't get that long with us. That's the whole reason I do this.", '重点是——它们陪我们的时间不长。这就是我做这件事的全部理由。'],
      ["Anyway. How's {pet} today?", '总之。{宠物}今天怎么样？'],
    ]},
    { name: '定在那儿（信念第二句，连发）', t: '', d: [
      ['I keep coming back to that thing I said this morning.', '我一直在想我早上说的那件事。'],
      ["A photo keeps happening. It's always moving — the light changes, the phone changes, it's somewhere on a laptop now.", '照片是不断发生的。光在变、手机在换，现在已经存在某个笔记本里了。'],
      ["A painting stops. That's the only thing it does, and it's the whole point.", '画会停下来。这是它唯一做的事，也是全部意义。'],
      ['Sorry, that was very serious for a Tuesday. What are you doing this evening?', '抱歉，周二说这么正经。你今晚干什么？'],
    ]},
    { name: '把昨天那句还给他（本天最关键）', t: '', d: [
      ["{name}, you said something yesterday and I haven't been able to put it down.", '{称呼}，你昨天说了一句话，我到现在都放不下。'],
      ['You said — "{他昨天那句原话，一字不改}".', '你说——「{原话}」。'],
      ["That's it. That's the thing. It's not the painting. It's that.", '就是这个。就是这个东西。不是画。是这个。'],
      ['I just wanted you to know it stayed with me.', '我就是想让你知道，这句话留在我这儿了。'],
    ]},
    { name: '橙猫日常（稀释情绪）', t: '', d: [
      ['This one has discovered that the windowsill is warm in the afternoon.', '这位发现下午窗台是暖的。'],
      ['He now spends four hours a day there. Doing nothing. Perfectly happy.', '他现在每天在那儿待四小时。什么都不干。非常快乐。'],
      ['{name}, is {pet} a windowsill type, or more of a following-you-around type?', '{称呼}，{宠物}是窗台型的，还是走哪儿跟哪儿型的？'],
      ['Both is the correct answer. Both is always the answer.', '"都是"才是正确答案。"都是"永远是答案。'],
    ]},
    { name: '轻口 · 你们多久了', t: '', d: [
      ['Can I ask — how long have you had {pet}?', '我能问吗——{宠物}你养多久了？'],
      ['I like knowing the number. It makes the whole thing more real to me.', '我喜欢知道这个数字。它让整件事对我来说更真实。'],
      ["That's a long time. That's most of what's happened to you since then.", '那是很长一段时间。从那之后发生在你身上的事，基本都在这里面了。'],
    ]},
    { name: '自嘲 · 我画得慢', t: '', d: [
      ["Confession: I'm a very slow painter.", '坦白一下：我画得很慢。'],
      ["Not careful — slow. There's a difference.", '不是细致——是慢。这俩不一样。'],
      ['{name}, are you fast at what you do, or are you the slow type?', '{称呼}，你做事快吗，还是慢的那种？'],
      ['Welcome. There are more of us than they admit.', '欢迎。我们这类人比他们承认的多。'],
    ]},
    { name: '生活对换', t: '', d: [
      ["{name}, what's the one thing you do every single day without fail?", '{称呼}，有什么事是你每天一定会做的？'],
      ['I mean the boring one. Coffee, the news, walking the dog. Not the impressive one.', '我说的是无聊那个。咖啡、看新闻、遛狗。不是那种了不起的。'],
      ['Mine is standing by the sink eating breakfast. Every day.', '我的是站在水池边吃早饭。每天。'],
      ["I'm going to think about that tomorrow morning when I'm at the sink.", '明天早上我在水池边的时候会想起这个。'],
    ]},
    { name: '职业对换', t: '', d: [
      ['If you could stop working tomorrow, what would you actually do with your time?', '如果明天可以不上班，你会拿时间干嘛？'],
      ["I'm not asking about retiring somewhere warm. I mean what would you do on a Tuesday.", '我不是问去哪养老。我是说，一个普通的周二你会干什么。'],
      ["That's a real answer. Most people just say \"travel\".", '这是真答案。大部分人只会说"旅行"。'],
    ]},
    { name: '环境对换', t: '', d: [
      ["What's the view out of your window right now?", '你现在窗外是什么景色？'],
      ['Not the nice version. The actual one.', '不要好看那个版本。就真实的。'],
      ["Okay, I can picture it now. That's a real place.", '好，我现在能想象出来了。这是个真实的地方。'],
    ]},
    { name: '请教他 · 一辈子里最值的一件事', t: '', d: [
      ['{name}, can I ask you a big question?', '{称呼}，我能问你个大问题吗？'],
      ["You've been around longer than me. I want to know what actually holds up.", '你比我年长。我想知道什么东西才是真的靠得住的。'],
      ["Out of everything you've spent money or time on in your life — what turned out to be worth it?", '你这辈子花过钱、花过时间的事里——哪一件后来证明是值的？'],
      ["I'm writing that down. That's a better answer than I expected.", '我记下来了。这答案比我预想的好。'],
    ]},
    { name: '请教他 · 有没有什么东西你一直留着', t: '', d: [
      ['Random question — do you still have anything from when you were a kid?', '随口问一句——你小时候的东西，还有留着的吗？'],
      ["I'm asking because I threw almost everything away and I regret most of it.", '我问是因为我几乎全扔了，我大部分都后悔。'],
      ["You kept it. That says something about you.", '你留着了。这说明你是个什么人。'],
    ]},
    { name: '他的名字其实是怎么来的', t: '', d: [
      ['I keep thinking about what you said about the name.', '我一直在想你说的名字那件事。'],
      ["Most people name them something that sounds good. You didn't.", '大部分人起名是起个好听的。你不是。'],
      ['Who picked it — you or somebody else?', '谁起的——你还是别人？'],
      ["That's better than the name itself.", '这比名字本身还好。'],
    ]},
    { name: '白天经历（晚）', t: 'e', d: [
      ["Spent the whole afternoon on one patch of fur and it still isn't right.", '一整个下午都在画一小块毛，还是不对。'],
      ['This is the part nobody photographs.', '这是没人会拍下来的那部分。'],
      ['{name}, how was your day? Anything worth reporting?', '{称呼}，你今天怎么样？有什么值得汇报的吗？'],
      ['Good. I like your good days.', '好。我喜欢你的好日子。'],
    ]},
    { name: '画面延续（晚）', t: 'e', d: [
      ['Still thinking about him at the door.', '还在想他在门口那个画面。'],
      ["I don't think I'll lose that image.", '我觉得我不会忘掉这个画面了。'],
      ['Goodnight, {name}.', '晚安，{称呼}。'],
    ]},
  ],
  6: [
    { name: '早餐照片（食物）', t: 'm', d: [
      ['Morning {name}. Congee. Again.', '早上好{称呼}。粥。又是。'],
      ['Six days and you now know exactly what I eat.', '六天了，你现在完全知道我吃什么。'],
      ['Does that feel like a long time or a short time to you?', '对你来说这算长还是算短？'],
      ['Same. It went faster than I expected.', '一样。比我预想的快。'],
    ]},
    { name: '只给不取 · 勾一张小构图（今天第一步）', t: '', d: [
      ["I sketched something this morning. Not for anything — I just wanted to see it.", '我早上勾了个东西。不是为了什么——我就是想看看它长什么样。'],
      ["It's rough. The proportions are off. But the feeling is there.", '很糙。比例也不对。但感觉对了。'],
      ["I don't know yet. I just wanted to see it on paper.", '我还不知道。我就是想看看它在纸上是什么样。'],
    ]},
    { name: '让他自己说 · 把画面推给他（本天主线）', t: '', d: [
      ['Can I show you what I actually see when you describe him?', '我能给你看看你描述他的时候，我脑子里是什么样吗？'],
      ['Just the eyes and the tilt of the head. Everything else is empty.', '只有眼睛和头歪的角度。其他全是空的。'],
      ["That's a painting. I don't know how else to say it.", '这就是一张画。我不知道还能怎么说。'],
    ]},
    { name: '如果他要开口 · 怎么接（本天最关键）', t: '', d: [
      ['Yeah?', '真的？'],
      ["I'd love that.", '我很愿意。'],
      ["Let me write down what you said so I don't get it wrong.", '让我把你说的话记下来，免得我记错了。'],
      ["Let's talk about that properly tomorrow — I want to get this one right, and I'd rather not rush it.", '这些我们明天好好说——这一张我想做对，不想赶。'],
    ]},
    { name: '如果他没开口 · 退回轻松（不许硬推）', t: '', d: [
      ["Anyway. That's my morning. How's yours going?", '总之。这就是我的早上。你那边怎么样？'],
      ["I'm going to go make a mess of some canvas.", '我要去把画布搞乱了。'],
      ['No pressure on any of that, by the way.', '顺便说一句，那些都别有压力。'],
    ]},
    { name: '轻口 · 他宠物的一个小毛病', t: '', d: [
      ['Tell me something annoying {pet} does.', '跟我说一个{宠物}让人烦的小毛病。'],
      ['Every animal has one. The orange one knocks things off tables for entertainment.', '每只动物都有。橘猫扒东西下桌当娱乐。'],
      ["That's worse than mine. I feel better about my cat now.", '那比我这个严重。我现在对我家猫感觉好多了。'],
    ]},
    { name: '自嘲 · 我今天什么也没画完', t: '', d: [
      ["I have to admit something. I didn't finish anything today.", '我得承认一件事。我今天什么都没画完。'],
      ["Some days the paint just doesn't behave.", '有些日子颜料就是不听话。'],
      ["{name}, do you have days where you just can't get anything done?", '{称呼}，你有那种什么都干不成的日子吗？'],
      ["Okay good. So it's not a character flaw.", '好。那就不是性格缺陷。'],
    ]},
    { name: '请教他 · 你觉得我该注意什么', t: '', d: [
      ['{name}, can I ask your opinion on something?', '{称呼}，我能问你个意见吗？'],
      ["I get too close to my own work. I can't see it anymore.", '我对自己的东西离得太近了。我看不见它了。'],
      ['If you were me — working on that one — what would you pay attention to?', '如果你是我——在弄那一张——你会注意什么？'],
      ["That's a good one. I hadn't thought about that.", '这个好。我没想到这一点。'],
    ]},
    { name: '你希望它挂在哪儿（画面收口）', t: '', d: [
      ["One more question and then I'll leave you alone.", '再问一个问题就不烦你了。'],
      ['If it existed — if it were sitting somewhere in your house right now — where would it be?', '如果它存在——如果它现在就放在你家某个地方——它会在哪儿？'],
      ["I can picture that. That's a good spot.", '我能想象出来。那个位置很好。'],
    ]},
    { name: '生活对换', t: '', d: [
      ["What's the thing you're looking forward to this week?", '你这周有什么在盼着的事？'],
      ['Not a big thing. Something small.', '不用大事。小事就行。'],
      ["That's a good one. I'd look forward to that too.", '这个好。我也会盼着这个。'],
    ]},
    { name: '环境对换', t: '', d: [
      ['Does it get dark early where you are now?', '你那边现在天黑得早了吗？'],
      ["It's getting dark here at six and I hate it.", '这边六点就黑了，我讨厌这样。'],
      ['Really? Okay, defend that. I want to hear it.', '真的？行，说个理由。我想听。'],
    ]},
    { name: '名字用回去', t: '', d: [
      ["{pet} — I noticed I've been calling him that all week now.", '{宠物}——我发现我这周一直这么叫他了。'],
      ["It's a good name. It fits.", '名字很好。很贴。'],
      ["Where's he right now, by the way?", '对了，他现在在哪儿？'],
    ]},
    { name: '白天经历（晚）', t: 'e', d: [
      ['Long day. Painted, cleaned up, painted again.', '长的一天。画画、收拾、再画。'],
      ["The studio smells like turpentine and I've stopped noticing it.", '画室一股松节油味，我已经闻不出来了。'],
      ['{name}, how was your day? Anything worth reporting?', '{称呼}，你今天怎么样？有什么值得汇报的吗？'],
      ['Those. I had one of those yesterday.', '那种日子。我昨天就过了一个。'],
    ]},
    { name: '进度照（晚）', t: 'e', d: [
      ['This is what my table looks like at the end of the day.', '这是我桌子一天结束时的样子。'],
      ["I'll deal with it tomorrow. I always say that.", '我明天收拾。我每次都这么说。'],
      ['You have a table like this too. I know you do.', '你也有这么一张桌子。我知道你有。'],
    ]},
    { name: '不用回我（晚）', t: 'e', d: [
      ["{name}, I know it's late there.", '{称呼}，我知道你那边很晚了。'],
      ["I don't need an answer to any of this today.", '这些我今天不需要任何答复。'],
      ['Just — goodnight.', '就是——晚安。'],
    ]},
  ],
};

function esc(s) {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

function emit(day, items) {
  const lines = [];
  lines.push(`/* ---------------- Day ${day} 种子（2026-09-30 老板要求：每天 15 个碎片 + 引导链） ----------------
   可读版见 knowledge/playbook/day${day}.md。t: 'm'=早 / 'e'=晚 / ''=通用。 */`);
  lines.push('const SEED_DAY' + day + ' = [');
  items.forEach((it, i) => {
    const morning = it.t === 'm';
    const evening = it.t === 'e';
    lines.push('  {');
    lines.push(`    id: 'f${day}_${i + 1}', name: '${esc(it.name)}', morning: ${morning}, evening: ${evening}, day: ${day},`);
    lines.push('    dialogues: [');
    it.d.forEach(([en, zh], j) => {
      lines.push(`      { id: 'd${day}_${i + 1}_${j + 1}', en: '${esc(en)}',`);
      lines.push(`        zh: '${esc(zh)}', sent: false },`);
    });
    lines.push('    ],');
    lines.push('  },');
  });
  lines.push('];');
  return lines.join('\n');
}

const out = [3, 4, 5, 6].map((d) => emit(d, DATA[d])).join('\n\n');
const target = path.join(__dirname, '..', 'tmp', 'seed_days.js');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, out, 'utf8');
console.log('已生成:', target);
console.log('碎片总数:', [3, 4, 5, 6].reduce((a, d) => a + DATA[d].length, 0));
console.log('对话总数:', [3, 4, 5, 6].reduce((a, d) => a + DATA[d].reduce((b, it) => b + it.d.length, 0), 0));
