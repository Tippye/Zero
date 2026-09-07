package com.tippye.zeromail;

import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;

/** Bounded, ordered transfer to private cache; the system picker decides the final destination. */
final class AttachmentTransfer implements AutoCloseable {
    static final long MAX_BYTES = 25L * 1024 * 1024;
    private File file;
    private FileOutputStream output;
    private String id, name, mime;
    private long expected, received;
    private int sequence;

    void start(File directory, JSONObject message) throws Exception {
        if (file != null) throw new IOException("Transfer already in progress");
        long size = message.getLong("size");
        String transferId = message.getString("id");
        if (size < 0 || size > MAX_BYTES || !transferId.matches("[a-zA-Z0-9-]{1,80}")) throw new IOException("Invalid transfer");
        id = transferId;
        name = UrlPolicy.filename(message.optString("name"));
        String type = message.optString("mime");
        mime = type.matches("[a-zA-Z0-9.+-]+/[a-zA-Z0-9.+-]+") ? type : "application/octet-stream";
        expected = size;
        received = 0;
        sequence = 0;
        file = File.createTempFile("attachment-", ".tmp", directory);
        output = new FileOutputStream(file);
    }

    void chunk(JSONObject message) throws Exception {
        check(message);
        String data = message.getString("data");
        if (output == null || message.getInt("seq") != sequence || data.length() > 131072) throw new IOException("Invalid chunk");
        byte[] bytes = Base64.decode(data, Base64.NO_WRAP);
        if (received + bytes.length > expected) throw new IOException("Attachment too large");
        output.write(bytes);
        received += bytes.length;
        sequence++;
    }

    void finish(JSONObject message) throws Exception {
        check(message);
        if (output == null || received != expected) throw new IOException("Incomplete attachment");
        output.close();
        output = null;
    }
    private void check(JSONObject message) throws Exception {
        if (file == null || !id.equals(message.getString("id"))) throw new IOException("Unknown transfer");
    }
    File file() { return file; }
    boolean matches(String value) { return file != null && id.equals(value); }
    String name() { return name; }
    String mime() { return mime; }
    boolean complete() { return file != null && output == null; }

    @Override public void close() {
        if (output != null) try { output.close(); } catch (IOException ignored) { }
        if (file != null) file.delete();
        output = null;
        file = null;
    }
}
