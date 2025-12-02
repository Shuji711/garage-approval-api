// api/createApprovalTickets.js
const NOTION_API_KEY = process.env.NOTION_API_KEY;
const NOTION_VERSION = "2022-06-28";

const MEMBERS_DB_ID = "会員DBのID";
const APPROVAL_DB_ID = "承認票DBのID";

export async function GET(req) {
  const { searchParams } = new URL(req.url);
  const proposalId = searchParams.get("proposalId");

  if (!proposalId) {
    return new Response("Missing proposalId", { status: 400 });
  }

  // 0. 議案ページから「承認対象」を取得
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
  const approvalTarget =
    proposal.properties["承認対象"]?.select?.name || "理事会";

  // 1. どのチェックボックスを見るか決める
  const roleProperty = approvalTarget === "正会員" ? "正会員" : "理事";

  // 2. 会員DBをクエリ
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

  // ここから下は「対象ごとに承認票を作る」処理（前に出した通り）
  // ...
}
