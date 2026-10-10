import { CATALOG } from "./catalog.js";

/**
 * Rule parser for one purchase sentence. Prices are not decided here.
 * Callers price every accepted sku_id from the server catalog.
 *
 * A uniquely named whitelist item with no written quantity is 1.
 * Vague quantities and alternatives ask a question instead of guessing.
 * The 1-cent pen is selected only when the sentence says so.
 */

export interface IntentItem {
  sku_id: string;
  quantity: number;
}

export interface IntentRejection {
  name: string;
  message: string;
}

export type IntentInterpretation =
  | { kind: "clarify"; questions: string[] }
  | { kind: "reject"; rejected: IntentRejection[] }
  | { kind: "items"; items: IntentItem[] };

const UNITS = "支枝只个包盒本份箱袋卷";
const STOPWORDS = [
  "会议室",
  "开会",
  "下周",
  "今天",
  "明天",
  "后天",
  "需要",
  "想要",
  "购买",
  "准备",
  "一下",
  "我们",
  "给我",
  "帮我",
  "缺少",
  "缺",
  "买",
  "要",
  "用",
  "的",
  "了",
  "和",
  "与",
  "及",
  "再",
  "还",
  "来",
  "请",
  "帮",
  "我",
].sort((a, b) => b.length - a.length);

interface Phrase {
  text: string;
  skuId: string;
  blocked: boolean;
  label: string;
}

export function normalizeUtterance(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[，。！？、,.!?;；:："“”'‘’（）()【】[\]·\-—]/g, "");
}

function maskStopwords(text: string): string {
  let masked = text;
  for (const word of STOPWORDS) {
    masked = masked.replaceAll(word, "|".repeat(word.length));
  }
  return masked;
}

function isBoundary(ch: string): boolean {
  return ch === "" || ch === "|" || /[0-9]/.test(ch) || UNITS.includes(ch);
}

function phrasesFor(keywords: readonly string[]): Phrase[] {
  const phrases: Phrase[] = [];
  const add = (skuId: string, blocked: boolean, label: string, text: string) => {
    const normalized = normalizeUtterance(text);
    if (!normalized || phrases.some((phrase) => phrase.text === normalized)) return;
    phrases.push({ text: normalized, skuId, blocked, label });
  };
  for (const sku of CATALOG) {
    const allowed = keywords.some((keyword) => keyword.length > 0 && sku.name.includes(keyword));
    add(sku.sku_id, !allowed, sku.name, sku.name);
    if (sku.sku_id === "sku-pen" && allowed) {
      add(sku.sku_id, false, sku.name, "签字笔");
      add(sku.sku_id, false, sku.name, "笔");
    }
    if (sku.sku_id === "sku-pen-cent" && allowed) {
      add(sku.sku_id, false, sku.name, "1分试买");
      add(sku.sku_id, false, sku.name, "一分试买");
      add(sku.sku_id, false, sku.name, "试买");
    }
    if (sku.sku_id === "sku-paper" && allowed) {
      add(sku.sku_id, false, sku.name, "A4纸");
    }
    if (sku.sku_id === "sku-folder" && allowed) {
      add(sku.sku_id, false, sku.name, "文件夹");
    }
    if (sku.sku_id === "sku-mug") {
      add(sku.sku_id, !allowed, sku.name, "马克杯");
      add(sku.sku_id, !allowed, sku.name, "杯子");
    }
  }
  return phrases;
}

function findMatches(masked: string, phrases: readonly Phrase[]): Array<Phrase & { index: number }> {
  const sorted = [...phrases].sort((a, b) => b.text.length - a.text.length);
  const taken = new Array<boolean>(masked.length).fill(false);
  const found: Array<Phrase & { index: number }> = [];
  for (let index = 0; index < masked.length; index += 1) {
    if (taken[index] || masked[index] === "|") continue;
    for (const phrase of sorted) {
      const end = index + phrase.text.length;
      if (!masked.startsWith(phrase.text, index)) continue;
      if (taken.slice(index, end).some(Boolean)) continue;
      const before = index === 0 ? "" : masked[index - 1];
      const after = end >= masked.length ? "" : masked[end];
      if (!isBoundary(before) || !isBoundary(after)) continue;
      for (let cursor = index; cursor < end; cursor += 1) taken[cursor] = true;
      found.push({ ...phrase, index });
      break;
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

function parseQty(token: string): number | null {
  if (/^\d+$/.test(token)) {
    const value = Number(token);
    return Number.isSafeInteger(value) && value >= 1 && value <= 100_000 ? value : null;
  }
  const digit: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
  };
  if (token === "十") return 10;
  if (/^十[一二三四五六七八九]$/.test(token)) return 10 + digit[token[1]];
  if (/^[一二三四五六七八九]十$/.test(token)) return digit[token[0]] * 10;
  if (/^[一二三四五六七八九]十[一二三四五六七八九]$/.test(token)) {
    return digit[token[0]] * 10 + digit[token[2]];
  }
  if (token.length === 1 && digit[token] > 0) return digit[token];
  return null;
}

function quantityBefore(masked: string, start: number, previousEnd: number): number | "missing" | "ambiguous" {
  const gap = masked.slice(previousEnd, start).replaceAll("|", "");
  const found = [...gap.matchAll(new RegExp(`([0-9]+|[零〇一二两三四五六七八九十]{1,4})([${UNITS}])?`, "g"))];
  if (found.length === 0) return "missing";
  if (found.length > 1) return "ambiguous";
  const value = parseQty(found[0][1]);
  return value === null ? "ambiguous" : value;
}

function clarify(questions: string[]): IntentInterpretation {
  return { kind: "clarify", questions };
}

function keywordHint(keywords: readonly string[]): string {
  const shown = keywords.filter((keyword) => keyword.length > 0).join("、");
  return shown || "当前授权里的商品";
}

export function interpretRequest(text: string, keywords: readonly string[]): IntentInterpretation {
  const normalized = normalizeUtterance(text);
  const hint = keywordHint(keywords);
  if (!normalized) {
    return clarify([`请说明要买的${hint}，以及数量。`]);
  }
  if (normalized.includes("或者") || normalized.includes("还是")) {
    return clarify(["请直接说要买哪几样。出现「或者」或「还是」时不会猜其中一样，也不会出方案。"]);
  }
  if (/一些|若干|多少|几[支枝只个包盒本份箱袋卷]|买点|点东西|一点/.test(normalized)) {
    return clarify([
      `请写明每种商品的数量，例如「10支笔和2包A4纸」。一些、若干、几 不能直接下单。当前可买的是：${hint}。`,
    ]);
  }

  const masked = maskStopwords(normalized);
  let matches = findMatches(masked, phrasesFor(keywords));
  const centNamed = matches.some((match) => match.skuId === "sku-pen-cent");
  const plainNamed = matches.some((match) => match.skuId === "sku-pen" && match.text === normalizeUtterance("黑色签字笔"));
  if (centNamed && !plainNamed) {
    matches = matches.filter((match) => match.skuId !== "sku-pen");
  }

  let rest = masked;
  for (const match of matches) {
    rest = `${rest.slice(0, match.index)}${"|".repeat(match.text.length)}${rest.slice(match.index + match.text.length)}`;
  }
  rest = rest.replace(new RegExp(`[0-9]+[${UNITS}]?|[零〇一二两三四五六七八九十]{1,4}[${UNITS}]?`, "g"), "");
  rest = rest.replace(new RegExp(`[|${UNITS}a-z]`, "g"), "");
  const unknown = rest.match(/[\u4e00-\u9fff]+/g) ?? [];
  const broad = unknown.filter((word) => /^(东西|文具|用品|商品|货)$/.test(word));
  const specificUnknown = unknown.filter((word) => !/^(东西|文具|用品|商品|货)$/.test(word));

  if (matches.length === 0 && specificUnknown.length === 0) {
    return clarify([`没有识别到可以购买的商品。请说明${hint}，并写上数量。含糊的说法不会生成方案。`]);
  }
  if (broad.length > 0 && matches.length === 0) {
    return clarify([`「${broad.join("、")}」太笼统。请说明${hint}，并写上数量。`]);
  }

  const rejected: IntentRejection[] = [
    ...matches
      .filter((match) => match.blocked)
      .map((match) => ({
        name: match.label,
        message: `「${match.label}」不在当前授权里，买不了，也不会换成别的商品。`,
      })),
    ...specificUnknown.map((name) => ({
      name,
      message: `「${name}」不在目录里，买不了，也不会换成别的商品。`,
    })),
    ...broad.map((name) => ({
      name,
      message: `「${name}」太笼统，不能从白名单里挑一件来代替。`,
    })),
  ];
  if (rejected.length > 0) {
    const seen = new Set<string>();
    return {
      kind: "reject",
      rejected: rejected.filter((item) => {
        if (seen.has(item.name)) return false;
        seen.add(item.name);
        return true;
      }),
    };
  }

  const items: Array<IntentItem & { explicit: boolean }> = [];
  let previousEnd = 0;
  for (const match of matches) {
    const quantity = quantityBefore(masked, match.index, previousEnd);
    previousEnd = match.index + match.text.length;
    if (quantity === "ambiguous") {
      return clarify(["数量没有写清楚。请写成「10支笔」或「两包A4纸」这样的说法。"]);
    }
    const explicit = quantity !== "missing";
    const next = explicit ? quantity : 1;
    const existing = items.find((item) => item.sku_id === match.skuId);
    if (!existing) {
      items.push({ sku_id: match.skuId, quantity: next, explicit });
      continue;
    }
    if (explicit && existing.explicit) existing.quantity += quantity;
    else if (explicit) {
      existing.quantity = quantity;
      existing.explicit = true;
    }
  }
  if (items.some((item) => item.quantity < 1 || item.quantity > 100_000)) {
    return clarify(["数量要在 1 到 100000 之间。"]);
  }
  return { kind: "items", items: items.map(({ sku_id, quantity }) => ({ sku_id, quantity })) };
}
