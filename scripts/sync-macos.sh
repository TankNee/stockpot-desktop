#!/usr/bin/env bash
#
# 把 GitHub release 里的 macOS 包拿下来，再传到自建服务器。
#
#   DEPLOY_TOKEN=xxx ./scripts/sync-macos.sh 1.0.8
#
# 为什么不让服务器自己去 GitHub 拉：那台机器到 objects.githubusercontent.com
# 慢到 15MB 能卡五分钟；本机下下来再传，一秒就到。
set -euo pipefail

VERSION="${1:?用法: ./scripts/sync-macos.sh <版本号，不带 v>}"
REPO="TankNee/stockpot-desktop"
BASE="${DEPLOY_BASE:-https://api.stockpot.neeto.cn}"
TOKEN="${DEPLOY_TOKEN:?需要 DEPLOY_TOKEN（服务端 .env 里那个）}"
TAG="v${VERSION}"

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "==> 从 $REPO 下 $TAG 的 macOS 包"
gh release download "$TAG" --repo "$REPO" --dir "$work" \
  --pattern "Stockpot.app.tar.gz" \
  --pattern "Stockpot.app.tar.gz.sig" \
  --pattern "*.dmg" \
  --clobber

app="$work/Stockpot.app.tar.gz"
sig="${app}.sig"
dmg=$(ls "$work"/*.dmg | head -1)
[ -f "$app" ] || { echo "没下到 app.tar.gz"; exit 1; }
[ -f "$sig" ] || { echo "没下到签名，自动更新会失败"; exit 1; }

notes=$(gh release view "$TAG" --repo "$REPO" --json body --jq '.body' | base64 | tr -d '\n')

push() {
  local file="$1" packaging="$2"
  shift 2
  echo "==> 上传 $(basename "$file") ($(du -h "$file" | cut -f1)) → $packaging"
  curl -sS --fail-with-body -X POST \
    "$BASE/api/v1/deploy/macos?version=${VERSION}&arch=universal&packaging=${packaging}" \
    -H "authorization: Bearer ${TOKEN}" \
    -H "x-notes-b64: ${notes}" \
    "$@" \
    --data-binary @"$file"
  echo
}

# 自动更新认的是 .app.tar.gz + 签名；dmg 是给人手动装的
push "$app" app -H "x-signature-b64: $(base64 < "$sig" | tr -d '\n')"
push "$dmg" dmg

echo "==> 完事。看点：$BASE/api/v1/app/updates/darwin-aarch64/aarch64/<旧版本>"
