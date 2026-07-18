"use strict";
const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const client = new DynamoDBClient({});
const TABLE = process.env.TABLE;
const ADMIN = (process.env.ADMIN || "").toLowerCase();

const json = (status, body) => ({
  statusCode: status,
  headers: { "content-type": "application/json" },
  body: typeof body === "string" ? body : JSON.stringify(body)
});

/* ---- anonymous identity: deterministic pseudonym from the Cognito sub, never the email ---- */
const ADJ = ["Steady","Focused","Relentless","Quiet","Bold","Patient","Sharp","Calm","Driven","Honest","Swift","Stoic","Bright","Gritty","Humble","Fierce"];
const NOUN = ["Climber","Runner","Scholar","Builder","Ranger","Pilot","Knight","Falcon","Tiger","Wolf","Phoenix","Summit","Arrow","Comet","Anchor","Beacon"];
function anonOf(sub) {
  let h = 0;
  for (const c of sub) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return { name: `${ADJ[h % 16]} ${NOUN[(h >> 4) % 16]} #${h % 997}`, aid: h.toString(36) };
}

/* ---- profanity filter: local wordlist (English + Hindi), zero cost, no AI quota ---- */
const BAD = ["fuck","fucker","fucking","motherfucker","shit","bitch","asshole","bastard","cunt","slut","whore","dickhead",
  "bsdk","bhosdike","bhosdi","bhosda","madarchod","madharchod","behenchod","bhenchod","bhnchod","chutiya","chutiye","chutia",
  "gandu","gaandu","gaand","lund","loda","lauda","lawda","randi","rundi","harami","haramkhor","kamina","kamine","tatti",
  "chod","chodu","chudai","jhant","jhatu","suar","kutti"];
function isAbusive(text) {
  const norm = text.toLowerCase()
    .replace(/[0@]/g, "o").replace(/[1!|]/g, "i").replace(/[3]/g, "e").replace(/[4]/g, "a").replace(/[5$]/g, "s").replace(/[7]/g, "t")
    .replace(/(.)\1{2,}/g, "$1$1");           // fuuuck -> fuuck
  const squashed = norm.replace(/[^a-z]/g, ""); // f.u-c k -> fuck
  const words = norm.replace(/[^a-z]+/g, " ");
  return BAD.some(w => new RegExp(`(^| )${w}( |$)`).test(words) || (w.length > 4 && squashed.includes(w)));
}

async function bumpCounter(pk, limit) {
  const { UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
  try {
    const res = await client.send(new UpdateItemCommand({
      TableName: TABLE, Key: { pk: { S: pk } },
      UpdateExpression: "ADD n :one", ExpressionAttributeValues: { ":one": { N: "1" } },
      ReturnValues: "UPDATED_NEW"
    }));
    return parseInt(res.Attributes.n.N, 10) <= limit;
  } catch { return true; } // fail open
}

async function community(method, sub, email, raw) {
  const me = anonOf(sub);
  const isAdmin = !!ADMIN && email.toLowerCase() === ADMIN;

  if (method === "GET") {
    const res = await client.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: "begins_with(pk, :p)",
      ExpressionAttributeValues: { ":p": { S: "cm#" } },
      ProjectionExpression: "pk, #n, #t, #a, aid",
      ExpressionAttributeNames: { "#n": "name", "#t": "text", "#a": "at" }
    }));
    const messages = (res.Items || [])
      .map(i => ({ id: i.pk.S, name: i.name?.S || "?", text: i.text?.S || "", at: i.at?.S || "", aid: i.aid?.S || "" }))
      .sort((a, b) => a.id < b.id ? -1 : 1)
      .slice(-100)
      .map(m => ({ ...m, mine: m.aid === me.aid }));
    return json(200, { me: { name: me.name, admin: isAdmin }, messages });
  }

  // POST
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }

  if (body.action === "delete" || body.action === "ban") {
    if (!isAdmin) return json(403, { error: "admins only" });
    if (body.action === "delete") {
      const id = String(body.id || "");
      if (!id.startsWith("cm#")) return json(400, { error: "bad id" });
      await client.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: id } } }));
      return json(200, { ok: true });
    }
    const aid = String(body.aid || "").slice(0, 20);
    if (!aid) return json(400, { error: "bad aid" });
    await client.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: "ban#" + aid }, at: { S: new Date().toISOString() } }
    }));
    return json(200, { ok: true });
  }

  const text = String(body.text || "").slice(0, 400).trim();
  if (!text) return json(400, { error: "empty" });

  const banned = await client.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: "ban#" + me.aid } } }));
  if (banned.Item) return json(403, { error: "You've been removed from the community chat." });

  if (isAbusive(text)) return json(422, { error: "Message removed — keep the community respectful." });

  const day = new Date().toISOString().slice(0, 10);
  if (!(await bumpCounter(`rl#cm#${day}#${me.aid}`, 100))) {
    return json(429, { error: "Daily chat limit reached." });
  }

  const now = new Date().toISOString();
  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `cm#${now}#${me.aid}` },
      name: { S: me.name }, text: { S: text }, at: { S: now }, aid: { S: me.aid }
    }
  }));
  return json(200, { ok: true });
}

exports.handler = async (event) => {
  const claims = event.requestContext?.authorizer?.jwt?.claims;
  const sub = claims?.sub;
  if (!sub) return json(401, { error: "unauthorized" });

  const method = event.requestContext.http.method;
  const path = event.rawPath || "";
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "{}");

  try {
    if (path === "/community") return await community(method, sub, String(claims.email || ""), raw);

    if (path === "/feedback" && method === "POST") {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      const text = String(parsed?.text || "").slice(0, 2000).trim();
      if (!text) return json(400, { error: "empty" });
      const now = new Date().toISOString();
      await client.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: "fb#" + now + "#" + sub.slice(0, 8) },
          text: { S: text },
          email: { S: String(claims.email || "") },
          at: { S: now }
        }
      }));
      return json(200, { ok: true });
    }

    if (method === "GET") {
      const res = await client.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: sub } } }));
      return json(200, res.Item?.state?.S || "{}");
    }

    if (method === "PUT") {
      if (raw.length > 380000) return json(413, { error: "state too large" });
      try { JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      await client.send(new PutItemCommand({
        TableName: TABLE,
        Item: { pk: { S: sub }, state: { S: raw }, updatedAt: { S: new Date().toISOString() } }
      }));
      return json(200, { ok: true });
    }

    return json(405, { error: "method not allowed" });
  } catch (err) {
    console.error("state error:", err && err.message);
    return json(500, { error: "server error" });
  }
};
