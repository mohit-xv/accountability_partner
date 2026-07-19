"use strict";
const { DynamoDBClient, GetItemCommand, PutItemCommand, DeleteItemCommand, ScanCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
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
  return { name: `${ADJ[h % 16]} ${NOUN[(h >> 4) % 16]} #${h % 997}`, aid: h.toString(36), h };
}

async function displayName(me) {
  try {
    const r = await client.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: "cmname#" + me.aid } } }));
    if (r.Item?.name?.S) return { name: r.Item.name.S, custom: true };
  } catch {}
  return { name: me.name, custom: false };
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
    const dn = await displayName(me);
    // GSI query: cost scales with message count, not table size
    const res = await client.send(new QueryCommand({
      TableName: TABLE,
      IndexName: "gsi1",
      KeyConditionExpression: "gsi1pk = :p",
      ExpressionAttributeValues: { ":p": { S: "cm" } },
      ScanIndexForward: false,
      Limit: 100
    }));
    const messages = (res.Items || [])
      .map(i => ({ id: i.pk.S, name: i.name?.S || "?", text: i.text?.S || "", at: i.at?.S || "", aid: i.aid?.S || "" }))
      .reverse()
      .map(m => ({ ...m, mine: m.aid === me.aid }));
    return json(200, { me: { name: dn.name, custom: dn.custom, admin: isAdmin }, messages });
  }

  // POST
  let body;
  try { body = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }

  if (body.action === "setname") {
    const clean = String(body.name || "").trim().replace(/\s+/g, " ");
    if (!/^[A-Za-z0-9 _]{3,20}$/.test(clean)) return json(400, { error: "Name must be 3–20 letters, numbers, spaces or _" });
    if (isAbusive(clean)) return json(422, { error: "Pick a respectful name." });
    const existing = await client.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: "cmname#" + me.aid } } }));
    if (existing.Item) return json(409, { error: "You've already chosen your name — it's permanent." });
    const display = `${clean} #${me.h % 997}`; // suffix prevents impersonation
    await client.send(new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: "cmname#" + me.aid }, name: { S: display }, at: { S: new Date().toISOString() } }
    }));
    return json(200, { ok: true, name: display });
  }

  if (body.action === "delete") {
    const id = String(body.id || "");
    if (!id.startsWith("cm#")) return json(400, { error: "bad id" });
    if (!isAdmin && !id.endsWith("#" + me.aid)) return json(403, { error: "You can only delete your own messages." });
    await client.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: id } } }));
    return json(200, { ok: true });
  }

  if (body.action === "ban") {
    if (!isAdmin) return json(403, { error: "admins only" });
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

  const dn = await displayName(me);
  const now = new Date().toISOString();
  await client.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `cm#${now}#${me.aid}` },
      gsi1pk: { S: "cm" }, gsi1sk: { S: `${now}#${me.aid}` },
      name: { S: dn.name }, text: { S: text }, at: { S: now }, aid: { S: me.aid }
    }
  }));
  return json(200, { ok: true });
}

async function adminStats() {
  const now = Date.now(), day = 86400000;
  const today = new Date().toISOString().slice(0, 10);
  let totalUsers = 0, confirmed = 0, newToday = 0, new7d = 0;
  try {
    const { CognitoIdentityProviderClient, ListUsersCommand } = require("@aws-sdk/client-cognito-identity-provider");
    const cog = new CognitoIdentityProviderClient({});
    let token, pages = 0;
    do {
      const r = await cog.send(new ListUsersCommand({ UserPoolId: process.env.POOL, Limit: 60, PaginationToken: token }));
      for (const u of r.Users || []) {
        totalUsers++;
        if (u.UserStatus === "CONFIRMED") confirmed++;
        const c = u.UserCreateDate ? new Date(u.UserCreateDate).getTime() : 0;
        if (now - c < day) newToday++;
        if (now - c < 7 * day) new7d++;
      }
      token = r.PaginationToken; pages++;
    } while (token && pages < 17);
    if (token) console.error("STATS TRUNCATED: user list capped at ~1020 — raise the page cap");
  } catch (e) { console.error("cognito stats failed:", e && e.message); }

  let withData = 0, activeToday = 0, active7 = 0, online = 0, bans = 0;
  let fb = 0, fbToday = 0, cm = 0, cmToday = 0, aiToday = 0, aiTotal = 0;
  let questsAdded = 0, questsDone = 0, milesDone = 0, focusMin = 0, withGoal = 0;
  let startKey;
  do {
    const r = await client.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: "pk, updatedAt, #n, #s",
      ExpressionAttributeNames: { "#n": "n", "#s": "state" },
      ExclusiveStartKey: startKey
    }));
    for (const i of r.Items || []) {
      const pk = i.pk.S;
      if (pk.startsWith("fb#")) { fb++; if (pk.startsWith("fb#" + today)) fbToday++; }
      else if (pk.startsWith("cm#")) { cm++; if (pk.startsWith("cm#" + today)) cmToday++; }
      else if (pk.startsWith("ban#")) bans++;
      else if (pk.startsWith("cmname#") || pk.startsWith("rl#")) { /* bookkeeping rows */ }
      else if (pk.includes("#ai#")) {
        const calls = parseInt(i.n?.N || "0", 10);
        aiTotal += calls;
        if (pk.endsWith("#" + today)) aiToday += calls;
      }
      else {
        withData++;
        const u = i.updatedAt?.S ? new Date(i.updatedAt.S).getTime() : 0;
        if (now - u < day) activeToday++;
        if (now - u < 7 * day) active7++;
        if (now - u < 10 * 60000) online++; // synced within 10 min ≈ online
        if (i.state?.S) {
          try {
            const st = JSON.parse(i.state.S);
            for (const d in (st.quests || {})) {
              const its = st.quests[d] || [];
              questsAdded += its.length;
              questsDone += its.filter(x => x.done).length;
            }
            milesDone += (st.milestones || []).filter(m => m.done).length;
            focusMin += Math.round(st.focusMin || 0);
            if (st.goals?.longTerm) withGoal++;
          } catch {}
        }
      }
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);

  return json(200, {
    totalUsers, confirmed, newToday, new7d,
    withData, activeToday, active7, online, withGoal,
    feedback: fb, feedbackToday: fbToday, community: cm, communityToday: cmToday, banned: bans,
    aiToday, aiTotal,
    questsAdded, questsDone, milesDone, focusMin
  });
}

// Best-effort mirror of feedback to the maker's Telegram — DynamoDB stays the source of truth.
async function notifyTelegram(text) {
  const token = process.env.TG_TOKEN, chat = process.env.TG_CHAT;
  if (!token || !chat) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
      signal: AbortSignal.timeout(4000)
    });
  } catch (err) {
    console.error("telegram push failed:", err && err.message);
  }
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

    if (path === "/stats" && method === "GET") {
      if (!ADMIN || String(claims.email || "").toLowerCase() !== ADMIN) return json(403, { error: "admins only" });
      return await adminStats();
    }

    if (path === "/feedback" && method === "POST") {
      let parsed;
      try { parsed = JSON.parse(raw); } catch { return json(400, { error: "bad json" }); }
      const text = String(parsed?.text || "").slice(0, 2000).trim();
      if (!text) return json(400, { error: "empty" });
      const fbDay = new Date().toISOString().slice(0, 10);
      if (!(await bumpCounter(`rl#fb#${fbDay}#${sub.slice(0, 8)}`, 30))) {
        return json(429, { error: "Daily feedback limit reached — thank you for the enthusiasm!" });
      }
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
      await notifyTelegram(`📮 New feedback\nFrom: ${claims.email || "unknown"}\n\n${text}`);
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
