#!/usr/bin/env bash
# Build script: produces dist/wood-fired-bugs-client.zip
#
# The zip contains:
#   wood-fired-bugs-client/
#     README.md
#     setup.bat
#     setup.ps1
#     setup.sh
#     commands/tasks/*.md          (10 skill files)
#     mcp-server/
#       dist/mcp/remote/*.js       (remote MCP server)
#       dist/mcp/resources/*.js    (events resource)
#       dist/mcp/errors.js         (error conversion)
#       dist/cli/                  (CLI compiled JS)
#       dist/schemas/*.js          (Zod schemas)
#       node_modules/              (runtime dependencies)
#       package.json

set -e

# Resolve project root (one level above scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

echo ""
echo "Wood Fired Bugs - Build Client Package"
echo "======================================="
echo "Project root: $PROJECT_ROOT"
echo ""

# ── 1. Build TypeScript ───────────────────────────────────────────────────────
echo "Building TypeScript..."
cd "$PROJECT_ROOT"
npm run build
echo "OK: TypeScript build complete"

# ── 2. Verify required files exist ───────────────────────────────────────────
echo ""
echo "Verifying build artifacts..."

required_files=(
    "dist/mcp/remote/index.js"
    "dist/mcp/resources/events.js"
    "dist/mcp/errors.js"
    "dist/schemas/task.schema.js"
    "node_modules/@modelcontextprotocol/sdk"
    "node_modules/zod"
    "client-package/setup.bat"
    "client-package/setup.ps1"
    "client-package/setup.sh"
    "client-package/README.md"
    "dist/cli/bin/tasks-client.js"
)

for f in "${required_files[@]}"; do
    if [[ ! -e "$PROJECT_ROOT/$f" ]]; then
        echo "ERROR: Required file/dir not found: $f"
        exit 1
    fi
    echo "  OK: $f"
done

# ── 3. Create staging directory ───────────────────────────────────────────────
echo ""
echo "Creating staging directory..."

STAGING_DIR=$(mktemp -d)
PACKAGE_DIR="$STAGING_DIR/wood-fired-bugs-client"
MCP_SERVER_DIR="$PACKAGE_DIR/mcp-server"

mkdir -p "$PACKAGE_DIR/commands/tasks"
mkdir -p "$MCP_SERVER_DIR/dist/mcp/remote"
mkdir -p "$MCP_SERVER_DIR/dist/mcp/resources"
mkdir -p "$MCP_SERVER_DIR/dist/schemas"
mkdir -p "$MCP_SERVER_DIR/node_modules"

echo "Staging to: $STAGING_DIR"

# ── 4. Copy files into staging ────────────────────────────────────────────────
echo ""
echo "Copying files..."

# Top-level package files
cp "$PROJECT_ROOT/client-package/README.md"  "$PACKAGE_DIR/"
cp "$PROJECT_ROOT/client-package/setup.bat"  "$PACKAGE_DIR/"
cp "$PROJECT_ROOT/client-package/setup.ps1"  "$PACKAGE_DIR/"
cp "$PROJECT_ROOT/client-package/setup.sh"   "$PACKAGE_DIR/"
chmod +x "$PACKAGE_DIR/setup.sh"

# Skills
cp "$PROJECT_ROOT/client-package/commands/tasks/"*.md  "$PACKAGE_DIR/commands/tasks/"

# MCP server compiled JS
cp "$PROJECT_ROOT/dist/mcp/remote/"*.js        "$MCP_SERVER_DIR/dist/mcp/remote/" 2>/dev/null || true
# Also copy .js.map files if present
cp "$PROJECT_ROOT/dist/mcp/remote/"*.js.map    "$MCP_SERVER_DIR/dist/mcp/remote/" 2>/dev/null || true

# Events resource
cp "$PROJECT_ROOT/dist/mcp/resources/"*.js     "$MCP_SERVER_DIR/dist/mcp/resources/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/mcp/resources/"*.js.map "$MCP_SERVER_DIR/dist/mcp/resources/" 2>/dev/null || true

# Errors module
cp "$PROJECT_ROOT/dist/mcp/errors.js"          "$MCP_SERVER_DIR/dist/mcp/"
cp "$PROJECT_ROOT/dist/mcp/errors.js.map"      "$MCP_SERVER_DIR/dist/mcp/" 2>/dev/null || true

# Schemas
cp "$PROJECT_ROOT/dist/schemas/"*.js           "$MCP_SERVER_DIR/dist/schemas/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/schemas/"*.js.map       "$MCP_SERVER_DIR/dist/schemas/" 2>/dev/null || true

# Also need the types module (task types used by schemas)
if [[ -d "$PROJECT_ROOT/dist/types" ]]; then
    mkdir -p "$MCP_SERVER_DIR/dist/types"
    cp "$PROJECT_ROOT/dist/types/"*.js         "$MCP_SERVER_DIR/dist/types/" 2>/dev/null || true
    cp "$PROJECT_ROOT/dist/types/"*.js.map     "$MCP_SERVER_DIR/dist/types/" 2>/dev/null || true
fi

# CLI compiled JS (client-safe commands only, no better-sqlite3 deps)
echo "  Copying CLI (client commands only)..."
mkdir -p "$MCP_SERVER_DIR/dist/cli/bin"
mkdir -p "$MCP_SERVER_DIR/dist/cli/commands"
mkdir -p "$MCP_SERVER_DIR/dist/cli/api"
mkdir -p "$MCP_SERVER_DIR/dist/cli/config"
mkdir -p "$MCP_SERVER_DIR/dist/cli/output"
mkdir -p "$MCP_SERVER_DIR/dist/cli/prompts"

# Client entry point
cp "$PROJECT_ROOT/dist/cli/bin/tasks-client.js"     "$MCP_SERVER_DIR/dist/cli/bin/"
cp "$PROJECT_ROOT/dist/cli/bin/tasks-client.js.map"  "$MCP_SERVER_DIR/dist/cli/bin/" 2>/dev/null || true

# All commands EXCEPT server-only ones (backup, doctor, stats, db-check)
for f in "$PROJECT_ROOT/dist/cli/commands/"*.js; do
    basename=$(basename "$f")
    case "$basename" in
        backup.js|doctor.js|stats.js|db-check.js) continue ;;
        *) cp "$f" "$MCP_SERVER_DIR/dist/cli/commands/" ;;
    esac
done
# Also copy .js.map for the included commands
for f in "$PROJECT_ROOT/dist/cli/commands/"*.js.map; do
    basename=$(basename "$f" .js.map)
    case "$basename" in
        backup|doctor|stats|db-check) continue ;;
        *) cp "$f" "$MCP_SERVER_DIR/dist/cli/commands/" 2>/dev/null || true ;;
    esac
done

# API client, config, output, prompts (all safe for remote use)
cp "$PROJECT_ROOT/dist/cli/api/"*.js      "$MCP_SERVER_DIR/dist/cli/api/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/api/"*.js.map  "$MCP_SERVER_DIR/dist/cli/api/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/config/"*.js     "$MCP_SERVER_DIR/dist/cli/config/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/config/"*.js.map "$MCP_SERVER_DIR/dist/cli/config/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/output/"*.js     "$MCP_SERVER_DIR/dist/cli/output/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/output/"*.js.map "$MCP_SERVER_DIR/dist/cli/output/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/prompts/"*.js     "$MCP_SERVER_DIR/dist/cli/prompts/" 2>/dev/null || true
cp "$PROJECT_ROOT/dist/cli/prompts/"*.js.map "$MCP_SERVER_DIR/dist/cli/prompts/" 2>/dev/null || true

# Create a minimal package.json for the MCP server
# Includes runtime dependencies for both MCP server and CLI
MCP_PKG_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/@modelcontextprotocol/sdk/package.json'); console.log(p.version)")
ZOD_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/zod/package.json'); console.log(p.version)")
CHALK_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/chalk/package.json'); console.log(p.version)")
CLITABLE_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/cli-table3/package.json'); console.log(p.version)")
COMMANDER_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/commander/package.json'); console.log(p.version)")
DOTENV_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/dotenv/package.json'); console.log(p.version)")
CLACK_VERSION=$(node -e "const p=require('$PROJECT_ROOT/node_modules/@clack/prompts/package.json'); console.log(p.version)")

cat > "$MCP_SERVER_DIR/package.json" <<PKGJSON
{
  "name": "wood-fired-bugs-client",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "@modelcontextprotocol/sdk": "$MCP_PKG_VERSION",
    "zod": "$ZOD_VERSION",
    "@clack/prompts": "$CLACK_VERSION",
    "chalk": "$CHALK_VERSION",
    "cli-table3": "$CLITABLE_VERSION",
    "commander": "$COMMANDER_VERSION",
    "dotenv": "$DOTENV_VERSION"
  }
}
PKGJSON

# Install dependencies in the mcp-server staging dir
echo "  Installing runtime dependencies (npm install)..."
(cd "$MCP_SERVER_DIR" && npm install --no-fund --no-audit 2>&1 | tail -3)

echo "OK: All files copied"

# ── 5. Create output directory ────────────────────────────────────────────────
mkdir -p "$PROJECT_ROOT/dist"
OUTPUT_ZIP="$PROJECT_ROOT/dist/wood-fired-bugs-client.zip"

# Remove previous build if exists
rm -f "$OUTPUT_ZIP"

# ── 6. Create zip ─────────────────────────────────────────────────────────────
echo ""
echo "Creating zip archive..."

if ! command -v zip &>/dev/null; then
    echo "ERROR: 'zip' command not found. Install it with: sudo apt-get install zip"
    rm -rf "$STAGING_DIR"
    exit 1
fi

(cd "$STAGING_DIR" && zip -r "$OUTPUT_ZIP" "wood-fired-bugs-client/" -x "*.DS_Store" -x "__pycache__/*" -x "*.pyc")

# ── 7. Cleanup and report ─────────────────────────────────────────────────────
rm -rf "$STAGING_DIR"

echo ""
if [[ ! -f "$OUTPUT_ZIP" ]]; then
    echo "ERROR: Zip file was not created!"
    exit 1
fi

ZIP_SIZE=$(du -h "$OUTPUT_ZIP" | cut -f1)
echo "SUCCESS: Package created"
echo ""
echo "  Path: $OUTPUT_ZIP"
echo "  Size: $ZIP_SIZE"
echo ""
echo "Contents preview:"
unzip -l "$OUTPUT_ZIP" | head -30
echo ""
echo "Distribute this zip to any developer on the LAN."
echo "They run setup.ps1 (Windows) or setup.sh (Linux/Mac) to configure Claude Code."
