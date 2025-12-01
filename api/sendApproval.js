// api/sendApproval.js

const LINE_CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;

// LINEにメッセージを送る共通関数
async function pushLineMessage(to, messages) {
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${LINE_CHANNEL_ACCESS_TOKEN}`,
    },
    body: JSON.stringify({
      to,
      messages,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    console.error("LINE API error:", res.status, text);
    throw new Error("LINE API error");
  }
}

// Flexメッセージを組み立てる
function buildFlexMessage({ title, deadline, approveUrl, denyUrl }) {
  const safeTitle = title || "案件名未設定";
  const safeDeadline = deadline || "未設定";

  return {
    type: "flex",
    altText: `【承認のお願い】案件名：${safeTitle}`,
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          {
            type: "text",
            text: "【承認のお願い】",
            weight: "bold",
            size: "lg",
          },
          {
            type: "text",
            text: `案件名：${safeTitle}`,
            wrap: true,
            margin: "md",
          },
          {
            type: "text",
            text: `提出期限：${safeDeadline}`,
            wrap: true,
            margin: "sm",
          },
        ],
      },
      footer: {
        type: "box",
        layout: "vertical",
        spacing: "sm",
        contents: [
          {
            type: "button",
            style: "primary",
            action: {
              type: "uri",
              label: "承認する",
              uri: approveUrl,
            },
          },
          {
            type: "button",
            style: "secondary",
            action: {
              type: "uri",
              label: "否認する",
              uri: denyUrl,
            },
          },
          {
            type: "text",
            text: "※承認結果は自動で記録されます。",
            size: "xs",
            color: "#888888",
            wrap: true,
            margin: "md",
          },
        ],
      },
    },
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  if (!LINE_CHANNEL_ACCESS_TOKEN) {
    res.status(500).json({ error: "LINE_CHANNEL_ACCESS_TOKEN is not set" });
    return;
  }

  // Notion からの JSON を取得（文字列でもオブジェクトでも対応）
  const body =
    typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

  const { title, deadline, approveUrl, denyUrl, toIds } = body;

  if (!approveUrl || !denyUrl) {
    res
      .status(400)
      .json({ error: "approveUrl and denyUrl are required in request body" });
    return;
  }

  // 送信先ユーザーID（LINEのuserId）
  // 1) リクエストbodyの toIds
  // 2) 環境変数 LINE_TO_IDS （カンマ区切り）
  const envIds = (process.env.LINE_TO_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const targetIds =
    (Array.isArray(toIds) && toIds.length > 0 ? toIds : envIds) || [];

  if (targetIds.length === 0) {
    res
      .status(500)
      .json({ error: "No LINE recipient IDs configured (toIds / LINE_TO_IDS)" });
    return;
  }

  const flex = buildFlexMessage({ title, deadline, approveUrl, denyUrl });

  // 全員に順番に push
  try {
    for (const to of targetIds) {
      await pushLineMessage(to, [flex]);
    }

    res.status(200).json({
      ok: true,
      sentTo: targetIds,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
