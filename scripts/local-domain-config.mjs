import path from 'node:path';

const quote = value => `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('$', '\\$')}"`;

export function localDomainConfig({ runtimeDir, upstreamPort = 4318, httpPort = 80, httpsPort = 443, workerUser = '' }) {
  if (!path.isAbsolute(runtimeDir) || /[\r\n]/.test(runtimeDir)) throw new Error('Runtime directory must be an absolute path.');
  if (workerUser && !/^[a-z_][a-z0-9_-]*$/i.test(workerUser)) throw new Error('Invalid worker user.');
  for (const port of [upstreamPort, httpPort, httpsPort]) if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port.');
  const tlsAuthority = `ningmeng.com${httpsPort === 443 ? '' : `:${httpsPort}`}`;
  const httpAuthority = `ningmeng.com${httpPort === 80 ? '' : `:${httpPort}`}`;
  const upstream = `http://127.0.0.1:${upstreamPort}`;
  const file = name => quote(path.join(runtimeDir, name));
  return `# Local-only Ningmeng gateway; the existing application remains on ${upstream}.
${workerUser ? `user ${workerUser};` : ''}
worker_processes 1;
pid ${file('nginx.pid')};
error_log ${file('error.log')} warn;
events { worker_connections 512; }
http {
    access_log off;
    server_tokens off;
    client_max_body_size 16m;
    client_body_temp_path ${file('client_temp')};
    proxy_temp_path ${file('proxy_temp')};
    map $http_origin $ningmeng_origin_ok {
        default 0;
        "" 1;
        "https://${tlsAuthority}" 1;
    }
    map $http_origin $ningmeng_upstream_origin {
        default "";
        "https://${tlsAuthority}" "${upstream}";
    }
    map $http_host $ningmeng_http_host_ok {
        default 0;
        "${httpAuthority}" 1;
        ${httpPort === 80 ? '"ningmeng.com:80" 1;' : ''}
    }
    map $http_host $ningmeng_tls_host_ok {
        default 0;
        "${tlsAuthority}" 1;
        ${httpsPort === 443 ? '"ningmeng.com:443" 1;' : ''}
    }
    server {
        listen 127.0.0.1:${httpPort} default_server;
        server_name ningmeng.com;
        if ($ningmeng_http_host_ok = 0) { return 403; }
        return 308 https://${tlsAuthority}$request_uri;
    }
    server {
        listen 127.0.0.1:${httpsPort} ssl default_server;
        server_name ningmeng.com;
        ssl_certificate ${file('ningmeng.pem')};
        ssl_certificate_key ${file('ningmeng-key.pem')};
        ssl_protocols TLSv1.2 TLSv1.3;
        if ($ningmeng_tls_host_ok = 0) { return 403; }
        if ($ningmeng_origin_ok = 0) { return 403; }
        if ($http_sec_fetch_site = cross-site) { return 403; }
        location / {
            proxy_pass ${upstream};
            proxy_http_version 1.1;
            proxy_set_header Host "127.0.0.1:${upstreamPort}";
            # Only the exact allowed browser origin is translated. The app still
            # enforces its session, CSRF token and Origin on every mutation.
            proxy_set_header Origin $ningmeng_upstream_origin;
            proxy_set_header Connection "";
            proxy_set_header X-Forwarded-Host "";
            proxy_set_header X-Forwarded-Proto "";
            proxy_cookie_flags codex_desk secure httponly samesite=strict;
            proxy_buffering off;
            proxy_request_buffering off;
            proxy_cache off;
            proxy_next_upstream off;
            proxy_read_timeout 3100s;
            proxy_send_timeout 3100s;
            proxy_redirect off;
        }
    }
}
`;
}
