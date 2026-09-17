"use client";

import { useRef, useState } from 'react';
import DOMPurify from 'dompurify';

export default function NewMailTool() {
  const [literacyLevel, setLiteracyLevel] = useState("beginner");
  const [status, setStatus] = useState("メール未選択");
  const [outputHtml, setOutputHtml] = useState('<div class="empty">メール(.eml)を選択して、気づきを書いてから「AI分析」を押してください</div>');
  const [userAnswer, setUserAnswer] = useState("");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isFileLoaded, setIsFileLoaded] = useState(false);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  
  const emailContext = useRef<any>(null);
  const currentFlags = useRef<any[]>([]);

  const escapeHtml = (str: string) => {
    const div = document.createElement("div");
    div.textContent = String(str ?? "");
    return div.innerHTML;
  };
  
  const textToHtml = (text: string) => escapeHtml(text).replace(/\r?\n/g, "<br>");

  const base64ToBytes = (b64: string) => {
    const bin = atob(String(b64).replace(/\s+/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  const bytesToBase64 = (bytes: Uint8Array) => {
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  };

  const decodeQuotedPrintable = (str: string) => {
    const noSoftBreaks = str.replace(/=\r\n/g, "").replace(/=\n/g, "");
    const bytes = [];
    for (let i = 0; i < noSoftBreaks.length; i++) {
      const ch = noSoftBreaks[i];
      if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(noSoftBreaks.substr(i + 1, 2))) {
        bytes.push(parseInt(noSoftBreaks.substr(i + 1, 2), 16));
        i += 2;
      } else {
        bytes.push(noSoftBreaks.charCodeAt(i) & 0xff);
      }
    }
    return new Uint8Array(bytes);
  };

  const decodeBytes = (bytes: Uint8Array, charset: string) => {
    const label = String(charset || "utf-8").trim();
    try {
      return new TextDecoder(label).decode(bytes);
    } catch (e) {
      return new TextDecoder("utf-8").decode(bytes);
    }
  };

  const decodeMimeWords = (str: string) => {
    if (!str) return "";
    return str.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (m, charset, enc, data) => {
      let bytes;
      if (enc.toUpperCase() === "B") bytes = base64ToBytes(data);
      else bytes = decodeQuotedPrintable(data.replace(/_/g, " "));
      return decodeBytes(bytes, charset);
    });
  };

  const parseHeaders = (block: string) => {
    const unfolded = block.replace(/\r\n/g, "\n").replace(/\n[ \t]+/g, " ");
    const lines = unfolded.split("\n").filter(Boolean);
    const headers: any = {};
    for (const line of lines) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      const key = m[1].trim().toLowerCase();
      headers[key] = headers[key] ? headers[key] + ", " + m[2] : m[2];
    }
    return headers;
  };

  const parseContentType = (v: string) => {
    if (!v) return { type: "text/plain", params: {} };
    const parts = v.split(";");
    const type = parts[0].trim().toLowerCase();
    const params: any = {};
    for (let i = 1; i < parts.length; i++) {
      const eq = parts[i].indexOf("=");
      if (eq === -1) continue;
      const key = parts[i].slice(0, eq).trim().toLowerCase();
      let val = parts[i].slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
      params[key] = val;
    }
    return { type, params };
  };

  const parseMimePart = (raw: string): any => {
  const sepMatch = raw.match(/\r?\n\r?\n/);
  let headerBlock, body;
  
  // ▼ ここに && sepMatch.index !== undefined を追加します
  if (sepMatch && sepMatch.index !== undefined) {
    headerBlock = raw.slice(0, sepMatch.index);
    body = raw.slice(sepMatch.index + sepMatch[0].length);
  } else {
    headerBlock = raw;
    body = "";
  }
  
  const headers = parseHeaders(headerBlock);
  const ct = parseContentType(headers["content-type"]);

  if (ct.type.startsWith("multipart/") && ct.params.boundary) {
    const segments = body.split("--" + ct.params.boundary);
    const partsRaw = segments.slice(1, -1);
    const children = partsRaw.map(p => p.replace(/^\r?\n/, "")).filter(p => p.trim().length > 0).map(p => parseMimePart(p));
    return { headers, type: ct.type, children };
  }

  const cte = String(headers["content-transfer-encoding"] || "7bit").toLowerCase().trim();
  let bytes;
  if (cte === "base64") bytes = base64ToBytes(body);
  else if (cte === "quoted-printable") bytes = decodeQuotedPrintable(body);
  else bytes = Uint8Array.from(body, c => c.charCodeAt(0) & 0xff);

  const isText = ct.type.startsWith("text/");
  return { headers, type: ct.type, bytes, text: isText ? decodeBytes(bytes, ct.params.charset || "utf-8") : null };
};

  const findPart = (node: any, wantType: string): any => {
    if (!node) return null;
    if (!node.children && node.type === wantType) return node;
    if (node.children) {
      for (const c of node.children) {
        const found = findPart(c, wantType);
        if (found) return found;
      }
    }
    return null;
  };

  const parseEml = async (file: File) => {
    const buffer = await file.arrayBuffer();
    const raw = new TextDecoder("iso-8859-1").decode(buffer);
    const root = parseMimePart(raw);
    
    const leaves: any[] = [];
    const collect = (n: any) => { if(n.children) n.children.forEach(collect); else leaves.push(n); };
    collect(root);

    const cidMap: any = {};
    for (const leaf of leaves) {
      const cidHeader = leaf.headers["content-id"];
      if (cidHeader && /^image\//i.test(leaf.type)) {
        const cid = cidHeader.replace(/^</, "").replace(/>$/, "").trim();
        if (cid) cidMap[cid] = `data:${leaf.type};base64,${bytesToBase64(leaf.bytes)}`;
      }
    }

    return {
      from: decodeMimeWords(root.headers["from"] || ""),
      subject: decodeMimeWords(root.headers["subject"] || ""),
      date: root.headers["date"] || "",
      html: findPart(root, "text/html")?.text || null,
      text: findPart(root, "text/plain")?.text || null,
      cidMap
    };
  };

  const buildIframeDocHtml = (sanitizedBodyHtml: string, parsed: any) => {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;overflow:hidden;font-family:sans-serif;font-size:14px;line-height:1.7;color:#222;background:#fff;padding:20px 22px;word-break:break-word;}
    .__meta{border-bottom:1px solid #ddd;margin-bottom:16px;padding-bottom:10px;font-size:12px;color:#555;}
    img{max-width:100%;height:auto;}
    mark{border-radius:3px;padding:0 1px;}
    .cat-なりすまし{background:#ff9999;} .cat-緊急性煽り{background:#ffc266;} .cat-個人情報要求{background:#ff7777;} .cat-不審URL{background:#ffb38a;}
    </style></head><body>
      <div class="__meta">
        <div><b>差出人：</b>${escapeHtml(parsed.from)}</div>
        <div><b>件名：</b>${escapeHtml(parsed.subject)}</div>
        <div><b>日時：</b>${escapeHtml(parsed.date)}</div>
      </div>
      <div id="__mailBody">${sanitizedBodyHtml}</div>
    </body></html>`;
  };

  const handleEmlFile = async (e: any) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIsFileLoaded(false);
    setStatus("メールを解析しています...");
    
    try {
      const parsed = await parseEml(file);
      const rawHtml = parsed.html 
        ? parsed.html.replace(/src=(["'])cid:([^"']+)\1/gi, (m:any, q:any, cid:any) => parsed.cidMap[cid.trim()] ? `src=${q}${parsed.cidMap[cid.trim()]}${q}` : m)
        : textToHtml(parsed.text || "");

      const sanitized = DOMPurify.sanitize(rawHtml, { FORBID_TAGS: ["script", "iframe", "form", "meta"] });
      const docHtml = buildIframeDocHtml(sanitized, parsed);

      if (viewerRef.current) {
        viewerRef.current.innerHTML = "";
        const iframe = document.createElement("iframe");
        iframe.setAttribute("sandbox", "allow-same-origin");
        viewerRef.current.appendChild(iframe);
        
        await new Promise(res => {
          iframe.onload = () => res(null);
          iframe.srcdoc = docHtml;
        });
        
        const iframeDoc = iframe.contentDocument;
        const bodyRoot = iframeDoc?.getElementById("__mailBody");
        
        let text = "";
        if (bodyRoot) {
          const walker = iframeDoc!.createTreeWalker(bodyRoot, NodeFilter.SHOW_TEXT, null);
          let node;
          while ((node = walker.nextNode())) text += node.nodeValue || "";
        }

        emailContext.current = { iframe, iframeDoc, bodyRoot, text, pristineHTML: bodyRoot?.innerHTML };
        
        const masked = text.replace(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g, "《EMAIL》");
        emailContext.current.maskedText = masked;
        
        iframe.style.height = (iframeDoc?.documentElement.scrollHeight || 500) + "px";
        setStatus("準備完了：分析ボタンを押してください");
        setIsFileLoaded(true);
      }
    } catch (err: any) {
      setStatus("エラー: " + err.message);
    }
  };

  const executeAnalysis = async () => {
    if (!emailContext.current) return;
    setIsAnalyzing(true);
    setStatus("AIへ送信しています...");
    
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maskedText: emailContext.current.maskedText,
          literacyLevel,
          userAnswer: literacyLevel === "advanced" ? userAnswer : ""
        })
      });
      
      if (!res.ok) throw new Error("API呼び出しに失敗しました");
      const result = await res.json();
      currentFlags.current = result.flags || [];
      
      let html = `<div class="risk-score ${result.risk_score >= 70 ? 'risk-high' : 'risk-low'}">危険度スコア：${result.risk_score} / 100</div>`;
      html += `<div class="flag-list">`;
      
      currentFlags.current.forEach((flag: any) => {
        html += `<div class="flag-item"><div class="flag-category">⚠ ${escapeHtml(flag.category)}</div>
        <div class="matched">${escapeHtml(flag.matched_text)}</div>
        <div>${escapeHtml(literacyLevel === "advanced" ? flag.reason_advanced : flag.reason_beginner)}</div>
        <div class="advice"><strong>対策：</strong> ${escapeHtml(flag.advice)}</div></div>`;
      });
      html += `</div>`;
      setOutputHtml(html);
      setStatus(`分析完了：検出 ${currentFlags.current.length}件`);
      
    } catch(err: any) {
      setStatus("AI分析エラー: " + err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  return (
    <div className="newmail-wrapper">
      <header className="newmail-header">
        <h1>メールセキュリティ教育ツール</h1>
        {/* ↓ ここのhrefをゲーム側のURLに変更してください */}
        <a className="nav-link" href="https://mwscup-9r7s.vercel.app/">← ゲームで学ぶ</a>
      </header>

      <div className="toolbar">
        <select value={literacyLevel} onChange={(e) => setLiteracyLevel(e.target.value)}>
          <option value="beginner">初学者向け説明</option>
          <option value="advanced">上級者向け説明</option>
        </select>
        <button className="btn-accent" onClick={() => fileInputRef.current?.click()}>メール(.eml)を選択</button>
        <button onClick={executeAnalysis} disabled={!isFileLoaded || isAnalyzing}>
          {isAnalyzing ? "AI分析中..." : "AI分析を実行"}
        </button>
        <input type="file" accept=".eml" ref={fileInputRef} onChange={handleEmlFile} style={{ display: 'none' }} />
      </div>

      {literacyLevel === "advanced" && (
        <div className="answer-box">
          <label>あなたの気づき（任意）：このメールで怪しいと思った箇所と、その理由を先に書いてみましょう。</label>
          <textarea rows={3} value={userAnswer} onChange={e => setUserAnswer(e.target.value)} disabled={!isFileLoaded || isAnalyzing} />
        </div>
      )}

      <div className="main">
        <section className="panel">
          <div className="panel-title">メール文</div>
          <div id="mailViewer" ref={viewerRef}><div className="empty">ここにメール文が表示されます</div></div>
          <div className="status">{status}</div>
        </section>
        <section className="panel">
          <div className="panel-title">AI分析結果</div>
          <div dangerouslySetInnerHTML={{ __html: outputHtml }} />
        </section>
      </div>
    </div>
  );
}