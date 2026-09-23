#!/bin/sh
# Run with macOS administrator privileges after preparing .local/domain-staging.
set -eu
[ "$(/usr/bin/id -u)" = 0 ] || { echo '需要 macOS 管理员权限。' >&2; exit 1; }
project_dir=$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")/.." && pwd)
stage="$project_dir/.local/domain-staging"
runtime='/Library/Application Support/Ningmeng/Domain'
agent='/Library/LaunchDaemons/com.local.ningmeng-domain.plist'
for name in nginx.conf ningmeng.pem ningmeng-key.pem com.local.ningmeng-domain.plist; do
    [ -f "$stage/$name" ] || { echo "缺少安装文件：$name" >&2; exit 1; }
done
/usr/bin/plutil -lint "$stage/com.local.ningmeng-domain.plist"
/usr/local/bin/openssl x509 -in "$stage/ningmeng.pem" -noout -checkhost ningmeng.com
/usr/bin/awk '
  /^[[:space:]]*#/ { next }
  { for (i=2; i<=NF; i++) {
      if ($i ~ /^#/) break;
      if ($i == "ningmeng.com" && $1 != "127.0.0.1") bad=1;
    }
  }
  END { exit bad ? 1 : 0 }
' /etc/hosts || { echo 'ningmeng.com 已有其他本机映射，未修改。' >&2; exit 1; }

# The root master binds the two loopback ports; request workers run as nobody.
/usr/bin/install -d -o root -g wheel -m 755 "$runtime"
/usr/bin/install -d -o nobody -g nobody -m 700 "$runtime/client_temp" "$runtime/proxy_temp"
/usr/bin/install -o root -g wheel -m 644 "$stage/nginx.conf" "$runtime/nginx.conf"
/usr/bin/install -o root -g wheel -m 644 "$stage/ningmeng.pem" "$runtime/ningmeng.pem"
/usr/bin/install -o root -g wheel -m 600 "$stage/ningmeng-key.pem" "$runtime/ningmeng-key.pem"
/usr/local/bin/nginx -e "$runtime/error.log" -p "$runtime/" -c "$runtime/nginx.conf" -t

# Certificate trust is installed separately as the logged-in user. macOS does
# not allow an administrator shell to present the user's Keychain dialog.
if ! /usr/bin/awk '/^[[:space:]]*#/ {next} {for(i=2;i<=NF;i++){if($i~/^#/)break;if($i=="ningmeng.com" && $1=="127.0.0.1")found=1}} END {exit found?0:1}' /etc/hosts; then
    /usr/bin/printf '\n# Ningmeng local workspace\n127.0.0.1 ningmeng.com\n' >> /etc/hosts
fi
/usr/bin/install -o root -g wheel -m 644 "$stage/com.local.ningmeng-domain.plist" "$agent"
if /bin/launchctl print system/com.local.ningmeng-domain >/dev/null 2>&1; then
    /bin/launchctl kickstart -k system/com.local.ningmeng-domain
else
    /bin/launchctl bootstrap system "$agent"
fi
/usr/bin/dscacheutil -flushcache
/usr/bin/killall -HUP mDNSResponder || true
echo 'ningmeng.com 本机 HTTPS 入口已安装。'
