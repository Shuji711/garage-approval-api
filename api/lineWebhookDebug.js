// api/lineWebhookDebug.js

export default async function handler(req, res) {
  // LINEからのWebhookイベントをそのままログに出す
  const body =
    typeof req.body === "string" ? JSON.parse(req.body) : (req.body || {});

  console.log("LINE Webhook Debug:", JSON.stringify(body, null, 2));

  // LINE側にOKを返す
  res.status(200).json({ ok: true });
}
