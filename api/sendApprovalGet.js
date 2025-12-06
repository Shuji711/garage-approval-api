// /api/sendApprovalGet.js
// LINE からの「内容を確認する」ボタン用。
// 承認票ID(pageId)を受け取り、議案情報＋承認/否認フォームを表示。
// 1度回答した承認票はロックし、2回目以降は「回答済み」と表示する。

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

// シンプルなHTMLレンダリング
function renderHtml({
  ticketTitle,
  proposalTitle,
  authorName,
  description,
  attachmentUrl,
  alreadyResult, // "承認" / "否認" / null
  showForm,
  pageId,
  message,
}) {
  const safeMessage = message || "";
  const infoLines = [];

  if (proposalTitle) {
    infoLines.push(`<div><strong>議案名</strong>：${proposalTitle}</div>`);
  }
  if (authorName) {
    infoLines.push(`<div><strong>作成者</strong>：${authorName}</div>`);
  }

  const infoHtml = infoLines.length
    ? `<div style="margin-bottom: 12px;">${infoLines.join("")}</div>`
    : "";

  const descHtml = description
    ? `<div style="white-space: pre-wrap; margin-top: 4px;">${description}</div>`
    : "";

  const attachHtml = attachmentUrl
    ? `<div style="margin-top: 8px;">
         <strong>添付資料</strong>：
         <a href="${attachmentUrl}" target="_blank" rel="noopener noreferrer">こちらを開く</a>
       </div>`
    : "";

  const statusHtml = alreadyResult
    ? `<div style="margin: 12px 0; color: #c62828;">
         この承認票はすでに「${alreadyResult}」として登録されています。<br>
         送信内容の変更や再回答はできません。必要な場合は事務局までご連絡ください。
       </div>`
    : "";

  const formHtml = showForm
    ? `<form method="POST" action="/api/sendApprovalGet?pageId=${pageId}">
         <fieldset style="border:none; margin: 12px 0;">
           <legend style="font-weight:bold;">承認／否認</legend>
           <label>
             <input type="radio" name="decision" value="approve" checked />
             承認する
           </label>
           &nbsp;&nbsp;
           <label>
             <input type="radio" name="decision" value="deny" />
             否認する
           </label>
         </fieldset>

         <div style="margin-top: 8px;">
           <label for="comment" style="font-weight:bold;">コメント（任意）</label><br />
           <textarea id="comment" name="comment"
             placeholder="必要に応じてコメントを入力してください。&#10;※否認の場合は理由の記載をお願いします。"
             style="width:100%; min-height:140px;"></textarea>
         </div>

         <p style="font-size: 0.85rem; color:#555; margin-top: 8px;">
           ・承認／否認どちらの場合もコメントを記入できます。<br>
           ・この承認票には 1 度だけ回答できます。送信後の取り消し・修正はできません。
         </p>

         <div style="margin-top: 16px;">
           <button type="submit"
             style="padding: 10px 20px; border-radius: 4px; border: none; cursor: pointer; background:#1976d2; color:#fff; font-weight:bold;">
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
    body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
           padding: 24px; line-height: 1.6; background:#f5f5f5; }
    .box { max-width: 720px; margin: 0 auto; background:#fff; border-radius: 8px;
           border: 1px solid #ddd; padding: 20px 24px; box-sizing:border-box; }
    h1 { font-size: 1.1rem; margin-top: 0; margin-bottom: 12px; }
    .section-title { font-weight:bold; margin-top: 12px; margin-bottom:4px; }
  </style>
</head>
<body>
  <div class="box">
    <h1>${ticketTitle || "承認フォーム"}</h1>
    ${safeMessage ? `<div style="margin-bottom: 12px;">${safeMessage}</div>` : ""}
    <div style="border:1px solid #eee; border-radius:6px; padding:12px 12px 8px; margin-bottom:16px;">
      <div class="section-title">議案情報</div>
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
    let attachmentUrl = "";

    const relProp = tProps["議案"];
    if (relProp && Array.isArray(relProp.relation) && relProp.relation.length > 0) {
      const proposalId = relProp.relation[0].id;
      const proposalPage = await getPage(proposalId);
      const pProps = proposalPage.properties || {};

      const pTitleProp = pProps["議案"] || pProps["名前"] || pProps["タイトル"];
      proposalTitle = extractText(pTitleProp) || "";

      // 提出者 or 作成者 or 担当者（施行）
      const authorProp =
        pProps["提出者"] ||
        pProps["作成者"] ||
        pProps["担当者（施行）"];

      if (authorProp && Array.isArray(authorProp.people) && authorProp.people.length > 0) {
        const p = authorProp.people[0];
        authorName = p.name || "";
      }

      // 内容（説明） or 内容 or 説明
      const descProp =
        pProps["内容（説明）"] ||
        pProps["内容"] ||
        pProps["説明"];

      description = extractText(descProp) || "";

      // 添付URL or 添付URL1
      const attachProp = pProps["添付URL"] || pProps["添付URL1"];
      if (attachProp && attachProp.url) {
        attachmentUrl = attachProp.url;
      } else if (attachProp && attachProp.rich_text) {
        attachmentUrl = extractText(attachProp);
      }
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
        attachmentUrl,
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
          attachmentUrl,
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
          "承認結果": {
            select: { name: resultName },
          },
          "承認日時": {
            date: { start: now },
          },
          "コメント": {
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

      const updateRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: "PATCH",
        headers: notionHeaders(),
        body: JSON.stringify(body),
      });

      const text = await updateRes.text();
      if (!updateRes.ok) {
        console.error("Notion update (sendApprovalGet) error:", text);
        res.statusCode = 500;
        return res.end("回答の登録に失敗しました。時間をおいて再度お試しください。");
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
        attachmentUrl,
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
    return res.end("内部エラーが発生しました。時間をおいて再度お試しください。");
  }
};
