package com.tippye.zeromail;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.IOException;
import java.net.HttpURLConnection;
import java.net.URL;

final class ServerRequest {
    private ServerRequest() {}
    static byte[] get(String url, String cookie, long limit) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setInstanceFollowRedirects(false);
        connection.setConnectTimeout(15000);
        connection.setReadTimeout(15000);
        connection.setUseCaches(false);
        if (cookie != null) connection.setRequestProperty("Cookie", cookie);
        connection.setRequestProperty("User-Agent", "ZeroMailAndroid/1.0.0");
        try {
            if (connection.getResponseCode() != 200 || connection.getContentLengthLong() > limit)
                throw new IOException("Server request failed");
            try (InputStream input = connection.getInputStream(); ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[16384]; int count;
                while ((count = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted() || output.size() + (long) count > limit) throw new IOException("Response limit exceeded");
                    output.write(buffer, 0, count);
                }
                return output.toByteArray();
            }
        } finally { connection.disconnect(); }
    }
}
