#!/usr/bin/env bash
# ============================================================
# Quest Board (public edition) — full-stack deploy
# Run in AWS CloudShell after uploading: template.yaml, app.html, deploy-cloud.sh
#
# Creates: Cognito user pool, DynamoDB table, 2 Lambdas,
# HTTP API (JWT-protected), S3 static site.
# Cost: ~free at personal/small scale (all serverless, pay-per-use).
# ============================================================
set -euo pipefail

REGION="ap-south-1"          # change if you like
STACK="questboard"

# --- Gemini key (free: https://aistudio.google.com/apikey) ---
read -r -s -p "Paste your Gemini API key (Enter to skip — assistant disabled): " GKEY
echo ""

echo ">> Deploying backend stack ($STACK) ..."
if [ -n "$GKEY" ]; then
  aws cloudformation deploy --stack-name "$STACK" --template-file template.yaml \
    --capabilities CAPABILITY_IAM --region "$REGION" \
    --parameter-overrides GeminiApiKey="$GKEY"
else
  aws cloudformation deploy --stack-name "$STACK" --template-file template.yaml \
    --capabilities CAPABILITY_IAM --region "$REGION"
fi

out(){ aws cloudformation describe-stacks --stack-name "$STACK" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text; }

API=$(out ApiUrl); CID=$(out ClientId); POOL=$(out UserPoolId)
echo ">> API: $API"
echo ">> UserPool: $POOL  Client: $CID"

echo ">> Injecting config into frontend"
sed -e "s|__API_URL__|$API|g" -e "s|__CLIENT_ID__|$CID|g" -e "s|__REGION__|$REGION|g" app.html > index.html

# --- bucket (reuse across deploys via .qb_bucket file) ---
if [ -f .qb_bucket ]; then
  BUCKET=$(cat .qb_bucket)
  echo ">> Reusing bucket $BUCKET"
else
  BUCKET="questboard-site-$RANDOM$RANDOM"
  echo ">> Creating bucket $BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION"
  else
    aws s3api create-bucket --bucket "$BUCKET" --region "$REGION" \
      --create-bucket-configuration LocationConstraint="$REGION"
  fi
  aws s3 website "s3://$BUCKET/" --index-document index.html
  aws s3api put-public-access-block --bucket "$BUCKET" \
    --public-access-block-configuration BlockPublicAcls=false,IgnorePublicAcls=false,BlockPublicPolicy=false,RestrictPublicBuckets=false
  aws s3api put-bucket-policy --bucket "$BUCKET" --policy "{
    \"Version\": \"2012-10-17\",
    \"Statement\": [{\"Sid\":\"PublicRead\",\"Effect\":\"Allow\",\"Principal\":\"*\",\"Action\":\"s3:GetObject\",\"Resource\":\"arn:aws:s3:::$BUCKET/*\"}]
  }"
  echo "$BUCKET" > .qb_bucket
fi

echo ">> Uploading site"
aws s3 cp index.html "s3://$BUCKET/index.html" --content-type "text/html; charset=utf-8"

echo ""
echo "============================================================"
echo "LIVE: http://$BUCKET.s3-website.$REGION.amazonaws.com"
echo ""
echo "Anyone can sign up with email + password; each user's data is"
echo "isolated and syncs across their devices."
echo "Assistant: $( [ -n "$GKEY" ] && echo "ENABLED (30 AI calls/user/day)" || echo "disabled (redeploy with a key to enable)" )"
echo "Re-deploy after changes: bash deploy-cloud.sh"
echo "============================================================"
