#!/usr/bin/env bash
# SL-0 app tester (docs/app-tester/DESIGN.md): one-time setup of the local
# code-signing identity "Plyloft Test Dev" that build-app.sh uses to sign
# "Plyloft Test.app". With a stable signature the app's designated requirement
# names this certificate instead of the binary's hash, so the keychain's
# "Always Allow" (dev account, `com.mbadv.ply.account.dev`) and TCC grants
# survive rebuilds.
#
#   scripts/app-tester/make-signing-identity.sh
#
# Self-signed (RSA 2048, extendedKeyUsage codeSigning, 10 years), made with
# the system openssl in a private temp dir, imported into the login keychain
# with codesign allowed to use the key, then the temp files (private key
# included) are removed. Idempotent: does nothing if the certificate exists.
# It never changes trust settings and never touches other keychain items.
# Dev tooling only: never used for Plyloft releases.
set -euo pipefail

NAME="Plyloft Test Dev"
KEYCHAIN="$HOME/Library/Keychains/login.keychain-db"
OPENSSL=/usr/bin/openssl # LibreSSL: its PKCS#12 defaults are what `security import` reads
SIGN_TIMEOUT="${PLY_TEST_SIGN_TIMEOUT:-60}"

if security find-certificate -c "$NAME" "$KEYCHAIN" >/dev/null 2>&1; then
  echo "✓ \"$NAME\" is already in the login keychain; nothing to do."
  security find-identity -p codesigning "$KEYCHAIN" | grep -F "\"$NAME\"" || true
  exit 0
fi

test -f "$KEYCHAIN" || { echo "✗ no login keychain at $KEYCHAIN" >&2; exit 1; }

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/plyloft-test-sign.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

cat >"$TMP/req.cnf" <<EOF
[req]
distinguished_name = dn
prompt = no
x509_extensions = v3
[dn]
CN = $NAME
[v3]
basicConstraints = critical, CA:false
keyUsage = critical, digitalSignature
extendedKeyUsage = critical, codeSigning
subjectKeyIdentifier = hash
EOF

"$OPENSSL" req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
  -config "$TMP/req.cnf" -keyout "$TMP/key.pem" -out "$TMP/cert.pem"

# A throwaway passphrase: `security import` mishandles empty PKCS#12 passwords.
P12_PASS="$("$OPENSSL" rand -hex 16)"
export P12_PASS
"$OPENSSL" pkcs12 -export -name "$NAME" -inkey "$TMP/key.pem" -in "$TMP/cert.pem" \
  -out "$TMP/identity.p12" -passout env:P12_PASS

security import "$TMP/identity.p12" -k "$KEYCHAIN" -f pkcs12 \
  -P "$P12_PASS" -T /usr/bin/codesign >/dev/null
unset P12_PASS
rm -rf "$TMP"
echo "✓ imported \"$NAME\" into the login keychain (key usable by /usr/bin/codesign)"

# Self-test on a throwaway copy of /usr/bin/true. An untrusted self-signed
# certificate is enough for codesign (find-identity lists it as
# CSSMERR_TP_NOT_TRUSTED, like "Plyloft Test Helper (local)", which signs the
# helper the same way). If macOS asks "codesign wants to access key", answer
# "Always Allow" once. codesign waits forever on a prompt nobody can answer,
# so it is bounded.
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/plyloft-test-sign-check.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
cp /usr/bin/true "$TEST_DIR/sign-check"
codesign --force --sign "$NAME" --identifier com.mbadv.ply.test.signcheck "$TEST_DIR/sign-check" &
sign_pid=$!
waited=0
while kill -0 "$sign_pid" 2>/dev/null; do
  if [ "$waited" -ge "$SIGN_TIMEOUT" ]; then
    kill "$sign_pid" 2>/dev/null || true
    echo "✗ codesign did not finish in ${SIGN_TIMEOUT}s: the keychain is probably locked or" >&2
    echo "  waiting on a 'codesign wants to access key' prompt. Unlock the Mac and run" >&2
    echo "  scripts/app-tester/build-app.sh; answer 'Always Allow' when asked." >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
if ! wait "$sign_pid"; then
  cat >&2 <<EOF
✗ codesign could not sign with "$NAME".
  On this macOS an untrusted self-signed certificate may not be accepted for
  code signing. Trust it for code signing only (macOS asks for your password):

    security find-certificate -c "$NAME" -p "$KEYCHAIN" > /tmp/plyloft-test-dev.pem
    security add-trusted-cert -r trustRoot -p codeSign -k "$KEYCHAIN" /tmp/plyloft-test-dev.pem
    rm /tmp/plyloft-test-dev.pem

  then run this script again (it will skip the import and only report).
EOF
  exit 1
fi
echo "✓ codesign can sign with \"$NAME\""

cat <<EOF

Next steps
  1. Rebuild the test app:  CARGO_TARGET_DIR=~/ply-build/<lane> scripts/app-tester/build-app.sh
     It now signs "Plyloft Test.app" with "$NAME" and prints a designated
     requirement that names this certificate, the same on every rebuild.
  2. Launch it once and answer "Always Allow" to the keychain prompt for
     com.mbadv.ply.account.dev (and grant any TCC permission it asks for).
     Later rebuilds keep those answers.
  The certificate lives in Keychain Access → login → My Certificates
  ("$NAME"). Deleting it there undoes this setup.
EOF
