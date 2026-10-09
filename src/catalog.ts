import { MERCHANT_ID, MERCHANT_NAME, type CatalogSku } from "./types.js";

/**
 * Server-side price list. Payment totals are computed only from these prices.
 * The mug is listed so `sku_not_allowed` can be demonstrated; its name matches
 * none of the default keywords.
 */
export const CATALOG: readonly CatalogSku[] = [
  {
    sku_id: "sku-pen",
    name: "黑色签字笔",
    unit_price_cents: 800,
    allowed_by_default_keywords: true,
  },
  {
    sku_id: "sku-pen-cent",
    name: "签字笔（1分试买）",
    unit_price_cents: 1,
    allowed_by_default_keywords: true,
  },
  {
    sku_id: "sku-paper",
    name: "A4纸 70g 500张",
    unit_price_cents: 2_500,
    allowed_by_default_keywords: true,
  },
  {
    sku_id: "sku-folder",
    name: "资料文件夹",
    unit_price_cents: 1_200,
    allowed_by_default_keywords: true,
  },
  {
    sku_id: "sku-mug",
    name: "陶瓷马克杯",
    unit_price_cents: 3_900,
    allowed_by_default_keywords: false,
  },
];

export function findSku(skuId: string): CatalogSku | undefined {
  return CATALOG.find((sku) => sku.sku_id === skuId);
}

export function catalogView(): {
  merchant_id: string;
  merchant_name: string;
  skus: CatalogSku[];
} {
  return {
    merchant_id: MERCHANT_ID,
    merchant_name: MERCHANT_NAME,
    skus: CATALOG.map((sku) => ({ ...sku })),
  };
}
