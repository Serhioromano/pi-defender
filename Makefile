.PHONY: publish test

# Publish a new version to npm + create a GitHub release.
#   1. Checks gh CLI is installed and authenticated, npm login if needed.
#   2. Commits any uncommitted changes (if any).
#   3. Pushes local commits to GitHub (if behind/ahead).
#   4. Bumps version in package.json and creates a git commit + tag (npm version).
#   5. Pushes the commit and tag to GitHub.
#   6. Publishes the package to npm registry (npm publish).
#   7. Extracts release notes from CHANGELOG.md and creates a GitHub release via gh.
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
	@command -v gh >/dev/null 2>&1 || { \
		echo "❌ GitHub CLI (gh) not found. Install: https://cli.github.com/"; \
		exit 1; \
	}
	@gh auth status >/dev/null 2>&1 || { \
		echo "❌ Not logged in to GitHub. Run: gh auth login"; \
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
	@echo "📦 Published to npm"
	@tag=$$(git describe --tags --abbrev=0); \
		notes_file=$$(mktemp); \
		awk -v ver="## [$$tag]" 'found && /^## \[/{exit} found{print} /^## \[/ && $$0 == ver{found=1}' CHANGELOG.md > "$$notes_file"; \
		if [ ! -s "$$notes_file" ]; then \
			echo "⚠️  No release notes found in CHANGELOG.md for $$tag, using auto-generated notes"; \
			gh release create "$$tag" --title "$$tag" --generate-notes; \
		else \
			echo "📝 Release notes extracted ($$(wc -l < "$$notes_file") lines)"; \
			gh release create "$$tag" --title "$$tag" --notes-file "$$notes_file"; \
		fi; \
		rm -f "$$notes_file"; \
		echo "🎉 GitHub release created: $$tag"
	@echo "🎉 Published! All done."

test:
	@echo "Running tests..."
	cd /tmp && pi -e ~/www/pi-defender/src/index.ts --no-extensions