"use strict";
/* Streak-risk reminder — runs daily (evening IST). Emails users whose streak
   is alive but who haven't completed a quest today. Skips silently unless a
   verified SES sender is configured. */
const { DynamoDBClient, ScanCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SESv2Client, SendEmailCommand } = require("@aws-sdk/client-sesv2");
const { CognitoIdentityProviderClient, ListUsersCommand } = require("@aws-sdk/client-cognito-identity-provider");

const ddb = new DynamoDBClient({});
const ses = new SESv2Client({});
const TABLE = process.env.TABLE;
const SENDER = process.env.SENDER;
const SITE = process.env.SITE || "";
const MAX_EMAILS_PER_RUN = 50;
const IST_OFFSET_MS = 5.5 * 3600000;

const istDate = (t) => new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);

function streakEndingYesterday(quests, todayIst) {
  const doneOn = d => (quests[d] || []).some(q => q.done);
  let streak = 0;
  let d = new Date(todayIst + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  while (doneOn(d.toISOString().slice(0, 10))) {
    streak++;
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return streak;
}

exports.handler = async () => {
  if (!SENDER) return { skipped: "no sender configured" };

  // sub -> email from Cognito
  const cog = new CognitoIdentityProviderClient({});
  const emailBySub = {};
  let token, pages = 0;
  do {
    const r = await cog.send(new ListUsersCommand({ UserPoolId: process.env.POOL, Limit: 60, PaginationToken: token }));
    for (const u of r.Users || []) {
      const attrs = Object.fromEntries((u.Attributes || []).map(a => [a.Name, a.Value]));
      if (attrs.sub && attrs.email && u.UserStatus === "CONFIRMED") emailBySub[attrs.sub] = attrs.email;
    }
    token = r.PaginationToken; pages++;
  } while (token && pages < 17);
  if (token) console.error("REMINDER TRUNCATED: user list capped at ~1020 — users beyond this get no reminders");

  const todayIst = istDate(Date.now());
  let sent = 0, atRisk = 0;
  let startKey;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: TABLE,
      ProjectionExpression: "pk, #s",
      ExpressionAttributeNames: { "#s": "state" },
      ExclusiveStartKey: startKey
    }));
    for (const item of r.Items || []) {
      const sub = item.pk.S;
      if (sub.includes("#") || !item.state?.S || !emailBySub[sub]) continue;
      let st;
      try { st = JSON.parse(item.state.S); } catch { continue; }
      if (st.remindersOff) continue; // user opted out — autonomy is the deal
      const quests = st.quests || {};
      const doneToday = (quests[todayIst] || []).some(q => q.done);
      if (doneToday) continue;
      const streak = streakEndingYesterday(quests, todayIst);
      if (streak < 3) continue; // only nag when there's something real to lose
      atRisk++;
      if (sent >= MAX_EMAILS_PER_RUN) continue;
      // idempotency marker: async Lambda retries must never re-email the same user the same day
      try {
        await ddb.send(new PutItemCommand({
          TableName: TABLE,
          Item: { pk: { S: `rl#rem#${todayIst}#${sub.slice(0, 12)}` }, at: { S: new Date().toISOString() } },
          ConditionExpression: "attribute_not_exists(pk)"
        }));
      } catch { continue; } // already sent today (or marker write failed) — skip
      const name = (st.profile && st.profile.name) || "there";
      try {
        await ses.send(new SendEmailCommand({
          FromEmailAddress: `Accountability Partner <${SENDER}>`,
          Destination: { ToAddresses: [emailBySub[sub]] },
          Content: { Simple: {
            Subject: { Data: `Your ${streak}-day streak ends tonight` },
            Body: { Text: { Data:
`Hey ${name},

${streak} days in a row — and today has no quest checked off yet.

One small rep before midnight keeps the chain alive. That's all it takes.

${SITE || "Open the app"}

— your accountability partner
(You can turn these reminders off anytime in the app: Goals → Streak reminder emails.)` } }
          } }
        }));
        sent++;
      } catch (err) {
        console.error("send failed for", emailBySub[sub].replace(/(.).+(@.+)/, "$1***$2"), "-", err && err.message);
      }
    }
    startKey = r.LastEvaluatedKey;
  } while (startKey);

  console.log(`streak reminders: ${atRisk} at risk, ${sent} emailed`);
  return { atRisk, sent };
};
