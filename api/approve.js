// /api/approve.js
// 承認フォーム表示 + 承認処理（コメント＆議案情報＆添付スロット＆Driveファイル名対応版）

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;

// --------------- 共通ユーティリティ ---------------

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const params = new URLSearchParams(body);
      resolve(params);
    });
    req.on("error", reject);
  });
}

// HTMLエスケープ
function escapeHtml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// YYYY-MM-DD → YYYY/MM/DD 表示用
function formatDateFromNotion(dateProp) {
  if (!dateProp || dateProp.type !== "date" || !dateProp.date || !dateProp.date.start) {
    return "";
  }
  const s = dateProp.date.start; // "2025-12-04T..." or "2025-12-04"
  const d = s.slice(0, 10);
  return d.replace(/-/g, "/");
}

// --------------- Google Drive 関連 ---------------

// Drive共有URLから fileId を抜き出す
function extractDriveFileId(url) {
  if (!url) return "";

  try {
    // /file/d/{id}/view 形式
    let m = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m && m[1]) return m[1];

    // ?id=xxxxx 形式
    const u = new URL(url);
    const idParam = u.searchParams.get("id");
    if (idParam) return idParam;

    // /uc?id=xxxxx 形式
    m = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m && m[1]) return m[1];
  } catch (e) {
    console.error("extractDriveFileId error:", e);
  }

  return "";
}

// Refresh Token から Access Token を取得
async function getDriveAccessToken() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    console.error("Google OAuth env vars missing");
    return null;
  }

  const params = new URLSearchParams();
  params.set("client_id", GOOGLE_CLIENT_ID);
  params.set("client_secret", GOOGLE_CLIENT_SECRET);
  params.set("refresh_token", GOOGLE_REFRESH_TOKEN);
  params.set("grant_type", "refresh_token");

  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  });

  if (!res.ok) {
    console.error("getDriveAccessToken error:", await res.text());
    return null;
  }

  const json = await res.json();
  return json.access_token || null;
}

// Drive API からファイル名などを取得
async function getDriveFileInfo(url) {
  const fileId = extractDriveFileId(url);
  if (!fileId) return null;

  const accessToken = await getDriveAccessToken();
  if (!accessToken) return null;

  const apiUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,webViewLink,iconLink,mimeType`;

  const res = await fetch(apiUrl, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    console.error("getDriveFileInfo error:", await res.text());
    return null;
  }

  const data = await res.json();
  return {
    name: data.name || "",
    webViewLink: data.webViewLink || url,
    iconLink: data.iconLink || "",
    mimeType: data.mimeType || "",
  };
}

// --------------- Notion 関連 ---------------

// 承認票ページ → 会員ページ → 氏名取得
async function getMemberNameFromApprovalPage(pageId) {
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
  });

  if (!pageRes.ok) {
    console.error("getMemberName page error:", await pageRes.text());
    return "";
  }

  const page = await pageRes.json();
  const memberProp = page.properties["会員"];
  if (
    !memberProp ||
    memberProp.type !== "relation" ||
    !memberProp.relation.length
  ) {
    return "";
  }

  const memberId = memberProp.relation[0].id;
  const memberRes = await fetch(
    `https://api.notion.com/v1/pages/${memberId}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    }
  );

  if (!memberRes.ok) {
    console.error("getMemberName member error:", await memberRes.text());
    return "";
  }

  const memberPage = await memberRes.json();
  const nameProp = memberPage.properties["氏名"];
  if (!nameProp || nameProp.type !== "title" || !nameProp.title.length) {
    return "";
  }
  return nameProp.title.map((t) => t.plain_text).join("");
}

// リッチテキスト or タイトルを文字列に
function notionTextToString(prop) {
  if (!prop) return "";
  if (prop.type === "rich_text" && prop.rich_text.length) {
    return prop.rich_text.map((t) => t.plain_text).join("");
  }
  if (prop.type === "title" && prop.title.length) {
    return prop.title.map((t) => t.plain_text).join("");
  }
  return "";
}

// 添付スロットを収集（添付資料名 / 添付URL）
function collectAttachmentSlots(props) {
  const attachments = [];

  // 共通処理
  const addSlot = (nameKey, urlKey) => {
    const urlProp = props[urlKey];
    if (!urlProp || urlProp.type !== "url" || !urlProp.url) return;

    const url = urlProp.url;
    const nameProp = props[nameKey];
    let label = notionTextToString(nameProp);
    if (!label) {
      // 名前が空の場合は汎用ラベル
      label = "添付資料を開く";
    }

    attachments.push({
      label,
      url,
    });
  };

  // 既存の無印スロット
  addSlot("添付資料名", "添付URL");

  // 添付資料名1〜5 / 添付URL1〜5
  for (let i = 1; i <= 5; i++) {
    addSlot(`添付資料名${i}`, `添付URL${i}`);
  }

  return attachments;
}

// 承認票ページ → 議案ページ → 議案情報をHTMLで返す
async function getProposalInfoHtmlFromApprovalPage(pageId) {
  try {
    const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
    });

    if (!pageRes.ok) {
      console.error("getProposalInfo approval error:", await pageRes.text());
      return "";
    }

    const approvalPage = await pageRes.json();
    const rel = approvalPage.properties["議案"];
    if (!rel || rel.type !== "relation" || !rel.relation.length) {
      return "";
    }

    const proposalId = rel.relation[0].id;
    const propRes = await fetch(
      `https://api.notion.com/v1/pages/${proposalId}`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${NOTION_API_KEY}`,
          "Notion-Version": NOTION_VERSION,
          "Content-Type": "application/json",
        },
      }
    );

    if (!propRes.ok) {
      console.error("getProposalInfo proposal error:", await propRes.text());
      return "";
    }

    const proposalPage = await propRes.json();
    const props = proposalPage.properties;

    // 議案名（タイトル）
    let title = "";
    const titleProp = props["議案"];
    if (titleProp && titleProp.type === "title" && titleProp.title.length) {
      title = titleProp.title.map((t) => t.plain_text).join("");
    }

    // 議案番号（フォーミュラ優先 → 議案番号）
    let number = "";
    const numFormulaProp = props["議案番号フォーミュラ"];
    if (
      numFormulaProp &&
      numFormulaProp.type === "formula" &&
      numFormulaProp.formula.type === "string"
    ) {
      number = numFormulaProp.formula.string || "";
    }
    if (!number) {
      const numProp = props["議案番号"];
      if (numProp) {
        if (numProp.type === "rich_text" && numProp.rich_text.length) {
          number = numProp.rich_text.map((t) => t.plain_text).join("");
        } else if (numProp.type === "number" && numProp.number != null) {
          number = String(numProp.number);
        }
      }
    }

    // 作成者（提出者）
    let author = "";
    const submitterProp = props["提出者"];
    if (submitterProp) {
      if (submitterProp.type === "people" && submitterProp.people.length) {
        author = submitterProp.people
          .map((p) => p.name || "")
          .filter(Boolean)
          .join("・");
      } else if (
        submitterProp.type === "rich_text" &&
        submitterProp.rich_text.length
      ) {
        author = submitterProp.rich_text.map((t) => t.plain_text).join("");
      } else if (
        submitterProp.type === "multi_select" &&
        submitterProp.multi_select.length
      ) {
        author = submitterProp.multi_select.map((t) => t.name).join("・");
      }
    }

    // 提出日
    const submittedAt = formatDateFromNotion(props["提出日"]);

    // 締切日 / 施行期限
    const deadline = formatDateFromNotion(props["締切日"]);
    const effectiveUntil = formatDateFromNotion(props["施行期限"]);

    // 添付資料スロット（外部URL系）
    let attachments = collectAttachmentSlots(props);

    // 添付スロットが一つも無い場合のみ、Driveリンクを使う
    if (attachments.length === 0) {
      const linkProp = props["添付リンク"];
      if (linkProp && linkProp.type === "url" && linkProp.url) {
        const url = linkProp.url;
        let driveInfo = null;
        try {
          driveInfo = await getDriveFileInfo(url);
        } catch (e) {
          console.error("Drive info fetch error:", e);
        }

        if (driveInfo && driveInfo.name) {
          attachments.push({
            label: driveInfo.name,
            url: driveInfo.webViewLink || url,
          });
        } else {
          attachments.push({
            label: "添付資料を開く",
            url,
          });
        }
      }
    }

    let attachmentHtml = "";
    if (attachments.length > 0) {
      const items = attachments
        .map(
          (a) =>
            `<li><a href="${escapeHtml(
              a.url
            )}" target="_blank" rel="noopener noreferrer">${escapeHtml(
              a.label
            )}</a></li>`
        )
        .join("");
      attachmentHtml = `<ul class="attachments-list">${items}</ul>`;
    }

    if (
      !title &&
      !number &&
      !author &&
      !submittedAt &&
      !deadline &&
      !effectiveUntil &&
      !attachmentHtml
    ) {
      return "";
    }

    return `
      <div class="proposal-box">
        <div class="proposal-header">議案情報</div>
        ${
          title
            ? `<div class="proposal-row"><span class="label">議案名</span><span class="value">${escapeHtml(
                title
              )}</span></div>`
            : ""
        }
        ${
          number
            ? `<div class="proposal-row"><span class="label">議案番号</span><span class="value">${escapeHtml(
                number
              )}</span></div>`
            : ""
        }
        ${
          author
            ? `<div class="proposal-row"><span class="label">作成者</span><span class="value">${escapeHtml(
                author
              )}</span></div>`
            : ""
        }
        ${
          submittedAt
            ? `<div class="proposal-row"><span class="label">提出日</span><span class="value">${escapeHtml(
                submittedAt
              )}</span></div>`
            : ""
        }
        ${
          deadline
            ? `<div class="proposal-row"><span class="label">締切日</span><span class="value">${escapeHtml(
                deadline
              )}</span></div>`
            : ""
        }
        ${
          effectiveUntil
            ? `<div class="proposal-row"><span class="label">施行期限</span><span class="value">${escapeHtml(
                effectiveUntil
              )}</span></div>`
            : ""
        }
        ${
          attachmentHtml
            ? `<div class="proposal-row proposal-row-attachments"><span class="label">添付資料</span><span class="value">${attachmentHtml}</span></div>`
            : ""
        }
      </div>
    `;
  } catch (e) {
    console.error("getProposalInfo exception:", e);
    return "";
  }
}

// --------------- HTML レンダリング ---------------

function renderForm({ errorMessage, initialDecision, proposalHtml }) {
  const errorBlock = errorMessage
    ? `<div class="error-global">
         ${errorMessage}
       </div>`
    : "";

  const checkedApprove =
    initialDecision === "承認" ? 'checked="checked"' : "";
  const checkedDeny =
    initialDecision === "否認" ? 'checked="checked"' : "";

  const proposalBlock = proposalHtml || "";

  return `<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>承認フォーム</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        sans-serif;
      padding: 16px;
      line-height: 1.6;
      background: #f5f5f7;
    }
    .container {
      max-width: 520px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 12px;
      padding: 16px 20px 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }
    h1 {
      font-size: 18px;
      margin: 0 0 8px;
    }
    .subtitle {
      font-size: 12px;
      color: #666;
      margin-bottom: 12px;
    }
    .proposal-box {
      font-size: 13px;
      background: #f7f9fc;
      border-radius: 8px;
      padding: 8px 10px 10px;
      margin-bottom: 14px;
      border: 1px solid #e0e6f2;
    }
    .proposal-header {
      font-weight: 600;
      font-size: 13px;
      margin-bottom: 6px;
    }
    .proposal-row {
      display: flex;
      margin-bottom: 2px;
    }
    .proposal-row .label {
      width: 80px;
      color: #555;
    }
    .proposal-row .value {
      flex: 1;
      color: #222;
    }
    .proposal-row-attachments .value {
      padding-top: 2px;
    }
    .attachments-list {
      margin: 0;
      padding-left: 1.1em;
    }
    .attachments-list li {
      margin: 0;
      padding: 0;
      list-style: disc;
      font-size: 13px;
    }
    .attachments-list a {
      text-decoration: underline;
    }
    .field {
      margin-bottom: 12px;
    }
    .field label {
      display: block;
      font-size: 14px;
      font-weight: 600;
      margin-bottom: 4px;
    }
    .radio-group {
      display: flex;
      gap: 16px;
      font-size: 14px;
    }
    .radio-group label {
      font-weight: normal;
    }
    textarea {
      width: 100%;
      min-height: 90px;
      font-size: 14px;
      padding: 8px;
      border-radius: 6px;
      border: 1px solid #ccc;
      resize: vertical;
      box-sizing: border-box;
    }
    textarea:focus {
      outline: none;
      border-color: #4a90e2;
      box-shadow: 0 0 0 1px rgba(74,144,226,0.25);
    }
    .help {
      font-size: 12px;
      color: #777;
      margin-top: 4px;
    }
    .error-global {
      margin-bottom: 8px;
      padding: 8px;
      border-radius: 6px;
      background: #ffecec;
      color: #c00;
      font-size: 13px;
    }
    .error-inline {
      font-size: 12px;
      color: #c00;
      margin-top: 4px;
    }
    .button-row {
      margin-top: 16px;
      display: flex;
      justify-content: flex-end;
    }
    button[type="submit"] {
      min-width: 120px;
      padding: 8px 16px;
      border-radius: 999px;
      border: none;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      background: #4a90e2;
      color: #fff;
      transition: background 0.15s ease, opacity 0.15s ease;
    }
    button[type="submit"]:hover:not(:disabled) {
      background: #3b7ac2;
    }
    button[type="submit"]:disabled {
      cursor: default;
      background: #bcd4f2;
      color: #ffffffcc;
    }
    .footer-note {
      margin-top: 12px;
      font-size: 11px;
      color: #999;
      text-align: right;
    }
  </style>
</head>
<body>
  <div class="container">
    ${errorBlock}
    <h1>承認フォーム</h1>
    <div class="subtitle">
      議案の内容を確認し、承認または否認を選択してください。
    </div>

    ${proposalBlock}

    <form id="approval-form" method="POST">
      <div class="field">
        <label>承認／否認</label>
        <div class="radio-group">
          <label>
            <input type="radio" name="decision" value="承認" ${checkedApprove}>
            承認する
          </label>
          <label>
            <input type="radio" name="decision" value="否認" ${checkedDeny}>
            否認する
          </label>
        </div>
        <div id="decision-error" class="error-inline" style="display:none;"></div>
      </div>

      <div class="field">
        <label for="comment">コメント</label>
        <textarea
          id="comment"
          name="comment"
          placeholder="必要に応じてコメントを入力してください。&#10;※否認の場合はコメントが必須です。"
        ></textarea>
        <div id="comment-error" class="error-inline" style="display:none;"></div>
        <div class="help">
          ・承認／否認どちらの場合も記入できます。<br>
          ・否認の場合は必ず理由を記入してください。
        </div>
      </div>

      <div class="button-row">
        <button type="submit" id="submit-btn" disabled>送信する</button>
      </div>

      <div class="footer-note">
        ボタンがグレーの間は、必要な項目が未入力です。
      </div>
    </form>
  </div>

  <script>
    (function () {
      const form = document.getElementById("approval-form");
      const radios = form.elements["decision"];
      const comment = document.getElementById("comment");
      const submitBtn = document.getElementById("submit-btn");
      const decisionError = document.getElementById("decision-error");
      const commentError = document.getElementById("comment-error");

      function getDecision() {
        let value = "";
        for (const r of radios) {
          if (r.checked) {
            value = r.value;
            break;
          }
        }
        return value;
      }

      function updateState() {
        const decision = getDecision();
        const c = comment.value.trim();

        decisionError.style.display = "none";
        decisionError.textContent = "";
        commentError.style.display = "none";
        commentError.textContent = "";

        if (!decision) {
          submitBtn.disabled = true;
          return;
        }

        if (decision === "否認") {
          if (!c) {
            submitBtn.disabled = true;
            return;
          }
        }

        submitBtn.disabled = false;
      }

      for (const r of radios) {
        r.addEventListener("change", updateState);
      }
      comment.addEventListener("input", updateState);

      form.addEventListener("submit", function (e) {
        const decision = getDecision();
        const c = comment.value.trim();

        let hasError = false;

        if (!decision) {
          hasError = true;
          decisionError.textContent = "承認／否認のいずれかを選択してください。";
          decisionError.style.display = "block";
        }

        if (decision === "否認" && !c) {
          hasError = true;
          commentError.textContent = "否認の場合はコメントの入力が必須です。";
          commentError.style.display = "block";
        }

        if (hasError) {
          e.preventDefault();
          submitBtn.disabled = true;
          return false;
        }

        return true;
      });

      updateState();
    })();
  </script>
</body>
</html>`;
}

// Notion更新（承認結果 + 承認日時 + コメント）
async function updateApproval(pageId, resultName, commentRaw) {
  const now = new Date().toISOString();

  let formattedComment = "";
  const trimmed = (commentRaw || "").trim();
  if (trimmed) {
    const name = await getMemberNameFromApprovalPage(pageId);
    if (name) {
      formattedComment = `（${name}）` + trimmed;
    } else {
      formattedComment = trimmed;
    }
  }

  const properties = {
    "承認結果": {
      select: { name: resultName },
    },
    "承認日時": {
      date: { start: now },
    },
  };

  if (formattedComment) {
    properties["コメント"] = {
      rich_text: [
        {
          type: "text",
          text: { content: formattedComment },
        },
      ],
    };
  }

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ properties }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion update error:", text);
    throw new Error("Failed to update Notion page");
  }
}

// --------------- エントリーポイント ---------------

module.exports = async (req, res) => {
  try {
    const url = new URL(req.url, `https://${req.headers.host}`);
    const pageId = url.searchParams.get("id");

    if (!pageId) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("パラメータ id が指定されていません。");
      return;
    }

    if (req.method === "GET") {
      const proposalHtml = await getProposalInfoHtmlFromApprovalPage(pageId);
      const html = renderForm({
        errorMessage: "",
        initialDecision: "承認",
        proposalHtml,
      });
      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(html);
      return;
    }

    if (req.method === "POST") {
      const params = await parseBody(req);
      const decision = params.get("decision") || "";
      const commentRaw = params.get("comment") || "";

      if (!decision) {
        const proposalHtml = await getProposalInfoHtmlFromApprovalPage(pageId);
        const html = renderForm({
          errorMessage: "承認／否認のいずれかを選択してください。",
          initialDecision: "",
          proposalHtml,
        });
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      if (decision === "否認" && !commentRaw.trim()) {
        const proposalHtml = await getProposalInfoHtmlFromApprovalPage(pageId);
        const html = renderForm({
          errorMessage: "否認の場合はコメントの入力が必須です。",
          initialDecision: "否認",
          proposalHtml,
        });
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      await updateApproval(pageId, decision, commentRaw);

      res.statusCode = 200;
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8" />
  <title>送信が完了しました</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>
    body {
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI",
        sans-serif;
      padding: 16px;
      background: #f5f5f7;
      line-height: 1.6;
    }
    .container {
      max-width: 480px;
      margin: 40px auto;
      background: #ffffff;
      border-radius: 12px;
      padding: 24px 20px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.08);
      text-align: center;
    }
    h1 {
      font-size: 18px;
      margin-bottom: 8px;
    }
    p {
      font-size: 14px;
      color: #333;
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>送信が完了しました</h1>
    <p>ご回答ありがとうございました。画面を閉じていただいて構いません。</p>
  </div>
</body>
</html>`);
      return;
    }

    res.statusCode = 405;
    res.setHeader("Allow", "GET, POST");
    res.end("Method Not Allowed");
  } catch (err) {
    console.error(err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("内部エラーが発生しました。しばらくしてから再度お試しください。");
  }
};
