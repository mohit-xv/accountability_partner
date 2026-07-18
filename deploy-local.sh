#!/usr/bin/env bash
# ============================================================
# Quest Board — one-command local deploy (idempotent)
#
# Deploys the backend stack, injects config into the frontend,
# publishes the site to S3, and smoke-tests it.
# Run from repo root: ./deploy-local.sh
# Requires: AWS CLI v2 (authenticated), bash, curl.
# Optional: GEMINI_API_KEY env var (assistant disabled without it).
# ============================================================
set -euo pipefail

REGION="${QB_REGION:-ap-south-1}"
STACK="questboard"
CLOUD_DIR="$(cd "$(dirname "$0")/cloud" && pwd)"

die(){ echo "ERROR: $*" >&2; exit 1; }

# ---------- 1. Preflight ----------
echo ">> Preflight"
# Key can come from the environment or from cloud/.env (never committed).
if [ -z "${GEMINI_API_KEY:-}" ] && [ -f "$CLOUD_DIR/.env" ]; then
  set -a; . "$CLOUD_DIR/.env"; set +a
fi
command -v aws >/dev/null 2>&1 || die "AWS CLI not found. Install v2: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html"
aws sts get-caller-identity --query Arn --output text >/dev/null 2>&1 \
  || die "AWS credentials not working. Run: aws configure   (then re-run this script)"
if [ -n "${GEMINI_API_KEY:-}" ]; then
  echo "   Gemini key: present — assistant will be ENABLED"
else
  echo "   Gemini key: NOT set — assistant disabled (get a free key at https://aistudio.google.com/apikey, then: export GEMINI_API_KEY=... and re-run)"
fi
echo "   Region: $REGION"

# ---------- 2. Deploy backend ----------
BUCKET_FILE="$CLOUD_DIR/.qb_bucket"
KNOWN_BUCKET=""
[ -f "$BUCKET_FILE" ] && KNOWN_BUCKET=$(cat "$BUCKET_FILE")
S3_ORIGIN=""
[ -n "$KNOWN_BUCKET" ] && S3_ORIGIN="http://$KNOWN_BUCKET.s3-website.$REGION.amazonaws.com"

out(){ aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text 2>/dev/null || true; }

# Private artifacts bucket for packaged Lambda code (bypasses the 4 KB inline limit)
ART_FILE="$CLOUD_DIR/.qb_artifacts"
ART=""
[ -f "$ART_FILE" ] && ART=$(cat "$ART_FILE")
if [ -z "$ART" ] || ! aws s3api head-bucket --bucket "$ART" --region "$REGION" 2>/dev/null; then
  ART="questboard-artifacts-$RANDOM$RANDOM"
  echo ">> Creating private artifacts bucket $ART"
  aws s3api create-bucket --bucket "$ART" --region "$REGION" \
    --create-bucket-configuration LocationConstraint="$REGION" >/dev/null
  echo "$ART" > "$ART_FILE"
fi
mkdir -p "$CLOUD_DIR/dist"
PACKAGED="$CLOUD_DIR/dist/packaged.yaml"
echo ">> Packaging Lambda code"
aws cloudformation package --template-file "$CLOUD_DIR/template.yaml" \
  --s3-bucket "$ART" --output-template-file "$PACKAGED" --region "$REGION" >/dev/null

deploy_stack(){ # $1 = comma-joined allowed CORS origins ("" = template default "*")
  local PARAMS=()
  [ -n "${GEMINI_API_KEY:-}" ] && PARAMS+=("GeminiApiKey=$GEMINI_API_KEY")
  [ -n "${ADMIN_EMAIL:-}" ] && PARAMS+=("AdminEmail=$ADMIN_EMAIL")
  [ -n "${TG_TOKEN:-}" ] && PARAMS+=("TgToken=$TG_TOKEN")
  [ -n "${TG_CHAT:-}" ] && PARAMS+=("TgChat=$TG_CHAT")
  if [ -n "$KNOWN_BUCKET" ]; then
    PARAMS+=("SiteDomain=$KNOWN_BUCKET.s3-website.$REGION.amazonaws.com")
    [ -n "$1" ] && PARAMS+=("SiteOrigin=$1")
  fi
  local ARGS=(--stack-name "$STACK" --template-file "$PACKAGED"
    --capabilities CAPABILITY_IAM --region "$REGION" --no-fail-on-empty-changeset)
  if [ ${#PARAMS[@]} -gt 0 ]; then
    aws cloudformation deploy "${ARGS[@]}" --parameter-overrides "${PARAMS[@]}"
  else
    aws cloudformation deploy "${ARGS[@]}"
  fi
}

echo ">> Deploying backend stack ($STACK)"
PRE_CDN=$(out CdnUrl); [ "$PRE_CDN" = "None" ] && PRE_CDN=""
ORIGINS="$S3_ORIGIN"
[ -n "$PRE_CDN" ] && ORIGINS="$PRE_CDN,$S3_ORIGIN"
deploy_stack "$ORIGINS"
CDN=$(out CdnUrl); [ "$CDN" = "None" ] && CDN=""
if [ -n "$CDN" ] && [ -n "${ORIGINS##*$CDN*}" ]; then
  echo ">> CloudFront created — updating API CORS to allow the HTTPS origin"
  deploy_stack "$CDN,$S3_ORIGIN"
fi

# ---------- 3. Read stack outputs ----------
API=$(out ApiUrl); CID=$(out ClientId); POOL=$(out UserPoolId)
[ -n "$API" ] && [ -n "$CID" ] || die "Could not read stack outputs (ApiUrl/ClientId)"
echo "   ApiUrl:     $API"
echo "   UserPoolId: $POOL"
echo "   ClientId:   $CID"

# ---------- 4. Build frontend ----------
echo ">> Building frontend -> cloud/dist/index.html"
mkdir -p "$CLOUD_DIR/dist"
sed -e "s|__API_URL__|$API|g" -e "s|__CLIENT_ID__|$CID|g" -e "s|__REGION__|$REGION|g" \
  "$CLOUD_DIR/app.html" > "$CLOUD_DIR/dist/index.html"
grep -q "__API_URL__" "$CLOUD_DIR/dist/index.html" && die "Placeholder injection failed"

# ---------- 5. Publish site ----------
BUCKET="$KNOWN_BUCKET"
if [ -n "$BUCKET" ]; then
  if ! aws s3api head-bucket --bucket "$BUCKET" --region "$REGION" 2>/dev/null; then
    echo "   Bucket $BUCKET from .qb_bucket no longer exists; creating a new one"
    BUCKET=""
  fi
fi
if [ -z "$BUCKET" ]; then
  BUCKET="questboard-site-$RANDOM$RANDOM"
  echo ">> Creating bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
  echo "$BUCKET" > "$BUCKET_FILE"
else
  echo ">> Reusing bucket $BUCKET"
fi
# The three calls below are safe to re-run every deploy.
aws s3 website "s3://$BUCKET/" --index-document index.html
aws s3api put-public-access-block --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
  \"Version\": \"2012-10-17\",
  \"Statement\": [{\"Sid\":\"PublicRead\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}]
}"

echo ">> Uploading site"
aws s3 cp "$CLOUD_DIR/dist/index.html" "s3://$BUCKET/index.html" \
  --content-type "text/html; charset=utf-8" --region "$REGION"

SITE_URL="http://$BUCKET.s3-website.$REGION.amazonaws.com"

# ---------- 6. Smoke test ----------
echo ">> Smoke test"
ok=0
for i in 1 2 3 4 5; do
  body=$(curl -s -m 15 "$SITE_URL" || true)
  case "$body" in *"<title>Accountability Partner"*) ok=1;; esac
  [ "$ok" = 1 ] && break
  sleep 3
done
[ "$ok" = 1 ] || die "Site check failed: $SITE_URL did not return the app page"
echo "   Site OK (200 + <title>Accountability Partner)"

if [ -n "$CDN" ]; then
  ok=0
  for i in 1 2 3 4 5 6; do
    body=$(curl -s -m 20 "$CDN" || true)
    case "$body" in *"<title>Accountability Partner"*) ok=1;; esac
    [ "$ok" = 1 ] && break
    sleep 5
  done
  [ "$ok" = 1 ] || die "CDN check failed: $CDN did not serve the app"
  echo "   CDN OK (HTTPS live at $CDN)"
fi

code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 "$API/state")
[ "$code" = "401" ] || die "API auth check failed: GET $API/state returned $code (expected 401)"
echo "   API OK (unauthenticated /state -> 401, JWT authorizer active)"

code=$(curl -s -o /dev/null -w "%{http_code}" -m 15 -X POST "$API/feedback")
[ "$code" = "401" ] || die "API auth check failed: POST $API/feedback returned $code (expected 401)"
echo "   Feedback route OK (unauthenticated -> 401)"

echo ""
echo "============================================================"
if [ -n "$CDN" ]; then
  echo "LIVE (HTTPS — share this one): $CDN"
  echo "S3 fallback (HTTP): $SITE_URL"
else
  echo "LIVE: $SITE_URL"
  echo "No CloudFront yet — run ./deploy-local.sh once more to create the HTTPS URL."
fi
echo "Assistant: $( [ -n "${GEMINI_API_KEY:-}" ] && echo "ENABLED" || echo "disabled (set GEMINI_API_KEY and re-run to enable)" )"
echo "Re-deploy after any change: ./deploy-local.sh"
echo "============================================================"
