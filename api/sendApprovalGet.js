// /api/sendApprovalGet.js
// LINE から遷移するブラウザ承認フォーム
// ・GET: フォーム表示 or 結果表示（1回ロック）
// ・POST: 承認/否認 + コメント保存（議案DBの状況は触らない）

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

async function notionFetch(path, options = {}) {
  const res = await fetch(`https://api.notion.com/v1/${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Notion API error ${res.status}: ${text}`);
  }
  return JSON.parse(text);
}

// --- HTML レンダリング系 -------------------------------------------------

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderResultPage({ result, datetime, comment }) {
  const resultLabel =
    result === "承認" ? "承認" : result === "否認" ? "否認" : "不明";

  const title =
    result === "承認"
      ? "承認内容確認"
      : result === "否認"
      ? "否認内容確認"
      : "回答内容確認";

  const commentText = comment?.trim()
    ? escapeHtml(comment)
    : "（コメントなし）";

  const datetimeText = datetime || "（記録なし）";

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; line-height: 1.6; }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  .box { border: 1px solid #ddd; border-radius: 8px; padding: 12px 14px; margin-top: 12px; }
  .row { margin-bottom: 8px; }
  .label { font-weight: 600; margin-right: 4px; }
</style>
</head>
<body>
<div class="container">
  <h1>${escapeHtml(title)}</h1>
  <div class="box">
    <div class="row"><span class="label">結果：</span>${escapeHtml(resultLabel)}</div>
    <div class="row"><span class="label">日時：</span>${escapeHtml(datetimeText)}</div>
    <div class="row"><span class="label">コメント：</span>${commentText}</div>
  </div>
</div>
</body>
</html>
`;
}

function renderFormPage({ proposal, errorMessage }) {
  const title = "承認依頼";
  const proposalTitle = proposal.title || "";
  const author = proposal.author || "";
  const desc = proposal.description || "";
  const attachments = proposal.attachments || [];

  const attachHtml = attachments
    .map((a, index) => {
      const label = a.label || `添付資料${index + 1}`;
      const url = a.url;
      if (!url) return "";
      return `<div class="row"><a href="${escapeHtml(
        url
      )}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a></div>`;
    })
    .join("");

  const errorHtml = errorMessage
    ? `<div class="error">${escapeHtml(errorMessage)}</div>`
    : "";

  return `
<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<title>${escapeHtml(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding: 16px; line-height: 1.6; }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 20px; margin-bottom: 12px; }
  .box { border: 1px solid #ddd; border-radius: 8px; padding: 12px 14px; margin-top: 12px; }
  .row { margin-bottom: 8px; }
  .label { font-weight: 600; margin-right: 4px; }
  .error { color: #c00; margin-bottom: 8px; }
  .note { font-size: 12px; color: #555; margin-top: 8px; }
  button { padding: 8px 16px; border-radius: 4px; border: none; cursor: pointer; }
  .btn-submit { background: #007bff; color: #fff; }
</style>
</head>
<body>
<div class="container">
  <h1>${escapeHtml(title)}</h1>

  <div class="box">
    <div class="row"><span class="label">議案：</span>${escapeHtml(
      proposalTitle
    )}</div>
    <div class="row"><span class="label">作成者：</span>${escapeHtml(
      author
    )}</div>
    <div class="row"><span class="label">内容：</span>${escapeHtml(desc)}</div>
    ${attachHtml}
  </div>

  <form method="POST" style="margin-top: 16px;">
    ${errorHtml}
    <div class="box">
      <div class="row">
        <span class="label">結果：</span>
        <label><input type="radio" name="decision" value="approve"> 承認</label>
        <label style="margin-left: 16px;"><input type="radio" name="decision" value="deny"> 否認</label>
      </div>
      <div class="row">
        <div class="label">コメント：</div>
        <textarea name="comment" rows="4" style="width:100%;"></textarea>
      </div>
      <div class="note">
        ※ この承認票には 1 度だけ回答できます。送信後の取り消し・修正はできません。<br/>
        ※ 否認を選択した場合はコメント（理由）の入力が必須です。
      </div>
      <div class="row" style="margin-top: 12px;">
        <button type="submit" class="btn-submit">送信する</button>
      </div>
    </div>
  </form>
</div>
</body>
</html>
`;
}

// --- Notion から表示用データを取得 ---------------------------------------

async function getTicketAndProposal(ticketId) {
  const ticketPage = await notionFetch(`pages/${ticketId}`);
  const tProps = ticketPage.properties || {};

  const resultSelect = tProps["承認結果"]?.select?.name || "";
  const approvedAt = tProps["承認日時"]?.date?.start || "";
  const commentProp =
    tProps["コメント"]?.rich_text?.[0]?.plain_text || "";

  const proposalRel = tProps["議案"]?.relation || [];
  const proposalId = proposalRel[0]?.id;

  let proposal = {
    id: "",
    title: "",
    author: "",
    description: "",
    attachments: [],
  };

  if (proposalId) {
    const proposalPage = await notionFetch(`pages/${proposalId}`);
    const pProps = proposalPage.properties || {};

    const title =
      proposalPage.properties["議案"]?.title?.[0]?.plain_text ||
      proposalPage.properties["名前"]?.title?.[0]?.plain_text ||
      "";

    const author =
      pProps["提出者"]?.people?.[0]?.name ||
      pProps["作成者"]?.people?.[0]?.name ||
      "";

    const descRich = pProps["内容（説明）"]?.rich_text;
    const desc =
      (Array.isArray(descRich)
        ? descRich.map((r) => r.plain_text).join("")
        : "") ||
      pProps["内容（説明）"]?.rich_text?.[0]?.plain_text ||
      "";

    const attachDefs = [
      { urlKey: "添付URL", labelKey: "添付資料名" },
      { urlKey: "添付URL1", labelKey: "添付資料名1" },
      { urlKey: "添付URL2", labelKey: "添付資料名2" },
      { urlKey: "添付URL3", labelKey: "添付資料名3" },
      { urlKey: "添付URL4", labelKey: "添付資料名4" },
      { urlKey: "添付URL5", labelKey: "添付資料名5" },
    ];

    const attachments = attachDefs
      .map((def, idx) => {
        const url = pProps[def.urlKey]?.url || "";
        if (!url) return null;
        const label =
          pProps[def.labelKey]?.rich_text?.[0]?.plain_text ||
          pProps[def.labelKey]?.title?.[0]?.plain_text ||
          (idx === 0 ? "添付資料を開く" : `添付資料${idx + 1}`);
        return { url, label };
      })
      .filter(Boolean);

    proposal = {
      id: proposalId,
      title,
      author,
      description: desc,
      attachments,
    };
  }

  return {
    ticketPage,
    resultSelect,
    approvedAt,
    comment: commentProp,
    proposal,
  };
}

// --- POST ボディ取得 ------------------------------------------------------

async function parsePostBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(raw);
  const data = {};
  for (const [key, value] of params.entries()) {
    data[key] = value;
  }
  return data;
}

// --- メインハンドラ -------------------------------------------------------

export default async function handler(req, res) {
  try {
    const { id, pageId } = req.query;
    const ticketId = id || pageId;

    if (!ticketId) {
      res.status(400).send("Missing id");
      return;
    }

    if (req.method === "GET") {
      const { resultSelect, approvedAt, comment, proposal } =
        await getTicketAndProposal(ticketId);

      if (resultSelect === "承認" || resultSelect === "否認") {
        const html = renderResultPage({
          result: resultSelect,
          datetime: approvedAt,
          comment,
        });
        res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(html);
        return;
      }

      const html = renderFormPage({ proposal, errorMessage: "" });
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
      return;
    }

    if (req.method === "POST") {
      const form = await parsePostBody(req);
      const decision = form.decision;
      const commentInput = form.comment || "";

      {
        const { resultSelect, approvedAt, comment, proposal } =
          await getTicketAndProposal(ticketId);
        if (resultSelect === "承認" || resultSelect === "否認") {
          const html = renderResultPage({
            result: resultSelect,
            datetime: approvedAt,
            comment,
          });
          res
            .status(200)
            .setHeader("Content-Type", "text/html; charset=utf-8");
          res.send(html);
          return;
        }

        if (!decision || (decision !== "approve" && decision !== "deny")) {
          const html = renderFormPage({
            proposal,
            errorMessage: "承認か否認を選択してください。",
          });
          res
            .status(200)
            .setHeader("Content-Type", "text/html; charset=utf-8");
          res.send(html);
          return;
        }

        if (decision === "deny" && !commentInput.trim()) {
          const html = renderFormPage({
            proposal,
            errorMessage:
              "否認を選択した場合はコメント（理由）の入力が必須です。",
          });
          res
            .status(200)
            .setHeader("Content-Type", "text/html; charset=utf-8");
          res.send(html);
          return;
        }
      }

      const now = new Date().toISOString();
      const resultName = decision === "approve" ? "承認" : "否認";

      const updateBody = {
        properties: {
          承認結果: { select: { name: resultName } },
          承認日時: { date: { start: now } },
        },
      };

      if (commentInput && commentInput.trim()) {
        updateBody.properties["コメント"] = {
          rich_text: [{ type: "text", text: { content: commentInput } }],
        };
      }

      await notionFetch(`pages/${ticketId}`, {
        method: "PATCH",
        body: JSON.stringify(updateBody),
      });

      const { resultSelect, approvedAt, comment } =
        await getTicketAndProposal(ticketId);

      const html = renderResultPage({
        result: resultSelect || resultName,
        datetime: approvedAt || now,
        comment: comment || commentInput,
      });
      res.status(200).setHeader("Content-Type", "text/html; charset=utf-8");
      res.send(html);
      return;
    }

    res.status(405).send("Method Not Allowed");
  } catch (e) {
    console.error("sendApprovalGet error:", e);
    res.status(500).send("Internal Server Error");
  }
}
