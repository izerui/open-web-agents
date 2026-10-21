// 知识库上传文件的解析,在独立的子进程里跑(由 extract-text.ts 用 child_process.fork 启动,超时直接杀掉)。
//
// 【为什么单独一个进程】解析是同步的重活(解压、在几十 MB 的 XML 上跑正则),放在 web 进程里,
// 计时器根本来不及触发,"超时"只是事后补一个错误,解析照样占满 web 进程;pdf.js 超时后也不会自己停。
// 【为什么不用 worker_threads】子线程的内存上限(resourceLimits)在大块分配时不可靠:实测 V8 直接
// 判整个进程内存耗尽(FATAL ERROR: Reached heap limit),主线程跟着崩。独立进程爆内存只死它自己。
// 入口必须是运行时按路径能找到的真实 JS 文件,所以用 .mjs 写,构建时显式带上(见 next.config.ts)。
//
// 支持:PDF(pdf.js,带 CMap)、.docx / .pptx / .xlsx(zip 里的 XML,解压后自取文字)、纯文本(UTF-8 / GBK)。
// 按文件头判断真实格式,不信扩展名。

import { createRequire } from "node:module";
import path from "node:path";
import { unzipSync } from "fflate";

class Rejected extends Error {}

const TEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log"]);
const OLE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const startsWith = (b, sig) => sig.every((v, i) => b[i] === v);

/** @returns {Promise<{format: string, text: string, pages?: number}>} */
async function extractByContent(ext, bytes, limits) {
  if (startsWith(bytes, [0x25, 0x50, 0x44, 0x46])) return extractPdf(bytes, limits); // %PDF
  if (startsWith(bytes, OLE)) {
    throw new Rejected(
      "这是旧版 Office 格式(.doc / .ppt / .xls)或加密的 Office 文件,请另存为 .docx / .pptx / .xlsx 后再上传",
    );
  }
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) return extractOoxml(bytes, limits); // zip
  if (TEXT_EXT.has(ext)) return { format: "text", text: decodeText(bytes) };
  throw new Rejected(
    "不支持的文件类型:支持 PDF、Word(.docx)、PPT(.pptx)、Excel(.xlsx)和纯文本(.txt .md .csv)",
  );
}

// ─────────────────────────── 纯文本 ───────────────────────────

/**
 * 常用汉字(简体约 800、繁体约 300)。用来判断旧编码文件该按 GBK 还是 Big5 解:
 * 编码选对了,解出来的字绝大多数是常用字;选错了,解出来是一串生僻字。
 */
const COMMON_CJK = new Set(
  "的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显吧阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读啊超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨呀板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪汇币丰蓝殊献桌啦瓦莱援译夺汽烧距裁偏符勇触课敬哭懂墙袭召罚侠厅拜巧侧韩冒债曼融惯享戴童犹乘挂奖绍厚纵障讯涉彻刊丈爆乌役描洗玛患妙镜唱烦签仙彼弗症仿倾牌陷鸟轰咱菜闭奋庆撤泪茶疾缘播朗杜奶季丹狗尾仪偷奔珠虫驻孔宜艾桥淡翼恨繁寒伴叹旦愈潮粮缩罢聚径恰挑袋灰捕徐珍幕映裂泰隔启尖忠累炎暂估泛荒偿横拒瑞忆孤鼻闹羊呆厉衡胞零穷舍码赫婆魂灾洪腿胆津俗辩胸晓劲贫仁偶辑邦恢赖圈摸仰润堆碰艇稍迟辆废净凶署壁御奉旋冬矿抬蛋晨伏吹鸡倍糊秦盾杯租骑乏隆诊奴摄丧污渡旗甘耐凭扎抢绪粗肩梁幻菲皆碎宙叔岩荡综爬荷悉蒂返井壮薄悄扫敏碍殖详迪矛霍允幅撒剩凯颗骂赏液番箱贴漫酸郎腰舒眉忧浮辛恋餐吓挺励辞艘键伍峰尺昨黎辈贯侦滑券崇扰宪绕趋慈乔阅汗枝拖墨胁插箭腊粉泥氏彭拔骗凤慧媒佩愤扑龄驱惜豪掩兼跃尸肃帕驶堡届欣惠册储飘桑闲惨洁踪勃宾频仇磨递邪撞拟滚奏巡颜剂绩贡疯坡瞧截燃焦殿伪柳锁逼颇昏劝呈搜勤戒驾漂饮曹朵仔柔俩孟腐幼践籍牧凉牲佳娜浓芳稿竹腹跌逻垂遵脉貌柏狱猜怜惑陶兽帐饰贷昌叙躺钢沟寄扶铺邓寿惧询汤盗肥尝匆辉奈扣廷澳嘛董迁凝慰厌脏腾幽怨鞋丢埋泉涌辖躲晋紫艰魏吾慌祝邮吐狠鉴曰械咬邻赤挤弯椅陪割揭韦悟聪雾锋梯猫祥阔誉筹丛牵鸣沈阁穆屈旨袖猎臂蛇贺柱抛鼠瑟戈牢逊迈欺吨琴衰瓶恼燕仲诱狼池疼卢仗冠粒遥吕玄尘冯抚浅敦纠钻晶岂峡苍喷耗凌敲菌赔涂粹扁亏寂煤熊恭湿循暖糖赋抑秩帽哀宿踏烂袁侯抖夹昆肝擦猪炼恒慎搬纽纹玻渔磁铜齿跨押怖漠疲叛遣兹祭醉拳弥斜档稀捷肤疫肿豆削岗晃吞宏癌肚隶履涨耀扭坛拨沃绘伐堪仆郭牺歼墓雇廉契拼惩捉覆刷劫嫌瓜歇雕闷乳串娃缴唤赢莲霸桃妥瘦搭赴岳嘉舱俊址庞耕锐缝悔邀玲惟斥宅添挖呵讼氧浩羽斤酷掠妖祸侍乙妨贪挣汪尿莉悬唇翰仓轨枚盐览傅帅庙芬屏寺胖璃愚滴疏萧姿颤丑劣柯寸扔盯辱匹俱辨饿蜂哦腔郁溃谨糟葛苗肠忌溜鸿爵鹏鹰笼丘桂滋聊挡纲肌茨壳痕碗穴膀卓贤卧膜毅锦欠哩函茫昂薛皱夸豫胃舌剥傲拾窝睁携陵哼棉晴铃填饲渴吻扮逆脆喘罩卜炉柴愉绳胎蓄眠竭喂傻慕浑奸扇柜悦拦诞饱乾泡贼亭夕爹酬儒姻卵氛泄杆挨僧蜜吟猩遂狭肖甜霞驳裕顽於摘矮秒卿畜咽披辅勾盆疆赌塑畏吵囊嗯泊肺骤缠冈羞瞪吊贾漏斑涛悠鹿俘锡卑葬铭滩嫁催璇翅盒蛮矣潘歧赐鲍锅廊拆灌勉盲宰佐啥胀扯禧辽抹筒棋裤唉朴咐孕誓喉妄拘链驰栏逝窃艳臭纤玑棵趁匠盈翁愁瞬婴孝颈倘浙谅蔽畅赠妮莎尉冻跪闯葡後厨鸭颠遮谊圳吁仑辟瘤嫂陀框谭亨钦庸歉芝吼甫衫摊宴嘱衷娇陕矩浦讶耸裸碧摧薪淋耻胶屠鹅饥盼脖虹翠崩账萍逢赚撑翔倡绵猴枯巫昭怔渊凑溪蠢禅阐旺寓藤匪伞碑挪琼脂谎慨菩萄狮掘抄岭晕逮砍掏狄晰罕挽脾舟痴蔡剪脊弓懒叉拐喃僚捐姊骚拓歪粘柄坑陌窄湘兆崖骄刹鞭芒筋聘钩棍嚷腺弦焰耍俯厘愣厦恳饶钉寡憾摔叠惹喻谱愧煌徽溶坠煞巾滥洒堵瓷咒姨棒郡浴媚稣淮哎屁漆淫巢吩撰啸滞玫硕钓蝶膝姚茂躯吏猿寨恕渠戚辰舶颁惶狐讽笨袍嘲啡泼衔倦涵雀旬僵撕肢垄夷逸茅侨舆窑涅蒲谦杭噢弊勋刮郊凄捧浸砖鼎篮蒸饼亩肾陡爪兔殷贞荐哑炭坟眨搏咳拢舅昧擅爽咖搁禄雌哨巩绢螺裹昔轩谬谍龟媳姜瞎冤鸦蓬巷琳栽沾诈斋瞒彪厄咨纺罐桶壤糕颂膨谐垒咕隙辣绑宠嘿兑霉挫稽辐乞纱裙嘻哇绣杖塘衍轴攀膊譬斌祈踢肆坎轿棚泣屡躁邱凰溢椎砸趟帘帆栖窜丸斩堤塌贩厢掀喀乖谜捏阎滨虏匙芦苹卸沼钥株祷剖熙哗劈怯棠胳桩瑰娱娶沫嗓蹲焚淘嫩韵衬匈钧竖峻豹捞菊鄙魄兜哄颖镑屑蚁壶怡渗秃迦旱哟咸焉谴宛稻铸锻伽詹毙恍贬烛骇芯汁桓坊驴朽靖佣汝碌迄冀荆崔雁绅珊榜诵傍彦醇笛禽勿娟瞄幢寇睹贿踩霆呜拱妃蔑谕缚诡篷淹腕煮倩卒勘馨逗甸贱炒灿敞蜡囚栗辜垫妒魁谣寞蜀甩涯枕丐泳奎泌逾叮黛燥掷藉枢憎鲸弘倚侮藩拂鹤蚀浆芙垃烤晒霜剿蕴圾绸屿氢驼妆捆铅逛淑榴丙痒钞蹄犬躬昼藻蛛褐颊奠募耽蹈陋侣魅岚侄虐堕陛莹荫狡阀绞膏垮茎缅喇绒搅凳梭丫姬诏钮棺耿缔懈嫉灶匀嗣鸽澡凿纬沸畴刃遏烁嗅叭熬瞥骸奢拙栋毯桐砂莽泻坪梳杉晤稚蔬蝇捣顷麽尴镖诧尬硫嚼羡沦沪旷彬芽狸冥碳咧惕暑咯萝汹腥窥俺潭崎麟捡拯厥澄萎哉涡滔暇溯鳞酿茵愕瞅暮衙诫斧兮焕棕佑嘶妓喧蓉删樱伺嗡娥梢坝蚕敷澜杏绥冶庇挠搂倏聂婉噪稼鳍菱盏匿吱寝揽髓秉哺矢啪帜邵嗽挟缸揉腻驯缆晌瘫贮觅朦僻隋蔓咋嵌虔畔琐碟涩胧嘟蹦冢浏裔襟叨诀旭虾簿啤擒枣嘎苑牟呕骆凸熄兀喔裳凹赎屯膛浇灼裘砰棘橡碱聋姥瑜毋娅沮萌俏黯撇粟粪尹苟癫蚂禹廖俭帖煎缕窦簇棱叩呐瑶墅莺烫蛙歹伶葱哮眩坤廓讳啼乍瓣矫跋枉梗厕琢讥釉窟敛轼庐胚呻绰扼懿炯竿慷虞锤栓桨蚊磅孽惭戳禀鄂馈垣溅咚钙礁彰豁眯磷雯墟迂瞻颅琉悼蝴拣渺眷悯汰慑婶斐嘘镶炕宦趴绷窘襄珀嚣拚酌浊毓撼嗜扛峭磕翘槽淌栅颓熏瑛颐忖" +
    "這個們來時說為國會學對發過還動當經與後點從現開關問體實長間樣種見頭機進電話員應無麼於當產業義們經東兩萬條線變區總資華聯書處計術認識論題據業壓幾辦農們齊廣門東報車軍節級強將萬類與係應數屬傳組權選際運隊單議備邊統場離歷聯戰標響網語讓護環較條製該覽賽態務協態絕費續聽讀質證導練細讓難雖顯醫試錢買賣滿圖團觀層總調專職銷險議據術課業簡積極導線紅綠藍黃視顏領顧預題類飛養馬鳥魚麗龍齊歲歸氣漢產當際雙級經緊紀結給統續總繼續聲聽與舉興見規親覺觸計訓記設許試詩話該說誰課請論識證護讀變讓財貨質購費資賀趕車軟較載輕輸辦農這進運過道達遠適選還邊鄉醫釋針錄長門開間關阿陸陽際隨難雲電靈響順須題風飯館體高鬥點黨",
);

/** 解出来的文字里常用汉字的比例(只看汉字;没有汉字返回 0) */
function commonRatio(text) {
  let cjk = 0;
  let common = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c >= 0x4e00 && c <= 0x9fff) {
      cjk++;
      if (COMMON_CJK.has(ch)) common++;
    }
  }
  return cjk === 0 ? 0 : common / cjk;
}

/**
 * 解出来的东西像不像正常文字:没有控制字符(换行、制表除外),可见字符占绝大多数;
 * 有汉字时常用字比例也要正常。用来判断没有 BOM 的 UTF-16(只有汉字时几乎没有 0 字节,看 0 的分布不够)
 */
function looksLikeText(text) {
  if (!text) return false;
  let visible = 0;
  let total = 0;
  let hasCjk = false;
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    total++;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return false;
    if (c >= 0x4e00 && c <= 0x9fff) hasCjk = true;
    if (c >= 0x20 && c !== 0x7f && !(c >= 0xd800 && c <= 0xdfff) && c !== 0xfffd) visible++;
    else if (c === 0x09 || c === 0x0a || c === 0x0d) visible++;
  }
  return visible / total > 0.98 && (!hasCjk || commonRatio(text) >= 0.4);
}

/**
 * 文本文件的编码。BOM 优先(UTF-8 / UTF-16);没有 BOM 的 UTF-16 看 0 的分布
 * (Windows 记事本"另存为 Unicode"就是 UTF-16,满是 0 字节,不能当二进制拒绝);
 * 再试严格的 UTF-8;都不是,按 GBK 与 Big5 各解一次,取常用汉字比例高的 ——
 * 两者都不像正常文字(选错编码会解出一串生僻字)就拒绝,不把乱码存进知识库
 */
function decodeText(bytes) {
  const strict = (enc, b) => new TextDecoder(enc, { fatal: true, ignoreBOM: true }).decode(b);
  const notBinary = (text) => {
    if (text.includes("\u0000")) throw new Rejected("这不是文本文件(含二进制内容)");
    return text;
  };
  try {
    if (startsWith(bytes, [0xef, 0xbb, 0xbf])) return notBinary(strict("utf-8", bytes.subarray(3)));
    if (startsWith(bytes, [0xff, 0xfe])) return notBinary(strict("utf-16le", bytes.subarray(2)));
    if (startsWith(bytes, [0xfe, 0xff])) return notBinary(strict("utf-16be", bytes.subarray(2)));
  } catch (err) {
    if (err instanceof Rejected) throw err;
    throw new Rejected("文本文件的编码有误,请另存为 UTF-8 后再上传");
  }
  if (bytes.includes(0)) {
    // 没有 BOM 的 UTF-16:两种字节序各解一次,像正常文字才接受;否则是二进制
    for (const enc of ["utf-16le", "utf-16be"]) {
      if (bytes.length % 2 !== 0) break;
      try {
        const text = strict(enc, bytes);
        if (looksLikeText(text)) return text;
      } catch {
        // 这种字节序解不开
      }
    }
    throw new Rejected("这不是文本文件(含二进制内容)");
  }
  try {
    return strict("utf-8", bytes);
  } catch {
    // 不是 UTF-8:往下试中文的旧编码
  }
  const candidates = [];
  for (const enc of ["gb18030", "big5"]) {
    try {
      const text = strict(enc, bytes);
      candidates.push({ text, score: commonRatio(text) });
    } catch {
      // 这种编码解不开
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.4) {
    throw new Rejected(
      "无法确定文本文件的编码(不是 UTF-8、UTF-16、GBK 或 Big5),请另存为 UTF-8 后再上传",
    );
  }
  return best.text;
}

// ─────────────────────────── PDF ───────────────────────────

/**
 * pdf.js 的数据目录:CMap 缺了,未嵌入字体的中文 PDF 提取出来是空的。
 * 从本文件所在位置向上解析,开发与 standalone 部署都能找到 node_modules 里的 pdfjs-dist
 */
function pdfjsDir() {
  const req = createRequire(import.meta.url);
  return path.dirname(req.resolve("pdfjs-dist/package.json"));
}

async function extractPdf(bytes, limits) {
  const lib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const dir = pdfjsDir();
  const task = lib.getDocument({
    data: new Uint8Array(bytes),
    cMapUrl: `${path.join(dir, "cmaps")}/`,
    cMapPacked: true,
    standardFontDataUrl: `${path.join(dir, "standard_fonts")}/`,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch (err) {
    if (err?.name === "PasswordException") {
      throw new Rejected("PDF 有密码保护,请去掉密码后再上传");
    }
    throw err;
  }
  try {
    if (doc.numPages > limits.maxPdfPages) {
      throw new Rejected(`PDF 超过 ${limits.maxPdfPages} 页,请拆分后再上传`);
    }
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      let line = "";
      const lines = [];
      for (const item of content.items) {
        if (!("str" in item)) continue;
        line += item.str;
        if (item.hasEOL) {
          lines.push(line);
          line = "";
        }
      }
      if (line) lines.push(line);
      pages.push(lines.join("\n"));
      page.cleanup();
    }
    return { format: "pdf", text: pages.join("\n\n"), pages: doc.numPages };
  } finally {
    await task.destroy().catch(() => {});
  }
}

// ─────────────────────────── Word / PPT / Excel(OOXML) ───────────────────────────

function unzipParts(bytes, wanted, limits) {
  let total = 0;
  const files = unzipSync(bytes, {
    filter: (f) => {
      if (!wanted(f.name)) return false;
      total += f.originalSize;
      if (total > limits.maxUnzippedBytes) throw new Rejected("文件解压后过大,疑似异常文件");
      return true;
    },
  });
  const out = {};
  let actual = 0;
  for (const [name, data] of Object.entries(files)) {
    actual += data.length;
    if (actual > limits.maxUnzippedBytes) throw new Rejected("文件解压后过大,疑似异常文件");
    out[name] = new TextDecoder("utf-8").decode(data);
  }
  return out;
}

function extractOoxml(bytes, limits) {
  const types = unzipParts(bytes, (n) => n === "[Content_Types].xml", limits)[
    "[Content_Types].xml"
  ];
  if (!types) throw new Rejected("不是 Office 文档(zip 压缩包请解压后上传里面的文件)");
  if (types.includes("wordprocessingml.document.main")) {
    const parts = unzipParts(bytes, (n) => n === "word/document.xml", limits);
    return { format: "docx", text: docxText(parts) };
  }
  if (types.includes("presentationml.presentation.main")) {
    const parts = unzipParts(
      bytes,
      (n) =>
        n === "ppt/presentation.xml" ||
        n === "ppt/_rels/presentation.xml.rels" ||
        /^ppt\/slides\/slide\d+\.xml$/.test(n),
      limits,
    );
    return { format: "pptx", ...pptxText(parts) };
  }
  if (types.includes("spreadsheetml.sheet.main")) {
    const parts = unzipParts(
      bytes,
      (n) =>
        n === "xl/workbook.xml" ||
        n === "xl/_rels/workbook.xml.rels" ||
        n === "xl/sharedStrings.xml" ||
        n === "xl/styles.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/.test(n),
      limits,
    );
    return { format: "xlsx", text: xlsxText(parts) };
  }
  throw new Rejected("不支持的 Office 文档类型:支持 .docx / .pptx / .xlsx");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
function unescapeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e) => {
    if (e.startsWith("#x")) return String.fromCodePoint(Number.parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(Number.parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? "";
  });
}

/** 一段 XML 里某个文本标签的全部文字(如 w:t、a:t),制表与换行标签换成对应字符 */
function runs(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<w:tab\\s*/>|<w:br\\s*/>|<a:br\\s*/>`,
    "g",
  );
  let out = "";
  for (const m of xml.matchAll(re)) {
    if (m[1] !== undefined) out += unescapeXml(m[1]);
    else out += m[0].includes("tab") ? "\t" : "\n";
  }
  return out;
}

function docxText(parts) {
  const xml = parts["word/document.xml"];
  if (!xml) throw new Rejected("Word 文档缺少正文");
  return xml
    .split(/<\/w:p>/)
    .map((p) => runs(p, "w:t"))
    .join("\n");
}

/**
 * 页面的展示顺序。【不能按文件编号】用户在 PowerPoint 里拖动页面后,slideN.xml 不改名,
 * 只有 presentation.xml 的 sldIdLst 顺序变;按编号读会悄悄把资料顺序读错,页码也跟着错。
 * 顺序取 sldIdLst 里各页的 r:id,经 presentation.xml.rels 对到文件。
 * 【顺序表里的每一页都必须解析得到】任何一页的 r:id、关系或文件缺失,都说明文件已损坏:
 * 拒绝整份文件。跳过它继续导入,会少一页、后面的页码全部错位,而上传还显示成功,原文件又不保留。
 * 不在顺序表里的页文件(已从演示里删掉、文件还留在包里)不导入。只有压根没有顺序表时才按文件编号排
 */
function slideOrder(parts) {
  const presentation = parts["ppt/presentation.xml"] ?? "";
  const list = /<p:sldIdLst\b[^>]*>([\s\S]*?)<\/p:sldIdLst>/.exec(presentation)?.[1];
  if (list === undefined) {
    return Object.keys(parts)
      .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .map((n) => ({ n, i: Number(/slide(\d+)\.xml$/.exec(n)?.[1]) }))
      .sort((a, b) => a.i - b.i)
      .map((x) => x.n);
  }
  const broken = (what) =>
    new Rejected(`PPT 文件结构不完整(${what}),可能已损坏;请在 PowerPoint 里打开另存后再上传`);
  const relsXml = parts["ppt/_rels/presentation.xml.rels"];
  if (relsXml === undefined) throw broken("缺少页面关系表");
  const rels = new Map(
    [...relsXml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /\bId="([^"]+)"/.exec(m[0])?.[1] ?? "",
      /\bTarget="([^"]+)"/.exec(m[0])?.[1] ?? "",
    ]),
  );
  return [...list.matchAll(/<p:sldId\b[^>]*>/g)].map((m, idx) => {
    const page = `第 ${idx + 1} 页`;
    const rid = /\br:id="([^"]+)"/.exec(m[0])?.[1];
    if (!rid) throw broken(`${page}没有引用`);
    const target = rels.get(rid);
    if (!target) throw broken(`${page}的引用 ${rid} 在关系表里找不到`);
    // Target 相对 ppt/ 目录,也可能写成以 / 开头的包内绝对路径
    const file = target.startsWith("/") ? target.slice(1) : path.posix.normalize(`ppt/${target}`);
    if (!(file in parts)) throw broken(`${page}指向的 ${file} 不存在`);
    return file;
  });
}

function pptxText(parts) {
  const slides = slideOrder(parts);
  const text = slides
    .map((n, idx) => {
      const body = (parts[n] ?? "")
        .split(/<\/a:p>/)
        .map((p) => runs(p, "a:t"))
        .filter((l) => l.trim())
        .join("\n");
      return body ? `第 ${idx + 1} 页\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return { text, pages: slides.length };
}

/** 单元格坐标的列号(从 0 起):"A1"→0、"C2"→2、"AA10"→26;没有坐标返回 null */
export function columnOf(ref) {
  const letters = /^([A-Z]+)\d*$/i.exec(ref ?? "")?.[1];
  if (!letters) return null;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// ─────────── Excel 数字格式:日期在文件里是序号,要按单元格的格式才能显示对 ───────────

/** 内置数字格式(ECMA-376 第 18.8.30 节;27–36、50–58 是中文区域的日期时间格式) */
const BUILTIN_FORMATS = {
  9: "0%",
  10: "0.00%",
  14: "yyyy-mm-dd",
  15: "d-mmm-yy",
  16: "d-mmm",
  17: "mmm-yy",
  18: "h:mm AM/PM",
  19: "h:mm:ss AM/PM",
  20: "h:mm",
  21: "h:mm:ss",
  22: "yyyy-mm-dd h:mm",
  27: "yyyy年m月",
  28: "m月d日",
  29: "m月d日",
  30: "m-d-yy",
  31: "yyyy年m月d日",
  32: "h时mm分",
  33: "h时mm分ss秒",
  34: "上午/下午h时mm分",
  35: "上午/下午h时mm分ss秒",
  36: "yyyy年m月",
  45: "mm:ss",
  46: "[h]:mm:ss",
  47: "mm:ss.0",
  50: "yyyy年m月",
  51: "m月d日",
  52: "yyyy年m月",
  53: "m月d日",
  54: "m月d日",
  55: "上午/下午h时mm分",
  56: "上午/下午h时mm分ss秒",
  57: "yyyy年m月",
  58: "m月d日",
};

/** 格式串的种类:去掉引号里的字面量、转义字符与方括号(颜色、条件),再看还剩哪些占位符 */
function formatKind(code) {
  if (!code || /^general$/i.test(code)) return { kind: "general" };
  const bare = code
    .split(";")[0]
    .replace(/"[^"]*"/g, "")
    .replace(/\\./g, "")
    .replace(/\[(?!h\]|m\]|s\])[^\]]*\]/gi, "");
  if (/[yd]/i.test(bare) || /[年月日]/.test(code)) {
    return { kind: "date", time: /[hs时秒]/i.test(bare), seconds: /s|秒/i.test(bare) };
  }
  if (/[hs时秒]/i.test(bare)) return { kind: "time", seconds: /s|秒/i.test(bare) };
  if (bare.includes("%")) {
    return { kind: "percent", decimals: /\.(0+)/.exec(bare)?.[1]?.length ?? 0 };
  }
  return { kind: "number" };
}

const pad = (n) => String(n).padStart(2, "0");

/**
 * 序号 → 日期。1900 日期系统里 Excel 沿用了 Lotus 1-2-3 的错误,把 1900 年当闰年:
 * 序号 60 是不存在的 1900-02-29,之后的序号都多 1。1904 系统从 1904-01-01 算起,没有这个问题
 */
function serialToParts(serial, date1904) {
  const days = Math.floor(serial);
  const seconds = Math.round((serial - days) * 86_400);
  if (!date1904 && days === 60) return { date: "1900-02-29", seconds };
  const base = date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, days < 60 ? 31 : 30);
  const d = new Date(base + days * 86_400_000);
  return {
    date: `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`,
    seconds,
  };
}

function clock(seconds, withSeconds) {
  const s = ((seconds % 86_400) + 86_400) % 86_400;
  const hh = pad(Math.floor(s / 3600));
  const mm = pad(Math.floor((s % 3600) / 60));
  return withSeconds ? `${hh}:${mm}:${pad(s % 60)}` : `${hh}:${mm}`;
}

/** 数字按常规格式显示:最多 15 位有效数字(0.1+0.2 存成 0.30000000000000004,Excel 显示 0.3) */
const general = (n) => String(Number(n.toPrecision(15)));

function formatNumber(raw, fmt, date1904) {
  const n = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(n)) return raw;
  switch (fmt.kind) {
    case "date": {
      const p = serialToParts(n, date1904);
      return fmt.time ? `${p.date} ${clock(p.seconds, fmt.seconds)}` : p.date;
    }
    case "time":
      return clock(Math.round(n * 86_400), fmt.seconds);
    case "percent":
      return `${(n * 100).toFixed(fmt.decimals)}%`;
    default:
      return general(n);
  }
}

/** 各样式编号(单元格的 s)对应的数字格式种类 */
function cellFormats(stylesXml) {
  const custom = new Map(
    [...(stylesXml ?? "").matchAll(/<numFmt\b[^>]*>/g)].map((m) => [
      Number(/numFmtId="(\d+)"/.exec(m[0])?.[1]),
      unescapeXml(/formatCode="([^"]*)"/.exec(m[0])?.[1] ?? ""),
    ]),
  );
  const xfs = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml ?? "")?.[1] ?? "";
  return [...xfs.matchAll(/<xf\b[^>]*>/g)].map((m) => {
    const id = Number(/numFmtId="(\d+)"/.exec(m[0])?.[1] ?? 0);
    return formatKind(custom.get(id) ?? BUILTIN_FORMATS[id]);
  });
}

/** Excel 一行最多补到这么多列:坐标被改成极大的列号时,不能为它铺出上万个空单元格 */
const MAX_COLUMNS = 16_384;

function xlsxText(parts) {
  const formats = cellFormats(parts["xl/styles.xml"]);
  const date1904 = /<workbookPr\b[^>]*\bdate1904="(1|true)"/.test(parts["xl/workbook.xml"] ?? "");
  const shared = [...(parts["xl/sharedStrings.xml"] ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map(
    (m) => runs(m[1] ?? "", "t"),
  );
  // 工作表名 → 文件:workbook.xml 的 r:id 经 workbook.xml.rels 对到 worksheets/sheetN.xml
  const rels = new Map(
    [...(parts["xl/_rels/workbook.xml.rels"] ?? "").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [
      /Id="([^"]+)"/.exec(m[0])?.[1] ?? "",
      /Target="([^"]+)"/.exec(m[0])?.[1] ?? "",
    ]),
  );
  const sheets = [...(parts["xl/workbook.xml"] ?? "").matchAll(/<sheet\b[^>]*>/g)].map((m) => {
    const name = unescapeXml(/name="([^"]*)"/.exec(m[0])?.[1] ?? "");
    const rid = /r:id="([^"]+)"/.exec(m[0])?.[1] ?? "";
    const target = (rels.get(rid) ?? "").replace(/^\/?xl\//, "");
    return { name, file: `xl/${target}` };
  });
  const order = sheets.length
    ? sheets
    : Object.keys(parts)
        .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
        .map((file, i) => ({ name: `工作表${i + 1}`, file }));
  return order
    .map(({ name, file }) => {
      const xml = parts[file];
      if (!xml) return "";
      const rows = [...xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
        // 【按坐标放进对应的列】空单元格在文件里通常根本不写:只按出现顺序拼,
        // "A2=张三、C2=95" 会拼成"张三\t95",95 就落到了 B 列。没写坐标的接着上一格往后排
        const cells = [];
        let next = 0;
        for (const c of (r[1] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const attrs = c[1] ?? "";
          const at = columnOf(/\sr="([^"]+)"/.exec(attrs)?.[1]) ?? next;
          if (at >= MAX_COLUMNS) continue;
          next = at + 1;
          const inner = c[2] ?? "";
          const t = /\st="([^"]+)"/.exec(attrs)?.[1];
          let value = "";
          if (t === "inlineStr") value = runs(inner, "t");
          else {
            const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
            if (v !== undefined) {
              if (t === "s") value = shared[Number(v)] ?? "";
              else if (t === "b") value = v === "1" ? "TRUE" : "FALSE";
              else if (t === "str" || t === "e" || t === "d") value = unescapeXml(v);
              else {
                // 数字:按单元格样式对应的数字格式显示(日期在文件里是序号)
                const style = Number(/\ss="(\d+)"/.exec(attrs)?.[1] ?? 0);
                value = formatNumber(
                  unescapeXml(v),
                  formats[style] ?? { kind: "general" },
                  date1904,
                );
              }
            }
          }
          cells[at] = value;
        }
        return Array.from(cells, (v) => v ?? "")
          .join("\t")
          .replace(/\t+$/, "");
      });
      const body = rows.filter((r) => r.trim()).join("\n");
      return body ? `工作表:${name}\n${body}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

// ─────────────────────────── 入口 ───────────────────────────

// 只在被 extract-text.ts 以解析子进程启动时接管消息 —— 测试里直接 import 本文件取函数时,
// 所在进程可能也有 IPC 通道(测试运行器的子进程),不能把它的消息当成解析任务
if (process.env.OWA_EXTRACT_CHILD === "1" && process.send) {
  process.once("message", (task) => {
    const { fileName, bytes, limits } = task;
    const ext = path.extname(fileName).toLowerCase();
    const reply = (m) => process.send?.(m, () => process.exit(0));
    extractByContent(ext, new Uint8Array(bytes), limits).then(
      (result) => reply({ ok: true, ...result }),
      (err) =>
        reply(
          err instanceof Rejected
            ? { ok: false, rejected: true, reason: err.message }
            : { ok: false, rejected: false, reason: String(err?.message ?? err).slice(0, 200) },
        ),
    );
  });
}
