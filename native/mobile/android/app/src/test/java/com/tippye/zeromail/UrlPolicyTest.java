package com.tippye.zeromail;

import org.junit.Test;
import java.util.Map;
import static org.junit.Assert.*;

public class UrlPolicyTest {
    @Test public void normalizesServers() {
        assertEquals("https://mail.example.com", UrlPolicy.server(" HTTPS://MAIL.EXAMPLE.COM:443/ ", false));
        assertEquals("http://192.168.1.4:8080", UrlPolicy.server("http://192.168.1.4:8080", true));
        assertEquals("https://[::1]:8443", UrlPolicy.server("https://[::1]:8443/", false));
    }
    @Test public void rejectsAmbiguousServers() {
        for (String raw : new String[]{"http://mail.example.com", "javascript:alert(1)", "https://user:pass@host",
                "https://host/path", "https://host?key=secret", "https://host/#x", "https://host:0", "https://host:65536",
                "https://host\\@other", "https://host%2f.other", "https://host\n.other"}) {
            assertThrows(raw, IllegalArgumentException.class, () -> UrlPolicy.server(raw, false));
        }
    }
    @Test public void originIncludesSchemeHostAndPort() {
        assertTrue(UrlPolicy.sameOrigin("https://mail.example.com", "https://MAIL.example.com:443/mail/inbox?x=1"));
        for (String raw : new String[]{"http://mail.example.com/mail", "https://mail.example.com.evil/mail",
                "https://mail.example.com:8443/", "https://user@mail.example.com/", "file:///etc/passwd"}) {
            assertFalse(raw, UrlPolicy.sameOrigin("https://mail.example.com", raw));
        }
    }
    @Test public void composePreservesChineseNewlinesAndLiteralPlus() {
        assertEquals("/mail/compose?", UrlPolicy.linkPath("mailto:"));
        assertEquals("/mail/compose?to=a%2Bb%40example.com&subject=%E4%B8%AD%E6%96%87&body=line1%0Aline2%2B%2520",
                UrlPolicy.linkPath("mailto:a+b@example.com?subject=%E4%B8%AD%E6%96%87&body=line1%0Aline2+%2520"));
        assertEquals("/mail/compose?to=a%40b%2Cc%40d&cc=x%2By%40z&bcc=hidden%40z", UrlPolicy.linkPath("mailto:a@b?to=c@d&cc=x+y@z&bcc=hidden@z&attachment=/private/file"));
        assertEquals("/mail/inbox", UrlPolicy.linkPath("zeromail://inbox"));
        assertEquals("/mail/compose?subject=Hello", UrlPolicy.linkPath("zeromail://compose?subject=Hello"));
    }
    @Test public void rejectsUnsupportedAndMalformedLinks() {
        for (String raw : new String[]{"https://example.com", "zeromail://compose/path", "zeromail://compose:42", "zeromail://inbox?url=x",
                "mailto://person@example.com", "mailto:a@b?subject=ok%0Abcc:other", "mailto:a@b?body=%00", "mailto:a@b?body=%GG",
                "zeromail://user@compose", "mailto:a@b#fragment", "mailto:" + "a".repeat(32000)}) {
            assertThrows(raw, IllegalArgumentException.class, () -> UrlPolicy.linkPath(raw));
        }
    }
    @Test public void sharesAreDataAndFilenamesHaveNoPaths() {
        assertEquals("/mail/compose?body=https%3A%2F%2Fexample.com%2F%3Fq%3Da%2Bb", UrlPolicy.composePath(Map.of("body", "https://example.com/?q=a+b")));
        assertEquals(".._.._secret_.txt", UrlPolicy.filename("../../secret\n.txt"));
        assertEquals("attachment", UrlPolicy.filename(".."));
        assertThrows(IllegalArgumentException.class, () -> UrlPolicy.notificationPath("https://other"));
    }
}
