const vscode = require('vscode');
const KEYWORDS = new Set(`SELECT FROM WHERE JOIN INNER LEFT RIGHT FULL OUTER CROSS ON AND OR NOT IN EXISTS BETWEEN LIKE IS NULL AS DISTINCT ALL UNION INTERSECT MINUS EXCEPT GROUP BY HAVING ORDER ASC DESC INSERT INTO VALUES UPDATE SET DELETE MERGE USING WHEN THEN ELSE END CASE WITH RECURSIVE CONNECT START PRIOR LEVEL NOCYCLE FETCH FIRST NEXT ROWS ONLY OFFSET OVER PARTITION RANGE ROW CURRENT UNBOUNDED PRECEDING FOLLOWING KEEP DENSE_RANK WITHIN ROLLUP CUBE PIVOT UNPIVOT RETURNING BULK COLLECT FOR NOWAIT WAIT SKIP LOCKED TABLE CREATE ALTER DROP TRUNCATE COMMIT ROLLBACK SAVEPOINT TRUE FALSE DEFAULT NULLS LAST FIRST`.split(/\s+/));
const FUNCTIONS = new Set(`NVL NVL2 DECODE COALESCE NULLIF TO_CHAR TO_DATE TO_NUMBER TO_TIMESTAMP SYSDATE SYSTIMESTAMP CURRENT_DATE CURRENT_TIMESTAMP ADD_MONTHS MONTHS_BETWEEN TRUNC ROUND SUBSTR INSTR LENGTH REPLACE REGEXP_LIKE REGEXP_REPLACE REGEXP_SUBSTR UPPER LOWER TRIM LTRIM RTRIM LPAD RPAD COUNT SUM AVG MIN MAX LISTAGG ROW_NUMBER RANK DENSE_RANK LAG LEAD FIRST_VALUE LAST_VALUE CAST EXTRACT GREATEST LEAST ABS MOD CEIL FLOOR SIGN CHR ASCII CONCAT SYS_GUID`.split(/\s+/));
const STATEMENTS = new Set(['select','insert','update','delete','sql']);
const CONTROLS = new Set(['if','choose','when','otherwise','foreach','trim','where','set','bind']);
const TYPES = ['keyword','function','statementTag','controlTag','comment','sqlComment','identifier','number','string','parameter','operator'];
let decorations = {};
const pending = new Map();
const cache = new WeakMap();
const EMPTY = () => Object.fromEntries(TYPES.map(t => [t, []]));
function resetDecorations() {
  for (const d of Object.values(decorations)) d.dispose();
  const cfg=vscode.workspace.getConfiguration('mybatisSqlHighlight');
  const colors={keyword:'#569CD6',function:'#DCDCAA',statementTag:'#B8A1E3',controlTag:'#F4B860',comment:'#73AD80',sqlComment:'#6A9955',identifier:'#D4D4D4',number:'#B5CEA8',string:'#CE9178',parameter:'#9CDCFE',operator:'#D4D4D4'};
  decorations={};
  for(const [type,defaultColor] of Object.entries(colors)) {
    decorations[type]=vscode.window.createTextEditorDecorationType({color:cfg.get(type+'Color',defaultColor)});
  }
}
function isMapper(doc, source) {
  // Untitled buffers are supported even before the user selects XML language mode.
  const supported = (doc.languageId === 'xml' && /\.xml$/i.test(doc.fileName)) ||
    (doc.isUntitled && (doc.languageId === 'xml' || doc.languageId === 'plaintext'));
  if (!supported) return false;
  // Check for a real root mapper element after optional XML declarations, DTD and comments.
  const head = source.slice(0, 12000)
    .replace(/^\uFEFF/, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE\s+[\s\S]*?(?:\[[\s\S]*?\]\s*)?>/gi, '');
  return /^\s*<mapper(?=[\s>])/i.test(head);
}
function tokenize(doc){
  const source=doc.getText(), cfg=vscode.workspace.getConfiguration('mybatisSqlHighlight');
  const result=EMPTY();
  if(!isMapper(doc,source)||source.length>cfg.get('maxFileSizeKB',2048)*1024)return result;
  const stack=[];
  const add=(type,a,b)=>{if(b>a)result[type].push(new vscode.Range(doc.positionAt(a),doc.positionAt(b)));};
  const insideSql=()=>stack.some(x=>STATEMENTS.has(x));
  const isWordStart=c=>!!c && /[A-Za-z_]/.test(c);
  const isWordPart=c=>!!c && /[A-Za-z_0-9$#]/.test(c);
  const isDigit=c=>!!c && /[0-9]/.test(c);
  let i=0, inCdata=false;
  while(i<source.length){
    // XML structures take priority over SQL tokens except while scanning a SQL string.
    if(!inCdata && source.startsWith('<!--',i)){
      const end=source.indexOf('-->',i+4),j=end<0?source.length:end+3;
      add('comment',i,j);i=j;continue;
    }
    if(!inCdata && source.startsWith('<![CDATA[',i)){inCdata=true;i+=9;continue;}
    if(inCdata && source.startsWith(']]>',i)){inCdata=false;i+=3;continue;}
    if(!inCdata && source[i]==='<'){
      if(source.startsWith('<?',i)){const end=source.indexOf('?>',i+2);i=end<0?source.length:end+2;continue;}
      if(source.startsWith('<!',i)){
        // Skip DOCTYPE including internal subset, which may contain '>' in declarations.
        let j=i+2,depth=0,quote=null;
        while(j<source.length){const c=source[j++];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='[')depth++;else if(c===']'&&depth)depth--;else if(c==='>'&&!depth)break;}
        i=j;continue;
      }
      let j=i+1,quote=null;
      while(j<source.length){const c=source[j++];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
      const tag=source.slice(i,j),m=/^<\s*(\/?)\s*([\w:-]+)/.exec(tag);
      if(m){
        const name=m[2].toLowerCase(),closing=!!m[1];
        if(STATEMENTS.has(name)||CONTROLS.has(name)){
          const type=STATEMENTS.has(name)?'statementTag':'controlTag';
          add(type,i,i+m[0].length);
          const close=/\/?>\s*$/.exec(tag);
          if(close)add(type,j-close[0].length,j);
        }
        if(closing){const idx=stack.lastIndexOf(name);if(idx>=0)stack.length=idx;}
        else if(!/\/\s*>$/.test(tag))stack.push(name);
      }
      i=j;continue;
    }
    if(!insideSql()){i++;continue;}
    const c=source[i];
    // SQL comments do not colorize SQL words or CDATA-like text inside them.
    if(c==='-'&&source[i+1]==='-'){
      const end=source.indexOf('\n',i+2),limit=end<0?source.length:end;
      // CDATA may terminate before the end of the SQL line.
      const cdEnd=inCdata?source.indexOf(']]>',i+2):-1;
      const stop=cdEnd>=0&&cdEnd<limit?cdEnd:limit;add('sqlComment',i,stop);i=stop;continue;
    }
    if(c==='/'&&source[i+1]==='*'){
      const end=source.indexOf('*/',i+2),limit=end<0?source.length:end+2;
      const cdEnd=inCdata?source.indexOf(']]>',i+2):-1;
      const stop=cdEnd>=0&&cdEnd<limit?cdEnd:limit;add('sqlComment',i,stop);i=stop;continue;
    }
    if(c==="'"||c==='"'){
      const start=i,q=c;i++;
      while(i<source.length){
        if(inCdata && source.startsWith(']]>',i))break;
        if(source[i]===q){if(source[i+1]===q){i+=2;continue;}i++;break;}
        // In normal XML text, actual markup ends the SQL text segment.
        if(!inCdata && source[i]==='<' && /^<(?:\/|[A-Za-z!?])/.test(source.slice(i,i+3)))break;
        i++;
      }
      if(q==="'")add('string',start,i);
      else add('identifier',start,i);
      continue;
    }
    if((c==='#'||c==='$')&&source[i+1]==='{'){
      const end=source.indexOf('}',i+2),cdEnd=inCdata?source.indexOf(']]>',i+2):-1;
      const start=i;
      i=end<0?source.length:end+1;
      if(cdEnd>=0&&cdEnd<i)i=cdEnd;
      // Explicit decoration overrides XML/TextMate colors in and outside CDATA.
      add('parameter',start,i);
      continue;
    }
    if(isDigit(c) && (i===0 || !/[A-Za-z0-9_$#.:]/.test(source[i-1]))){
      const start=i;
      const match=/^(?:0[xX][0-9a-fA-F]+|(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)/.exec(source.slice(i,i+48));
      if(match){i+=match[0].length;if(i===source.length || !isWordPart(source[i]))add('number',start,i);continue;}
    }
    if(isWordStart(c)){
      const start=i;while(i<source.length&&isWordPart(source[i]))i++;
      const value=source.slice(start,i).toUpperCase();
      const prev=source.slice(Math.max(0,start-2),start).trimEnd().slice(-1);
      if(prev!=='.'&&prev!==':'){
        if(KEYWORDS.has(value))add('keyword',start,i);
        else if(FUNCTIONS.has(value))add('function',start,i);
        else add('identifier',start,i);
      } else add('identifier',start,i);
      continue;
    }
    // SQL punctuation and operators: explicitly override inherited XML/CDATA token colors.
    // Do not touch XML markup, comments, quoted strings, or MyBatis parameters:
    // those were consumed by the branches above.
    if (/[=+*%|&^~!<>?:.,;()\[\]{}\/\-]/.test(c)) {
      add('operator', i, i + 1);
    }
    i++;
  }
  return result;
}
function getRanges(doc) {
  const cfg = vscode.workspace.getConfiguration('mybatisSqlHighlight', doc.uri);
  if (!cfg.get('enabled', true)) return EMPTY();
  const key = `${doc.version}:${cfg.get('maxFileSizeKB', 2048)}`;
  const cached = cache.get(doc);
  if (cached && cached.key === key) return cached.ranges;
  const ranges = tokenize(doc);
  cache.set(doc, { key, ranges });
  return ranges;
}
function update(editor) {
  if (!editor || !editor.document || editor.document.isClosed) return;
  const ranges = getRanges(editor.document);
  for (const t of TYPES) editor.setDecorations(decorations[t], ranges[t]);
}
function refresh() { for (const ed of vscode.window.visibleTextEditors) update(ed); }
function schedule(doc) {
  const key = doc ? doc.uri.toString() : '__all__';
  clearTimeout(pending.get(key));
  pending.set(key, setTimeout(() => {
    pending.delete(key);
    if (doc) {
      for (const ed of vscode.window.visibleTextEditors) if (ed.document === doc) update(ed);
    } else refresh();
  }, 250));
}
function activate(context) {
  resetDecorations();
  refresh();
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(() => schedule()));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(() => schedule()));
  context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(e => {
    if (vscode.window.visibleTextEditors.some(ed => ed.document === e.document)) schedule(e.document);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeCloseTextDocument(doc => {
    const key = doc.uri.toString(); clearTimeout(pending.get(key)); pending.delete(key);
  }));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('mybatisSqlHighlight')) {
      resetDecorations(); refresh();
    }
  }));
  context.subscriptions.push({ dispose: () => {
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
    for (const d of Object.values(decorations)) d.dispose();
  }});
}
function deactivate() {}
module.exports = { activate, deactivate, tokenize }; // tokenize exported for regression tests
