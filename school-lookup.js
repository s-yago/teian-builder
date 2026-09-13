/* ==================================================================
   school-lookup.js  —  富山市の小学校区・中学校区の判定モジュール
   ViVi不動産 内製ツール共通部品（ファネルチャートと同一ロジック）

   使い方（ブラウザ）:
     <script src="school-lookup.js"></script>
     <script>
       const db  = await (await fetch('data/school_district_toyama.json')).json();
       const ov  = await (await fetch('data/school_override.json')).json();
       const sho = SchoolLookup.of('芝園町１丁目', db, ov);
       // => { sho:'芝園', chu:'芝園', confident:true, label:'芝園小学校' }

       // 成約データなど、明細の配列にまとめて付けるとき
       SchoolLookup.annotate(recs, db, ov);   // 各レコードに school / school_confident /
                                              // school_label / school_chu が入る
     </script>

   使い方（Node.js）:
     const SchoolLookup = require('./school-lookup.js');

   判定の考え方:
     - 町名だけで校区が決まるものは confident:true。label は「芝園小学校」
     - 番地によって分かれる町名は confident:false。label は
       「呉羽小学校または寒江小学校。詳しくはお調べください。」
       候補が3つ以上なら「A小学校・B小学校・C小学校のいずれか。詳しくはお調べください。」
     - お客様に見せる文字列は必ず label を使うこと。sho は候補が配列になる場合がある
     - 区域表に載っていない町名は school_override.json の手動登録で補う

   出典: 富山市小中学校及び義務教育学校通学区域表（令和8年4月1日改正）
   ================================================================== */

const Z2H = s => (s || '').replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

/* PDFによっては「富⼭市」のように部首の文字が使われている。通常の漢字に直す。 */
const RADICAL_FIX = {'⻄':'西','⻑':'長','⻘':'青','⻢':'馬','⻩':'黄','⻭':'歯','⻯':'竜','⻲':'亀',
                     '⻔':'門','⻗':'雨','⻟':'食','⻣':'骨','⻤':'鬼','⺼':'月','⻍':'辶','⻖':'阝',
                     '戶':'戸','靑':'青','黃':'黄'};
function fixKanji(text){
  let out = '';
  for (const ch of (text || '')){
    const o = ch.codePointAt(0);
    if ((o >= 0x2E80 && o <= 0x2FDF) || (o >= 0xF900 && o <= 0xFAFF)){
      let n = ch.normalize('NFKC');
      n = RADICAL_FIX[n] || RADICAL_FIX[ch] || n;
      out += n;
    } else {
      out += RADICAL_FIX[ch] || ch;
    }
  }
  return out;
}
const toInt = s => parseInt(String(s).replace(/,/g, ''), 10);

/* ---------- REINSテキストのパーサ ---------- */
function priceOf(seg){
  let m = seg.match(/([\d,]+)\s*万円/);
  if (m) return toInt(m[1]);
  m = seg.match(/万円\s*\n\s*([\d,]+)\s/);
  return m ? toInt(m[1]) : null;
}
function builtOf(seg){
  let m = seg.match(/(19\d\d|20\d\d)\s*年?（[^）]*）\s*(\d+)\s*月/);
  if (m) return [parseInt(m[1]), parseInt(m[2])];
  m = seg.match(/年（[^）]*）\s*(\d+)\s*月\s*\n\s*(19\d\d|20\d\d)/);
  if (m) return [parseInt(m[2]), parseInt(m[1])];
  return [null, null];
}
/* レイアウト保持テキストでの見た目の列位置（全角は2文字ぶん） */
const WIDE = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/;
function vcol(s, i){
  let w = 0;
  for (let k = 0; k < i; k++) w += WIDE.test(s[k]) ? 2 : 1;
  return w;
}
function lineFields(line){
  const out = [];
  const re = /\S(?:.*?\S)?(?=\s{2,}|$)/g;
  let m;
  while ((m = re.exec(line)) !== null){
    if (m[0].trim()) out.push({ col: m.index, t: m[0] });
    if (re.lastIndex === m.index) re.lastIndex++;
  }
  return out;
}

const JUNK_NAMES = ['一住','二住','一中','二中','商業','近商','準工','工業','一低','二低','準住','無指定','市街化','定めなし'];

function nameMadoriFloor(seg){
  const lines = seg.split('\n');
  let name = null, madori = null, floor = null;

  // (1) 価格行に「建物名  [N階]  間取り」が並ぶ基本形
  for (const line of lines){
    const mm = line.match(new RegExp('^.*[\\d.]\\s*万円\\s{1,}(\\S.*?)\\s{2,}(' + MADORI + ')\\s*$'));
    if (mm){ name = clean(mm[1]); madori = clean(mm[2]).replace(/ /g, ''); break; }
  }
  // (2) 間取りが取れなければ末尾から拾う
  if (madori === null){
    const mm = seg.match(new RegExp('(' + MADORI + ')\\s*$', 'm'));
    if (mm) madori = clean(mm[1]).replace(/ /g, '');
  }
  // (3) 建物名が価格行に無い場合
  if (name === null){
    for (const line of lines){
      const mm = line.match(/^.*[\d.]\s*万円\s{1,}(\S[^円]*?)\s*$/);
      if (mm && !/(徒歩|停歩|バス|分|km)$/.test(mm[1])){ name = clean(mm[1]); break; }
    }
  }
  // (4) 建物名が次行以降に折り返されている場合
  if (name === null){
    for (let i = 0; i < lines.length; i++){
      const line = lines[i];
      if (/[\d.]\s*万円/.test(line) &&
          !(new RegExp('万円\\s{1,}\\S.*(' + MADORI + ')\\s*$')).test(line)){
        for (const nxt of lines.slice(i + 1, i + 4)){
          const mm = nxt.match(/^\s{6,}(\S.*?)\s*$/);
          if (mm && !/(万円|円|徒歩|停歩|バス|分|km|年（)/.test(mm[1])){
            let cand = mm[1];
            const m2 = cand.match(new RegExp('\\s*([0-9０-９]{1,2})\\s*階\\s*(' + MADORI + ')?\\s*$'));
            if (m2){
              if (floor === null) floor = parseInt(Z2H(m2[1]));
              cand = cand.slice(0, m2.index);
            } else {
              cand = cand.replace(new RegExp('\\s{2,}(' + MADORI + ')\\s*$'), '');
            }
            name = clean(cand) || null;
            break;
          }
        }
        break;
      }
    }
  }
  if (name){
    // 建物名の末尾に付いた階数を分離
    for (let k = 0; k < 3; k++){
      const nz = Z2H(name);
      const mm = nz.match(/\s*(\d{1,2})\s*階\s*$/);
      if (!mm) break;
      if (floor === null) floor = parseInt(mm[1]);
      name = clean(name.slice(0, mm.index)) || '';
    }
    if (name && /階\s*$/.test(name)){
      const head = name.replace(/\s*階\s*$/, '').trim();
      let idx = -1;
      if (head.slice(0, 6)) idx = lines.findIndex(l => l.includes(head.slice(0, 6)));
      if (idx >= 0){
        for (const nxt of lines.slice(idx + 1, idx + 5)){
          if (!nxt.trim()) break;            // 空行より先は別の物件の断片
          const mm2 = nxt.match(new RegExp('^\\s*([0-9０-９]{1,2})(?:\\s+([1-9１-９]))?(?:\\s*' + MADORI + ')?\\s*$'));
          if (mm2){
            if (floor === null) floor = parseInt(Z2H(mm2[1]));
            if (mm2[2] && madori && !/^[1-9１-９]/.test(madori)) madori = Z2H(mm2[2]) + madori;
            break;
          }
        }
      }
      name = head;
    }
    name = name || null;
  }
  if (name && /^[-\s]*[\d.,]+\s*(万円|円)\s*$/.test(name)) name = null;
  if (name && (/^[-\d.,㎡\s]*$/.test(name) || JUNK_NAMES.includes(name))) name = null;

  // (5) 建物名が長く、価格行の上下の行に分かれて出るレイアウト
  //     （ブラウザでPDFから起こした場合によく起きる）
  if (name === null){
    let pi = null;
    const mdEnd0 = new RegExp('(' + MADORI + ')\\s*$');
    lines.forEach((line, i) => { if (/[\d.]\s*万円/.test(line) && mdEnd0.test(line)) pi = i; });
    if (pi === null) lines.forEach((line, i) => { if (/[\d.]\s*万円/.test(line)) pi = i; });
    if (pi !== null){
      const parts = [];
      for (const j of [pi - 1, pi + 1]){
        if (j < 0 || j >= lines.length || !lines[j].trim()) continue;
        if (/(万円|円|徒歩|停歩|バス|㎡|年（|階)/.test(lines[j])) continue;
        const m5 = lines[j].match(/^\s*(\S(?:.*?\S)?)\s*$/);
        if (m5 && vcol(lines[j], m5.index + m5[0].indexOf(m5[1])) >= 40
            && !/^[-0-9０-９\s]*$/.test(m5[1])){
          parts.push([j, m5[1]]);
        }
      }
      if (parts.length){
        parts.sort((a, b) => a[0] - b[0]);
        name = clean(parts.map(x => x[1]).join(''));
      }
    }
  }

  // セルが折り返され、間取りの数字・所在階・建物名の続きが次の行に落ちる場合の補正
  // 例）「… 3階              ＬＤＫ」／次行に「Ｅ ＦＯＲＴ」と「3」
  let anchor = null;
  const mdEnd = new RegExp('(' + MADORI + ')\\s*$');
  lines.forEach((line, i) => {
    if (!mdEnd.test(line)) return;
    const fs = lineFields(line);
    if (fs.length >= 2) anchor = { i, ncol: vcol(line, fs[fs.length - 2].col) };
  });
  if (anchor){
    const digits = [];
    for (const nxt of lines.slice(anchor.i + 1, anchor.i + 4)){
      if (!nxt.trim()) break;                // 空行より先は別の物件の断片
      if (/(万円|円|徒歩|停歩|バス|年（|㎡)/.test(nxt)) continue;
      const re2 = /(?:^|\s{2,})([0-9０-９]{1,2})(?=\s{2,}|$)/g;
      let m2;
      while ((m2 = re2.exec(nxt)) !== null){
        const at = nxt.indexOf(m2[1], m2.index);
        if (vcol(nxt, at) >= 40) digits.push(parseInt(Z2H(m2[1])));
      }
      const m3 = nxt.match(/^\s*(\S(?:.*?\S)?)(?=\s{2,}|$)/);
      if (m3 && name && Math.abs(vcol(nxt, m3.index + m3[0].indexOf(m3[1])) - anchor.ncol) <= 2
          && !/^[0-9０-９\s]*$/.test(m3[1])){
        name = name + m3[1];
      }
    }
    if (digits.length){
      if (madori && !/^[1-9１-９]/.test(madori)){
        madori = String(digits[digits.length - 1]) + madori;
        digits.pop();
      }
      if (floor === null && digits.length) floor = digits[digits.length - 1];
    }
  }

  if (floor === null){
    const mm = seg.match(/\s([0-9０-９]{1,2})\s*階\s/);
    if (mm) floor = parseInt(Z2H(mm[1]));
  }
  return [name, madori, floor];
}

function normalizeText(text){
  return text.replace(new RegExp('^\\s*(' + KIND_PAT + ')\\s*\\n(\\s*)(\\d{9,12})(\\s|$)', 'gm'),
                      (m, a, b, c, d) => b + c + ' ' + a + ' ');
}

const KANJI = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
function kanjiNum(s){
  if (KANJI[s]) return KANJI[s];
  const m = s.match(/^十([一二三四五六七八九])$/);
  return m ? 10 + KANJI[m[1]] : null;
}
function norm(t){
  t = (t || '').normalize('NFKC').trim().replace(/ /g, '').replace(/ケ/g, 'ヶ');
  const pairs = [['舘','館'],['曽','曾'],['冨','富'],['嶋','島'],['渕','淵'],['沢','澤'],['タ林','夕林']];
  for (const [a, b] of pairs) t = t.split(a).join(b);
  // 「上ニ杉」「ニ松」のようにカタカナのニで書かれた漢数字を二に直す
  // （「ニュータウン」など本当のカタカナ語は前後の文字で見分けて残す）
  const isKata = ch => !!ch && /[ァ-ヴー]/.test(ch);
  let out = '';
  for (let i = 0; i < t.length; i++){
    out += (t[i] === 'ニ' && !isKata(t[i - 1]) && !isKata(t[i + 1])) ? '二' : t[i];
  }
  t = out;
  let cut = false;
  for (let n = 2; n < 7; n++){
    if (t.length > n * 2 && t.slice(0, n) === t.slice(n, n * 2)){ t = t.slice(n); cut = true; break; }
  }
  if (!cut){
    const m = t.match(/^(.{2,5})町/);
    if (m && t.startsWith(m[1] + '町' + m[1])) t = t.slice(m[1].length + 1);
  }
  t = t.replace(/([一二三四五六七八九]|十[一二三四五六七八九]?)丁目/g, (mm, g) => {
    const n = kanjiNum(g); return n ? n + '丁目' : mm;
  });
  return Z2H(t);
}
function expand(town){
  const t = norm(town);
  let m = t.match(/^(.+?)(\d+)丁目[~〜～\-](?:.*?)(\d+)丁目$/);
  if (m){ const out = []; for (let i = +m[2]; i <= +m[3]; i++) out.push(m[1] + i + '丁目'); return out; }
  m = t.match(/^(.+?)(\d+)区[~〜～\-](?:.*?)(\d+)区$/);
  if (m){ const out = []; for (let i = +m[2]; i <= +m[3]; i++) out.push(m[1] + i + '区'); return out; }
  return [t];
}

function parseSchoolTable(raw){
  raw = fixKanji(raw);
  const entries = [];
  let sho = null, chu = null, buf = [];
  const flush = () => {
    if (sho && chu && buf.length){
      let joined = '';
      for (const part of buf){
        const p = part.trim();
        if (!p) continue;
        const broken = /(丁|[一二三四五六七八九十]|第|字|番|の)$/.test(joined) || /^(目|丁|番|号|区|[~〜～])/.test(p);
        if (joined && !/[、，]$/.test(joined) && !/^[、，)）]/.test(p) && !broken) joined += '、';
        joined += p;
      }
      entries.push([sho, chu, joined]);
    }
  };
  // 2文字以上の空白を列の区切りとみなし、各項目の開始位置（何文字目か）を取る
  const fields = line => {
    const out = [];
    const re = /\S(?:.*?\S)?(?=\s{2,}|$)/g;
    let m;
    while ((m = re.exec(line)) !== null){
      if (m[0].trim()) out.push({ t: m[0], col: m.index });
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    return out;
  };

  // ページごとに列の位置を測る（PDFの起こし方でページごとに字下げが変わるため）
  for (const page of raw.split('\f')){
    const keep = [];
    for (const ln of page.split('\n')){
      const t = ln.replace(/\s+$/, '');
      if (!t.trim()) continue;
      if (/通学区域表|改正/.test(t) || /^\s*\d\/\d\s*$/.test(t)) continue;
      if (/^\s*小学校\s+中学校\s+町名\s*$/.test(t)) continue;
      keep.push(t);
    }
    if (!keep.length) continue;

    const indent = l => l.length - l.replace(/^ +/, '').length;
    // 町名の列＝もっとも多く現れる字下げ（折り返し行が一番多いため）
    const count = {};
    keep.forEach(l => { count[indent(l)] = (count[indent(l)] || 0) + 1; });
    let townCol = 0, best = -1;
    for (const k in count) if (count[k] > best){ best = count[k]; townCol = +k; }
    // 小学校の列＝町名より左にある行のうち、いちばん左
    const heads = keep.filter(l => indent(l) < townCol - 2).map(indent);
    const base = heads.length ? Math.min.apply(null, heads) : 0;

    for (const line of keep){
      const f = fields(line);
      const ind = indent(line);
      // 学校名らしい項目か（短くて、町名の並びではなく、「（前期課程）」のような続きでもない）
      const nameLike = x => x && x.length <= 10 && !/[、，]/.test(x) && !/^[（(]/.test(x);
      const isRow = f.length >= 3 && ind <= base + 2 && nameLike(f[0].t) && nameLike(f[1].t);
      const isChu = !isRow && f.length >= 2 && ind > base + 2 && ind < townCol - 2 && nameLike(f[0].t);
      if (isRow){
        flush(); buf = [];
        sho = f[0].t; chu = f[1].t;
        buf.push(f.slice(2).map(x => x.t).join(''));
      } else if (isChu && sho){
        flush(); buf = [];
        chu = f[0].t;
        buf.push(f.slice(1).map(x => x.t).join(''));
      } else {
        buf.push(line.trim());
      }
    }
  }
  flush();

  const towns = {};
  for (const [sho_, chu_, body] of entries){
    for (const chunk of body.replace(/[、，]/g, '\n').split('\n')){
      const c = chunk.trim();
      if (!c) continue;
      let hasCond = /[(（]/.test(c);
      let base = c.replace(/[(（][^)）]*[)）]?/g, '').trim();
      const mBare = base.match(/^(.*?[^\d\s,~〜～])\s+[\d\s,~〜～]*\d\s*[番号](のみ|を除く)?$/);
      if (mBare){ base = mBare[1].trim(); hasCond = true; }
      if (/[)）]/.test(base)) base = base.split(/[)）]/).pop().trim();
      base = base.replace(/^[\d\s,~〜～のを除るみ番号字第､、]+/, '').trim();
      if (!base || /^[\d\s,~〜～のを除るみ番号字第]*$/.test(base)) continue;
      for (const t of expand(base)){
        if (!t) continue;
        if (!towns[t]) towns[t] = { sho: [], chu: [], partial: false };
        if (!towns[t].sho.includes(sho_)) towns[t].sho.push(sho_);
        if (!towns[t].chu.includes(chu_)) towns[t].chu.push(chu_);
        if (hasCond) towns[t].partial = true;
      }
    }
  }
  for (const t in towns) if (towns[t].sho.length > 1) towns[t].partial = true;
  const shoSet = new Set();
  for (const t in towns) towns[t].sho.forEach(s => shoSet.add(s));
  return { city: '富山市', towns, sho_list: [...shoSet].sort() };
}

function lookupSchool(db, town){
  const t = norm(town);
  const towns = db.towns || {};
  const pick = rec => (rec.sho.length === 1 && !rec.partial) ? [rec.sho[0], true] : [rec.sho, false];
  if (towns[t]) return pick(towns[t]);
  const t2 = t.replace(/\d+丁目$/, '');
  if (t2 !== t && towns[t2]) return pick(towns[t2]);
  let cands = new Set();
  for (const k in towns) if (k.startsWith(t)) towns[k].sho.forEach(s => cands.add(s));
  if (cands.size === 1) return [[...cands][0], true];
  if (cands.size) return [[...cands].sort(), false];
  const m = t.match(/^(.+?)町$/);
  if (m){
    cands = new Set();
    for (const k in towns) if (k.startsWith(m[1])) towns[k].sho.forEach(s => cands.add(s));
    if (cands.size === 1) return [[...cands][0], true];
    if (cands.size) return [[...cands].sort(), false];
  }
  const keys = Object.keys(towns).sort((a, b) => b.length - a.length);
  for (const k of keys) if (k.length >= 2 && t.startsWith(k)) return pick(towns[k]);
  return [null, false];
}

function schoolLabel(school, confident){
  if (confident && typeof school === 'string') return school + '小学校';
  if (!school) return '校区は要確認';
  const arr = typeof school === 'string' ? [school] : school;
  const names = arr.map(s => s + '小学校');
  if (names.length >= 3) return names.join('・') + 'のいずれか。詳しくはお調べください。';
  return names.join('または') + '。詳しくはお調べください。';
}

function normName(s){
  return (s || '').normalize('NFKC').trim().toUpperCase()
    .replace(/\s+/g, '').replace(/(ワンルーム|[A-C]棟|棟)$/, '');
}

function annotateSchool(recs, db, ov){
  if (db && db.towns){
    for (const r of recs){
      const [s, c] = lookupSchool(db, r.town || '');
      r.school = c ? s : (s || null);
      r.school_confident = c;
      r.school_label = schoolLabel(r.school, c);
    }
  }
  if (!ov) return recs;
  const mans = ov.mansions || [], kod = ov.kodate_towns || [], notes = ov.notes || [];
  const noteIdx = {}; notes.forEach(n => noteIdx[n.town] = n);
  const townIdx = {}; kod.forEach(t => townIdx[t.town] = t);
  for (const r of recs){
    if (r.school_confident) continue;
    let m = mans.find(x => x.town === r.town && normName(x.name) === normName(r.name));
    if (!m && r.name) m = mans.find(x => normName(x.name) === normName(r.name));
    if (!m && r.name){
      let frag = r.name;
      for (const pre of ['富山市', r.town || '', (r.town || '').replace(/\d+丁目$/, '')]){
        if (pre) frag = frag.split(pre).join('');
      }
      frag = normName(frag.replace(/^[\s\d\-－丁目]+/, ''));
      if (frag.length >= 4){
        const cands = mans.filter(x => x.town === r.town && normName(x.name).startsWith(frag));
        if (cands.length && new Set(cands.map(c => c.sho)).size === 1) m = cands[0];
      }
    }
    if (!m) m = townIdx[r.town];
    const note = noteIdx[r.town];
    if (note){
      r.school = note.candidates || null;
      r.school_confident = false;
      r.school_label = schoolLabel(r.school, false);
      continue;
    }
    if (m){
      r.school = m.sho; r.school_confident = true; r.school_label = schoolLabel(m.sho, true);
      if (m.chu) r.school_chu = m.chu;
    }
  }
  return recs;
}

function shintaishin(r){
  if (r.newbuild) return true;
  if (!r.built_y) return null;
  const y = r.built_y, m = r.built_m || 1;
  return (y > 1981) || (y === 1981 && m >= 6);
}


/* ---- 公開API ---- */
function chuDbOf(db){
  // 中学校区を同じ照合ロジックで引くための入れ替えDB
  const towns = {};
  for (const t in db.towns){
    const v = db.towns[t];
    towns[t] = { sho: v.chu, chu: v.chu, partial: v.partial };
  }
  return { city: db.city, towns: towns };
}

/* 町名から校区を引く。戻り値 {sho, chu, confident, label, candidates} */
function of(town, db, ov){
  const rec = { town: town };
  annotateSchool([rec], db, ov || null);
  let chu = rec.school_chu || null;
  if (!chu && db && db.towns){
    const r2 = lookupSchool(chuDbOf(db), town || '');
    if (r2[1] && typeof r2[0] === 'string') chu = r2[0];
    else if (Array.isArray(r2[0]) && r2[0].length === 1) chu = r2[0][0];
  }
  return {
    sho: rec.school_confident ? rec.school : null,
    candidates: rec.school_confident ? null : (Array.isArray(rec.school) ? rec.school : null),
    chu: chu,
    confident: !!rec.school_confident,
    label: rec.school_label
  };
}

/* 明細の配列にまとめて付ける（school / school_confident / school_label / school_chu） */
function annotate(recs, db, ov){
  annotateSchool(recs, db, ov || null);
  if (db && db.towns){
    const cdb = chuDbOf(db);
    for (const r of recs){
      if (r.school_chu) continue;
      const r2 = lookupSchool(cdb, r.town || '');
      if (r2[1] && typeof r2[0] === 'string') r.school_chu = r2[0];
      else if (Array.isArray(r2[0]) && r2[0].length === 1) r.school_chu = r2[0][0];
    }
  }
  return recs;
}

const SchoolLookup = {
  of: of,                        // 町名1件を判定
  annotate: annotate,            // 配列にまとめて付与
  label: schoolLabel,            // 表示文言を作る
  norm: norm,                    // 町名の表記ゆれを揃える
  shintaishin: shintaishin,      // 新耐震(true)/旧耐震(false)/不明(null)
  parseSchoolTable: parseSchoolTable,   // 通学区域表テキスト → 校区DB（改正時の作り直し用）
  fixKanji: fixKanji             // 「富⼭市」など部首の文字を通常の漢字に直す
};

if (typeof module !== 'undefined' && module.exports) module.exports = SchoolLookup;
if (typeof window !== 'undefined') window.SchoolLookup = SchoolLookup;
