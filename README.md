# Accountability Partner

A free habit and goal-tracking web app with an AI partner that keeps you honest.

**Live:** https://dwm0bg67p8h54.cloudfront.net

Sign up with email, set a goal and a target date, and work it daily: quests, streaks, XP, a consistency grid, a focus timer, and an AI companion that plans with you — and tells you plainly when you're slipping.

## Why it exists

Most habit apps cheer. This one holds you accountable. It is built on the psychology of long preparations (competitive exams, big goals), which move through three phases:

1. **High motivation** (first ~30%) — novelty does the pushing. Bank reps while it's easy.
2. **The grind** (~30–75%) — the goal feels far and progress feels invisible. The log and streak exist for this phase: trust the record, not the feeling.
3. **The final push** (last ~25%) — anxiety rises. Moderate arousal is peak performance (Yerkes–Dodson); nerves get reframed as readiness.

The AI partner carries this model in every conversation, sees your last seven days of hits and misses, and responds accordingly — including the hard truths, followed by the smallest next step. The full write-up is on the in-app feedback page.

## Features

- Daily quests with XP and streaks; unfinished tasks carry over and are counted against you
- Milestones, a GitHub-style consistency grid, and a 25/50-minute focus timer
- End-of-day notes with a mistake-register habit
- AI partner that can add, complete, and remove quests and milestones, set goals, write your day note, and remember your name — from plain language
- Cross-device sync; a one-time four-step tour; an in-app feedback page

## Architecture

```
Browser ── CloudFront ── S3 (single-file frontend)
   │
   ├── Cognito (email + password, JWT)
   └── API Gateway (JWT authorizer)
         ├── GET/PUT /state ──> Lambda ──> DynamoDB
         ├── POST /feedback ──> Lambda ──> DynamoDB
         └── POST /ai ────────> Lambda ──> Gemini
```

- `cloud/app.html` — the entire frontend. Vanilla JS, one file, no build step. Config injected at deploy.
- `cloud/template.yaml` — the entire backend as CloudFormation. Both Lambdas are inlined (under the 4 KB limit), so the backend is a single file too.
- Everything is pay-per-use; at personal scale it runs within the AWS free tier.
- The Gemini key stays server-side; each user gets 30 AI calls per day.

## Deploy

Requires AWS CLI v2 (authenticated) and bash. A [Gemini API key](https://aistudio.google.com/apikey) is optional — without it the app works and the AI is disabled.

```bash
echo 'GEMINI_API_KEY=your-key' > cloud/.env   # optional
./deploy-local.sh
```

The script is idempotent: stack deploy, config injection, S3 publish, CloudFront, smoke tests, live URL printed at the end. On a fresh AWS account run it twice — the second run adds CloudFront's URL to CORS. `cloud/deploy-cloud.sh` is an alternative for AWS CloudShell.

### Stack parameters

| Parameter | Default | Notes |
|---|---|---|
| `GeminiApiKey` | blank | blank = AI disabled |
| `AiDailyLimit` | 30 | AI calls per user per day |
| `ModelId` | `gemini-flash-latest` | tracks Google's current flash model |
| `SiteOrigin`, `SiteDomain` | auto | set by the deploy script |

## Layout

```
deploy-local.sh       one-command deploy (idempotent)
cloud/
  app.html            frontend (single file, by design)
  template.yaml       backend (CloudFormation)
  deploy-cloud.sh     CloudShell fallback
  read-feedback.sh    dump user feedback from DynamoDB
  .env                Gemini key (gitignored)
```

## Security

- Every API route requires a Cognito JWT; unauthenticated requests get 401
- User data is isolated per account (DynamoDB keyed by token subject)
- CORS restricted to the site's origins; HTTPS enforced by CloudFront
- The Gemini key exists only as a NoEcho stack parameter → Lambda env var
- User text is HTML-escaped before rendering

## Reading feedback

```bash
bash cloud/read-feedback.sh
```
