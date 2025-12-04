// /api/approve.js
// 承認フォーム表示 + 承認処理（コメント対応版）

const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

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

function renderForm({ errorMessage, initialDecision }) {
  const errorBlock = errorMessage
    ? `<div class="error-global">
         ${errorMessage}
       </div>`
    : "";

  const checkedApprove =
    initialDecision === "承認" ? 'checked="checked"' : "";
  const checkedDeny =
    initialDecision === "否認" ? 'checked="checked"' : "";

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
      max-width: 480px;
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
    return "";
  }

  const memberPage = await memberRes.json();
  const nameProp = memberPage.properties["氏名"];
  if (!nameProp || nameProp.type !== "title" || !nameProp.title.length) {
    return "";
  }
  return nameProp.title[0].plain_text || "";
}

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
    // セレクトプロパティ「承認結果」に "承認" / "否認" を入れる
    "承認結果": {
      select: { name: resultName },
    },
    // 日付プロパティ「承認日時」に実行時刻を入れる
    "承認日時": {
      date: { start: now },
    },
  };

  // コメントがある場合のみ上書き（承認＋空コメントでは既存を保持）
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

  const body = { properties };

  const res = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${NOTION_API_KEY}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("Notion update error:", text);
    throw new Error("Failed to update Notion page");
  }
}

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
      // approveリンクから来た場合は「承認」を初期選択にする
      const html = renderForm({
        errorMessage: "",
        initialDecision: "承認",
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

      // バリデーション
      if (!decision) {
        const html = renderForm({
          errorMessage: "承認／否認のいずれかを選択してください。",
          initialDecision: "",
        });
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      if (decision === "否認" && !commentRaw.trim()) {
        const html = renderForm({
          errorMessage: "否認の場合はコメントの入力が必須です。",
          initialDecision: "否認",
        });
        res.statusCode = 400;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(html);
        return;
      }

      // Notion更新
      await updateApproval(pageId, decision, commentRaw);

      // 完了メッセージ表示
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

    // その他のメソッドは許可しない
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
