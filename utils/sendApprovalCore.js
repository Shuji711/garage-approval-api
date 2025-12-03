// /utils/sendApprovalCore.js
// 承認票DB のページIDを受け取り、関連する議案情報を取得して
// 承認依頼メッセージを LINE に送信する（概要のみ）

const { ensureIssueSequence } = require("./issueNumberCore");

function formatJpDate(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return "";
  const w = ["日", "月", "火", "水", "木", "金", "土"];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${
    w[d.getDay()]
  }）`;
}

async function sendApprovalMessage(pageId) {
  const notionToken = process.env.NOTION_API_KEY;
  const lineToken = process.env.LINE_CHANNEL_ACCESS_TOKEN;

  // --- 1. 承認票ページを取得 ---
  const pageRes = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    headers: {
      Authorization: `Bearer ${notionToken}`,
      "Notion-Version": "2022-06-28",
      "Content-Type": "application/json",
    },
  });

  if (!pageRes.ok) {
    const txt = await pageRes.text();
    throw new Error(
      `Failed to fetch approval page: ${pageRes.status} ${txt || pageRes.statusText}`
    );
  }

  const pageData = await pageRes.json();
  const props = pageData.properties || {};

  // 承認票タイトル（ここでは「議案名」として扱う）
  const title =
    props["名前"]?.title?.[0]?.plain_text ||
    props["タイトル"]?.title?.[0]?.plain_text ||
    "承認依頼";

  // --- 2. 議案ページ関連情報の取得 ---
  let issueNo = "";
  let proposalSummary = "";
  let proposerNames = "";
  let deadlineText = "";
  let proposalUrl = "";

  try {
    const proposalRel = props["議案"]?.relation || [];
    const proposalPageId = proposalRel[0]?.id;

    if (proposalPageId) {
      // (1) 議案番号の自動採番（未採番なら振る）
      await ensureIssueSequence(proposalPageId);

      // (2) 採番後の議案ページを再取得
      const proposalRes = await fetch(
        `https://api.notion.com/v1/pages/${proposalPageId}`,
        {
          headers: {
            Authorization: `Bearer ${notionToken}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
          },
        }
      );

      if (proposalRes.ok) {
        const proposalData = await proposalRes.json();
        const pProps = proposalData.properties || {};

        // 議案番号
        const issueProp =
          pProps["議案番号フォーミュラ"] ||
          pProps["議案番号"] ||
          pProps["議案番号（自動）"];

        issueNo =
          issueProp?.formula?.string ??
          issueProp?.rich_text?.[0]?.plain_text ??
          "";

        // 内容（説明）を要約
        const descSource = pProps["内容（説明）"]?.rich_text;
        if (Array.isArray(descSource) && descSource.length > 0) {
          const fullText = descSource.map((r) => r.plain_text || "").join("");
          proposalSummary =
            fullText.length > 120 ? fullText.slice(0, 120) + "…" : fullText;
        }

        // 発議者（会員DBへのリレーション想定）
        const proposerRel = pProps["発議者"]?.relation || [];
        const proposerList = [];
        for (const rel of proposerRel) {
          const memberId = rel.id;
          try {
            const memberRes = await fetch(
              `https://api.notion.com/v1/pages/${memberId}`,
              {
                headers: {
                  Authorization: `Bearer ${notionToken}`,
                  "Notion-Version": "2022-06-28",
                  "Content-Type": "application/json",
                },
              }
            );
            if (!memberRes.ok) continue;
            const memberData = await memberRes.json();
            const mProps = memberData.properties || {};
            const mNameProp =
              mProps["氏名"] || mProps["名前"] || mProps["タイトル"];
            let memberName = "";
            if (
              mNameProp &&
              mNameProp.type === "title" &&
              Array.isArray(mNameProp.title) &&
              mNameProp.title.length > 0
            ) {
              memberName = mNameProp.title[0].plain_text || "";
            }
            if (memberName) proposerList.push(memberName);
          } catch (e) {
            console.error("Fetch proposer for LINE failed:", e);
          }
        }
        if (proposerList.length > 0) {
          proposerNames = proposerList.join("、");
        }

        // 承認期限（日付プロパティ）
        const deadlineProp =
          pProps["承認期限"]?.date || pProps["期限"]?.date || null;
        const deadlineStart = deadlineProp?.start;
        if (deadlineStart) {
          deadlineText = formatJpDate(deadlineStart);
        }

        // Notion 議案ページURL（IDのハイフンを外して生成）
        const cleanId = proposalPageId.replace(/-/g, "");
        proposalUrl = `https://www.notion.so/${cleanId}`;
      }
    }
  } catch (e) {
    console.error("Issue / proposal info fetch failed:", e);
  }

  // --- 3. 承認票から LINE 送信先の取得 ---
  const memberRel = props["会員"]?.relation || [];
  const lineRollup = props["LINEユーザーID"];
  const lineUserIds = [];

  // ① ロールアップ
  if (lineRollup && lineRollup.type === "rollup") {
    const roll = lineRollup.rollup;
    if (roll && roll.type === "array" && Array.isArray(roll.array)) {
      for (const item of roll.array) {
        if (item.type === "rich_text" && item.rich_text?.length) {
          const idText = item.rich_text[0].plain_text;
          if (idText) lineUserIds.push(idText);
        }
      }
    }
  }

  // ② 会員DB側補完
  if (lineUserIds.length === 0 && memberRel.length > 0) {
    for (const rel of memberRel) {
      const memberId = rel.id;
      try {
        const memberRes = await fetch(
          `https://api.notion.com/v1/pages/${memberId}`,
          {
            headers: {
              Authorization: `Bearer ${notionToken}`,
              "Notion-Version": "2022-06-28",
              "Content-Type": "application/json",
            },
          }
        );
        if (!memberRes.ok) continue;
        const memberData = await memberRes.json();
        const mProps = memberData.properties || {};
        const lineText =
          mProps["LINEユーザーID"]?.rich_text?.[0]?.plain_text || "";
        if (lineText) lineUserIds.push(lineText);
      } catch (e) {
        console.error("Fetch member for LINE ID failed:", e);
      }
    }
  }

  if (lineUserIds.length === 0) {
    return {
      ok: false,
      error: "LINEユーザーID を取得できませんでした。",
    };
  }

  // --- 4. Notion に approveURL / denyURL / LINEユーザーID文字列 を書き戻す ---
  const approveUrl = `https://approval.garagetsuno.org/approve?id=${pageId}`;
  const denyUrl = `https://approval.garagetsuno.org/deny?id=${pageId}`;
  const lineIdJoined = lineUserIds.join("\n");

  try {
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${notionToken}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          approveURL: { url: approveUrl },
          denyURL: { url: denyUrl },
          LINEユーザーID文字列: {
            rich_text: [
              {
                type: "text",
                text: { content: lineIdJoined },
              },
            ],
          },
        },
      }),
    });
  } catch (e) {
    console.error("Failed to write approve/deny URL or LINE IDs to Notion:", e);
  }

  // --- 5. LINE Flex メッセージ構築 ---
  const agendaLine = issueNo ? `${issueNo}　${title}` : title;

  const bodyContents = [
    {
      type: "text",
      text: "承認依頼",
      weight: "bold",
      size: "lg",
      align: "center",
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        { type: "text", text: "議案", weight: "bold", size: "sm" },
        { type: "text", text: agendaLine, size: "sm", wrap: true },
      ],
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        { type: "text", text: "内容", weight: "bold", size: "sm" },
        {
          type: "text",
          text: proposalSummary || "（内容未入力）",
          size: "sm",
          wrap: true,
        },
      ],
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        { type: "text", text: "発議者", weight: "bold", size: "sm" },
        {
          type: "text",
          text: proposerNames || "（発議者情報なし）",
          size: "sm",
          wrap: true,
        },
      ],
    },
    {
      type: "box",
      layout: "vertical",
      margin: "md",
      spacing: "xs",
      contents: [
        { type: "text", text: "期限", weight: "bold", size: "sm" },
        {
          type: "text",
          text: deadlineText || "（期限の指定なし）",
          size: "sm",
          wrap: true,
        },
      ],
    },
  ];

  const footerContents = [];

  // 承認フォームへ遷移するボタン
  footerContents.push({
    type: "button",
    style: "primary",
    height: "md",
    margin: "none",
    action: {
      type: "uri",
      label: "内容を確認する",
      uri: approveUrl,
    },
  });

  // 案内テキスト
  footerContents.push({
    type: "text",
    text:
      "ボタンを押すとブラウザが開きます。開いた画面で内容を確認し、承認または否認を選んでください。",
    wrap: true,
    size: "xs",
    color: "#888888",
    margin: "sm",
  });

  const message = {
    type: "flex",
    altText: "承認依頼があります",
    contents: {
      type: "bubble",
      body: {
        type: "box",
        layout: "vertical",
        contents: bodyContents,
      },
      footer: {
        type: "box",
        layout: "vertical",
        contents: footerContents,
        spacing: "md",
      },
    },
  };

  // --- 6. LINE に送信（ログ付き） ---
  for (const lineId of lineUserIds) {
    try {
      const res = await fetch("https://api.line.me/v2/bot/message/push", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${lineToken}`,
        },
        body: JSON.stringify({
          to: lineId,
          messages: [message],
        }),
      });

      const text = await res.text();

      console.log("LINE push response:", {
        to: lineId,
        status: res.status,
        body: text,
      });

      if (!res.ok) {
        throw new Error(
          `LINE push failed: ${res.status} ${text || res.statusText}`
        );
      }
    } catch (e) {
      console.error("LINE push exception:", e);
      throw e;
    }
  }

  return {
    ok: true,
    sentTo: lineUserIds,
    issueNo,
    proposalUrl,
  };
}

module.exports = {
  sendApprovalMessage,
};
