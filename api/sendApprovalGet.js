// /api/sendApprovalGet.js
import { sendApprovalMessage } from '../../utils/sendApprovalCore.js'; 

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ error: "Method not allowed" });
    }

    const { pageId } = req.query;
    if (!pageId) {
      return res.status(400).json({ error: "Missing pageId" });
    }

    const result = await sendApprovalMessage(pageId);
    return res.status(200).json(result);

  } catch (err) {
    console.error("GET send error:", err);
    return res.status(500).json({ error: err.message });
  }
}
