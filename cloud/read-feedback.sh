#!/usr/bin/env bash
# Dump user feedback collected by the in-app feedback page (newest last).
# Run: bash cloud/read-feedback.sh
set -euo pipefail
REGION="${QB_REGION:-ap-south-1}"
aws dynamodb scan --table-name questboard-state --region "$REGION" \
  --filter-expression "begins_with(pk, :p)" \
  --expression-attribute-values '{":p":{"S":"fb#"}}' \
  --query "sort_by(Items, &at.S)[].{when:at.S, from:email.S, feedback:text.S}" \
  --output table
