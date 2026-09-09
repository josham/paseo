#!/usr/bin/env bash
#
# Point an Edge Android build at the fork's own Firebase project and Expo project, so
# it can receive push notifications.
#
# Run this after `npm ci` and before `expo prebuild`: both values are read by
# packages/app/app.config.js and baked into the native project.
#
# Why two projects rather than one file. The daemon does not talk to a phone directly —
# packages/server/src/server/push/push-service.ts POSTs to Expo's push service, which
# then delivers over FCM. So a build needs both halves of that chain to be ours:
#
#   google-services.json  Firebase credentials for sh.paseo.edge. Without it the app
#                         cannot mint a device token at all, which is why a stock Edge
#                         build has no push.
#   Expo projectId        what getExpoPushTokenAsync mints against
#                         (packages/app/src/push-notifications/internal/subscriptions.ts).
#                         Expo delivers using the FCM service-account key uploaded to
#                         *that* project, so it has to be the Expo project holding a key
#                         for the Firebase project above. Upstream's id points at
#                         getpaseo's, whose credentials cannot deliver to our app.
#
# Half of this pairing is worse than none: with upstream's projectId and our Firebase
# file the app happily returns a push token and every notification is dropped, with
# nothing logged on either end. The caller passes both or neither.
#
# Usage:
#   scripts/edge/android-push-config.sh --google-services FILE --project-id ID \
#       [--owner NAME] [--slug SLUG]
#
# --owner and --slug are what upstream's config calls the app: together they name an Expo
# "experience". Point them at the same project the id belongs to, so nothing in the config
# describes a project that is not ours.
#
# The daemon needs no configuration and no credentials: it only forwards tokens the app
# gives it. Any Edge daemon can push to an Edge app built this way.

set -euo pipefail

APP_CONFIG="packages/app/app.config.js"
SECRETS_DIR="packages/app/.secrets"
APP_ID="sh.paseo.edge"
UPSTREAM_PROJECT_ID="0e7f65ce-0367-46c8-a238-2b65963d235a"
UPSTREAM_OWNER="getpaseo"
UPSTREAM_SLUG="voice-mobile"
google_services=""
project_id=""
owner=""
slug=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --google-services) google_services="$2"; shift 2 ;;
        --project-id) project_id="$2"; shift 2 ;;
        --owner) owner="$2"; shift 2 ;;
        --slug) slug="$2"; shift 2 ;;
        --app-id) APP_ID="$2"; shift 2 ;;
        -h|--help) sed -n '2,29p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown argument: $1" >&2; exit 2 ;;
    esac
done

[[ -n "$google_services" ]] || { echo "--google-services is required" >&2; exit 2; }
[[ -n "$project_id" ]] || { echo "--project-id is required" >&2; exit 2; }
[[ -f "$google_services" ]] || { echo "No such file: $google_services" >&2; exit 1; }
[[ -f "$APP_CONFIG" ]] || { echo "Run from the repo root: $APP_CONFIG is missing" >&2; exit 1; }

# The Gradle plugin fails later with "No matching client found for package name", but by
# then the run has spent half an hour compiling. Say it here instead.
node - "$google_services" "$APP_ID" <<'NODE'
const fs = require('node:fs');
const [file, appId] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(file, 'utf8'));
const packages = (config.client ?? []).map((c) => c?.client_info?.android_client_info?.package_name);
if (!packages.includes(appId)) {
  console.error(
    `${file} registers ${JSON.stringify(packages)}, not ${appId} — add an Android app with that package name to the Firebase project`,
  );
  process.exit(1);
}
NODE

mkdir -p "$SECRETS_DIR"
# app.config.js falls back to this path when GOOGLE_SERVICES_FILE_PROD is unset, so
# putting the file where it already looks needs no environment variable downstream.
cp "$google_services" "$SECRETS_DIR/google-services.prod.json"

grep -qF "projectId: \"$UPSTREAM_PROJECT_ID\"" "$APP_CONFIG" || {
    echo "Expected upstream's EAS projectId in $APP_CONFIG — it changed, check what it means for push" >&2
    exit 1
}
sed -i "s|projectId: \"$UPSTREAM_PROJECT_ID\"|projectId: \"$project_id\"|" "$APP_CONFIG"

if [[ -n "$slug" ]]; then
    grep -qF "slug: \"$UPSTREAM_SLUG\"" "$APP_CONFIG" || {
        echo "Expected slug: \"$UPSTREAM_SLUG\" in $APP_CONFIG" >&2
        exit 1
    }
    sed -i "s|slug: \"$UPSTREAM_SLUG\"|slug: \"$slug\"|" "$APP_CONFIG"
fi

if [[ -n "$owner" ]]; then
    grep -qF "owner: \"$UPSTREAM_OWNER\"" "$APP_CONFIG" || {
        echo "Expected owner: \"$UPSTREAM_OWNER\" in $APP_CONFIG" >&2
        exit 1
    }
    sed -i "s|owner: \"$UPSTREAM_OWNER\"|owner: \"$owner\"|" "$APP_CONFIG"
fi

echo "google-services -> $SECRETS_DIR/google-services.prod.json"
grep -n "slug:\|projectId:\|owner:" "$APP_CONFIG"
