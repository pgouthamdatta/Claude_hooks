# Add this to a specific repo's own local pre-commit hook (e.g. append to
# .husky/pre-commit) ONLY IF that repo manages its own git core.hooksPath (Husky does
# this automatically on `npm install`) — in that case the global hook this kit installs
# gets silently overridden by that repo's local config, so the branch-name check needs
# to run from inside that repo's own hook instead. See the kit's README "Limitations"
# section for why this can't be automated away.
#
# Steps for that repo:
#   1. Copy scripts/check-branch-name.sh from this kit into that repo (e.g. into its own
#      scripts/ directory).
#   2. Add this line to .husky/pre-commit (or wherever that repo's local hook lives):

sh scripts/check-branch-name.sh
