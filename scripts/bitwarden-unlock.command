#!/bin/zsh
# Lets agent-tabs fill logins from your Bitwarden vault (browser_fill_login).
#
# Copy your Bitwarden master password to the clipboard, then run this. It takes the password from
# the clipboard (never displayed), logs the Bitwarden CLI in if needed (trying the US server, then
# the EU one; you type the two-step code if asked), unlocks the vault, keeps the session key in
# the macOS keychain (service "agent-tabs-bitwarden") and clears the clipboard.
# Run again whenever agents report Bitwarden is locked.
# To revoke: `bw lock` (or `bw logout`) and
#   security delete-generic-password -a agent-tabs -s agent-tabs-bitwarden
BW=$(command -v bw || echo /opt/homebrew/bin/bw)
EMAIL=${1:-}

finish() {
  pbcopy < /dev/null # don't leave the master password on the clipboard
  echo
  read -r "?$1 Press Enter to close."
  exit
}

bw_status() {
  $BW status | /usr/bin/python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])'
}

BW_MASTER_PASSWORD=$(pbpaste | tr -d '\r\n')
export BW_MASTER_PASSWORD
[[ -n $BW_MASTER_PASSWORD ]] || finish "The clipboard is empty: copy your master password first."

if [[ $(bw_status) == unauthenticated ]]; then
  [[ -n $EMAIL ]] || read -r "EMAIL?Bitwarden email: "
  for server in https://vault.bitwarden.com https://vault.bitwarden.eu; do
    $BW config server $server > /dev/null
    echo "Logging in to Bitwarden ($server) as $EMAIL. Type your two-step code if asked."
    # No output redirect: bw only shows its two-step prompt when writing to a terminal.
    if $BW login "$EMAIL" --passwordenv BW_MASTER_PASSWORD; then
      break
    fi
    echo "That didn't work on $server."
  done
  [[ $(bw_status) != unauthenticated ]] || finish "Login failed on both servers (check the password on the clipboard)."
fi

session=$($BW unlock --passwordenv BW_MASTER_PASSWORD --raw)
unset BW_MASTER_PASSWORD
[[ -n $session ]] || finish "Unlock failed."
/usr/bin/security add-generic-password -U -a agent-tabs -s agent-tabs-bitwarden -w "$session" || finish "Couldn't save the key to the keychain."
$BW sync --session "$session" > /dev/null
unset session
finish "Done: agents can now fill logins from Bitwarden. (The clipboard has been cleared.)"
