#!/usr/bin/env bash
set -euo pipefail
umask 077
(( EUID == 0 )) || { echo 'Run as root on the verified SubBoost host.' >&2; exit 1; }
src=$(cd "$(dirname "$0")" && pwd -P)
for tool in python3 docker gpg tar systemd-run systemctl curl; do command -v "$tool" >/dev/null; done
docker compose version
etc=/etc/subboost-fork
lib=/usr/local/lib/subboost-fork
state=/var/lib/subboost-fork
for d in "$lib" "$etc" "$state" "$state"/{incoming,receipts,backups}; do
  [[ ! -L $d && $(realpath -m "$d") == "$d" ]] || exit 1
  [[ ! -e $d || ( -d $d && $(stat -c %u "$d") == 0 ) ]] || exit 1
done
install -d -o root -g root -m 755 "$lib"
install -d -o root -g root -m 700 "$etc" "$state" "$state"/{incoming,receipts,backups}
if [[ ! -e $etc/backup.key ]]; then
  (set -C; head -c 64 /dev/urandom | base64 -w0 > "$etc/backup.key")
fi
[[ -f $etc/backup.key && ! -L $etc/backup.key && $(stat -c '%u:%a' "$etc/backup.key") == 0:600 ]]
for file in host.py production.py smoke.py fork-manager.sh; do
  install -m 644 "$src/$file" "$lib/$file.next"
  mv -T "$lib/$file.next" "$lib/$file"
done
install -m 755 "$src/deploy.sh" /usr/local/sbin/subboost-fork-deploy.next
mv -T /usr/local/sbin/subboost-fork-deploy.next /usr/local/sbin/subboost-fork-deploy
printf '%s\n' 'Installed the release receiver. Populate /etc/subboost-fork/host.json and run preflight.'
