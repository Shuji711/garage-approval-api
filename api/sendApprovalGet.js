// /api/sendApprovalGet.js
// LINE からの「内容を確認する」ボタン用。
// 承認票ID(pageId)を受け取り、議案情報＋承認/否認フォームを表示。
// 1度回答した承認票はロックし、2回目以降は「回答済み」と表示する。
// 添付資料は最大5件まで表示し、あれば「添付資料名」プロパティをラベルとして利用する。

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

function notionHeaders() {
  return {
    Authorization: `Bearer ${NOTION_API_KEY}`,
    "Notion-Version": NOTION_VERSION,
    "Content-Type": "application/json",
  };
}

async function getPage(pageId) {
  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: notionHeaders(),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error("Notion getPage error:", text);
    throw new Error("Notion ページの取得に失敗しました。");
  }
  return JSON.parse(text);
}

function extractText(prop) {
  if (!prop) return "";
  if (Array.isArray(prop.title) && prop.title.length > 0) {
    return prop.title.map((t) => t.plain_text || "").join("");
  }
  if (Array.isArray(prop.rich_text) && prop.rich_text.length > 0) {
    return prop.rich_text.map((t) => t.plain_text || "").join("");
  }
  return "";
}

// 議案ページから添付資料一覧を取得
// 想定プロパティ：
//  - 添付URL / 添付URL1〜5   : URL or リッチテキスト
//  - 添付資料名 / 添付資料名1〜5 : ラベル用（リッチテキスト）
function extractAttachments(pProps) {
  const attachments = [];

  // index = 0 用（添付URL / 添付資料名）
  const patterns = [
    { urlKey: "添付URL", labelKey: "添付資料名" },
  ];

  // 添付URL1〜5 / 添付資料名1〜5 を順番に追加
  for (let i = 1; i <= 5; i++) {
    patterns.push({
      urlKey: `添付URL${i}`,
      labelKey: `添付資料名${i}`,
    });
  }

  for (let i = 0; i < patterns.length; i++) {
    const { urlKey, labelKey } = patterns[i];

    const urlProp = pProps[urlKey];
    if (!urlProp) continue;

    let url = "";
    if (urlProp.url) {
      url = urlProp.url;
    } else if (Array.isArray(urlProp.rich_text)) {
      url = extractText(urlProp);
    }
    url = (url || "").trim();
    if (!url) continue;

    const labelProp = pProps[labelKey];
    let label = labelProp ? extractText(labelProp).trim() : "";

    if (!label) {
      // ラベルがなければデフォルト名
      const index = attachments.length + 1;
      label = attachments.length === 0 ? "添付資料を開く" : `添付資料${index}`;
    }

    attachments.push({ url, label });
  }

  return attachments;
}

// シンプルなHTMLレンダリング（モバイルファースト・Apple HIG寄せ）
function renderHtml({
  ticketTitle,
  proposalTitle,
  authorName,
  description,
  attachments, // [{url, label}]
  alreadyResult, // "承認" / "否認" / null
  showForm,
  pageId,
  message,
}) {
  const safeMessage = message || "";
  const infoLines = [];

  if (proposalTitle) {
    infoLines.push(
      `<div><span class="label">議案名</span><span class="value">${proposalTitle}</span></div>`
    );
  }
  if (authorName) {
    infoLines.push(
      `<div><span class="label">作成者</span><span class="value">${authorName}</span></div>`
    );
  }

  const infoHtml = infoLines.length
    ? `<div class="info-block">${infoLines.join("")}</div>`
    : "";

  const descHtml = description
    ? `<div class="section">
         <div class="section-title">内容（説明）</div>
         <div class="section-body">${description.replace(/\n/g, "<br>")}</div>
       </div>`
    : "";

  let attachHtml = "";
  if (attachments && attachments.length > 0) {
    const items = attachments
      .map(
        (att) =>
          `<li class="attach-item">
             <a href="${att.url}" target="_blank" rel="noopener noreferrer" class="attach-link">
               ${att.label}
             </a>
           </li>`
      )
      .join("");
    attachHtml = `<div class="section">
        <div class="section-title">添付資料</div>
        <ul class="attach-list">
          ${items}
        </ul>
      </div>`;
  }

  // ★ 初回（message があるとき）は赤い「すでに承認済み」メッセージを出さない
  const statusHtml =
    alreadyResult && !safeMessage
      ? `<div class="status status-locked">
           この承認票はすでに「${alreadyResult}」として登録されています。<br>
           送信内容の変更や再回答はできません。必要な場合は事務局までご連絡ください。
         </div>`
      : "";

  const formHtml = showForm
    ? `<form method="POST" action="/api/sendApprovalGet?pageId=${pageId}">
         <fieldset class="field-group">
           <legend class="field-title">承認／否認</legend>
           <label class="radio-row">
             <input type="radio" name="decision" value="approve" checked />
             <span>承認する</span>
           </label>
           <label class="radio-row">
             <input type="radio" name="decision" value="deny" />
             <span>否認する</span>
           </label>
         </fieldset>

         <div class="field-group">
           <label for="comment" class="field-title">コメント（任意）</label>
           <textarea id="comment" name="comment"
             placeholder="必要に応じてコメントを入力してください。\n※否認の場合は理由の記載をお願いします。"
             class="textarea"></textarea>
         </div>

         <p class="note">
           ・承認／否認どちらの場合もコメントを記入できます。<br>
           ・この承認票には 1 度だけ回答できます。送信後の取り消し・修正はできません。
         </p>

         <div class="actions">
           <button type="submit" class="primary-button">
             送信する
           </button>
         </div>
       </form>`
    : "";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>${ticketTitle || "承認フォーム"}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <style>
    :root {
      color-scheme: light;
      --bg: #f2f2f7;
      --card-bg: #ffffff;
      --border-subtle: #e0e0e0;
      --text-main: #111111;
      --text-sub: #555555;
      --accent: #007aff;
      --danger: #c62828;
      --radius-card: 14px;
      --radius-button: 999px;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      line-height: 1.6;
      background: var(--bg);
      color: var(--text-main);
    }
    .box {
      max-width: 680px;
      margin: 0 auto;
      background: var(--card-bg);
      border-radius: var(--radius-card);
      border: 1px solid var(--border-subtle);
      padding: 18px 18px 20px;
      box-shadow: 0 2px 6px rgba(0,0,0,0.03);
    }
    h1 {
      font-size: 17px;
      margin: 0 0 10px;
      font-weight: 600;
    }
    .message {
      margin-bottom: 12px;
      font-size: 14px;
      color: var(--text-sub);
    }
    .info-card {
      border-radius: 12px;
      border: 1px solid var(--border-subtle);
      padding: 12px 14px;
      margin-bottom: 16px;
      background: #fafafa;
    }
    .info-header {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .info-block > div {
      display: flex;
      flex-wrap: wrap;
      font-size: 14px;
      margin-bottom: 4px;
    }
    .info-block .label {
      min-width: 72px;
      color: var(--text-sub);
    }
    .info-block .value {
      flex: 1;
      font-weight: 500;
    }
    .section {
      margin-top: 10px;
    }
    .section-title {
      font-size: 13px;
      font-weight: 600;
      margin-bottom: 4px;
      color: var(--text-sub);
    }
    .section-body {
      font-size: 14px;
      white-space: pre-wrap;
    }
    .attach-list {
      list-style: none;
      padding: 0;
      margin: 4px 0 0;
    }
    .attach-item + .attach-item {
      margin-top: 6px;
    }
    .attach-link {
      display: inline-block;
      font-size: 14px;
      text-decoration: none;
      color: var(--accent);
      padding: 6px 10px;
      border-radius: 999px;
      border: 1px solid rgba(0,122,255,0.3);
      background: rgba(0,122,255,0.04);
    }
    .status {
      font-size: 13px;
      margin: 12px 0;
      border-radius: 10px;
      padding: 10px 12px;
    }
    .status-locked {
      background: #ffecec;
      color: var(--danger);
      border: 1px solid rgba(198,40,40,0.2);
    }
    .field-group {
      border: none;
      margin: 14px 0 8px;
      padding: 0;
    }
    .field-title {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 6px;
    }
    .radio-row {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 15px;
      padding: 8px 0;
    }
    .radio-row input[type="radio"] {
      width: 18px;
      height: 18px;
    }
    .textarea {
      width: 100%;
      min-height: 140px;
      font-size: 14px;
      padding: 8px 10px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
      resize: vertical;
    }
    .note {
      font-size: 12px;
      color: var(--text-sub);
      margin-top: 6px;
    }
    .actions {
      margin-top: 16px;
      display: flex;
      justify-content: flex-end;
    }
    .primary-button {
      padding: 10px 20px;
      border-radius: var(--radius-button);
      border: none;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
      font-weight: 600;
      font-size: 15px;
    }
    .primary-button:active {
      filter: brightness(0.9);
    }
    @media (max-width: 480px) {
      .box {
        padding: 14px 12px 16px;
        border-radius: 12px;
      }
      .primary-button {
        width: 100%;
        justify-content: center;
      }
      .actions {
        margin-top: 14px;
      }
    }
  </style>
</head>
<body>
  <div class="box">
    <h1>${ticketTitle || "承認フォーム"}</h1>
    ${
      safeMessage
        ? `<div class="message">${safeMessage}</div>`
        : ""
    }
    <div class="info-card">
      <div class="info-header">議案情報</div>
      ${infoHtml}
      ${descHtml}
      ${attachHtml}
    </div>
    ${statusHtml}
    ${formHtml}
  </div>
</body>
</html>`;
}

// x-www-form-urlencoded をパース
async function parseFormBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = {};
  for (const pair of raw.split("&")) {
    if (!pair) continue;
    const [k, v] = pair.split("=");
    const key = decodeURIComponent(k.replace(/\+/g, " "));
    const val = decodeURIComponent((v || "").replace(/\+/g, " "));
    params[key] = val;
  }
  return params;
}

module.exports = async (req, res) => {
  const { pageId } = req.query;

  if (!pageId) {
    res.statusCode = 400;
    return res.end("pageId が指定されていません。");
  }

  if (!NOTION_API_KEY) {
    res.statusCode = 500;
    return res.end("サーバー設定エラー：NOTION_API_KEY が未設定です。");
  }

  try {
    // まず承認票ページを取得
    const ticketPage = await getPage(pageId);
    const tProps = ticketPage.properties || {};

    // 承認票タイトル（議案名／氏名など）
    const tTitleProp = tProps["名前"] || tProps["タイトル"];
    const ticketTitle = extractText(tTitleProp) || "承認フォーム";

    // 承認結果（ロック判定用）
    const resultProp = tProps["承認結果"];
    const alreadyResult =
      resultProp && resultProp.select && resultProp.select.name
        ? resultProp.select.name
        : null;

    // 関連議案を取得（1件想定）
    let proposalTitle = "";
    let authorName = "";
    let description = "";
    let attachments = [];

    const relProp = tProps["議案"];
    if (
      relProp &&
      Array.isArray(relProp.relation) &&
      relProp.relation.length > 0
    ) {
      const proposalId = relProp.relation[0].id;
      const proposalPage = await getPage(proposalId);
      const pProps = proposalPage.properties || {};

      const pTitleProp =
        pProps["議案"] || pProps["名前"] || pProps["タイトル"];
      proposalTitle = extractText(pTitleProp) || "";

      // 提出者 or 作成者 or 担当者（施行）
      const authorProp =
        pProps["提出者"] ||
        pProps["作成者"] ||
        pProps["担当者（施行）"];

      if (
        authorProp &&
        Array.isArray(authorProp.people) &&
        authorProp.people.length > 0
      ) {
        const p = authorProp.people[0];
        authorName = p.name || "";
      }

      // 内容（説明） or 内容 or 説明
      const descProp =
        pProps["内容（説明）"] ||
        pProps["内容"] ||
        pProps["説明"];

      description = extractText(descProp) || "";

      // 添付資料（複数対応）
      attachments = extractAttachments(pProps);
    }

    if (req.method === "GET") {
      const msg = alreadyResult
        ? ""
        : "議案の内容を確認し、承認または否認を選択して送信してください。";

      const html = renderHtml({
        ticketTitle,
        proposalTitle,
        authorName,
        description,
        attachments,
        alreadyResult,
        showForm: !alreadyResult,
        pageId,
        message: msg,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).end(html);
    }

    if (req.method === "POST") {
      // 2回目以降はロック
      if (alreadyResult) {
        const html = renderHtml({
          ticketTitle,
          proposalTitle,
          authorName,
          description,
          attachments,
          alreadyResult,
          showForm: false,
          pageId,
          message: "",
        });
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        return res.status(200).end(html);
      }

      const form = await parseFormBody(req);
      const decision = form.decision === "deny" ? "deny" : "approve";
      const comment = form.comment || "";

      const now = new Date().toISOString();
      const resultName = decision === "deny" ? "否認" : "承認";

      const body = {
        properties: {
          承認結果: {
            select: { name: resultName },
          },
          承認日時: {
            date: { start: now },
          },
          コメント: {
            rich_text: comment
              ? [
                  {
                    text: { content: comment },
                  },
                ]
              : [],
          },
        },
      };

      const updateRes = await fetch(
        `https://api.notion.com/v1/pages/${pageId}`,
        {
          method: "PATCH",
          headers: notionHeaders(),
          body: JSON.stringify(body),
        }
      );

      const text = await updateRes.text();
      if (!updateRes.ok) {
        console.error("Notion update (sendApprovalGet) error:", text);
        res.statusCode = 500;
        return res.end(
          "回答の登録に失敗しました。時間をおいて再度お試しください。"
        );
      }

      const doneMsg =
        decision === "deny"
          ? "否認を受け付けました。ご回答ありがとうございます。"
          : "承認を受け付けました。ご回答ありがとうございます。";

      const html = renderHtml({
        ticketTitle,
        proposalTitle,
        authorName,
        description,
        attachments,
        alreadyResult: resultName,
        showForm: false,
        pageId,
        message: doneMsg,
      });
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).end(html);
    }

    res.setHeader("Allow", "GET, POST");
    res.statusCode = 405;
    return res.end("Method Not Allowed");
  } catch (err) {
    console.error("sendApprovalGet error:", err);
    res.statusCode = 500;
    return res.end(
      "内部エラーが発生しました。時間をおいて再度お試しください。"
    );
  }
};
