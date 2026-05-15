import { strFromU8, unzipSync } from "fflate";

const REPORT_PERIOD_END = {
  "11013": "03-31",
  "11012": "06-30",
  "11014": "09-30",
  "11011": "12-31"
};

const FACTS = {
  operating_revenue: {
    localNames: ["Revenue", "OperatingRevenue"],
    accountId: "ifrs-full_Revenue",
    accountName: "영업수익",
    period: "duration",
    ord: "1"
  },
  operating_income: {
    localNames: ["ProfitLossFromOperatingActivities", "OperatingIncomeLoss"],
    accountId: "ifrs-full_ProfitLossFromOperatingActivities",
    accountName: "영업이익",
    period: "duration",
    ord: "2"
  },
  pretax_income: {
    localNames: ["ProfitLossBeforeTax", "ProfitLossFromContinuingOperationsBeforeTax"],
    accountId: "ifrs-full_ProfitLossBeforeTax",
    accountName: "세전이익",
    period: "duration",
    ord: "3"
  },
  net_income: {
    localNames: ["ProfitLoss"],
    accountId: "ifrs-full_ProfitLoss",
    accountName: "당기순이익",
    period: "duration",
    ord: "4"
  },
  assets: {
    localNames: ["Assets"],
    accountId: "ifrs-full_Assets",
    accountName: "자산총계",
    period: "instant",
    ord: "5"
  },
  liabilities: {
    localNames: ["Liabilities"],
    accountId: "ifrs-full_Liabilities",
    accountName: "부채총계",
    period: "instant",
    ord: "6"
  },
  equity: {
    localNames: ["Equity"],
    accountId: "ifrs-full_Equity",
    accountName: "자본총계(자기자본)",
    period: "instant",
    ord: "7"
  }
};

const COMPONENT_FACTS = {
  FeeAndCommissionIncome: ["ifrs-full_FeeAndCommissionIncome", "수수료수익"],
  RevenueFromInterest: ["ifrs-full_RevenueFromInterest", "이자수익"],
  RevenueFromDividends: ["ifrs-full_RevenueFromDividends", "배당수익"],
  GainFromFinancialInstruments: ["ifrs-full_GainFromFinancialInstruments", "금융상품관련이익"],
  GainFromFinancialInstrumentsAtFairValueThroughProfitOrLoss: ["ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughProfitOrLoss", "당기손익-공정가치측정금융상품관련이익"],
  GainFromFinancialInstrumentsAtAmortisedCost: ["ifrs-full_GainFromFinancialInstrumentsAtAmortisedCost", "상각후원가측정금융상품관련이익"],
  GainFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome: ["ifrs-full_GainFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome", "기타포괄손익-공정가치측정금융자산관련이익"],
  GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss: ["ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughProfitOrLoss", "당기손익-공정가치측정금융상품관련순손익"],
  GainLossFromFinancialInstrumentsAtAmortisedCost: ["ifrs-full_GainLossFromFinancialInstrumentsAtAmortisedCost", "상각후원가측정금융상품관련순손익"],
  GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome: ["ifrs-full_GainLossFromFinancialInstrumentsAtFairValueThroughOtherComprehensiveIncome", "기타포괄손익-공정가치측정금융자산관련순손익"],
  ForeignExchangeGain: ["ifrs-full_ForeignExchangeGain", "외환거래이익"],
  GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss: ["ifrs-full_GainsLossesOnExchangeDifferencesOnTranslationRecognisedInProfitOrLoss", "외환거래손익"],
  OtherOperatingIncome: ["ifrs-full_OtherOperatingIncome", "기타영업수익"],
  OtherOperatingIncomeExpense: ["ifrs-full_OtherOperatingIncomeExpense", "기타의영업손익"],
  MiscellaneousOtherOperatingIncome: ["ifrs-full_MiscellaneousOtherOperatingIncome", "기타영업수익"]
};

export function parseXbrlFinancialStatement(rawZip, { corpCode, corpName, stockCode, bsnsYear, reprtCode, fsDiv, fallbackOfs, rceptNo }) {
  const xml = xbrlText(rawZip);
  const contexts = parseContexts(xml);
  const periodEnd = `${bsnsYear}-${REPORT_PERIOD_END[reprtCode]}`;
  for (const candidateFsDiv of fsDivCandidates(fsDiv, fallbackOfs)) {
    const rows = extractForFsDiv(xml, contexts, {
      corpCode,
      corpName,
      stockCode,
      bsnsYear,
      reprtCode,
      fsDiv: candidateFsDiv,
      periodEnd,
      rceptNo
    });
    if (rows.length) {
      return { rows, usedFsDiv: candidateFsDiv };
    }
  }
  return { rows: [], usedFsDiv: fsDiv };
}

function xbrlText(rawZip) {
  const files = unzipSync(rawZip);
  const name = Object.keys(files).find((path) => /\.(xbrl|xml)$/i.test(path) && !/_lab-/i.test(path));
  if (!name) {
    throw new Error("XBRL ZIP 안에서 XBRL 파일을 찾지 못했습니다.");
  }
  return strFromU8(files[name]);
}

function parseContexts(xml) {
  const contexts = {};
  const regex = /<[^>]*context\b([^>]*)>([\s\S]*?)<\/[^>]*context>/g;
  for (const match of xml.matchAll(regex)) {
    const id = attr(match[1], "id");
    if (!id) continue;
    const body = match[2];
    contexts[id] = {
      contextId: id,
      instant: tagText(body, "instant"),
      startDate: tagText(body, "startDate"),
      endDate: tagText(body, "endDate"),
      members: [...body.matchAll(/<[^>]*explicitMember\b[^>]*>([^<]*)<\/[^>]*explicitMember>/g)].map((item) => item[1] || "")
    };
  }
  return contexts;
}

function extractForFsDiv(xml, contexts, options) {
  const rows = [];
  const memberKeyword = options.fsDiv === "CFS" ? "ConsolidatedMember" : "SeparateMember";
  for (const [metricName, spec] of Object.entries(FACTS)) {
    const contextIds = matchingContextIds(contexts, options.periodEnd, spec.period, memberKeyword);
    const fact = findFact(xml, contextIds, spec.localNames);
    if (!fact) continue;
    const amount = fact.text;
    rows.push({
      corp_code: options.corpCode,
      corp_name: options.corpName,
      stock_code: options.stockCode,
      bsns_year: String(options.bsnsYear),
      reprt_code: options.reprtCode,
      account_id: spec.accountId,
      account_nm: spec.accountName,
      sj_div: spec.period === "instant" ? "BS" : "IS",
      sj_nm: spec.period === "instant" ? "재무상태표" : "손익계산서",
      thstrm_amount: amount,
      thstrm_add_amount: spec.period === "duration" ? amount : "",
      ord: spec.ord,
      currency: fact.unitRef,
      rcept_no: options.rceptNo,
      data_source: "XBRL 원문",
      xbrl_metric: metricName
    });
  }
  rows.push(...extractComponentRows(xml, contexts, options, memberKeyword));
  return rows;
}

function extractComponentRows(xml, contexts, options, memberKeyword) {
  const rows = [];
  const contextIds = matchingContextIds(contexts, options.periodEnd, "duration", memberKeyword);
  let ord = 101;
  for (const [localName, [accountId, accountName]] of Object.entries(COMPONENT_FACTS)) {
    const fact = findFact(xml, contextIds, [localName]);
    if (!fact) continue;
    rows.push({
      corp_code: options.corpCode,
      corp_name: options.corpName,
      stock_code: options.stockCode,
      bsns_year: String(options.bsnsYear),
      reprt_code: options.reprtCode,
      account_id: accountId,
      account_nm: accountName,
      sj_div: "IS",
      sj_nm: "손익계산서",
      thstrm_amount: fact.text,
      thstrm_add_amount: fact.text,
      ord: String(ord),
      currency: fact.unitRef,
      rcept_no: options.rceptNo,
      data_source: "XBRL 원문",
      xbrl_component: localName
    });
    ord += 1;
  }
  return rows;
}

function matchingContextIds(contexts, periodEnd, periodType, memberKeyword) {
  return Object.values(contexts)
    .filter((context) => {
      if (periodType === "instant" && context.instant !== periodEnd) return false;
      if (periodType === "duration" && !(context.startDate.endsWith("-01-01") && context.endDate === periodEnd)) return false;
      return context.members.some((member) => member.includes(memberKeyword));
    })
    .sort((a, b) => contextScore(a).localeCompare(contextScore(b)))
    .map((context) => context.contextId);
}

function contextScore(context) {
  const nonStatementMemberCount = context.members.filter((member) => !member.includes("ConsolidatedAndSeparateFinancialStatementsAxis")).length;
  const accumulatedPreference = /dF[A-Z]*A_/.test(context.contextId) ? 0 : 1;
  return `${String(nonStatementMemberCount).padStart(4, "0")}-${accumulatedPreference}-${String(context.contextId.length).padStart(4, "0")}`;
}

function findFact(xml, contextIds, localNames) {
  const contextRank = new Map(contextIds.map((contextId, index) => [contextId, index]));
  const facts = [];
  for (const localName of localNames) {
    const regex = new RegExp(`<(?:[\\w.-]+:)?${escapeRegExp(localName)}\\b([^>]*)>([^<]*)<\\/(?:[\\w.-]+:)?${escapeRegExp(localName)}>`, "g");
    for (const match of xml.matchAll(regex)) {
      const attrs = match[1];
      const contextRef = attr(attrs, "contextRef");
      if (!contextRank.has(contextRef)) continue;
      const text = (match[2] || "").trim();
      if (!/^-?\d+(\.\d+)?$/.test(text)) continue;
      facts.push({
        rank: contextRank.get(contextRef),
        text,
        unitRef: attr(attrs, "unitRef")
      });
    }
  }
  facts.sort((a, b) => a.rank - b.rank);
  return facts[0] || null;
}

function tagText(xml, tag) {
  const match = new RegExp(`<[^>]*${tag}\\b[^>]*>([^<]*)<\\/[^>]*${tag}>`).exec(xml);
  return match ? (match[1] || "").trim() : "";
}

function attr(attrs, name) {
  const match = new RegExp(`${name}\\s*=\\s*["']([^"']*)["']`).exec(attrs || "");
  return match ? match[1] : "";
}

function fsDivCandidates(fsDiv, fallbackOfs) {
  return fsDiv === "CFS" && fallbackOfs ? ["CFS", "OFS"] : [fsDiv];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
