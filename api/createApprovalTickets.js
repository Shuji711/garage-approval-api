// api/createApprovalTickets.js
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

// Notion データベースID
// 会員DB
const MEMBERS_DB_ID = "2ba9f7abb33d8087b1cccb9e96348f26";
// 承認票DB
const APPROVAL_DB_ID = "2ba9f7abb33d806e92ccded4f2149d86";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const proposalId = searchParams.get("proposalId");

  if (!proposalId) {
    return new Response("Missing proposalId", { status: 400 });
  }

  // 0. 議案ページから「承認対象」を取得（理事会 / 正会員）
  const proposalRes = await fetch(
    `https://api.notion.com/v1/pages/${proposalId}`,
    {
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
      },
    }
  );

  if (!proposalRes.ok) {
    const text = await proposalRes.text();
    return new Response(text, { status: proposalRes.status });
  }

  const proposal = await proposalRes.json();

  // セレクトプロパティ「承認対象」
  // オプション：理事会 / 正会員
  const approvalTarget =
    proposal.properties["承認対象"]?.select?.name || "理事会";

  // 1. どのロールを見るか決定
  //   理事会 → 会員DB「理事」チェック
  //   正会員 → 会員DB「正会員」チェック
  const roleProperty = approvalTarget === "正会員" ? "正会員" : "理事";

  // 2. 会員DBをクエリ（役割 + LINEユーザーIDあり）
  const membersRes = await fetch(
    `https://api.notion.com/v1/databases/${MEMBERS_DB_ID}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          and: [
            {
              property: roleProperty,
              checkbox: { equals: true },
            },
            {
              property: "LINEユーザーID",
              rich_text: { is_not_empty: true },
            },
          ],
        },
      }),
    }
  );

  if (!membersRes.ok) {
    const text = await membersRes.text();
    return new Response(text, { status: membersRes.status });
  }

  const membersData = await membersRes.json();
  const targets = membersData.results;

  // 対象者がいない場合も正常終了にしておく
  if (!targets || targets.length === 0) {
    return new Response("No members found for approval", { status: 200 });
  }

  // 3. 対象者ごとに承認票を作成
  for (const m of targets) {
    const memberPageId = m.id;

    // 3-1. 承認票ページを作成
    const createRes = await fetch("https://api.notion.com/v1/pages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        parent: { database_id: APPROVAL_DB_ID },
        properties: {
          // タイトル（必要に応じてあとで変更可）
          名前: {
            title: [
              {
                text: { content: "承認票" },
              },
            ],
          },
          議案: {
            relation: [{ id: proposalId }],
          },
          会員: {
            relation: [{ id: memberPageId }],
          },
          承認結果: {
            select: null,
          },
          承認日時: {
            date: null,
          },
        },
      }),
    });

    if (!createRes.ok) {
      const text = await createRes.text();
      return new Response(text, { status: createRes.status });
    }

    const created = await createRes.json();
    const approvalPageId = created.id;

    // 3-2. 自分の「ページID」プロパティにIDを書き込む
    await fetch(`https://api.notion.com/v1/pages/${approvalPageId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: {
          ページID: {
            rich_text: [
              {
                text: {
                  content: approvalPageId,
                },
              },
            ],
          },
        },
      }),
    });
  }

  return new Response("OK");
}
