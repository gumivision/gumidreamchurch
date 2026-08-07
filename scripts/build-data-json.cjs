// scripts/build-data-json.cjs
// 실행 환경: GitHub Actions (Node 20, Linux)
// 동작: posts/*.md / gallery/*.md 의 frontmatter 를 읽어 /data.json 을 새로 빌드
// 의존: 없음 (의존성 없는 pure node)

'use strict';

const fs   = require('fs');
const path = require('path');

// ===== 경로 =====
const REPO_ROOT = path.resolve(__dirname, '..');
const POSTS_DIR   = path.join(REPO_ROOT, 'posts');
const GALLERY_DIR = path.join(REPO_ROOT, 'gallery');
const OUTPUT      = path.join(REPO_ROOT, 'data.json');

// ===== 안전 가드 =====
function safeReadText(p){
  try { return fs.readFileSync(p, 'utf8'); }
  catch(e){ console.error(`[warn] cannot read ${p}: ${e.message}`); return null; }
}
function safeListMd(dir){
  try {
    return fs.readdirSync(dir)
      .filter(n => n.toLowerCase().endsWith('.md'))
      .map(n => path.join(dir, n));
  } catch(e){
    console.warn(`[warn] no dir ${dir} - assuming empty`);
    return [];
  }
}

// ===== 의존성 없는 frontmatter 파서 =====
function parseFrontmatter(raw){
  if(!raw) return { meta: {}, body: '' };
  const text = raw.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if(lines[0].trim() !== '---') return { meta: {}, body: text.trim() };

  let end = -1;
  for(let i = 1; i < lines.length; i++){
    if(lines[i].trim() === '---'){ end = i; break; }
  }
  if(end === -1) return { meta: {}, body: text.trim() };

  const meta = {};
  for(let j = 1; j < end; j++){
    const line = lines[j];
    // image: images/foo.jpg  /  "image: images/foo.jpg"  /  'image: images/foo.jpg'
    let m = line.match(/^[A-Za-z_][\w-]*\s*:\s*(.*)$/);
    if(!m) continue;
    const key = m[1].toLowerCase();
    let val = (m[2] || '').trim().replace(/^["']/, '').replace(/["']$/, '').trim();

    const lowered = line.toLowerCase();
    if(line.trim().startsWith('- ')) continue;             // 다중 list 항목은 별도 처리
    if(line.trim() === '' || line.trim() === '"' || line.trim() === "'") continue;

    if(lowered.startsWith('title')) meta.title = val;
    else if(lowered.startsWith('date'))  meta.date  = val;
    else if(lowered.startsWith('image')){
      // image: images/foo.jpg → "images/foo.jpg"
      // image: "https://..."  → 그대로 보존
      const src = val;
      if(/^https?:\/\//i.test(src) || /^images\//.test(src)){
        meta.image = src;
      }else if(/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(src)){
        meta.image = 'images/' + src.replace(/^\/+/,'').replace(/^images\//,'');
      }
    }
  }

  // images: (다중 이미지 리스트) 파싱
  // 인용문 '—' 처리: 어떤 CMS 는 'images'를 닫는 구분자로 사용. 안전하게 무시.
  const images = [];
  const m = text.match(/^images\s*:\s*\n((?:\s*-\s*"?[^"\n]+"?\s*\n?)+)/m);
  if(m){
    const block = m[1];
    block.split('\n').forEach(line => {
      const t = line.replace(/^\s*-\s*/, '').replace(/"/g, '').trim();
      if(!t) return;
      // "—" 같은 placeholder, '--' 같은 마커, '""' 빈 값 모두 무시
      if(t === '—' || t === '--' || t === '---') return;
      if(t.startsWith('http')) images.push(t);
      else if(/^images\//.test(t)) images.push(t);
      else if(/\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(t)) images.push('images/' + t.replace(/^\/+/,'').replace(/^images\//,''));
    });
  }
  if(images.length && !meta.image) meta.images = images;

  return { meta, body: lines.slice(end+1).join('\n').trim() };
}

// ===== 본문 마크다운 → 안전한 HTML 토막 (간단 버전) =====
function mdToLiteHtml(md){
  if(!md) return '';
  let t = String(md).replace(/\r\n?/g, '\n');

  // 코드블록 / 인라인 코드 보호
  const codes = [];
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => { codes.push(c); return `\u0000CODE${codes.length-1}\u0000`; });
  t = t.replace(/`([^`]+)`/g, (_, c) => `\u0000IC${esc(c)}\u0000`);

  // 이미지
  t = t.replace(/!\[(.*?)\]\(([^)\s]+)(?:\s+"(.*?)")?\)/g, (_, alt, src) => {
    let s = src;
    if(!/^https?:\/\//i.test(s) && !/^images\//.test(s)){
      s = /^images\//.test(s) ? s : 'images/' + s.replace(/^\/+/,'');
    }
    return `<img src="${s}" alt="${esc(alt)}" loading="lazy" />`;
  });

  // 링크 / 헤더 / 굵게 / 기울기 / hr / 리스트
  t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  t = t.replace(/^### (.*)$/gm, '<h4>$1</h4>')
       .replace(/^## (.*)$/gm,  '<h3>$1</h3>')
       .replace(/^# (.*)$/gm,   '<h2>$1</h2>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
       .replace(/(^|[^*])\*([^*]+)\*([^*]|$)/g, '$1<em>$2</em>$3');
  t = t.replace(/^\s*---\s*$/gm, '<hr/>');

  // 단락
  const blocks = t.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
  const html = blocks.map(b => {
    if(/^<(h\d|img|hr|ul|ol|pre|blockquote|table)/.test(b)) return b;
    // 같은 블록 안의 단일 줄바꿈은 <br/>
    return `<p>${b.replace(/\n/g,'<br/>')}</p>`;
  }).join('\n');

  return html
    .replace(/\u0000IC(.+?)\u0000/g, '<code>$1</code>')
    .replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `<pre><code>${esc(codes[+i])}</code></pre>`);
}
function esc(s){
  return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ===== 빌드 =====
const posts = safeListMd(POSTS_DIR).map(file => {
  const raw = safeReadText(file) || '';
  const { meta, body } = parseFrontmatter(raw);
  // 날짜가 없으면 파일명에서 추출, 그것도 없으면 0
  let date = meta.date || '';
  if(!date){
    const m = path.basename(file).match(/(\d{4})-(\d{2})-(\d{2})/);
    if(m) date = `${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`;
  }
  return {
    src:    path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
    title:  meta.title || path.basename(file).replace(/\.md$/, ''),
    date,
    image:  meta.image || (Array.isArray(meta.images) && meta.images[0]) || '',
    body:   mdToLiteHtml(body)
  };
}).sort((a,b) => {
  const ta = Date.parse(a.date) || 0;
  const tb = Date.parse(b.date) || 0;
  return tb - ta;
});

// 갤러리: gallery/*.md 의 frontmatter.images / image 를 모두 모아서 평탄화
const gallery = [];
safeListMd(GALLERY_DIR).forEach(file => {
  const raw = safeReadText(file) || '';
  const { meta, body } = parseFrontmatter(raw);
  const list = [];
  if(Array.isArray(meta.images)) list.push(...meta.images);
  else if(meta.image)             list.push(meta.image);
  // 본문 안 ![](images/...) 도 보충 (안전 fallback)
  const imgsInBody = (body.match(/!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g) || [])
    .map(s => { const m = s.match(/\(([^)\s]+)/); return m ? m[1] : ''; })
    .filter(s => s && !/^https?:\/\//i.test(s));
  list.push(...imgsInBody);
  // 절대경로도 정규화
  list.forEach(p => {
    if(!p) return;
    if(/^https?:\/\//i.test(p)) { gallery.push(p); return; }
    const norm = 'images/' + String(p).replace(/^\/+/,'').replace(/^images\//,'');
    if(!gallery.includes(norm)) gallery.push(norm);
  });
});

const data = { posts, gallery };
fs.writeFileSync(OUTPUT, JSON.stringify(data, null, 2) + '\n', 'utf8');

console.log(`[ok] data.json written`);
console.log(`     posts:   ${posts.length}`);
console.log(`     gallery: ${gallery.length}`);
console.log(`     path:    ${path.relative(process.cwd(), OUTPUT)}`);
