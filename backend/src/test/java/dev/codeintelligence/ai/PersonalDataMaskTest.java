package dev.codeintelligence.ai;

import static org.assertj.core.api.Assertions.assertThat;

import dev.codeintelligence.evidence.SecretMask;
import org.junit.jupiter.api.Test;

class PersonalDataMaskTest {

    @Test
    void masksEmailAddressesStablyPerValueWithinOneRequest() {
        assertThat(PersonalDataMask.mask(
                        "mail jane.doe+ci@example.co.kr, cc Ops@Example.invalid, again JANE.DOE+ci@example.co.kr"))
                .isEqualTo("mail [EMAIL_1], cc [EMAIL_2], again [EMAIL_1]");
        assertThat(PersonalDataMask.mask("<a href=\"mailto:jane@example.invalid\">"))
                .isEqualTo("<a href=\"mailto:[EMAIL_1]\">");
    }

    @Test
    void masksKoreanAndInternationalPhoneNumbers() {
        assertThat(PersonalDataMask.mask("call 010-2345-6789 / 01023456789 / 010.2345.6789"))
                .isEqualTo("call [PHONE_1] / [PHONE_1] / [PHONE_1]");
        assertThat(PersonalDataMask.mask("office 02-345-6789, 031 234 5678, 070-1234-5678"))
                .isEqualTo("office [PHONE_1], [PHONE_2], [PHONE_3]");
        assertThat(PersonalDataMask.mask("intl +82 10-2345-6789, +44 20 7946 0958, +1 (415) 555-0132"))
                .isEqualTo("intl [PHONE_1], [PHONE_2], [PHONE_3]");
        assertThat(PersonalDataMask.mask("US (415) 555-0132 or 415-555-0132")).isEqualTo("US [PHONE_1] or [PHONE_1]");
    }

    @Test
    void masksResidentRegistrationNumbersCardsAndSsns() {
        assertThat(PersonalDataMask.mask("RRN 900101-1234567 and 0412313234567"))
                .isEqualTo("RRN [RRN_1] and 0412313234567");
        // An unhyphenated 13-digit value is masked only when its date and pre-2020 checksum are valid.
        assertThat(PersonalDataMask.mask("rrn=8001011234560")).isEqualTo("rrn=[RRN_1]");
        // Numbers follow detection order per kind (contiguous card form first), stable per value.
        assertThat(PersonalDataMask.mask("card 4111 1111 1111 1111, 4111-1111-1111-1111, 5500000000000004"))
                .isEqualTo("card [CARD_2], [CARD_2], [CARD_1]");
        assertThat(PersonalDataMask.mask("amex 3782 822463 10005")).isEqualTo("amex [CARD_1]");
        assertThat(PersonalDataMask.mask("SSN 078-05-1120")).isEqualTo("SSN [SSN_1]");
    }

    @Test
    void leavesIdentifiersVersionsHashesAndOrdinaryNumbersUnchanged() {
        String code = """
                @Override public String version() { return "2.345.678.9012"; } // semver 10.2345.6789
                long epochMs = 1791292686000L; long micros = 1791292686000000L;
                long orderId = 4111111111111112L; String order = "4111111111111112"; int port = 5432; double ratio = 0.0102345678;
                String sha = "9f86d081884c7d659a2feaeaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a";
                String uuid = "550e8400-e29b-41d4-a716-446655440000"; String ip = "192.168.10.200";
                String dep = "lodash@4.17.21"; String scoped = "@types/node@20.1.0"; String remote = "git@github.com:org/repo.git";
                String ssh = "ssh://git@github.com/org/repo.git"; String date = "2026-10-07"; String time = "12:34:56";
                String id = "user_01023456789"; String k = "A010-2345-6789"; String ref = "file:src/App.java:120";
                String ssnLike = "000-12-3456"; String rrnLike = "901301-1234567"; String phoneLike = "+1 23";
                """;
        assertThat(PersonalDataMask.mask(code)).isEqualTo(code);
        assertThat(PersonalDataMask.mask(null)).isNull();
        assertThat(PersonalDataMask.mask("")).isEmpty();
    }

    @Test
    void neverCrossesLinesSoEvidenceLineReferencesStayValid() {
        String text = "010-2345\n-6789\njane\n@example.invalid";
        assertThat(PersonalDataMask.mask(text)).isEqualTo(text);
        assertThat(PersonalDataMask.mask("a\njane@example.invalid\nb").lines().count())
                .isEqualTo(3);
    }

    @Test
    void composesWithSecretMaskWithoutRestoringOrRenumberingSecrets() {
        String masked = PersonalDataMask.mask(SecretMask.redact(
                "postgresql://ci_user:pw-fixture@db.example.invalid/app token=abc jane@example.invalid"));
        assertThat(masked)
                .isEqualTo("postgresql://ci_user:[REDACTED]@db.example.invalid/app token=[REDACTED] [EMAIL_1]");
        assertThat(PersonalDataMask.detects("jane@example.invalid")).isTrue();
        assertThat(PersonalDataMask.detects("class Todo {}")).isFalse();
        // Masking is idempotent: placeholders are never matched again.
        assertThat(PersonalDataMask.mask(masked)).isEqualTo(masked);
    }
}
