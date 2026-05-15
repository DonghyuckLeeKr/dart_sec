export const SECTORS = {
  securities: {
    description: "스팩, 펀드, SPC, 해외지점, 과거 합병법인을 제외한 국내 증권사 비교 유니버스",
    companies: [
      { name: "미래에셋증권", corp_code: "00111722", stock_code: "006800" },
      { name: "NH투자증권", corp_code: "00120182", stock_code: "005940" },
      { name: "한국투자증권", corp_code: "00160144", stock_code: "" },
      { name: "삼성증권", corp_code: "00104856", stock_code: "016360" },
      { name: "KB증권", corp_code: "00164876", stock_code: "003450" },
      { name: "신한투자증권", corp_code: "00138321", stock_code: "" },
      { name: "하나증권", corp_code: "00113465", stock_code: "" },
      { name: "메리츠증권", corp_code: "00163682", stock_code: "" },
      { name: "키움증권", corp_code: "00296290", stock_code: "039490" },
      { name: "대신증권", corp_code: "00110893", stock_code: "003540" },
      { name: "한화투자증권", corp_code: "00148610", stock_code: "003530" },
      { name: "유안타증권", corp_code: "00117601", stock_code: "003470" },
      { name: "DB금융투자", corp_code: "00115694", stock_code: "016610" },
      { name: "유진투자증권", corp_code: "00131054", stock_code: "001200" },
      { name: "교보증권", corp_code: "00113359", stock_code: "030610" },
      { name: "신영증권", corp_code: "00136721", stock_code: "001720" },
      { name: "현대차증권", corp_code: "00137997", stock_code: "001500" },
      { name: "SK증권", corp_code: "00131850", stock_code: "001510" },
      { name: "LS증권", corp_code: "00330424", stock_code: "078020" },
      { name: "한양증권", corp_code: "00162416", stock_code: "001750" },
      { name: "코리아에셋투자증권", corp_code: "00304915", stock_code: "190650" },
      { name: "부국증권", corp_code: "00123772", stock_code: "001270" },
      { name: "유화증권", corp_code: "00145190", stock_code: "003460" },
      { name: "상상인증권", corp_code: "00112059", stock_code: "001290" },
      { name: "다올투자증권", corp_code: "00156859", stock_code: "030210" },
      { name: "BNK투자증권", corp_code: "00251400", stock_code: "" },
      { name: "아이엠증권", corp_code: "00148665", stock_code: "" },
      { name: "아이비케이투자증권", corp_code: "00684918", stock_code: "" },
      { name: "토스증권", corp_code: "01527984", stock_code: "" },
      { name: "카카오페이증권", corp_code: "00762146", stock_code: "" },
      { name: "우리투자증권", corp_code: "01015364", stock_code: "" },
      { name: "케이프투자증권", corp_code: "00684972", stock_code: "" },
      { name: "리딩투자증권", corp_code: "00323549", stock_code: "" },
      { name: "흥국증권", corp_code: "00380836", stock_code: "" }
    ]
  },
  securities_listed: {
    description: "종목코드가 있는 국내 증권사 중심 비교 유니버스. 스팩, 펀드, SPC, 과거 합병법인은 제외",
    companies: [
      { name: "미래에셋증권", corp_code: "00111722", stock_code: "006800" },
      { name: "NH투자증권", corp_code: "00120182", stock_code: "005940" },
      { name: "삼성증권", corp_code: "00104856", stock_code: "016360" },
      { name: "KB증권", corp_code: "00164876", stock_code: "003450" },
      { name: "메리츠증권", corp_code: "00163682", stock_code: "" },
      { name: "키움증권", corp_code: "00296290", stock_code: "039490" },
      { name: "대신증권", corp_code: "00110893", stock_code: "003540" },
      { name: "한화투자증권", corp_code: "00148610", stock_code: "003530" },
      { name: "유안타증권", corp_code: "00117601", stock_code: "003470" },
      { name: "DB금융투자", corp_code: "00115694", stock_code: "016610" },
      { name: "유진투자증권", corp_code: "00131054", stock_code: "001200" },
      { name: "교보증권", corp_code: "00113359", stock_code: "030610" },
      { name: "신영증권", corp_code: "00136721", stock_code: "001720" },
      { name: "현대차증권", corp_code: "00137997", stock_code: "001500" },
      { name: "SK증권", corp_code: "00131850", stock_code: "001510" },
      { name: "LS증권", corp_code: "00330424", stock_code: "078020" },
      { name: "한양증권", corp_code: "00162416", stock_code: "001750" },
      { name: "코리아에셋투자증권", corp_code: "00304915", stock_code: "190650" },
      { name: "부국증권", corp_code: "00123772", stock_code: "001270" },
      { name: "유화증권", corp_code: "00145190", stock_code: "003460" },
      { name: "상상인증권", corp_code: "00112059", stock_code: "001290" },
      { name: "다올투자증권", corp_code: "00156859", stock_code: "030210" }
    ]
  }
};

export function sectorNames() {
  return Object.keys(SECTORS);
}

export function resolveCompanies(sector, limit, offset = 0) {
  const entry = SECTORS[sector];
  if (!entry) {
    throw new Error(`알 수 없는 섹터입니다: ${sector}`);
  }
  const count = Number(limit || 0);
  const start = Math.max(Number(offset || 0), 0);
  const rows = entry.companies.slice(start);
  return count > 0 ? rows.slice(0, count) : rows;
}
