#!/bin/sh
set -eu

ADMIN_URL="http://garage:3903"
ADMIN_TOKEN="streamtube-dev-admin-token"
AUTH_HEADER="Authorization: Bearer ${ADMIN_TOKEN}"

echo "Waiting for Garage admin API..."
attempt=0
until curl -sf -H "$AUTH_HEADER" "$ADMIN_URL/v2/GetClusterStatus" >/tmp/status.json 2>/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "Garage admin API did not become ready in time." >&2
    exit 1
  fi
  sleep 1
done

NODE_ID=$(jq -r '.nodes[0].id' /tmp/status.json)
LAYOUT_VERSION=$(jq -r '.layoutVersion' /tmp/status.json)
HAS_ROLE=$(jq -r '.nodes[0].role // empty' /tmp/status.json)

if [ -z "$HAS_ROLE" ]; then
  echo "Assigning cluster layout to node $NODE_ID..."
  curl -sf -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -X POST "$ADMIN_URL/v2/UpdateClusterLayout" \
    -d "{\"roles\":[{\"id\":\"$NODE_ID\",\"zone\":\"dc1\",\"capacity\":1000000000,\"tags\":[]}]}" >/dev/null

  NEW_VERSION=$((LAYOUT_VERSION + 1))
  curl -sf -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -X POST "$ADMIN_URL/v2/ApplyClusterLayout" \
    -d "{\"version\": $NEW_VERSION}" >/dev/null
else
  echo "Node already has a layout role, skipping layout assignment."
fi

echo "Ensuring access key $STORAGE_ACCESS_KEY_ID exists..."
if ! curl -sf -H "$AUTH_HEADER" "$ADMIN_URL/v2/GetKeyInfo?id=$STORAGE_ACCESS_KEY_ID" >/dev/null 2>&1; then
  curl -sf -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -X POST "$ADMIN_URL/v2/ImportKey" \
    -d "{\"accessKeyId\":\"$STORAGE_ACCESS_KEY_ID\",\"secretAccessKey\":\"$STORAGE_SECRET_ACCESS_KEY\",\"name\":\"streamtube-videos\"}" >/dev/null
else
  echo "Key already exists, skipping import."
fi

echo "Ensuring bucket $STORAGE_BUCKET exists..."
BUCKET_ID=$(curl -sf -H "$AUTH_HEADER" "$ADMIN_URL/v2/ListBuckets" | jq -r --arg alias "$STORAGE_BUCKET" '.[] | select(.globalAliases != null and (.globalAliases | index($alias)) != null) | .id')

if [ -z "$BUCKET_ID" ]; then
  BUCKET_ID=$(curl -sf -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    -X POST "$ADMIN_URL/v2/CreateBucket" \
    -d "{\"globalAlias\":\"$STORAGE_BUCKET\"}" | jq -r '.id')
  echo "Created bucket $STORAGE_BUCKET ($BUCKET_ID)."
else
  echo "Bucket already exists ($BUCKET_ID), skipping create."
fi

echo "Granting key $STORAGE_ACCESS_KEY_ID access to bucket $STORAGE_BUCKET..."
curl -sf -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  -X POST "$ADMIN_URL/v2/AllowBucketKey" \
  -d "{\"accessKeyId\":\"$STORAGE_ACCESS_KEY_ID\",\"bucketId\":\"$BUCKET_ID\",\"permissions\":{\"read\":true,\"write\":true,\"owner\":true}}" >/dev/null

echo "Garage bootstrap complete."
