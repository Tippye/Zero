package com.tippye.zeromail;

import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.io.UnsupportedEncodingException;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

/** Kept independent of Android so all entry points share the same tested URL rules. */
public final class UrlPolicy {
    private static final Set<String> FIELDS = Set.of("to", "cc", "bcc", "subject", "body");
    private UrlPolicy() {}

    public static String server(String raw, boolean allowHttp) {
        try {
            URI uri = new URI(raw.trim()).parseServerAuthority();
            String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
            if (!(scheme.equals("https") || (scheme.equals("http") && allowHttp))
                    || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null
                    || !(uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))
                    || uri.getPort() == 0 || uri.getPort() > 65535) throw new IllegalArgumentException();
            int port = uri.getPort();
            String suffix = port == -1 || (scheme.equals("https") && port == 443)
                    || (scheme.equals("http") && port == 80) ? "" : ":" + port;
            return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + suffix;
        } catch (Exception e) {
            throw new IllegalArgumentException("Invalid server origin");
        }
    }

    public static boolean sameOrigin(String origin, String raw) {
        try {
            URI uri = new URI(raw).parseServerAuthority();
            if (uri.getRawUserInfo() != null || uri.getHost() == null) return false;
            return origin.equals(server(uri.getScheme() + "://" + uri.getRawAuthority(), true));
        } catch (Exception e) { return false; }
    }

    public static String linkPath(String raw) {
        if (raw == null || raw.length() > 32000) throw new IllegalArgumentException("Invalid link");
        if (raw.equalsIgnoreCase("mailto:")) return "/mail/compose?";
        try {
            URI uri = new URI(raw);
            if (uri.getRawFragment() != null || uri.getRawUserInfo() != null) throw new IllegalArgumentException();
            Map<String, String> fields = new LinkedHashMap<>();
            String query;
            if ("mailto".equalsIgnoreCase(uri.getScheme())) {
                String rest = uri.getRawSchemeSpecificPart();
                if (rest.startsWith("//")) throw new IllegalArgumentException();
                int separator = rest.indexOf('?');
                String to = separator < 0 ? rest : rest.substring(0, separator);
                if (!to.isEmpty()) fields.put("to", decode(to));
                query = separator < 0 ? "" : rest.substring(separator + 1);
            } else if ("zeromail".equalsIgnoreCase(uri.getScheme()) && uri.getPort() == -1
                    && (uri.getRawPath().isEmpty() || uri.getRawPath().equals("/"))) {
                if ("inbox".equalsIgnoreCase(uri.getHost()) && uri.getRawQuery() == null) return "/mail/inbox";
                if (!"compose".equalsIgnoreCase(uri.getHost())) throw new IllegalArgumentException();
                query = uri.getRawQuery() == null ? "" : uri.getRawQuery();
            } else throw new IllegalArgumentException();
            for (String part : query.split("&")) {
                if (part.isEmpty()) continue;
                int separator = part.indexOf('=');
                String key = decode(separator < 0 ? part : part.substring(0, separator)).toLowerCase(Locale.ROOT);
                if (!FIELDS.contains(key)) continue;
                String value = decode(separator < 0 ? "" : part.substring(separator + 1));
                fields.put(key, key.equals("to") && fields.containsKey(key) ? fields.get(key) + "," + value : value);
            }
            return composePath(fields);
        } catch (Exception e) { throw new IllegalArgumentException("Invalid mail link"); }
    }

    public static String composePath(Map<String, String> fields) {
        StringBuilder query = new StringBuilder();
        for (Map.Entry<String, String> entry : fields.entrySet()) {
            String key = entry.getKey(), value = entry.getValue();
            if (!FIELDS.contains(key) || value == null) continue;
            if (value.indexOf('\0') >= 0 || (!key.equals("body") && (value.contains("\r") || value.contains("\n"))))
                throw new IllegalArgumentException("Invalid compose field");
            if (query.length() > 0) query.append('&');
            query.append(key).append('=').append(encode(value));
        }
        if (query.length() > 96000) throw new IllegalArgumentException("Compose link too long");
        return "/mail/compose?" + query;
    }

    public static String notificationPath(String threadId) {
        if (threadId == null || !threadId.startsWith("mbx.") || threadId.length() > 4000)
            throw new IllegalArgumentException("Invalid thread");
        return "/mail/inbox?threadId=" + encode(threadId);
    }

    public static String filename(String raw) {
        String name = raw == null ? "" : raw.replaceAll("[\\x00-\\x1f\\x7f/\\\\]", "_").trim();
        if (name.isEmpty() || name.equals(".") || name.equals("..")) return "attachment";
        return name.substring(0, Math.min(180, name.length()));
    }

    private static String decode(String raw) {
        // mailto is a URI, not an HTML form. A literal plus must survive exactly once.
        try { return URLDecoder.decode(raw.replace("+", "%2B"), "UTF-8"); }
        catch (UnsupportedEncodingException e) { throw new IllegalStateException(e); }
    }
    private static String encode(String raw) {
        try { return URLEncoder.encode(raw, "UTF-8"); }
        catch (UnsupportedEncodingException e) { throw new IllegalStateException(e); }
    }
}
