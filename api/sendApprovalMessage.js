// api/sendApprovalMessage.js
import sendApprovalCore from "../utils/sendApprovalCore.js";

export default async function handler(req, res) {
  try {
    const result = await sendApprovalCore();
    res.status(200).json({ status: "ok", result });
  } catch (err) {
    console.error("Error in sendApprovalMessage:", err);
    res.status(500).json({ status: "error", message: err.message });
  }
}
