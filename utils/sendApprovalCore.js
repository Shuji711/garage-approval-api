// /utils/sendApprovalCore.js
// 承認票ページIDを受け取り、
// その承認票に紐づく「会員」の LINEユーザーID を取得して
// 承認依頼メッセージを1人に送信する

export async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  if (!notionToken) {
    throw new Error("NOTION_API_KEY is not set");
  }
  if (!lineToken) {
    throw new Error("LINE_CHANNEL_ACCESS_TOKEN is not set");
  }

  // 1) 承認票ページを取得
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
    },
  });

  const page = await pageRes.json();

  if (!pageRes.ok) {
    console.error("Notion API error (approval page):", page);
    throw new Error(`Notion API error: ${page.message || pageRes.statusText}`);
  }

  const props = page.properties || {};

  // 2) 承認票のタイトル（名前）を取得
  //    「名前」 or 「案件名」など、柔軟に拾う
  const titleProp = props["名前"] || props["案件名"] || props["Name"];
  let title = "案件名なし";

  if (titleProp?.title?.length) {
    title = titleProp.title.map(t => t.plain_text).join("") || "案件名なし";
  } else if (titleProp?.rich_text?.length) {
    title = titleProp.rich_text.map(t => t.plain_text).join("") || "案件名なし";
  }

  // 3) 会員リレーションから、会員ページIDを取得
  const memberRel = props["会員"] || props["承認者"] || props["会員（承認者）"];
  const memberId = memberRel?.relation?.[0]?.id;

  if (!memberId) {
    throw new Error("承認票に会員リレーションが設定されていません（プロパティ「会員」）");
  }

  // 4) 会員ページを取得して「LINEユーザーID」を読む
  const memberRes = await fetch(`https://api.notion.com/v1/pages/${memberId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
    },
  });

  const memberPage = await memberRes.json();

  if (!memberRes.ok) {
    console.error("Notion API error (member page):", memberPage);
    throw new Error(`Notion API error (member): ${memberPage.message || memberRes.statusText}`);
  }

  const mProps = memberPage.properties || {};
  const lineIdProp = mProps["LINEユーザーID"];

  let lineUserId = "";

  if (lineIdProp?.rich_text?.length) {
    lineUserId = lineIdProp.rich_text.map(t => t.plain_text).join("").trim();
  }

  if (!lineUserId) {
    throw new Error("会員ページに LINEユーザーID が設定されていません");
  }

  // 5) 承認／否認リンクを生成（本番ドメインに合わせる）
  const base = "https://approval.garagetsuno.org";
  const approveUrl = `${base}/approve?id=${pageId}`;
  const denyUrl = `${base}/deny?id=${pageId}`;

  // 6) LINE に送るメッセージ
  const message = {
    type: "flex",
    altText: "【承認のお願い】",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: [
          { type: "text", text: "【承認のお願い】", weight: "bold", size: "lg" },
          { type: "text", text: `案件名：${title}`, wrap: true, margin: "md" },
          {
            type: "separator",
            margin: "md",
          },
          {
            type: "button",
            style: "primary",
            margin: "md",
            action: { type: "uri", label: "承認する", uri: approveUrl },
          },
          {
            type: "button",
            style: "secondary",
            margin: "sm",
            action: { type: "uri", label: "否認する", uri: denyUrl },
          },
          {
            type: "text",
            text: "※承認結果は自動で記録されます。",
            size: "xs",
            color: "#999999",
            margin: "md",
          },
        ],
      },
    },
  };

  // 7) LINE へ送信（この承認票の担当者 1名のみ）
  const res = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${lineToken}`,
    },
    body: JSON.stringify({
      to: lineUserId,
      messages: [message],
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    console.error("LINE API error:", res.status, body);
    throw new Error(`LINE API error: ${res.status}`);
  }

  return { ok: true, sentTo: [lineUserId] };
}
