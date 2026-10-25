// lib/validate.js — worldwide shipping validation (same rules as the popup; the server never trusts the browser alone)
import { parsePhoneNumberFromString } from "libphonenumber-js/min";

export const ISO = "AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IS IT JE JM JO JP KE KG KH KI KM KN KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW".split(" ");
const NO_ZIP = new Set("AE AG AI AO AW BF BI BJ BO BQ BS BW BZ CD CF CG CI CK CM CW DJ DM ER FJ GA GD GH GM GQ GY HK KI KM KN LY ML MO MR MW NR NU QA RW SB SC SL SO SR SS ST SX TD TF TG TK TL TO TV UG VU YE ZW".split(" "));
const ZIP = {
  US: /^\d{5}(-\d{4})?$/, CA: /^[A-CEGHJ-NPR-TVXY]\d[A-CEGHJ-NPR-TV-Z] ?\d[A-CEGHJ-NPR-TV-Z]\d$/i, GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
  AU: /^\d{4}$/, NZ: /^\d{4}$/, IN: /^\d{6}$/, DE: /^\d{5}$/, FR: /^\d{5}$/, IT: /^\d{5}$/, ES: /^\d{5}$/, NL: /^\d{4} ?[A-Z]{2}$/i,
  BE: /^\d{4}$/, CH: /^\d{4}$/, AT: /^\d{4}$/, DK: /^\d{4}$/, NO: /^\d{4}$/, SE: /^\d{3} ?\d{2}$/, FI: /^\d{5}$/, PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/, IE: /^[A-Z]\d[\dW] ?[A-Z\d]{4}$/i, JP: /^\d{3}-?\d{4}$/, BR: /^\d{5}-?\d{3}$/, MX: /^\d{5}$/, SG: /^\d{6}$/,
  ZA: /^\d{4}$/, CN: /^\d{6}$/, KR: /^\d{5}$/, MY: /^\d{5}$/, PH: /^\d{4}$/, TH: /^\d{5}$/, ID: /^\d{5}$/, IL: /^\d{7}$/, SA: /^\d{5}(-\d{4})?$/,
  TR: /^\d{5}$/, RU: /^\d{6}$/, UA: /^\d{5}$/, GR: /^\d{3} ?\d{2}$/, CZ: /^\d{3} ?\d{2}$/, SK: /^\d{3} ?\d{2}$/, HU: /^\d{4}$/, RO: /^\d{6}$/,
  BG: /^\d{4}$/, HR: /^\d{5}$/, SI: /^\d{4}$/, LU: /^\d{4}$/, CL: /^\d{7}$/, CO: /^\d{6}$/, PE: /^\d{5}$/, PK: /^\d{5}$/, BD: /^\d{4}$/,
  LK: /^\d{5}$/, NP: /^\d{5}$/, EG: /^\d{5}$/, MA: /^\d{5}$/, KE: /^\d{5}$/, NG: /^\d{6}$/, VN: /^\d{6}$/, AR: /^([A-Z]\d{4}[A-Z]{3}|\d{4})$/i,
};
const ZIP_ANY = /^[A-Z0-9][A-Z0-9 -]{1,9}$/i;
const PROV = {
  US: "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR AA AE AP".split(" "),
  CA: "AB BC MB NB NL NS NT NU ON PE QC SK YT".split(" "),
  AU: "ACT NSW NT QLD SA TAS VIC WA".split(" "),
};
const LETTERS = /^[\p{L}][\p{L}\p{M}' .,-]{0,59}$/u;

export function validateShipping(s) {
  const c = s.country_code;
  if (!ISO.includes(c)) return ["country_code"];
  const bad = [];
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(s.email)) bad.push("email");
  if (!LETTERS.test(s.first_name)) bad.push("first_name");
  if (!LETTERS.test(s.last_name)) bad.push("last_name");
  if (s.address1.length < 4 || !/\p{L}/u.test(s.address1)) bad.push("address1");
  if (!/^[\p{L}][\p{L}\p{M}' .,()-]{1,59}$/u.test(s.city)) bad.push("city");
  if (PROV[c] ? !PROV[c].includes(s.province) : s.province) bad.push("province");
  if (!PROV[c] && s.province_name && !/^[\p{L}\d][\p{L}\p{M}\d' .,()-]{0,59}$/u.test(s.province_name)) bad.push("province_name");
  if (NO_ZIP.has(c) ? false : !(ZIP[c] || ZIP_ANY).test(s.zip)) bad.push("zip");
  const p = parsePhoneNumberFromString(s.phone || "", c);
  if (!p || !p.isValid()) bad.push("phone");
  else s.phone = p.number; // normalised E.164, e.g. +447911123456
  return bad;
}
