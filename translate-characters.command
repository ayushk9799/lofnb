#!/bin/zsh
# Double-click to translate all companion profiles and save them to the database.
[ -f ~/.zprofile ] && source ~/.zprofile 2>/dev/null
[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null
cd "$(dirname "$0")"
echo "Running in $(pwd) with node $(node -v 2>&1)"
npm run characters:translate 2>&1 | tee translate-characters.log
echo "--- finished (exit ${pipestatus[1]}) ---" | tee -a translate-characters.log
