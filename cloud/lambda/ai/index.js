"use strict";
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient({});
const TABLE = process.env.TABLE;
const KEY = process.env.GKEY;
const DAILY_LIMIT = parseInt(process.env.LIMIT || "30", 10);

// Primary model first, then fallbacks — survives per-model rate limits and retirements.
const MODELS = [...new Set([process.env.MODEL || "gemini-2.5-flash", "gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-flash-latest"])];
const ATTEMPT_TIMEOUT_MS = 9000;
const RETRY_DELAY_MS = 700;

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body)
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGemini(model, payload) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
  });
  const data = await resp.json().catch(() => ({}));
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = parts ? parts.filter(p => !p.thought).map(p => p.text || "").join("") : "";
  return { status: resp.status, ok: resp.ok && !!text, text, data };
}

exports.handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (!sub) return json(401, { error: "unauthorized" });
  if (!KEY) return json(501, { error: "The assistant isn't configured yet." });

  // Per-user daily cap (atomic counter, resets by date key)
  const day = new Date().toISOString().slice(0, 10);
  try {
    const res = await client.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `${sub}#ai#${day}` } },
      UpdateExpression: "ADD n :one",
      ExpressionAttributeValues: { ":one": { N: "1" } },
      ReturnValues: "UPDATED_NEW"
    }));
    if (parseInt(res.Attributes.n.N, 10) > DAILY_LIMIT) {
      return json(429, { error: "Daily assistant limit reached — resets at midnight UTC." });
    }
  } catch (err) {
    console.error("cap check failed:", err && err.message); // fail open — cap is best-effort
  }

  let body;
  try {
    body = JSON.parse(event.isBase64Encoded
      ? Buffer.from(event.body || "", "base64").toString("utf8")
      : (event.body || "{}"));
  } catch {
    return json(400, { error: "bad json" });
  }

  const system = String(body.system || "").slice(0, 9000);
  const messages = Array.isArray(body.messages) ? body.messages.slice(-12) : [];
  const contents = messages.map(m => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: String(m.text || "").slice(0, 4000) }]
  }));
  if (!contents.length) return json(400, { error: "no messages" });

  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 2048, responseMimeType: "application/json" }
  };

  // Try primary model twice (transient errors), then each fallback once.
  const plan = [MODELS[0], MODELS[0], ...MODELS.slice(1)];
  let lastStatus = 0;
  for (let i = 0; i < plan.length; i++) {
    if (i > 0) await sleep(RETRY_DELAY_MS);
    try {
      const r = await callGemini(plan[i], payload);
      if (r.ok) return json(200, { text: r.text });
      lastStatus = r.status;
      console.error(`attempt ${i + 1} (${plan[i]}) failed:`, r.status, JSON.stringify(r.data?.error || {}).slice(0, 300));
      if (r.status === 400 || r.status === 403) break; // key/request problem — retrying won't help
    } catch (err) {
      lastStatus = 0;
      console.error(`attempt ${i + 1} (${plan[i]}) threw:`, err && err.message);
    }
  }

  if (lastStatus === 429) return json(503, { error: "The assistant is in high demand right now — try again in a minute." });
  return json(502, { error: "The assistant couldn't respond just now — your board is unaffected. Try again shortly." });
};
