export type KeywordList = "banned" | "restricted";
export type FlagLevel = "review" | "hold";
export type RiskLevel = "pass" | "review" | "hold";

export interface DeclarationInput {
  shipmentRef?: string;
  direction?: string;
  consignor?: string;
  consignee?: string;
  tradeMode?: string;
  transportMode?: string;
  originCountry?: string;
  destinationCountry?: string;
  goodsName?: string;
  spec?: string;
  hsCode?: string;
  taxCode?: string;
  quantity?: string;
  unit?: string;
  totalAmount?: string;
  currency?: string;
  grossWeightKg?: string;
  netWeightKg?: string;
  packages?: string;
  packageType?: string;
  contractNo?: string;
  invoiceNo?: string;
  licenseNo?: string;
  remark?: string;
}

export interface KeywordHit {
  field: "goodsName" | "spec" | "remark";
  keyword: string;
  list: KeywordList;
  message: string;
}

export interface HsRiskFlag {
  level: FlagLevel;
  code: string;
  message: string;
  hsCode: string | null;
}

export interface MissingField {
  field: string;
  label: string;
  reason: string;
}

export interface ReviewResult {
  shipmentRef: string;
  riskLevel: RiskLevel;
  keywordHits: KeywordHit[];
  hsRisks: HsRiskFlag[];
  missingFields: MissingField[];
  checkedAt: string;
}

export interface GatedReview {
  shipmentRef: string;
  riskLevel: RiskLevel;
  keywordHitCount: number;
  hsRiskCount: number;
  missingFieldCount: number;
  keywordHits: KeywordHit[] | null;
  hsRisks: HsRiskFlag[] | null;
  missingFields: MissingField[] | null;
  checkedAt: string;
}

export interface SkillPlaintext {
  format: "customs-compliance-skill-plaintext-v1";
  title: string;
  text: string;
}
