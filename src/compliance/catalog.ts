import type { SkillPlaintext } from "./types.ts";

export interface KeywordRule {
  keyword: string;
  message: string;
}

export interface HsPrefixRule {
  prefix: string;
  level: "review" | "hold";
  code: string;
  message: string;
}

export interface NameHsRule {
  keywords: string[];
  prefixes: string[];
  code: string;
  message: string;
}

export interface FieldRule {
  field: string;
  label: string;
  reason: string;
}

export const BANNED_KEYWORDS: KeywordRule[] = [
  { keyword: "象牙", message: "象牙及其制品通常受 CITES 与禁止进出境规定约束" },
  { keyword: "犀牛角", message: "犀牛角受 CITES 严格管制" },
  { keyword: "犀角", message: "犀角为犀牛角的常见申报写法" },
  { keyword: "虎骨", message: "虎骨受 CITES 严格管制" },
  { keyword: "穿山甲", message: "穿山甲及其制品禁止商业性贸易" },
  { keyword: "海洛因", message: "麻醉药品，禁止以一般贸易申报" },
  { keyword: "甲基苯丙胺", message: "麻醉药品，禁止以一般贸易申报" },
  { keyword: "冰毒", message: "甲基苯丙胺的俗称，按禁止类拦截" },
  { keyword: "可卡因", message: "麻醉药品，禁止以一般贸易申报" },
  { keyword: "大麻", message: "大麻及制品需按禁毒与海关规定拦截" },
  { keyword: "枪支", message: "枪支属于武器类，禁止或特许" },
  { keyword: "枪械", message: "枪械属于武器类，禁止或特许" },
  { keyword: "弹药", message: "弹药属于武器类，禁止或特许" },
  { keyword: "爆炸物", message: "爆炸物属于禁止或特许类" },
  { keyword: "雷管", message: "雷管属于爆炸物相关管制" },
  { keyword: "黑火药", message: "黑火药属于爆炸物相关管制" },
  { keyword: "核材料", message: "核材料禁止以普通货物申报" },
  { keyword: "放射性", message: "放射性物质需按危险品与禁限目录拦截" },
];

export const RESTRICTED_KEYWORDS: KeywordRule[] = [
  { keyword: "锂电池", message: "锂电池需核对 UN38.3、运输鉴定与申报要素" },
  { keyword: "锂离子电池", message: "锂离子电池按危险品与电池申报要求复核" },
  { keyword: "无人机", message: "无人机可能涉及出口管制与最终用户审查" },
  { keyword: "易制毒", message: "易制毒化学品需许可证" },
  { keyword: "药品", message: "药品需进口注册或出口证明" },
  { keyword: "原料药", message: "原料药需核对药品监管证件" },
  { keyword: "医疗器械", message: "医疗器械需核对备案或注册证" },
  { keyword: "稀土", message: "稀土出口可能需要出口许可" },
  { keyword: "密码设备", message: "密码设备可能需要商用密码许可" },
  { keyword: "文物", message: "文物出境需文物主管部门审核" },
  { keyword: "古董", message: "古董按文物监管口径复核年代与证明" },
  { keyword: "烟草", message: "烟草实行专卖许可" },
  { keyword: "种子", message: "种子进出境需检疫与种质审批" },
  { keyword: "农药", message: "农药需登记与进口许可" },
  { keyword: "两用物项", message: "两用物项需出口许可与最终用户说明" },
  { keyword: "半导体", message: "半导体可能涉及出口管制清单" },
  { keyword: "集成电路", message: "集成电路需核对税号、许可证与最终用户" },
];

export const HS_PREFIX_RULES: HsPrefixRule[] = [
  { prefix: "2844", level: "hold", code: "HS_RADIOACTIVE", message: "税号 2844 放射性元素及同位素，按禁止或特许类拦截" },
  { prefix: "8507", level: "review", code: "HS_BATTERY", message: "税号 8507 蓄电池，核对锂电池运输条件与申报要素" },
  { prefix: "8542", level: "review", code: "HS_IC", message: "税号 8542 集成电路，核对出口管制与最终用户" },
  { prefix: "93", level: "hold", code: "HS_ARMS", message: "第 93 章武器弹药，禁止或特许类" },
  { prefix: "36", level: "hold", code: "HS_EXPLOSIVES", message: "第 36 章炸药及烟火制品，禁止或特许类" },
  { prefix: "30", level: "review", code: "HS_PHARMA", message: "第 30 章药品，核对注册证与许可证" },
  { prefix: "29", level: "review", code: "HS_ORGANIC_CHEM", message: "第 29 章有机化学品，核对易制毒与两用物项" },
  { prefix: "28", level: "review", code: "HS_INORGANIC_CHEM", message: "第 28 章无机化学品，核对管制名录" },
  { prefix: "88", level: "review", code: "HS_AIRCRAFT", message: "第 88 章航空器，无人机等需核对管制" },
  { prefix: "97", level: "review", code: "HS_ART", message: "第 97 章艺术品、收藏品及古物" },
  { prefix: "44", level: "review", code: "HS_WOOD", message: "第 44 章木及木制品，核对濒危木材与原产地证" },
  { prefix: "71", level: "review", code: "HS_JEWELRY", message: "第 71 章珠宝贵金属，核对估价与许可证" },
];

export const NAME_HS_RULES: NameHsRule[] = [
  {
    keywords: ["锂电池", "锂离子电池", "锂电"],
    prefixes: ["8507", "8506"],
    code: "HS_NAME_BATTERY",
    message: "品名含锂电池，税号未落在 8506/8507",
  },
  {
    keywords: ["无人机"],
    prefixes: ["8806", "88", "8525"],
    code: "HS_NAME_DRONE",
    message: "品名含无人机，税号未落在 8806/88/8525",
  },
  {
    keywords: ["象牙"],
    prefixes: ["9601", "0507"],
    code: "HS_NAME_IVORY",
    message: "品名含象牙，税号未落在 9601/0507",
  },
  {
    keywords: ["集成电路", "芯片", "半导体"],
    prefixes: ["8541", "8542"],
    code: "HS_NAME_IC",
    message: "品名含集成电路或芯片，税号未落在 8541/8542",
  },
];

export const REQUIRED_FIELDS: FieldRule[] = [
  { field: "direction", label: "进出口方向", reason: "报关单必填" },
  { field: "consignor", label: "发货人", reason: "报关单必填" },
  { field: "consignee", label: "收货人", reason: "报关单必填" },
  { field: "goodsName", label: "商品名称", reason: "报关单必填" },
  { field: "hsCode", label: "HS 编码", reason: "商品归类必填，中国报关使用 10 位编码" },
  { field: "quantity", label: "申报数量", reason: "报关单必填" },
  { field: "unit", label: "计量单位", reason: "报关单必填" },
  { field: "totalAmount", label: "总价", reason: "报关单必填" },
  { field: "currency", label: "币制", reason: "报关单必填" },
  { field: "originCountry", label: "原产国", reason: "报关单必填" },
  { field: "destinationCountry", label: "运抵国", reason: "报关单必填" },
  { field: "tradeMode", label: "监管方式", reason: "报关单必填" },
  { field: "transportMode", label: "运输方式", reason: "报关单必填" },
  { field: "grossWeightKg", label: "毛重（千克）", reason: "报关单必填" },
  { field: "netWeightKg", label: "净重（千克）", reason: "报关单必填" },
  { field: "packages", label: "件数", reason: "报关单必填" },
];

export function renderSkillPlaintext(): SkillPlaintext {
  const lines: string[] = [
    "报关合规审查 Skill 明文",
    "格式 customs-compliance-skill-plaintext-v1",
    "本文件只在买断付款成功后交付。周期付费不提供这份明文。",
    "",
    "一、禁止类关键词（命中则风险等级为拦截）",
    ...BANNED_KEYWORDS.map((rule) => `- ${rule.keyword}：${rule.message}`),
    "",
    "二、限制类关键词（命中则至少为复核，并要求许可证号）",
    ...RESTRICTED_KEYWORDS.map((rule) => `- ${rule.keyword}：${rule.message}`),
    "",
    "三、必填栏位",
    ...REQUIRED_FIELDS.map((field) => `- ${field.field} ${field.label}：${field.reason}`),
    "- contractNo 合同协议号：出口时必填",
    "- licenseNo 许可证号：命中禁限关键词时必填",
    "- taxCode 税收分类编码：跨境监管方式下必填，且为 19 位数字",
    "",
    "四、HS / 税码启发式",
    "- HS 去掉空格、点、横线后须为 10 位数字",
    "- 多个税号前缀同时命中时，只保留最长前缀",
    ...HS_PREFIX_RULES.map((rule) => `- ${rule.prefix} ${rule.code}（${rule.level}）：${rule.message}`),
    ...NAME_HS_RULES.map((rule) => `- ${rule.code}：${rule.message}`),
    "- TAX_CODE_FORMAT：已填税收分类编码但不是 19 位数字",
    "- TAX_CODE_MISSING：监管方式含「跨境」但未填税收分类编码",
    "- WEIGHT_NET_GT_GROSS：净重大于毛重",
  ];

  return {
    format: "customs-compliance-skill-plaintext-v1",
    title: "报关合规审查 Skill 明文",
    text: lines.join("\n"),
  };
}
