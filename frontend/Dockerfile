FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
# --include=optional forces npm to honor platform-specific optional deps
# (rollup's native binaries) even when an inherited package-lock.json
# pruned them out for a different arch. Works around the long-standing
# npm bug at https://github.com/npm/cli/issues/4828.
RUN npm install --include=optional

COPY . .

EXPOSE 5173
