#!/bin/bash
# deploy.sh — run this ON THE DROPLET, from inside the highmark-automation
# directory, to pull the latest code, rebuild the image, and restart the
# container. Plain docker build/run — no docker-compose involved.
#
# First-time setup (once): clone the repo via the deploy key, then manually
# scp .env and spoton-housing.json into this directory — this script does
# NOT touch those, on purpose, since they're not in git.
#
# Usage:
#   ./deploy.sh

set -e  # stop immediately if any command fails

IMAGE_NAME="highmark-automation"
CONTAINER_NAME="highmark-worker"

echo "==> Pulling latest code..."
git pull origin main

echo "==> Checking required files are present..."
if [ ! -f .env ]; then
    echo "ERROR: .env not found. This must be scp'd in manually, it's not in git."
    exit 1
fi
if [ ! -f spoton-housing.json ]; then
    echo "ERROR: spoton-housing.json not found. This must be scp'd in manually, it's not in git."
    exit 1
fi

echo "==> Building image..."
docker build -t "$IMAGE_NAME" .

echo "==> Stopping and removing old container (if it exists)..."
# "|| true" on each: if the container doesn't exist yet (first-ever deploy),
# stop/rm would fail and, combined with `set -e` above, kill the script here.
# These two steps are allowed to fail harmlessly; everything after is not.
docker stop "$CONTAINER_NAME" 2>/dev/null || true
docker rm "$CONTAINER_NAME" 2>/dev/null || true

echo "==> Starting new container..."
docker run -d \
    --name "$CONTAINER_NAME" \
    --restart unless-stopped \
    --env-file .env \
    -v "$(pwd)/spoton-housing.json:/app/spoton-housing.json:ro" \
    --memory="512m" \
    "$IMAGE_NAME"

echo "==> Done. Tailing logs (Ctrl+C to stop watching — container keeps running)..."
docker logs -f --tail=50 "$CONTAINER_NAME"