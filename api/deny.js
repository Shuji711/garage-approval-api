export default async function handler(req, res) {
  try {
    const id = req.query.id;
    if (!id) {
      return res.status(400).json({ error: "id がありません" });
    }

    return res.status(200).json({
      message: "deny API 動作OK",
      received_id: id,
    });
  } catch (e) {
    return res.status(500).json({ error: "サーバーエラー" });
  }
}
