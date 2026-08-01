#!/usr/bin/env bash
set -euo pipefail

: "${RUNNER_TEMP:?RUNNER_TEMP is required}"
: "${GITHUB_ENV:?GITHUB_ENV is required}"
: "${RELEASE_TAG_GPG_PRIVATE_KEY:?RELEASE_TAG_GPG_PRIVATE_KEY is required}"
: "${RELEASE_TAG_GPG_PASSPHRASE:?RELEASE_TAG_GPG_PASSPHRASE is required}"
: "${RELEASE_TAG_GPG_FINGERPRINT:?RELEASE_TAG_GPG_FINGERPRINT is required}"

if [[ ! "$RELEASE_TAG_GPG_FINGERPRINT" =~ ^[0-9A-F]{40}$ ]]; then
  echo "release tag GPG fingerprint must be 40 uppercase hexadecimal characters" >&2
  exit 1
fi

release_gnupg_home=$(mktemp -d "$RUNNER_TEMP/harmolyn-release-gnupg.XXXXXX")
release_gpg_wrapper=$(mktemp "$RUNNER_TEMP/harmolyn-release-gpg.XXXXXX")
release_gpg_passphrase="$release_gnupg_home/passphrase"
cleanup_failed_setup() {
  status=$?
  if (( status != 0 )); then
    rm -rf -- "$release_gnupg_home"
    rm -f -- "$release_gpg_wrapper"
  fi
  exit "$status"
}
trap cleanup_failed_setup EXIT

chmod 700 "$release_gnupg_home"
export GNUPGHOME="$release_gnupg_home"

printf '%s' "$RELEASE_TAG_GPG_PRIVATE_KEY" | gpg --batch --import >/dev/null
actual_fingerprint=$(gpg --batch --with-colons --list-secret-keys "$RELEASE_TAG_GPG_FINGERPRINT" \
  | awk -F: '$1 == "fpr" { print $10; exit }')
if [[ "$actual_fingerprint" != "$RELEASE_TAG_GPG_FINGERPRINT" ]]; then
  echo "imported release tag key does not match RELEASE_TAG_GPG_FINGERPRINT" >&2
  exit 1
fi

printf '%s' "$RELEASE_TAG_GPG_PASSPHRASE" > "$release_gpg_passphrase"
chmod 600 "$release_gpg_passphrase"
printf '%s\n' \
  '#!/usr/bin/env bash' \
  'exec gpg --batch --pinentry-mode loopback --passphrase-file "$GNUPGHOME/passphrase" "$@"' \
  > "$release_gpg_wrapper"
chmod 700 "$release_gpg_wrapper"

git config gpg.program "$release_gpg_wrapper"
git config user.signingkey "$RELEASE_TAG_GPG_FINGERPRINT"
printf 'GNUPGHOME=%s\n' "$GNUPGHOME" >> "$GITHUB_ENV"
printf 'HARMOLYN_RELEASE_GPG_PROGRAM=%s\n' "$release_gpg_wrapper" >> "$GITHUB_ENV"
trap - EXIT
