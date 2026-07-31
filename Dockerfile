# Playwright's official image ships Node + Chromium + all required OS-level
# libraries already installed and version-matched to the `playwright` npm
# package below. Using this instead of a plain `node` image avoids a long
# tail of missing-shared-library errors when Chromium tries to launch.
# Tag version MUST match the "playwright" version in package.json.
FROM mcr.microsoft.com/playwright:v1.62.0-jammy

WORKDIR /app

# Copy ONLY the dependency manifests first, not the whole project. Docker
# caches each instruction as a layer; as long as package.json/package-lock.json
# haven't changed, `npm ci` below is skipped on rebuilds and reuses the cached
# layer — so editing src/*.ts later won't force a slow reinstall every time.
COPY package.json package-lock.json ./

# npm ci (not npm install) — installs EXACTLY what's in package-lock.json,
# no version drift, no accidental upgrades. Standard for reproducible builds.
RUN npm ci

# Now copy the rest of the project. This layer invalidates on every code
# change, but that's fine — it's cheap, and everything above it stays cached.
COPY . .

# Compiles TypeScript → dist/, per your existing "build" script in package.json.
RUN npm run build

# No CMD ["npm", "start"] here on purpose — see docker-compose / run command
# below. Keeping the image itself unopinionated about restart behavior.
CMD ["node", "dist/index.js"]