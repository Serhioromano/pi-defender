.PHONY: publish test

# Publish a new version to npm.
#   1. Checks if logged in to npm (npm whoami), runs npm login if not.
#   2. Commits any uncommitted changes (if any).
#   3. Pushes local commits to GitHub (if behind/ahead).
#   4. Bumps version in package.json and creates a git commit + tag (npm version).
#   5. Pushes the commit and tag to GitHub.
#   6. Publishes the package to npm registry (npm publish).
#
# Usage: make publish v=<version>
#   make publish v=patch   — 1.0.1 → 1.0.2
#   make publish v=minor   — 1.0.1 → 1.1.0
#   make publish v=major   — 1.0.1 → 2.0.0
#   make publish v=1.5.0   — explicit version
publish:
	@test -n "$(v)" || { \
		echo "❌ Usage: make publish v=<version>"; echo "   Example: make publish v=patch"; \
		exit 1; \
	}
	@npm whoami >/dev/null 2>&1 || { \
		echo "🔑 Not logged in to npm. Running npm login..."; \
		npm login; \
	}
	@if ! git diff --quiet --exit-code || ! git diff --cached --quiet --exit-code; then \
		echo "📦 Uncommitted changes found. Committing..."; \
		git add -A; \
		git commit -m "Prepare for new version $(v)"; \
	fi
	@git pull --rebase origin master
	@git push origin master
	@newver=$$(npm version $(v) 2>&1 | tail -1); \
		echo "🏷️  Version bumped: $$newver"
	git push origin master --follow-tags
	@echo "🚀 Pushed to GitHub"
	npm publish
	@echo "🎉 Published! All done."

test:
	@echo "Running tests..."
	cd /tmp && pi -e ~/www/pi-defender/src/index.ts --no-extensions